// Zero-dependency field-weighted BM25F search index over compiled TM1 tools.
//
// Weights title > name > toolset > keywords > params > description so long
// descriptions never drown out the tool whose name/title/category matches the
// query, and applies a relative score cutoff (default 70% of top hit) instead
// of a fixed top-K dump.
import type { Tm1RequiresVersion } from "../annotations.js";
import { aliasesForToolset, type ToolsetName } from "../toolsets.js";

export interface ToolSearchDoc {
  name: string;
  title: string;
  toolset: ToolsetName;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  pinned: boolean;
  sandboxScoped: boolean;
  taskSupport?: "optional" | "required";
  requiresVersion?: Tm1RequiresVersion;
  keywords?: readonly string[];
  paramNames: readonly string[];
}

export interface ToolSearchMatch {
  doc: ToolSearchDoc;
  score: number;
}

export interface ToolSearchOptions {
  query?: string;
  toolset?: ToolsetName;
  access?: "all" | "read" | "write";
  minScoreRatio?: number;
  limit?: number;
}

export const DEFAULT_MIN_SCORE_RATIO = 0.7;
export const DEFAULT_SEARCH_LIMIT = 12;
export const DEFAULT_BROWSE_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 30;

const BM25_K1 = 1.2;
const SYNONYM_WEIGHT = 0.45;
const EXACT_NAME_BONUS = 50;

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "in",
  "to",
  "for",
  "on",
  "with",
  "and",
  "or",
  "by",
  "from",
  "is",
  "are",
  "be",
  "as",
  "at",
  "it",
  "its",
  "this",
  "that",
  "tm1",
  "via",
  "can",
  "does",
  "do",
  "use",
  "using",
  "how",
]);

const STEM_MAP: Record<string, string> = {
  axes: "axis",
  aliases: "alias",
  entries: "entry",
  hierarchies: "hierarchy",
  dependencies: "dependency",
  properties: "property",
  queries: "query",
  activities: "activity",
  sandboxes: "sandbox",
  processes: "process",
  indexes: "index",
  indices: "index",
  statuses: "status",
  overfeeding: "overfeed",
  writing: "write",
  reading: "read",
  running: "run",
  executing: "execute",
  deleting: "delete",
  creating: "create",
  updating: "update",
  searching: "search",
  checking: "check",
  tracing: "trace",
  comparing: "compare",
  diffing: "diff",
  auditing: "audit",
  reordering: "reorder",
  clearing: "clear",
  saving: "save",
  listing: "list",
  sampling: "sample",
  importing: "import",
  exporting: "export",
  validating: "validate",
  compiling: "compile",
  inspecting: "inspect",
  diagnosing: "diagnose",
  logging: "log",
  locking: "lock",
  blocking: "lock",
  waiting: "wait",
  waiters: "wait",
  threads: "thread",
  jobs: "job",
  sessions: "session",
  feeders: "feeder",
  rules: "rule",
  cubes: "cube",
  dimensions: "dimension",
  elements: "element",
  attributes: "attribute",
  cells: "cell",
  views: "view",
  chores: "chore",
  files: "file",
  logs: "log",
  errors: "error",
  connections: "connection",
  stats: "stat",
  statistics: "stat",
  calculations: "calculation",
  permissions: "permission",
  rights: "right",
  groups: "group",
  users: "user",
  clients: "client",
  tuples: "tuple",
  members: "member",
  subsets: "subset",
  refs: "ref",
  references: "ref",
};

/**
 * Deterministic light stemmer for TM1 domain tokens.
 */
export function stemToken(token: string): string {
  const mapped = STEM_MAP[token];
  if (mapped !== undefined) return mapped;
  if (token.length <= 4) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (
    token.endsWith("ches") ||
    token.endsWith("shes") ||
    token.endsWith("xes") ||
    token.endsWith("zes") ||
    token.endsWith("sses")
  ) {
    return token.slice(0, -2);
  }
  if (
    token.endsWith("s") &&
    !token.endsWith("ss") &&
    !token.endsWith("us") &&
    !token.endsWith("is") &&
    !token.endsWith("as") &&
    !token.endsWith("os")
  ) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Tokenize text into normalized, stemmed search terms, splitting camelCase
 * boundaries and filtering stop words while preserving `"all"` and `"v11"`/`"v12"`.
 */
export function tokenize(text: string): string[] {
  const splitCamel = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const raw = splitCamel.toLowerCase().split(/[^a-z0-9]+/);
  const out: string[] = [];
  for (const part of raw) {
    if (part.length < 2 || STOP_WORDS.has(part)) continue;
    out.push(stemToken(part));
  }
  return out;
}

// Curated query-time TM1 jargon expansion. Keys are stemmed tokens; values are
// expanded into stemmed tokens at SYNONYM_WEIGHT (< 1) so direct hits always win.
const TM1_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  ti: ["turbointegrator", "process"],
  turbointegrator: ["ti", "process"],
  proc: ["process"],
  dim: ["dimension"],
  elem: ["element"],
  member: ["element"],
  attr: ["attribute"],
  alias: ["attribute", "element"],
  chore: ["schedule"],
  schedule: ["chore"],
  skipcheck: ["feeder", "rule"],
  overfeed: ["feeder", "audit"],
  cellput: ["write", "cell"],
  cellputn: ["write", "cell"],
  cellputs: ["write", "cell"],
  cellget: ["mdx", "cell"],
  cellgetn: ["mdx", "cell"],
  cellgets: ["mdx", "cell"],
  zeroout: ["clear", "cube"],
  wipe: ["clear"],
  truncate: ["clear"],
  savedataall: ["save", "data"],
  cubesavedata: ["save", "data"],
  persist: ["save", "data"],
  pae: ["v12"],
  saas: ["v12"],
  migration: ["v12", "readiness"],
  deprecated: ["v12", "readiness"],
  lock: ["activity", "thread", "contention"],
  contention: ["activity", "lock"],
  thread: ["activity"],
  job: ["activity"],
  session: ["activity"],
  permission: ["security"],
  right: ["security"],
  acl: ["security"],
  user: ["security"],
  group: ["security"],
  odata: ["rest"],
  endpoint: ["rest"],
  raw: ["rest"],
  lineage: ["callgraph", "flow", "usage"],
  impact: ["usage", "callgraph", "flow"],
  dependency: ["callgraph", "usage"],
  downstream: ["callgraph", "chore"],
  upstream: ["flow", "usage"],
  dataflow: ["flow", "data"],
  whatif: ["sandbox"],
  txlog: ["log", "transaction"],
  txn: ["log", "transaction"],
  transaction: ["log", "query"],
  msglog: ["log", "message"],
  message: ["log", "query"],
  compile: ["check"],
  syntax: ["check"],
  validate: ["check"],
  lint: ["check", "audit"],
  deploy: ["upsert", "import", "install"],
  compare: ["diff"],
  drift: ["compare", "diff"],
  pro: ["import", "export", "process"],
  git: ["import", "export", "process"],
  memory: ["stat", "reorder"],
  storage: ["reorder", "order", "dimension"],
  optimize: ["reorder", "audit"],
  health: ["state", "server"],
  status: ["state", "activity"],
  consolidation: ["element", "hierarchy", "calculation"],
  leaf: ["element", "writable"],
  picklist: ["mdx", "view", "cell"],
  tuple: ["mdx", "set"],
  subset: ["mdx", "set", "element"],
  asciioutput: ["server", "file"],
  blob: ["file"],
  application: ["file"],
  error: ["diagnose", "error", "log"],
  failed: ["diagnose", "error", "log"],
  crash: ["diagnose", "error", "log"],
};

interface FieldConfig {
  weight: number;
  b: number;
}

const FIELDS = [
  "title",
  "name",
  "toolset",
  "keywords",
  "params",
  "description",
] as const;
type FieldName = (typeof FIELDS)[number];

const FIELD_CONFIG: Readonly<Record<FieldName, FieldConfig>> = {
  title: { weight: 4.0, b: 0.4 },
  name: { weight: 3.5, b: 0.4 },
  toolset: { weight: 2.5, b: 0.3 },
  keywords: { weight: 2.0, b: 0.3 },
  params: { weight: 1.2, b: 0.5 },
  description: { weight: 1.0, b: 0.75 },
};

interface IndexedDoc {
  doc: ToolSearchDoc;
  fields: Record<FieldName, Map<string, number>>;
  lengths: Record<FieldName, number>;
  allTerms: Set<string>;
}

function termFreqs(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

function expandQueryTerms(queryTokens: readonly string[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const token of queryTokens) {
    weights.set(token, 1.0);
  }
  for (const token of queryTokens) {
    const synonyms = TM1_SYNONYMS[token];
    if (!synonyms) continue;
    for (const syn of synonyms) {
      const stemmed = stemToken(syn);
      if (!weights.has(stemmed)) {
        weights.set(stemmed, SYNONYM_WEIGHT);
      }
    }
  }
  return weights;
}

const ABBREVIATIONS = /(?:e\.g|i\.e|etc|vs|incl|excl|approx|fig|no|ref)$/i;

/**
 * Extract a concise first-sentence summary from a tool description without
 * splitting on abbreviations or chopping mid-word.
 */
export function summarizeDescription(desc: string, maxLen = 160): string {
  const clean = desc.replace(/\s+/g, " ").trim();
  let depth = 0;
  let sentenceEnd = -1;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "(") {
      depth++;
    } else if (ch === ")" && depth > 0) {
      depth--;
    } else if (ch === "." && depth === 0) {
      const next = clean[i + 1];
      const atEnd = next === undefined;
      const followedBySpace = next === " ";
      if (!atEnd && !followedBySpace) continue;
      const before = clean.slice(0, i);
      if (/\d$/.test(before) && /^\d/.test(next ?? "")) continue;
      if (ABBREVIATIONS.test(before)) continue;
      const prevChar = clean[i - 1] ?? "";
      if (prevChar === " " || prevChar === ".") continue;
      sentenceEnd = i;
      break;
    }
  }
  const sentence = sentenceEnd === -1 ? clean : clean.slice(0, sentenceEnd);
  if (sentence.length <= maxLen) return sentence;
  const budget = maxLen - 1;
  const lastSpace = sentence.lastIndexOf(" ", budget);
  const cut = lastSpace > Math.floor(maxLen * 0.4) ? lastSpace : budget;
  return `${sentence.slice(0, cut).replace(/[\s,;:\-—(]+$/, "")}…`;
}

/**
 * Field-weighted BM25F index over the compiled tool surface.
 */
export class ToolSearchIndex {
  private readonly indexed: IndexedDoc[] = [];
  private readonly avgLengths: Record<FieldName, number>;
  private readonly df = new Map<string, number>();

  constructor(docs: readonly ToolSearchDoc[]) {
    const totals: Record<FieldName, number> = {
      title: 0,
      name: 0,
      toolset: 0,
      keywords: 0,
      params: 0,
      description: 0,
    };

    for (const doc of docs) {
      const nameTokens = tokenize(doc.name.replace(/^tm1_/, ""));
      const exactName = doc.name.toLowerCase();
      if (!nameTokens.includes(exactName)) {
        nameTokens.push(exactName);
      }

      const toolsetTokens = tokenize(
        [doc.toolset, ...aliasesForToolset(doc.toolset)].join(" "),
      );
      const titleTokens = tokenize(doc.title);
      const keywordTokens = tokenize((doc.keywords ?? []).join(" "));
      const paramTokens = tokenize(doc.paramNames.join(" "));
      const descTokens = tokenize(doc.description);

      const tokenLists: Record<FieldName, string[]> = {
        title: titleTokens,
        name: nameTokens,
        toolset: toolsetTokens,
        keywords: keywordTokens,
        params: paramTokens,
        description: descTokens,
      };

      const fields = {} as Record<FieldName, Map<string, number>>;
      const lengths = {} as Record<FieldName, number>;
      const allTerms = new Set<string>();

      for (const field of FIELDS) {
        const list = tokenLists[field];
        fields[field] = termFreqs(list);
        lengths[field] = list.length;
        totals[field] += list.length;
        for (const term of fields[field].keys()) {
          allTerms.add(term);
        }
      }

      for (const term of allTerms) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }

      this.indexed.push({ doc, fields, lengths, allTerms });
    }

    const n = Math.max(docs.length, 1);
    this.avgLengths = {
      title: Math.max(totals.title / n, 1),
      name: Math.max(totals.name / n, 1),
      toolset: Math.max(totals.toolset / n, 1),
      keywords: Math.max(totals.keywords / n, 1),
      params: Math.max(totals.params / n, 1),
      description: Math.max(totals.description / n, 1),
    };
  }

  get size(): number {
    return this.indexed.length;
  }

  toolsetCounts(): Array<{ toolset: ToolsetName; count: number }> {
    const counts = new Map<ToolsetName, number>();
    for (const { doc } of this.indexed) {
      counts.set(doc.toolset, (counts.get(doc.toolset) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([toolset, count]) => ({ toolset, count }));
  }

  search(opts: ToolSearchOptions = {}): ToolSearchMatch[] {
    const access = opts.access ?? "all";
    const matchesFilter = (doc: ToolSearchDoc): boolean => {
      if (opts.toolset !== undefined && doc.toolset !== opts.toolset) {
        return false;
      }
      if (access === "read" && !doc.readOnly) return false;
      if (access === "write" && doc.readOnly) return false;
      return true;
    };

    const trimmedQuery = opts.query?.trim() ?? "";
    if (trimmedQuery === "") {
      if (opts.toolset === undefined && access === "all") {
        return [];
      }
      const cap = Math.min(
        Math.max(opts.limit ?? DEFAULT_BROWSE_LIMIT, 1),
        MAX_SEARCH_LIMIT,
      );
      return this.indexed
        .filter(({ doc }) => matchesFilter(doc))
        .map(({ doc }) => ({ doc, score: 0 }))
        .sort((a, b) => a.doc.name.localeCompare(b.doc.name))
        .slice(0, cap);
    }

    const queryTokens = tokenize(trimmedQuery);
    const exactQuery = trimmedQuery.toLowerCase();
    const expandedTerms = expandQueryTerms(queryTokens);
    const n = this.indexed.length;

    const scored: ToolSearchMatch[] = [];
    for (const item of this.indexed) {
      if (!matchesFilter(item.doc)) continue;

      let score = 0;
      const shortName = item.doc.name.replace(/^tm1_/, "").toLowerCase();
      if (
        exactQuery === item.doc.name.toLowerCase() ||
        exactQuery === shortName
      ) {
        score += EXACT_NAME_BONUS;
      }

      for (const [term, queryWeight] of expandedTerms) {
        const df = this.df.get(term) ?? 0;
        if (df === 0) continue;

        let pseudoTf = 0;
        for (const field of FIELDS) {
          const tf = item.fields[field].get(term) ?? 0;
          if (tf === 0) continue;
          const { weight, b } = FIELD_CONFIG[field];
          const avgLen = this.avgLengths[field];
          const lenNorm = 1 - b + b * (item.lengths[field] / avgLen);
          pseudoTf += (weight * tf) / Math.max(lenNorm, 0.1);
        }
        if (pseudoTf === 0) continue;

        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const bm25 = (pseudoTf * (BM25_K1 + 1)) / (pseudoTf + BM25_K1);
        score += queryWeight * idf * bm25;
      }

      if (score > 0) {
        scored.push({ doc: item.doc, score });
      }
    }

    if (scored.length === 0) return [];

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.doc.pinned !== b.doc.pinned) return a.doc.pinned ? -1 : 1;
      return a.doc.name.localeCompare(b.doc.name);
    });

    const topScore = scored[0]!.score;
    const minRatio = opts.minScoreRatio ?? DEFAULT_MIN_SCORE_RATIO;
    const cutoff = topScore * minRatio;
    const cap = Math.min(
      Math.max(opts.limit ?? DEFAULT_SEARCH_LIMIT, 1),
      MAX_SEARCH_LIMIT,
    );

    return scored.filter((m) => m.score >= cutoff).slice(0, cap);
  }
}
