// The sandbox tools (tm1_list_sandboxes, tm1_create_sandbox,
// tm1_compare_sandbox, tm1_discard_sandbox, tm1_delete_sandbox,
// tm1_publish_sandbox) as handlers, against a fake TM1 client.
//
// What this suite pins:
//   - create, discard and delete refuse a name without TM1_SANDBOX_PREFIX in
//     sandbox mode, before any TM1 call, and accept any name in readwrite;
//   - publish is refused on a sandbox connection and needs confirm;
//   - every sandbox tool answers UNSUPPORTED_OPERATION naming
//     DisableSandboxing=T when TM1 reports sandboxing off, and runs otherwise;
//   - compare matches cells by coordinate, not by ordinal, and reads the
//     sandbox side through `!sandbox`.
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ConnectionRegistry } from "../../src/connections.js";
import { registerListSandboxes } from "../../src/tools/sandboxes/list-sandboxes.js";
import { registerCreateSandbox } from "../../src/tools/sandboxes/create-sandbox.js";
import {
  registerCompareSandbox,
  cellsByCoordinate,
  diffCells,
} from "../../src/tools/sandboxes/compare-sandbox.js";
import { registerDiscardSandbox } from "../../src/tools/sandboxes/discard-sandbox.js";
import { registerDeleteSandbox } from "../../src/tools/sandboxes/delete-sandbox.js";
import { registerPublishSandbox } from "../../src/tools/sandboxes/publish-sandbox.js";
import { captureTool } from "../helpers/client-harness.js";
import { contractCheckedClient } from "../helpers/service-contract.js";
import { TM1Error, TM1ErrorCode, type MdxResult } from "../../src/types.js";
import type { TM1Client } from "../../src/tm1-client.js";
import type { ClientSource } from "../../src/tools/define-tool.js";
import type { ToolRegistrar } from "../../src/tools/define-tool.js";

type Mode = "readwrite" | "sandbox" | "readonly";

const PREFIX = "mcp-";

function cellset(rows: string[], values: Array<number | null>): MdxResult {
  return {
    totalCellCount: values.length,
    cells: values.map((value) => ({ value, formattedValue: "" })),
    axes: [
      {
        tuples: rows.map((name) => ({
          members: [{ name, hierarchyName: "Region" }],
        })),
      },
    ],
  };
}

/**
 * A fake TM1 client with the spies every sandbox tool may reach. `sandboxing`
 * is what TM1 reported at login (undefined = not read yet). The `cells` service
 * is wrapped in the recorded-contract check, so the fake cannot drift from the
 * shape the real service returns.
 */
function fakeTm1(
  mode: Mode,
  opts: {
    sandboxing?: boolean | undefined;
    base?: MdxResult;
    inSandbox?: MdxResult;
  } = {},
) {
  const sandboxes = {
    list: vi.fn(async () => [
      {
        name: "mcp-a",
        includeInSandboxDimension: true,
        isActive: false,
        isLoaded: true,
        isQueued: false,
      },
      {
        name: "Proposal-1",
        includeInSandboxDimension: true,
        isActive: false,
        isLoaded: false,
        isQueued: false,
      },
    ]),
    create: vi.fn(async () => undefined),
    discardChanges: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    publish: vi.fn(async () => undefined),
  };
  const cells = {
    executeMdx: vi.fn(
      async (
        _mdx: string,
        _top?: number,
        _skip?: number,
        _opts?: unknown,
        sandbox?: string,
      ) =>
        sandbox === undefined
          ? (opts.base ?? cellset(["Berlin"], [10]))
          : (opts.inSandbox ?? cellset(["Berlin"], [10])),
    ),
  };
  const raw = {
    version: 11,
    mode,
    sandboxPrefix: PREFIX,
    sandboxingDisabled: opts.sandboxing,
    sandboxes,
    cells,
  };
  return {
    tm1: contractCheckedClient(raw) as unknown as TM1Client,
    sandboxes,
    cells,
  };
}

/**
 * One registered tool, called the way the SDK calls it: args are parsed by the
 * tool's schema first (defaults apply, unknown keys fail), and the call runs
 * through the connection gate of a registry in the given mode.
 */
function toolOn(
  register: ToolRegistrar,
  tm1: TM1Client,
  mode: Mode = "readwrite",
) {
  const source = ConnectionRegistry.of([{ name: "conn", client: tm1, mode }]);
  const { schema, cb } = captureTool(register, source as ClientSource);
  const parser = z.object(schema);
  return (args: Record<string, unknown>) =>
    cb(parser.parse({ connection: "conn", ...args }), {});
}

const body = (res: unknown) =>
  JSON.parse(
    (res as { content: Array<{ text: string }> }).content[0].text,
  ) as Record<string, unknown>;

// ── name prefix ─────────────────────────────────────────────────────────────

const NAMED = [
  {
    label: "tm1_create_sandbox",
    register: registerCreateSandbox,
    method: "create" as const,
    args: (n: string) => ({ sandboxName: n }),
  },
  {
    label: "tm1_discard_sandbox",
    register: registerDiscardSandbox,
    method: "discardChanges" as const,
    args: (n: string) => ({ sandboxName: n, confirm: n }),
  },
  {
    label: "tm1_delete_sandbox",
    register: registerDeleteSandbox,
    method: "delete" as const,
    args: (n: string) => ({ sandboxName: n, confirm: n }),
  },
];

describe("create, discard and delete name the sandbox they may touch", () => {
  it.each(NAMED)(
    "$label refuses a name without the prefix in sandbox mode, before any TM1 call",
    async ({ register, method, args }) => {
      const f = fakeTm1("sandbox");
      const call = toolOn(register, f.tm1, "sandbox");
      await expect(call(args("Proposal-1"))).rejects.toMatchObject({
        code: TM1ErrorCode.PERMISSION_DENIED,
      });
      await expect(call(args("Proposal-1"))).rejects.toThrow(
        /does not start with "mcp-"/,
      );
      expect(f.sandboxes[method]).not.toHaveBeenCalled();
    },
  );

  it.each(NAMED)(
    "$label acts on a managed name in sandbox mode",
    async ({ register, method, args }) => {
      const f = fakeTm1("sandbox");
      const call = toolOn(register, f.tm1, "sandbox");
      const res = await call(args("mcp-whatif"));
      expect(body(res)).toMatchObject({ success: true });
      expect(f.sandboxes[method]).toHaveBeenCalledWith("mcp-whatif");
    },
  );

  it.each(NAMED)(
    "$label acts on any name in readwrite mode",
    async ({ register, method, args }) => {
      const f = fakeTm1("readwrite");
      const call = toolOn(register, f.tm1, "readwrite");
      await call(args("Proposal-1"));
      expect(f.sandboxes[method]).toHaveBeenCalledWith("Proposal-1");
    },
  );

  it("tm1_create_sandbox refuses an empty name", async () => {
    const f = fakeTm1("readwrite");
    const call = toolOn(registerCreateSandbox, f.tm1, "readwrite");
    await expect(call({ sandboxName: "   " })).rejects.toMatchObject({
      code: TM1ErrorCode.VALIDATION_ERROR,
    });
    expect(f.sandboxes.create).not.toHaveBeenCalled();
  });
});

// ── publish and confirm ─────────────────────────────────────────────────────

describe("tm1_publish_sandbox", () => {
  it("is refused on a sandbox connection, before any TM1 call", async () => {
    const f = fakeTm1("sandbox");
    const call = toolOn(registerPublishSandbox, f.tm1, "sandbox");
    await expect(
      call({ sandboxName: "mcp-a", confirm: "mcp-a" }),
    ).rejects.toThrow(
      /changes TM1 outside a sandbox, but connection "conn" is in sandbox mode/,
    );
    expect(f.sandboxes.publish).not.toHaveBeenCalled();
  });

  it("publishes on a readwrite connection", async () => {
    const f = fakeTm1("readwrite");
    const call = toolOn(registerPublishSandbox, f.tm1, "readwrite");
    await call({ sandboxName: "Proposal-1", confirm: "Proposal-1" });
    expect(f.sandboxes.publish).toHaveBeenCalledWith("Proposal-1");
  });
});

describe("confirm is required on the destructive sandbox tools", () => {
  const CONFIRMED = [
    {
      label: "tm1_discard_sandbox",
      register: registerDiscardSandbox,
      method: "discardChanges" as const,
    },
    {
      label: "tm1_delete_sandbox",
      register: registerDeleteSandbox,
      method: "delete" as const,
    },
    {
      label: "tm1_publish_sandbox",
      register: registerPublishSandbox,
      method: "publish" as const,
    },
  ];

  it.each(CONFIRMED)(
    "$label input rejects a missing confirm",
    ({ register }) => {
      const f = fakeTm1("readwrite");
      const { schema } = captureTool(register, f.tm1);
      const parser = z.object(schema);
      expect(parser.safeParse({ sandboxName: "mcp-a" }).success).toBe(false);
    },
  );

  it.each(CONFIRMED)(
    "$label refuses a mismatched confirm and changes nothing",
    async ({ register, method }) => {
      const f = fakeTm1("readwrite");
      const call = toolOn(register, f.tm1, "readwrite");
      await expect(
        call({ sandboxName: "mcp-a", confirm: "mcp-b" }),
      ).rejects.toMatchObject({ code: TM1ErrorCode.VALIDATION_ERROR });
      expect(f.sandboxes[method]).not.toHaveBeenCalled();
    },
  );
});

// ── DisableSandboxing ───────────────────────────────────────────────────────

describe("every sandbox tool follows TM1's DisableSandboxing", () => {
  const ALL: Array<{
    label: string;
    register: ToolRegistrar;
    args: Record<string, unknown>;
  }> = [
    { label: "tm1_list_sandboxes", register: registerListSandboxes, args: {} },
    {
      label: "tm1_create_sandbox",
      register: registerCreateSandbox,
      args: { sandboxName: "mcp-a" },
    },
    {
      label: "tm1_compare_sandbox",
      register: registerCompareSandbox,
      args: {
        sandboxName: "mcp-a",
        mdx: "SELECT {[Region].[Berlin]} ON 0 FROM [Sales]",
      },
    },
    {
      label: "tm1_discard_sandbox",
      register: registerDiscardSandbox,
      args: { sandboxName: "mcp-a", confirm: "mcp-a" },
    },
    {
      label: "tm1_delete_sandbox",
      register: registerDeleteSandbox,
      args: { sandboxName: "mcp-a", confirm: "mcp-a" },
    },
    {
      label: "tm1_publish_sandbox",
      register: registerPublishSandbox,
      args: { sandboxName: "mcp-a", confirm: "mcp-a" },
    },
  ];

  it.each(ALL)(
    "$label answers with the DisableSandboxing=T reason and calls nothing",
    async ({ register, args }) => {
      const f = fakeTm1("readwrite", { sandboxing: true });
      const call = toolOn(register, f.tm1, "readwrite");
      const err = await call(args).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TM1Error);
      const e = err as TM1Error;
      expect(e.code).toBe(TM1ErrorCode.UNSUPPORTED_OPERATION);
      expect(e.message).toContain("DisableSandboxing=T");
      expect(e.message).toContain('is unavailable on connection "conn"');
      expect(f.sandboxes.list).not.toHaveBeenCalled();
      expect(f.sandboxes.create).not.toHaveBeenCalled();
      expect(f.sandboxes.discardChanges).not.toHaveBeenCalled();
      expect(f.sandboxes.delete).not.toHaveBeenCalled();
      expect(f.sandboxes.publish).not.toHaveBeenCalled();
      expect(f.cells.executeMdx).not.toHaveBeenCalled();
    },
  );

  it.each(ALL)(
    "$label runs when the setting is unknown or off",
    async ({ register, args }) => {
      for (const sandboxing of [undefined, false]) {
        const f = fakeTm1("readwrite", { sandboxing });
        const call = toolOn(register, f.tm1, "readwrite");
        await expect(call(args)).resolves.toBeDefined();
      }
    },
  );
});

// ── list ────────────────────────────────────────────────────────────────────

describe("tm1_list_sandboxes", () => {
  it("marks the sandboxes this server may write, by prefix", async () => {
    const f = fakeTm1("sandbox");
    const page = body(
      await toolOn(registerListSandboxes, f.tm1, "sandbox")({}),
    );
    expect(page.items).toEqual([
      expect.objectContaining({ name: "mcp-a", managed: true }),
      expect.objectContaining({ name: "Proposal-1", managed: false }),
    ]);
  });
});

// ── compare ─────────────────────────────────────────────────────────────────

describe("compare matches cells by coordinate", () => {
  it("lists only the cells that differ, with the change", () => {
    const base = cellsByCoordinate(cellset(["Berlin", "Paris"], [10, 20]));
    const sand = cellsByCoordinate(cellset(["Berlin", "Paris"], [15, 20]));
    expect(diffCells(base, sand)).toEqual([
      { coordinates: ["Region:Berlin"], base: 10, sandbox: 15, change: 5 },
    ]);
  });

  it("stays right when NON EMPTY gives the sides different axes", () => {
    // Base has Berlin only; the sandbox wrote Paris, so its NON EMPTY axis
    // has two tuples and Berlin moved to ordinal 1. Ordinal matching would
    // report Berlin as changed.
    const base = cellsByCoordinate(cellset(["Berlin"], [10]));
    const sand = cellsByCoordinate(cellset(["Paris", "Berlin"], [7, 10]));
    expect(diffCells(base, sand)).toEqual([
      { coordinates: ["Region:Paris"], base: null, sandbox: 7, change: 7 },
    ]);
  });

  it("treats empty, zero and null as the same", () => {
    const base = cellsByCoordinate(cellset(["Berlin"], [null]));
    const sand = cellsByCoordinate(cellset(["Berlin"], [0]));
    expect(diffCells(base, sand)).toEqual([]);
  });
});

describe("tm1_compare_sandbox", () => {
  const MDX = "SELECT {[Region].[Berlin], [Region].[Paris]} ON 0 FROM [Sales]";

  it("reads base first, then the sandbox, and reports the differences", async () => {
    const f = fakeTm1("sandbox", {
      base: cellset(["Berlin", "Paris"], [10, 20]),
      inSandbox: cellset(["Berlin", "Paris"], [15, 20]),
    });
    const res = await toolOn(
      registerCompareSandbox,
      f.tm1,
      "sandbox",
    )({
      sandboxName: "mcp-a",
      mdx: MDX,
    });
    expect(f.cells.executeMdx).toHaveBeenCalledTimes(2);
    expect(f.cells.executeMdx.mock.calls[0]?.[4]).toBeUndefined();
    expect(f.cells.executeMdx.mock.calls[1]?.[4]).toBe("mcp-a");
    expect(body(res)).toMatchObject({
      sandbox: "mcp-a",
      cellsCompared: 2,
      differences: 1,
      truncated: false,
      cells: [
        { coordinates: ["Region:Berlin"], base: 10, sandbox: 15, change: 5 },
      ],
    });
  });

  it("refuses a slice larger than maxCells instead of comparing part of it", async () => {
    const f = fakeTm1("sandbox", {
      base: cellset(["Berlin", "Paris", "Rome"], [1, 2, 3]),
    });
    await expect(
      toolOn(
        registerCompareSandbox,
        f.tm1,
        "sandbox",
      )({
        sandboxName: "mcp-a",
        mdx: MDX,
        maxCells: 2,
      }),
    ).rejects.toMatchObject({ code: TM1ErrorCode.VALIDATION_ERROR });
  });

  it("caps the listed differences and says so", async () => {
    const f = fakeTm1("sandbox", {
      base: cellset(["Berlin", "Paris"], [1, 2]),
      inSandbox: cellset(["Berlin", "Paris"], [5, 6]),
    });
    const res = await toolOn(
      registerCompareSandbox,
      f.tm1,
      "sandbox",
    )({
      sandboxName: "mcp-a",
      mdx: MDX,
      maxDifferences: 1,
    });
    expect(body(res)).toMatchObject({
      differences: 2,
      truncated: true,
    });
    expect((body(res).cells as unknown[]).length).toBe(1);
  });

  it("needs a sandbox name", async () => {
    const f = fakeTm1("sandbox");
    await expect(
      toolOn(
        registerCompareSandbox,
        f.tm1,
        "sandbox",
      )({
        sandboxName: "  ",
        mdx: MDX,
      }),
    ).rejects.toMatchObject({ code: TM1ErrorCode.VALIDATION_ERROR });
    expect(f.cells.executeMdx).not.toHaveBeenCalled();
  });
});
