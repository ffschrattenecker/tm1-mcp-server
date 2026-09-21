// tm1_clear_cube dropped `dimensions`/`tuples` in 4.0.0. A stored call that
// still carries them meant "clear this region" — and the server never had a
// region clear, so v4.0.0 refused it. Once the fields left the schema the SDK
// began stripping them, which turned exactly that call into a silent full wipe.
// These tests pin the refusal, parsing through the registered schema so the
// handler sees what the SDK would actually hand it.
import { describe, it, expect, vi } from "vitest";
import { z, type ZodRawShape } from "zod";
import { registerClearCube } from "../../src/tools/model-building/clear-cube.js";
import type { TM1Client } from "../../src/tm1-client.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function handlerFor(client: TM1Client): ToolHandler {
  let captured: ToolHandler | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  const server = {
    tool: (
      _name: string,
      _desc: string,
      schema: ZodRawShape,
      handler: ToolHandler,
    ) => {
      parser = z.object(schema);
      captured = handler;
    },
  };
  registerClearCube(
    server as unknown as Parameters<typeof registerClearCube>[0],
    client,
  );
  // Read back through explicit types: TS narrows the closure variables to
  // `never` because it cannot see that register* called `tool` synchronously.
  const h = captured as ToolHandler | null;
  const p = parser as z.ZodObject<ZodRawShape> | null;
  if (!h || !p) throw new Error("handler not registered");
  return (args) => h(p.parse(args));
}

function makeClient() {
  const clear = vi.fn(async () => undefined);
  return { clear, client: { cubes: { clear } } as unknown as TM1Client };
}

describe("tm1_clear_cube legacy arguments", () => {
  it("refuses a call carrying the removed region arguments", async () => {
    const { client, clear } = makeClient();
    await expect(
      handlerFor(client)({
        cubeName: "Sales",
        confirm: "Sales",
        dimensions: ["Region", "Month"],
        tuples: [["Berlin"], ["Jan"]],
      }),
    ).rejects.toThrow(/no longer takes `dimensions`\/`tuples`/);
    expect(clear).not.toHaveBeenCalled();
  });

  it("refuses even an empty legacy array", async () => {
    const { client, clear } = makeClient();
    await expect(
      handlerFor(client)({
        cubeName: "Sales",
        confirm: "Sales",
        dimensions: [],
      }),
    ).rejects.toThrow(/NOT executed/);
    expect(clear).not.toHaveBeenCalled();
  });

  it("still clears the whole cube for the current two-argument call", async () => {
    const { client, clear } = makeClient();
    await handlerFor(client)({ cubeName: "Sales", confirm: "Sales" });
    expect(clear).toHaveBeenCalledWith("Sales");
  });
});
