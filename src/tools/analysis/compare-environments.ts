import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { fingerprint } from "../../lib/fingerprint.js";
import { mapSettledWithConcurrency } from "../../lib/concurrency.js";
import { compileUserRegex } from "../../lib/safe-regex.js";
import { tm1NameKey } from "../../lib/tm1-name.js";
import { CompareEnvironmentsResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";

const OBJECT_TYPES = ["cubes", "dimensions", "processes", "chores"] as const;
type ObjectType = (typeof OBJECT_TYPES)[number];

// Hierarchy reads in deep mode, per side.
const DEEP_CONCURRENCY = 4;

/**
 * One object as the compare sees it: the name as the server spells it, and
 * per aspect a fingerprint. Two objects differ in every aspect whose
 * fingerprints differ.
 */
interface Entry {
  name: string;
  aspects: Record<string, string>;
}

interface ReadOpts {
  includeControl: boolean;
  deep: boolean;
  /**
   * Name filter. The handler also applies it to every reader's result; a
   * reader that fetches per object (deep dimensions) must apply it before the
   * fan-out, or a narrow compare still reads the whole model.
   */
  regex: RegExp | undefined;
}

const DRILL_DOWN: Record<ObjectType, string | undefined> = {
  cubes: "tm1_diff_cube_rules",
  dimensions: "tm1_diff_hierarchy",
  processes: "tm1_diff_processes",
  chores: undefined,
};

async function readCubes(c: TM1Client, o: ReadOpts): Promise<Entry[]> {
  const cubes = await c.cubes.getAllRules({
    includeControl: o.includeControl,
    withDimensions: true,
  });
  return cubes.map((cube) => ({
    name: cube.cubeName,
    aspects: {
      dimensions: (cube.dimensions ?? []).map(tm1NameKey).join("\u0000"),
      rules: fingerprint(cube.rulesText),
    },
  }));
}

async function readProcesses(c: TM1Client, o: ReadOpts): Promise<Entry[]> {
  // Datasource: type and source object only (listDataSources never selects
  // credentials or the ODBC query), so a changed query is not detected here.
  const [processes, sources] = await Promise.all([
    c.processes.fetchForCallgraph(o.includeControl),
    c.processes.listDataSources(o.includeControl),
  ]);
  const sourceOf = new Map(
    sources.map((d) => [
      tm1NameKey(d.name),
      [d.type, d.sourceName ?? "", d.view ?? "", d.subset ?? ""].join("|"),
    ]),
  );
  return processes.map((p) => ({
    name: p.name,
    aspects: {
      dataSource: sourceOf.get(tm1NameKey(p.name)) ?? "",
      code: fingerprint(p.prolog, p.metadata, p.data, p.epilog),
      parameters: fingerprint(
        ...p.parameters.map((n) => `${n}=${p.parameterDefaults.get(n) ?? ""}`),
      ),
    },
  }));
}

async function readChores(c: TM1Client, o: ReadOpts): Promise<Entry[]> {
  const chores = await c.chores.list();
  return chores
    .filter((ch) => o.includeControl || !ch.name.startsWith("}"))
    .map((ch) => ({
      name: ch.name,
      aspects: {
        active: String(ch.active),
        schedule: `${ch.startTime}|${ch.frequency}`,
        steps: fingerprint(JSON.stringify(ch.processes)),
      },
    }));
}

async function readDimensions(c: TM1Client, o: ReadOpts): Promise<Entry[]> {
  const dims = (await c.dimensions.list({ includeElementCount: true })).filter(
    (d) =>
      (o.includeControl || !d.name.startsWith("}")) &&
      (!o.regex || o.regex.test(d.name)),
  );
  const entries: Entry[] = dims.map((d) => ({
    name: d.name,
    aspects: {
      hierarchies: d.hierarchies.map(tm1NameKey).sort().join("\u0000"),
      elementCount: String(
        Object.values(d.elementCounts ?? {}).reduce((x, y) => x + y, 0),
      ),
    },
  }));
  if (!o.deep) return entries;
  const structures = await mapSettledWithConcurrency(
    dims,
    DEEP_CONCURRENCY,
    async (d) => {
      const parts: string[] = [];
      for (const h of [...d.hierarchies].sort()) {
        const s = await c.hierarchies.getStructure(d.name, h);
        parts.push(
          tm1NameKey(h),
          ...s.elements.map((e) => `${tm1NameKey(e.name)}:${e.type}`).sort(),
          ...s.edges
            .map(
              (e) =>
                `${tm1NameKey(e.parent)}>${tm1NameKey(e.child)}:${e.weight}`,
            )
            .sort(),
        );
      }
      return fingerprint(...parts);
    },
  );
  structures.forEach((r, i) => {
    // A hierarchy that cannot be read is reported as its own aspect rather
    // than failing the whole compare.
    entries[i]!.aspects.structure =
      r.status === "fulfilled" ? r.value : "unreadable";
  });
  return entries;
}

const READERS: Record<
  ObjectType,
  (c: TM1Client, o: ReadOpts) => Promise<Entry[]>
> = {
  cubes: readCubes,
  dimensions: readDimensions,
  processes: readProcesses,
  chores: readChores,
};

function compare(a: Entry[], b: Entry[], limit: number) {
  const mapB = new Map(b.map((e) => [tm1NameKey(e.name), e]));
  const keysA = new Set(a.map((e) => tm1NameKey(e.name)));
  const onlyInA: string[] = [];
  const differs: Array<{ name: string; aspects: string[] }> = [];
  let identical = 0;
  for (const ea of a) {
    const eb = mapB.get(tm1NameKey(ea.name));
    if (!eb) {
      onlyInA.push(ea.name);
      continue;
    }
    const aspects = Object.keys(ea.aspects).filter(
      (k) => ea.aspects[k] !== eb.aspects[k],
    );
    if (aspects.length === 0) identical++;
    else differs.push({ name: ea.name, aspects });
  }
  const onlyInB = b
    .filter((e) => !keysA.has(tm1NameKey(e.name)))
    .map((e) => e.name);
  const sort = (x: string, y: string) => x.localeCompare(y);
  onlyInA.sort(sort);
  onlyInB.sort(sort);
  differs.sort((x, y) => sort(x.name, y.name));
  const truncated =
    onlyInA.length > limit || onlyInB.length > limit || differs.length > limit;
  return {
    countA: a.length,
    countB: b.length,
    identical,
    counts: {
      onlyInA: onlyInA.length,
      onlyInB: onlyInB.length,
      differs: differs.length,
    },
    onlyInA: onlyInA.slice(0, limit),
    onlyInB: onlyInB.slice(0, limit),
    differs: differs.slice(0, limit),
    ...(truncated ? { truncated: true } : {}),
  };
}

export const registerCompareEnvironments = defineTool({
  name: "tm1_compare_environments",
  description: [
    "Drift overview of connection vs connectionB (e.g. PROD vs DEV): per object type, objects on one side only and objects that differ, with the differing aspects. Drill in with the tool named in drillDown.",
  ],
  annotations: READ_ONLY,
  peer: true,
  output: CompareEnvironmentsResultSchema,
  input: {
    objectTypes: z
      .array(z.enum(OBJECT_TYPES))
      .optional()
      .describe("Object types to compare (default: all)."),
    nameRegex: z
      .string()
      .optional()
      .describe("Only objects whose name matches (case-insensitive)."),
    includeControl: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include '}' control objects (default false)."),
    deep: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Also fingerprint every hierarchy's elements and edges (slow on large models).",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .default(100)
      .describe("Most names per list (default 100); counts stay exact."),
  },
  handler: async (
    { objectTypes, nameRegex, includeControl, deep, limit },
    { a, b },
  ) => {
    const types: readonly ObjectType[] =
      objectTypes && objectTypes.length > 0 ? objectTypes : OBJECT_TYPES;
    const regex =
      nameRegex === undefined
        ? undefined
        : compileUserRegex(nameRegex, "i", "nameRegex");
    const keep = (entries: Entry[]) =>
      regex ? entries.filter((e) => regex.test(e.name)) : entries;
    const opts = { includeControl, deep, regex };

    const results: Record<string, unknown> = {};
    let identical = true;
    for (const type of types) {
      const [ea, eb] = await Promise.all([
        READERS[type](a.client, opts),
        READERS[type](b.client, opts),
      ]);
      const r = compare(keep(ea), keep(eb), limit);
      if (r.counts.onlyInA + r.counts.onlyInB + r.counts.differs > 0)
        identical = false;
      const drillDown = DRILL_DOWN[type];
      results[type] = { ...r, ...(drillDown ? { drillDown } : {}) };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              connectionA: a.name,
              connectionB: b.name,
              identical,
              ...results,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
});
