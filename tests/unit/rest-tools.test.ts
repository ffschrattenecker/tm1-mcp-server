import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import type { TM1Client } from "../../src/tm1-client.js";
import type { RestBody } from "../../src/tm1-client/services/rest-service.js";
import { ConnectionRegistry } from "../../src/connections.js";
import { registerRestRead } from "../../src/tools/rest/rest-read.js";
import { registerRestWrite } from "../../src/tools/rest/rest-write.js";
import type { ToolRegistrar } from "../../src/tools/define-tool.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

interface Sent {
  method: string;
  path: string;
  body?: unknown;
  opts?: { timeoutMs?: number };
}

// Fake client: only `rest` is used by these tools. `reply` decides the body.
function fakeClient(reply: (s: Sent) => RestBody | Promise<RestBody>) {
  const sent: Sent[] = [];
  const client = {
    version: 11,
    connectionId: "fake:1",
    rest: {
      get: async (path: string, opts?: Sent["opts"]) => {
        const s: Sent = { method: "GET", path, ...(opts ? { opts } : {}) };
        sent.push(s);
        return reply(s);
      },
      send: async (
        method: string,
        path: string,
        body?: unknown,
        opts?: Sent["opts"],
      ) => {
        const s: Sent = { method, path, body, ...(opts ? { opts } : {}) };
        sent.push(s);
        return reply(s);
      },
    },
  } as unknown as TM1Client;
  return { client, sent };
}

function setup(
  register: ToolRegistrar,
  reply: (s: Sent) => RestBody | Promise<RestBody> = () => ({ kind: "empty" }),
  mode: "readonly" | "readwrite" = "readwrite",
) {
  const { client, sent } = fakeClient(reply);
  let h: ((a: unknown) => Promise<unknown>) | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  register(
    {
      tool: (_n: string, _d: string, s: ZodRawShape, cb: typeof h) => {
        parser = z.object(s);
        h = cb;
      },
    } as never,
    ConnectionRegistry.of([{ name: "default", client, mode }]),
  );
  const call = async (args: Record<string, unknown>) => {
    const res = (await h!(parser!.parse(args))) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(res.content[0].text) as Record<string, unknown>;
  };
  return { call, sent };
}

const json = (v: unknown): RestBody => ({ kind: "json", json: v });

describe("tm1_rest_read", () => {
  it("GETs the path as given and strips @odata annotations recursively", async () => {
    const { call, sent } = setup(registerRestRead, () =>
      json({
        "@odata.context": "$metadata#Cubes",
        "@odata.count": 2,
        value: [
          {
            "@odata.etag": "W/1",
            Name: "Sales",
            Dimensions: [{ "@odata.id": "x", Name: "Region" }],
            "Dimensions@odata.navigationLink": "Cubes('Sales')/Dimensions",
          },
          { Name: "HR", Dimensions: [] },
        ],
      }),
    );
    const out = await call({ path: "Cubes?$count=true&$expand=Dimensions" });
    expect(sent).toEqual([
      {
        method: "GET",
        path: "Cubes?$count=true&$expand=Dimensions",
        opts: { signal: undefined },
      },
    ]);
    expect(out).toEqual({
      truncated: false,
      count: 2,
      data: {
        value: [
          { Name: "Sales", Dimensions: [{ Name: "Region" }] },
          { Name: "HR", Dimensions: [] },
        ],
      },
    });
  });

  it("masks credential keys and passwords inside TI code", async () => {
    const { call } = setup(registerRestRead, () =>
      json({
        Name: "P",
        DataSource: { password: "hunter2", userName: "sa" },
        PrologProcedure: "ODBCOpen('dsn', 'sa', 'hunter2');\nx = 1;",
      }),
    );
    const out = await call({ path: "Processes('P')" });
    const text = JSON.stringify(out);
    expect(text).not.toContain("hunter2");
    expect(out.data).toMatchObject({
      DataSource: { password: "***", userName: "sa" },
    });
    expect((out.data as { PrologProcedure: string }).PrologProcedure).toContain(
      "x = 1;",
    );
  });

  // Addressing one Procedure property returns the code as `value` (JSON) or
  // as the whole body ($value): no *Procedure key marks it as code.
  it.each<[string, RestBody]>([
    [
      "Processes('P')/PrologProcedure",
      json({
        "@odata.context": "x",
        value: "ODBCOpen('dsn','sa','hunter2');\nx = 1;",
      }),
    ],
    [
      "Processes('P')/PrologProcedure/$value",
      {
        kind: "text",
        text: "ODBCOpen('dsn','sa','hunter2');\nx = 1;",
      },
    ],
    [
      "Chores('c')/Tasks(0)/Process/DataProcedure/$value",
      { kind: "text", text: "ODBCOpen('dsn','sa','hunter2');" },
    ],
  ])("masks TI code read directly: %s", async (path, body) => {
    const { call } = setup(registerRestRead, () => body);
    const out = await call({ path });
    const text = JSON.stringify(out);
    expect(text).not.toContain("hunter2");
    expect(text).toContain("ODBCOpen");
  });

  it("returns plain text bodies as text, masking credential pairs", async () => {
    const { call } = setup(registerRestRead, () => ({
      kind: "text",
      text: "Error: ODBC login failed PWD=hunter2;\nline 2",
    }));
    const out = await call({ path: "ErrorLogFiles('e.log')/Content" });
    expect(out.truncated).toBe(false);
    expect(out.text).toContain("line 2");
    expect(out.text).not.toContain("hunter2");
    expect(out.data).toBeUndefined();
  });

  it("cuts a long text body to maxChars", async () => {
    const { call } = setup(registerRestRead, () => ({
      kind: "text",
      text: "x".repeat(5_000),
    }));
    const out = await call({
      path: "ErrorLogFiles('e.log')/Content",
      maxChars: 1_000,
    });
    expect(out).toEqual({
      truncated: true,
      text: "x".repeat(998), // + 2 quotes = 1000 as shipped
      totalChars: 5_000,
    });
  });

  it("trims value[] to the longest prefix that fits, with kept/total", async () => {
    const value = Array.from({ length: 500 }, (_, i) => ({
      Name: `Element_${i}`,
      Type: "Numeric",
    }));
    const { call } = setup(registerRestRead, () =>
      json({ "@odata.context": "c", value }),
    );
    const out = await call({
      path: "Dimensions('D')/Hierarchies('D')/Elements",
      maxChars: 2_000,
    });
    expect(out.truncated).toBe(true);
    expect(out.total).toBe(500);
    expect(out.truncatedAt).toBe("value");
    const kept = out.kept as number;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(500);
    const data = out.data as { value: unknown[] };
    expect(data.value).toEqual(value.slice(0, kept));
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(2_000);
    // One more item would not have fit.
    expect(
      JSON.stringify({ value: value.slice(0, kept + 1) }).length,
    ).toBeGreaterThan(2_000);
  });

  it("trims the largest nested array of an entity ($expand=Elements)", async () => {
    const Elements = Array.from({ length: 300 }, (_, i) => ({ Name: `e${i}` }));
    const { call } = setup(registerRestRead, () =>
      json({ Name: "H", Edges: [{ P: "a", C: "b" }], Elements }),
    );
    const out = await call({
      path: "Dimensions('D')/Hierarchies('H')?$expand=Elements,Edges",
      maxChars: 1_500,
    });
    expect(out).toMatchObject({
      truncated: true,
      truncatedAt: "Elements",
      total: 300,
    });
    expect(out.data).toMatchObject({ Name: "H", Edges: [{ P: "a", C: "b" }] });
  });

  it("falls back to a string cut when a single object is too big", async () => {
    const { call } = setup(registerRestRead, () =>
      json({ Name: "P", PrologProcedure: "y".repeat(3_000) }),
    );
    const out = await call({ path: "Processes('P')", maxChars: 1_000 });
    expect(out.truncated).toBe(true);
    expect(out.data).toBeUndefined();
    expect(JSON.stringify(out.text).length).toBeLessThanOrEqual(1_000);
    expect(out.totalChars).toBeGreaterThan(3_000);
  });

  it("POSTs only Processes('P')/tm1.Compile", async () => {
    const { call, sent } = setup(registerRestRead, () => json({ value: [] }));
    const out = await call({ path: "Processes('P')/tm1.Compile" });
    expect(sent.map((s) => [s.method, s.path])).toEqual([
      ["POST", "Processes('P')/tm1.Compile"],
    ]);
    expect(out).toEqual({ truncated: false, data: { value: [] } });
  });

  it.each([
    "Cubes('C')/tm1.Unload",
    "Processes('P')/tm1.ExecuteWithReturn",
    "Cellsets('x')",
    "$batch",
  ])("refuses %s without sending anything", async (path) => {
    const { call, sent } = setup(registerRestRead);
    await expect(call({ path })).rejects.toBeInstanceOf(TM1Error);
    expect(sent).toEqual([]);
  });

  it("works on a readonly connection", async () => {
    const { call } = setup(
      registerRestRead,
      () => json({ value: [] }),
      "readonly",
    );
    await expect(call({ path: "Cubes" })).resolves.toMatchObject({
      truncated: false,
    });
  });
});

describe("tm1_rest_write", () => {
  it("sends method, path, body and timeout, and returns the cleaned echo", async () => {
    const { call, sent } = setup(registerRestWrite, () =>
      json({ "@odata.context": "c", Name: "D" }),
    );
    const out = await call({
      method: "POST",
      path: "Dimensions",
      body: { Name: "D" },
      timeoutMs: 5_000,
    });
    expect(sent).toEqual([
      {
        method: "POST",
        path: "Dimensions",
        body: { Name: "D" },
        opts: { signal: undefined, timeoutMs: 5_000 },
      },
    ]);
    expect(out).toEqual({
      success: true,
      method: "POST",
      path: "Dimensions",
      truncated: false,
      data: { Name: "D" },
    });
  });

  it("returns a bare envelope for an empty (204) response", async () => {
    const { call } = setup(registerRestWrite);
    const out = await call({
      method: "PATCH",
      path: "Chores('X')",
      body: { Active: true },
    });
    expect(out).toEqual({
      success: true,
      method: "PATCH",
      path: "Chores('X')",
    });
  });

  it("DELETE needs confirm = the last key; a mismatch sends nothing", async () => {
    const { call, sent } = setup(registerRestWrite);
    const path = "Dimensions('D')/Hierarchies('H')/Elements('e1')";
    await expect(call({ method: "DELETE", path })).rejects.toMatchObject({
      code: TM1ErrorCode.VALIDATION_ERROR,
    });
    await expect(
      call({ method: "DELETE", path, confirm: "D" }),
    ).rejects.toMatchObject({
      code: TM1ErrorCode.VALIDATION_ERROR,
    });
    expect(sent).toEqual([]);
    await call({ method: "DELETE", path, confirm: "e1" });
    expect(sent.map((s) => s.method)).toEqual(["DELETE"]);
  });

  it("cancel needs confirm = the thread id", async () => {
    const { call, sent } = setup(registerRestWrite);
    const path = "Threads(42)/tm1.CancelOperation";
    await expect(
      call({ method: "POST", path, confirm: "41" }),
    ).rejects.toBeInstanceOf(TM1Error);
    await call({ method: "POST", path, confirm: "42" });
    expect(sent).toHaveLength(1);
  });

  it("refuses a kept tool's operation with its name in the hint", async () => {
    const { call, sent } = setup(registerRestWrite);
    await expect(
      call({
        method: "PATCH",
        path: "Processes('P')",
        body: { PrologProcedure: "" },
      }),
    ).rejects.toMatchObject({
      code: TM1ErrorCode.UNSUPPORTED_OPERATION,
      hint: expect.stringContaining("tm1_upsert_process"),
    });
    expect(sent).toEqual([]);
  });

  it("is refused on a readonly connection before anything is sent", async () => {
    const { call, sent } = setup(registerRestWrite, undefined, "readonly");
    await expect(
      call({ method: "POST", path: "Dimensions", body: { Name: "D" } }),
    ).rejects.toMatchObject({ code: TM1ErrorCode.PERMISSION_DENIED });
    expect(sent).toEqual([]);
  });

  it("turns a timeout into 'outcome unknown', not 'retry'", async () => {
    const { call } = setup(registerRestWrite, () => {
      throw new TM1Error({
        code: TM1ErrorCode.LOCK_TIMEOUT,
        message: "Request to x timed out",
      });
    });
    await expect(
      call({ method: "POST", path: "Cubes('C')/tm1.Unload" }),
    ).rejects.toMatchObject({
      hint: expect.stringContaining("outcome unknown"),
    });
  });

  it("masks secrets in the echo", async () => {
    const { call } = setup(registerRestWrite, () =>
      json({ Name: "u", Password: "hunter2" }),
    );
    const out = await call({
      method: "POST",
      path: "Users",
      body: { Name: "u", Password: "hunter2" },
    });
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });
});

describe("RestService", () => {
  it("prefixes /api/v1/, parses JSON, keeps text, maps empty", async () => {
    const { RestService } =
      await import("../../src/tm1-client/services/rest-service.js");
    const calls: unknown[][] = [];
    const bodies = ['{"value":[1]}', "plain log", "", "42"];
    const http = {
      requestRaw: async (...a: unknown[]) => (calls.push(a), bodies.shift()),
      request: async (...a: unknown[]) => (calls.push(a), undefined),
    };
    const rest = new RestService(http as never);
    await expect(rest.get("Cubes")).resolves.toEqual({
      kind: "json",
      json: { value: [1] },
    });
    await expect(rest.get("ErrorLogFiles('e')/Content")).resolves.toEqual({
      kind: "text",
      text: "plain log",
    });
    await expect(rest.get("Cubes")).resolves.toEqual({ kind: "empty" });
    await expect(rest.get("Cubes/$count")).resolves.toEqual({
      kind: "json",
      json: 42,
    });
    await expect(
      rest.send("DELETE", "Cubes('C')", undefined, { timeoutMs: 5 }),
    ).resolves.toEqual({ kind: "empty" });
    expect(calls[0]).toEqual(["GET", "/api/v1/Cubes", undefined]);
    expect(calls[4]).toEqual([
      "DELETE",
      "/api/v1/Cubes('C')",
      undefined,
      { timeoutMs: 5 },
    ]);
  });
});

describe("output schemas", () => {
  it("accept every shaped read payload", async () => {
    const { RestReadResultSchema } =
      await import("../../src/tools/rest/rest-read.js");
    const { call } = setup(registerRestRead, () =>
      json({
        value: Array.from({ length: 200 }, (_, i) => ({ Name: `n${i}` })),
      }),
    );
    const out = await call({ path: "Cubes", maxChars: 1_000 });
    expect(RestReadResultSchema.strict().parse(out)).toEqual(out);
  });
});

describe("budget is measured as shipped (escaped)", () => {
  it("cuts escape-heavy text so its JSON form fits maxChars", async () => {
    const { call } = setup(registerRestRead, () => ({
      kind: "text",
      text: '"\r\n'.repeat(5_000),
    }));
    const out = await call({
      path: "ErrorLogFiles('e.log')/Content",
      maxChars: 1_000,
    });
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out.text).length).toBeLessThanOrEqual(1_000);
    expect(JSON.stringify(out.text).length).toBeGreaterThan(990);
  });

  it("keeps the whole payload under the 80k response guard at the hard max", async () => {
    const { call } = setup(registerRestRead, () =>
      json({ Name: "P", PrologProcedure: '"\\n'.repeat(60_000) }),
    );
    const out = await call({ path: "Processes('P')", maxChars: 70_000 });
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThan(80_000);
  });
});

describe("tm1_rest_write: string body", () => {
  it("parses a stringified JSON body before sending", async () => {
    const { call, sent } = setup(registerRestWrite);
    await call({
      method: "PATCH",
      path: "Chores('X')",
      body: '{"Active":true}',
    });
    expect(sent[0].body).toEqual({ Active: true });
  });

  it("refuses a stringified body that sets Rules", async () => {
    const { call, sent } = setup(registerRestWrite);
    await expect(
      call({ method: "PATCH", path: "Cubes('C')", body: '{"Rules":"x"}' }),
    ).rejects.toMatchObject({
      hint: expect.stringContaining("tm1_set_cube_rules"),
    });
    expect(sent).toEqual([]);
  });
});

// Reading the secret property itself: TM1 answers `{ value: "<secret>" }`, or
// with /$value the bare secret as the whole body. No secret-named key.
describe("tm1_rest_read: secret property paths", () => {
  it.each<[string, RestBody]>([
    [
      "Processes('P')/DataSource/password",
      json({ "@odata.context": "x", value: "hunter2" }),
    ],
    [
      "Processes('P')/DataSource/password/$value",
      { kind: "text", text: "hunter2" },
    ],
    [
      "ActiveConfiguration/Access/LDAP/Password/$value",
      { kind: "text", text: "hunter2" },
    ],
    [
      "Configuration/Access/LDAP/Password",
      json({ "@odata.context": "x", value: "hunter2" }),
    ],
  ])("masks the bare secret: %s", async (path, body) => {
    const { call } = setup(registerRestRead, () => body);
    const out = await call({ path });
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(out.truncated).toBe(false);
    expect(out.data ?? out.text).toEqual(
      body.kind === "text" ? "***" : { value: "***" },
    );
  });

  it("refuses $entity?$id=<secret path> without sending", async () => {
    const { call, sent } = setup(registerRestRead, () =>
      json({ value: "hunter2" }),
    );
    await expect(
      call({ path: "$entity?$id=Processes('P')/DataSource/password" }),
    ).rejects.toMatchObject({ code: TM1ErrorCode.UNSUPPORTED_OPERATION });
    expect(sent).toEqual([]);
  });

  it("leaves a non-secret primitive alone", async () => {
    const { call } = setup(registerRestRead, () =>
      json({ "@odata.context": "x", value: "sa" }),
    );
    const out = await call({ path: "Processes('P')/DataSource/userName" });
    expect(out.data).toEqual({ value: "sa" });
  });
});
