// The cell layer under TM1_MODE=sandbox and TM1_MODE=readwrite with a sandbox.
//
// What this suite pins:
//   - tm1_write_cells sends nothing (no TM1 call at all) when the target is not
//     allowed: no sandbox, a foreign sandbox, or a control cube;
//   - a sandboxed write goes into the sandbox, reads it back from there, and
//     binds a left-out Sandboxes dimension to it;
//   - every REST request of a sandboxed write, MDX read and single-cell read
//     carries `!sandbox=`, and a base call carries none;
//   - readwrite base writes are unchanged;
//   - tm1_execute_mdx passes its sandbox through (trimmed) and stays read-only.
import { describe, it, expect, vi } from "vitest";
import { registerWriteCells } from "../../src/tools/celldata/write-cells.js";
import { registerExecuteMdx } from "../../src/tools/celldata/execute-mdx.js";
import { CellService } from "../../src/tm1-client/services/cell-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import type { TM1Client } from "../../src/tm1-client.js";
import type { SandboxPolicyContext } from "../../src/lib/sandbox-policy.js";
import { TM1Error, TM1ErrorCode, type MdxResult } from "../../src/types.js";
import { captureParsedTool, stubbedClient } from "../helpers/client-harness.js";
import { contractCheckedHttp } from "../helpers/contract-http.js";
import { makeTestConfig } from "../helpers/tm1-config.js";

const SANDBOX: SandboxPolicyContext = {
  mode: "sandbox",
  sandboxPrefix: "mcp-",
};
const READWRITE: SandboxPolicyContext = {
  mode: "readwrite",
  sandboxPrefix: "mcp-",
};
const CUBE = ["Region", "Month"];
const WITH_SANDBOXES = [...CUBE, "Sandboxes"];

/**
 * A write tool wired to spies for every TM1 call it could make. The spies are
 * returned so a test can assert that a refused write touched none of them.
 */
function writeTool(ctx: SandboxPolicyContext, cubeDims: string[]) {
  const spies = {
    getDimensionNames: vi.fn(async () => cubeDims),
    consolidatedAmong: vi.fn(async () => [] as string[]),
    writeCells: vi.fn(async () => undefined),
    getValue: vi.fn(async (_cube: string, elements: string[]) =>
      elements.length > 0 ? 42 : null,
    ),
  };
  const client = {
    ...ctx,
    elements: { consolidatedAmong: spies.consolidatedAmong },
    cells: { writeCells: spies.writeCells, getValue: spies.getValue },
    cubes: { getDimensionNames: spies.getDimensionNames },
  } as unknown as TM1Client;
  const call = captureParsedTool<
    { content: Array<{ text: string }> },
    TM1Client
  >(registerWriteCells, client);
  const sent = () =>
    Object.values(spies).some((spy) => spy.mock.calls.length > 0);
  return { call, spies, sent };
}

const ARGS = {
  cubeName: "Sales",
  dimensions: CUBE,
  cells: [{ elements: ["Berlin", "Jan"], value: 42 }],
  confirm: "Sales",
};

describe("tm1_write_cells under TM1_MODE=sandbox", () => {
  it("sends nothing without a sandbox, not even a read", async () => {
    const { call, spies, sent } = writeTool(SANDBOX, CUBE);
    await expect(call(ARGS)).rejects.toMatchObject({
      code: TM1ErrorCode.PERMISSION_DENIED,
    });
    expect(sent()).toBe(false);
    expect(spies.writeCells).not.toHaveBeenCalled();
  });

  it("refuses a sandbox without the prefix before any TM1 call", async () => {
    const { call, sent } = writeTool(SANDBOX, CUBE);
    await expect(call({ ...ARGS, sandbox: "Proposal-1" })).rejects.toThrow(
      /does not start with "mcp-"/,
    );
    expect(sent()).toBe(false);
  });

  it("refuses a control cube even into a managed sandbox", async () => {
    const { call, sent } = writeTool(SANDBOX, ["}Cubes", "}Groups"]);
    await expect(
      call({
        cubeName: "}CubeSecurity",
        dimensions: ["}Cubes", "}Groups"],
        cells: [{ elements: ["Sales", "Viewers"], value: "WRITE" }],
        sandbox: "mcp-whatif",
        confirm: "}CubeSecurity",
      }),
    ).rejects.toMatchObject({ code: TM1ErrorCode.PERMISSION_DENIED });
    expect(sent()).toBe(false);
  });

  // Measured on TM1 11 and 12: the server ignores spaces in a name, so
  // `Cubes(' }ClientGroups')` and `FROM [ }ClientGroups]` reach the control cube.
  it("refuses a control cube named with a leading space", async () => {
    const { call, spies, sent } = writeTool(SANDBOX, ["}Cubes", "}Groups"]);
    await expect(
      call({
        cubeName: " }CubeSecurity",
        dimensions: ["}Cubes", "}Groups"],
        cells: [{ elements: ["Sales", "Viewers"], value: "WRITE" }],
        sandbox: "mcp-whatif",
        confirm: " }CubeSecurity",
      }),
    ).rejects.toThrow(/control cube/);
    expect(sent()).toBe(false);
    expect(spies.writeCells).not.toHaveBeenCalled();
  });

  it("writes into the named sandbox and reads the value back from it", async () => {
    const { call, spies } = writeTool(SANDBOX, CUBE);
    const res = await call({ ...ARGS, sandbox: "mcp-whatif" });
    expect(spies.writeCells).toHaveBeenCalledWith(
      "Sales",
      CUBE,
      [{ elements: ["Berlin", "Jan"], value: 42 }],
      "mcp-whatif",
    );
    expect(spies.getValue).toHaveBeenCalledWith(
      "Sales",
      ["Berlin", "Jan"],
      "mcp-whatif",
    );
    expect(JSON.stringify(res)).toContain('"sandbox":"mcp-whatif"');
  });

  it("binds a left-out Sandboxes dimension to the sandbox, not Base", async () => {
    const { call, spies } = writeTool(SANDBOX, WITH_SANDBOXES);
    const res = await call({ ...ARGS, sandbox: "mcp-whatif" });
    expect(spies.writeCells).toHaveBeenCalledWith(
      "Sales",
      WITH_SANDBOXES,
      [{ elements: ["Berlin", "Jan", "mcp-whatif"], value: 42 }],
      "mcp-whatif",
    );
    expect(spies.getValue).toHaveBeenCalledWith(
      "Sales",
      ["Berlin", "Jan", "mcp-whatif"],
      "mcp-whatif",
    );
    expect(JSON.stringify(res)).toContain('"sandboxDefaulted":"mcp-whatif"');
  });

  it.each(["Base", "Proposal-1"])(
    "cannot reach Sandboxes:%s through the coordinate",
    async (other) => {
      const { call, spies } = writeTool(SANDBOX, WITH_SANDBOXES);
      await expect(
        call({
          ...ARGS,
          dimensions: WITH_SANDBOXES,
          cells: [{ elements: ["Berlin", "Jan", other], value: 42 }],
          sandbox: "mcp-whatif",
        }),
      ).rejects.toThrow(/targets sandbox "mcp-whatif"/);
      expect(spies.writeCells).not.toHaveBeenCalled();
    },
  );

  it.each([
    "[mcp-whatif]",
    "[Sandboxes].[mcp-whatif]",
    "[Sandboxes].[Sandboxes].[MCP-WhatIf]",
  ])("accepts the target sandbox written as %s", async (ref) => {
    const { call, spies } = writeTool(SANDBOX, WITH_SANDBOXES);
    await call({
      ...ARGS,
      dimensions: WITH_SANDBOXES,
      cells: [{ elements: ["Berlin", "Jan", ref], value: 42 }],
      sandbox: "mcp-whatif",
    });
    expect(spies.writeCells).toHaveBeenCalledTimes(1);
  });

  it.each([
    "[Sandboxes].[Sandboxes].[Base]",
    "[Sandboxes].[Proposal-1]",
    "[Region].[Region].[mcp-whatif]",
    "[Sandboxes].[Other].[mcp-whatif]",
  ])("refuses the qualified reference %s", async (ref) => {
    const { call, spies } = writeTool(SANDBOX, WITH_SANDBOXES);
    await expect(
      call({
        ...ARGS,
        dimensions: WITH_SANDBOXES,
        cells: [{ elements: ["Berlin", "Jan", ref], value: 42 }],
        sandbox: "mcp-whatif",
      }),
    ).rejects.toThrow(/targets sandbox "mcp-whatif"/);
    expect(spies.writeCells).not.toHaveBeenCalled();
  });
});

describe("tm1_write_cells under TM1_MODE=readwrite", () => {
  it("writes base data unchanged: no sandbox on the write or the read-back", async () => {
    const { call, spies } = writeTool(READWRITE, CUBE);
    const res = await call(ARGS);
    expect(spies.writeCells).toHaveBeenCalledWith(
      "Sales",
      CUBE,
      [{ elements: ["Berlin", "Jan"], value: 42 }],
      undefined,
    );
    expect(spies.getValue).toHaveBeenCalledWith(
      "Sales",
      ["Berlin", "Jan"],
      undefined,
    );
    expect(JSON.stringify(res)).not.toContain('"sandbox"');
  });

  it("leaves a control cube writable", async () => {
    const { call, spies } = writeTool(READWRITE, ["}Cubes", "}Groups"]);
    await call({
      cubeName: "}CubeSecurity",
      dimensions: ["}Cubes", "}Groups"],
      cells: [{ elements: ["Sales", "Viewers"], value: "WRITE" }],
      confirm: "}CubeSecurity",
    });
    expect(spies.writeCells).toHaveBeenCalledTimes(1);
  });
});

// ── REST paths ───────────────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

// A fake TM1HttpClient that records every request. `reply` answers by method
// and path; a thrown error simulates TM1 refusing that request.
function recordingHttp(
  reply: (method: string, path: string, n: number) => unknown,
) {
  const calls: Call[] = [];
  const http = contractCheckedHttp({
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return reply(method, path, calls.length);
    }),
  } as unknown as TM1HttpClient);
  return { http, calls };
}

const cellsetId = (method: string, path: string) =>
  method === "POST" && path.startsWith("/api/v1/ExecuteMDX")
    ? { ID: "cs0" }
    : undefined;

const PARAM = "!sandbox=mcp-whatif";

describe("REST requests carry !sandbox", () => {
  it("on every request of a sandboxed write, bulk form", async () => {
    const { http, calls } = recordingHttp(cellsetId);
    await new CellService(http).writeCells(
      "Sales",
      CUBE,
      [{ elements: ["Berlin", "Jan"], value: 1 }],
      "mcp-whatif",
    );
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /api/v1/ExecuteMDX?${PARAM}`,
      `PATCH /api/v1/Cellsets('cs0')/Cells?${PARAM}`,
      `DELETE /api/v1/Cellsets('cs0')?${PARAM}`,
    ]);
  });

  it("on the single-cell fallback writes too", async () => {
    // A bulk PATCH refused with a 4xx is re-walked one cell at a time, through
    // the Cells(0) path. Every one of those requests must carry the sandbox.
    const refused = new TM1Error({
      code: TM1ErrorCode.TM1_ERROR,
      message: "CubeCellWriteStatusElementIsConsolidated",
      httpStatus: 400,
    });
    const { http, calls } = recordingHttp((method, path) => {
      if (method === "PATCH" && path.split("?")[0].endsWith("/Cells")) {
        throw refused;
      }
      return cellsetId(method, path);
    });
    await new CellService(http).writeCells(
      "Sales",
      CUBE,
      [{ elements: ["Berlin", "Jan"], value: 1 }],
      "mcp-whatif",
    );
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain(`PATCH /api/v1/Cellsets('cs0')/Cells(0)?${PARAM}`);
    expect(calls.every((c) => c.path.includes(PARAM))).toBe(true);
  });

  it("not on a base write", async () => {
    const { http, calls } = recordingHttp(cellsetId);
    await new CellService(http).writeCells("Sales", CUBE, [
      { elements: ["Berlin", "Jan"], value: 1 },
    ]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => !c.path.includes("!sandbox"))).toBe(true);
  });

  it("on the ExecuteMDX POST and the cellset DELETE of a sandboxed read", async () => {
    const { http, calls } = recordingHttp((method) =>
      method === "POST" ? { ID: "cs0", Cells: [], Axes: [] } : undefined,
    );
    await new CellService(http).executeMdx(
      "SELECT {} ON 0 FROM [Sales]",
      10,
      0,
      undefined,
      "mcp-whatif",
    );
    expect(calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
    expect(calls[0]?.path).toMatch(
      /^\/api\/v1\/ExecuteMDX\?\$expand=.*&!sandbox=mcp-whatif$/,
    );
    expect(calls[1]?.path).toBe(`/api/v1/Cellsets('cs0')?${PARAM}`);
  });

  it("not on a base MDX read", async () => {
    const { http, calls } = recordingHttp((method) =>
      method === "POST" ? { ID: "cs0", Cells: [], Axes: [] } : undefined,
    );
    await new CellService(http).executeMdx("SELECT {} ON 0 FROM [Sales]");
    expect(calls.length).toBe(2);
    expect(calls.every((c) => !c.path.includes("!sandbox"))).toBe(true);
  });

  it("on the ExecuteMDX POST and the cellset DELETE of a single-cell read", async () => {
    const { http, calls } = recordingHttp((method, path) => {
      if (method === "GET") {
        return { Name: "Sales", Dimensions: CUBE.map((Name) => ({ Name })) };
      }
      return method === "POST" && path.startsWith("/api/v1/ExecuteMDX")
        ? { ID: "cs0", Cells: [{ Value: 7, FormattedValue: "7" }] }
        : undefined;
    });
    const value = await new CellService(http).getValue(
      "Sales",
      ["Berlin", "Jan"],
      "mcp-whatif",
    );
    expect(value).toBe(7);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "DELETE"]);
    expect(calls[0]?.path).not.toContain("!sandbox");
    expect(calls[1]?.path).toMatch(/&!sandbox=mcp-whatif$/);
    expect(calls[2]?.path).toBe(`/api/v1/Cellsets('cs0')?${PARAM}`);
  });

  it("binds a left-out Sandboxes to the sandbox in a single-cell read", async () => {
    const { http, calls } = recordingHttp((method, path) => {
      if (method === "GET") {
        return {
          Name: "Sales",
          Dimensions: WITH_SANDBOXES.map((Name) => ({ Name })),
        };
      }
      return method === "POST" && path.startsWith("/api/v1/ExecuteMDX")
        ? { ID: "cs0", Cells: [{ Value: 7, FormattedValue: "7" }] }
        : undefined;
    });
    await new CellService(http).getValue("Sales", ["Berlin", "Jan"], "mcp-a");
    const mdx = (calls[1]?.body as { MDX: string }).MDX;
    expect(mdx).toContain("[Sandboxes].[mcp-a]");
    expect(mdx).not.toContain("[Base]");
  });

  it("binds a left-out Sandboxes to Base in a base single-cell read", async () => {
    const { http, calls } = recordingHttp((method, path) => {
      if (method === "GET") {
        return {
          Name: "Sales",
          Dimensions: WITH_SANDBOXES.map((Name) => ({ Name })),
        };
      }
      return method === "POST" && path.startsWith("/api/v1/ExecuteMDX")
        ? { ID: "cs0", Cells: [{ Value: 7, FormattedValue: "7" }] }
        : undefined;
    });
    await new CellService(http).getValue("Sales", ["Berlin", "Jan"]);
    const mdx = (calls[1]?.body as { MDX: string }).MDX;
    expect(mdx).toContain("[Sandboxes].[Base]");
    expect(calls.every((c) => !c.path.includes("!sandbox"))).toBe(true);
  });
});

// ── tm1_execute_mdx ──────────────────────────────────────────────────────────

describe("tm1_execute_mdx sandbox argument", () => {
  const EMPTY: MdxResult = { totalCellCount: 0, cells: [], axes: [] };

  function readTool() {
    const executeMdx = vi.fn(async (..._args: unknown[]) => EMPTY);
    const client = { cells: { executeMdx } } as unknown as TM1Client;
    const call = captureParsedTool<unknown, TM1Client>(
      registerExecuteMdx,
      client,
    );
    return { call, executeMdx };
  }

  it("passes the sandbox to the cellset read, trimmed", async () => {
    const { call, executeMdx } = readTool();
    await call({ mdx: "SELECT {} ON 0 FROM [Sales]", sandbox: " mcp-x " });
    expect(executeMdx.mock.calls[0]?.[4]).toBe("mcp-x");
  });

  it("reads base data when no sandbox is given", async () => {
    const { call, executeMdx } = readTool();
    await call({ mdx: "SELECT {} ON 0 FROM [Sales]" });
    expect(executeMdx.mock.calls[0]?.[4]).toBeUndefined();
  });

  it("reads any sandbox, not only a managed one, in sandbox mode", async () => {
    // Reads are allowed into any sandbox: the prefix guards writes only.
    const { call, executeMdx } = readTool();
    await call({ mdx: "SELECT {} ON 0 FROM [Sales]", sandbox: "Proposal-1" });
    expect(executeMdx.mock.calls[0]?.[4]).toBe("Proposal-1");
  });
});

// ── TM1Client ────────────────────────────────────────────────────────────────

describe("TM1Client exposes the connection's mode and prefix", () => {
  it("reads both from its config, which the write policy consults", () => {
    const client = stubbedClient(
      makeTestConfig({ mode: "sandbox", sandboxPrefix: "agent_" }),
    );
    expect(client.mode).toBe("sandbox");
    expect(client.sandboxPrefix).toBe("agent_");
  });
});
