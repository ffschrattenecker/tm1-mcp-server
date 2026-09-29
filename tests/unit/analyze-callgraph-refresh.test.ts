import { describe, it, expect, beforeEach } from "vitest";
import { z, type ZodRawShape } from "zod";
import type { TM1Client } from "../../src/tm1-client.js";
import {
  buildIndexFromTM1,
  getCallgraphCacheStats,
  invalidateCallgraphCache,
} from "../../src/lib/callgraph/tm1-adapter.js";
import { registerAnalyzeCallgraph } from "../../src/tools/analysis/analyze-callgraph.js";

// refresh:true replaces tm1_invalidate_callgraph_cache: it drops this
// connection's cached index and rebuilds it before answering.
function stubClient(connectionId: string) {
  let fetches = 0;
  const client = {
    connectionId,
    processes: {
      fetchForCallgraph: async () => {
        fetches++;
        return [];
      },
    },
    cubes: { getAllRules: async () => [] },
    chores: { list: async () => [] },
  } as unknown as TM1Client;
  return { client, fetches: () => fetches };
}

function register(client: TM1Client) {
  let h: ((a: unknown) => Promise<unknown>) | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  registerAnalyzeCallgraph(
    {
      tool: (_n: string, _d: string, s: ZodRawShape, cb: typeof h) => {
        parser = z.object(s);
        h = cb;
      },
    } as never,
    client,
  );
  return (args: Record<string, unknown>) =>
    (
      h!(parser!.parse(args)) as Promise<{ content: Array<{ text: string }> }>
    ).then((r) => ({
      // The server proxy turns the JSON text into structuredContent; the bare
      // handler only returns the text.
      structuredContent: JSON.parse(r.content[0].text) as Record<
        string,
        unknown
      >,
    }));
}

describe("tm1_analyze_callgraph refresh", () => {
  beforeEach(() => {
    invalidateCallgraphCache();
  });

  it("without refresh a second call is served from the cache", async () => {
    const { client, fetches } = stubClient("a");
    const call = register(client);
    await call({});
    await call({});
    expect(fetches()).toBe(1);
  });

  it("refresh:true rebuilds the index and republishes it", async () => {
    const { client, fetches } = stubClient("a");
    const call = register(client);
    await call({});
    const res = await call({ refresh: true });
    expect(fetches()).toBe(2);
    expect(res.structuredContent.mode).toBe("globalRanking");
    // The rebuilt index is cached for the next (non-refresh) caller.
    await call({});
    expect(fetches()).toBe(2);
    expect(getCallgraphCacheStats().map((e) => e.key)).toEqual(["a|inc=false"]);
  });

  it("refresh on one connection leaves another connection's cache alone", async () => {
    const a = stubClient("a");
    const b = stubClient("b");
    await buildIndexFromTM1(b.client);
    await register(a.client)({ refresh: true });
    expect(
      getCallgraphCacheStats()
        .map((e) => e.key)
        .sort(),
    ).toEqual(["a|inc=false", "b|inc=false"]);
    await buildIndexFromTM1(b.client);
    expect(b.fetches()).toBe(1);
  });
});
