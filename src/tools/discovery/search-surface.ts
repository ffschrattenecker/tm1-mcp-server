// Opt-in search-mode projection over CompiledToolSurface.
//
// Exposes a small pinned set of top-level tools (including taskSupport tools so
// clients can negotiate io.modelcontextprotocol/tasks) plus meta-tools:
//   - tm1_search_tools    (field-weighted BM25F + 70% relative score cutoff)
//   - tm1_describe_tool   (returns full inputSchema / optional outputSchema)
//   - tm1_call_read_tool  (readOnlyHint=true  — dispatches READ_ONLY tools)
//   - tm1_call_write_tool (destructiveHint=true — dispatches mutating tools;
//                          omitted completely when no write tools are registered)
import type pino from "pino";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import type {
  CallToolResult,
  McpServer,
  ServerContext,
  Tool,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import {
  slimJsonSchema,
  withSlimJsonSchema,
} from "../../lib/slim-json-schema.js";
import {
  runWithTraceContext,
  type TraceContext,
} from "../../lib/trace-context.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { DESTRUCTIVE, READ_ONLY } from "../annotations.js";
import { formatTm1ErrorResult, type McpToolResult } from "../error-format.js";
import { TOOLSET_NAMES, type ToolsetName } from "../toolsets.js";
import {
  postProcessToolResult,
  strictInputSchema,
  type PreparedToolRegistration,
} from "../with-annotations.js";
import {
  DEFAULT_BROWSE_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  ToolSearchIndex,
  summarizeDescription,
  type ToolSearchDoc,
} from "./search-index.js";

export const PINNED_BASE_TOOLS: ReadonlySet<string> = new Set([
  "tm1_list_connections",
  "tm1_rest_read",
  "tm1_execute_mdx",
]);

export interface BaseCompiledTool {
  prepared: PreparedToolRegistration;
  toolDef: Tool;
  toolset: ToolsetName;
}

export interface CompiledMetaTool {
  toolDef: Tool;
  strictInput: ZodTypeAny;
  outputSchemaJson?: Record<string, unknown>;
  invoke: (
    args: Record<string, unknown>,
    ctx: ServerContext,
    lowLevel: McpServer["server"],
    trace: TraceContext | undefined,
  ) => Promise<CallToolResult>;
}

export interface SearchSurfaceProjection {
  pinnedNames: ReadonlySet<string>;
  hasWriteTools: boolean;
  exposedTools: Tool[];
  metaTools: ReadonlyMap<string, CompiledMetaTool>;
  index: ToolSearchIndex;
}

const SEARCH_META_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

const SEARCH_INPUT_SHAPE: ZodRawShape = {
  query: z
    .string()
    .optional()
    .describe(
      "Natural-language task or TM1 term (e.g. 'clear cube', 'TurboIntegrator code', 'lock contention'). Omit with toolset/access to browse.",
    ),
  toolset: z
    .enum(TOOLSET_NAMES)
    .optional()
    .describe("Optional category filter."),
  access: z
    .enum(["all", "read", "write"])
    .optional()
    .default("all")
    .describe("Filter by read-only vs mutating tools."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .optional()
    .describe(
      `Maximum matches to return (default ${DEFAULT_SEARCH_LIMIT} for search, ${DEFAULT_BROWSE_LIMIT} for browse, max ${MAX_SEARCH_LIMIT}).`,
    ),
};

const SEARCH_OUTPUT_SCHEMA = z.object({
  query: z.string().optional(),
  mode: z.enum(["search", "browse", "overview"]),
  totalIndexed: z.number().int(),
  returned: z.number().int(),
  matches: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      toolset: z.string(),
      summary: z.string(),
      readOnly: z.boolean(),
      destructive: z.boolean(),
      pinned: z.boolean(),
      callVia: z.enum(["direct", "tm1_call_read_tool", "tm1_call_write_tool"]),
      score: z.number().optional(),
      requiresVersion: z.string().optional(),
    }),
  ),
  availableToolsets: z
    .array(
      z.object({
        toolset: z.string(),
        count: z.number().int(),
      }),
    )
    .optional(),
  hint: z.string().optional(),
});

const DESCRIBE_INPUT_SHAPE: ZodRawShape = {
  toolName: z
    .string()
    .min(1)
    .describe("Exact TM1 tool name (e.g. 'tm1_get_cube_rules')."),
  includeOutputSchema: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include the tool's outputSchema JSON when true."),
};

const DESCRIBE_OUTPUT_SCHEMA = z.object({
  name: z.string(),
  title: z.string(),
  toolset: z.string(),
  description: z.string(),
  annotations: z.record(z.string(), z.unknown()),
  pinned: z.boolean(),
  callVia: z.enum(["direct", "tm1_call_read_tool", "tm1_call_write_tool"]),
  taskSupport: z.enum(["optional", "required"]).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

const CALL_TOOL_INPUT_SHAPE: ZodRawShape = {
  toolName: z
    .string()
    .min(1)
    .describe("Exact TM1 tool name returned by tm1_search_tools."),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .default({})
    .describe("Tool arguments matching tm1_describe_tool inputSchema."),
};

function buildOutputSchemaJson(schema: ZodTypeAny): Record<string, unknown> {
  const slim = withSlimJsonSchema(schema);
  return slimJsonSchema(
    slim["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    }),
  ) as Record<string, unknown>;
}

function buildInputSchemaJson(strictInput: ZodTypeAny): Tool["inputSchema"] {
  const slim = withSlimJsonSchema(strictInput);
  return slim["~standard"].jsonSchema.input({
    target: "draft-2020-12",
  }) as Tool["inputSchema"];
}

function callViaFor(
  pinned: boolean,
  readOnly: boolean,
): "direct" | "tm1_call_read_tool" | "tm1_call_write_tool" {
  if (pinned) return "direct";
  return readOnly ? "tm1_call_read_tool" : "tm1_call_write_tool";
}

function isPinnedTool(
  name: string,
  prepared: PreparedToolRegistration,
): boolean {
  return PINNED_BASE_TOOLS.has(name) || prepared.taskSupport !== undefined;
}

/**
 * Build the search-mode projection on top of the compiled base tools.
 */
export function buildSearchSurfaceProjection(opts: {
  mode: "readwrite" | "sandbox" | "readonly";
  toolsByName: ReadonlyMap<string, BaseCompiledTool>;
  responseMode: "legacy" | "structured";
  maxResponseChars: number;
  logger: pino.Logger;
}): SearchSurfaceProjection {
  const pinnedNames = new Set<string>();
  const pinnedTools: Tool[] = [];
  const docs: ToolSearchDoc[] = [];
  let hasWriteTools = false;

  for (const [name, entry] of opts.toolsByName) {
    const { prepared, toolDef, toolset } = entry;
    const pinned = isPinnedTool(name, prepared);
    if (pinned) {
      pinnedNames.add(name);
      pinnedTools.push(toolDef);
    }
    const readOnly = prepared.annotations.readOnlyHint === true;
    const destructive = prepared.annotations.destructiveHint === true;
    if (!readOnly) hasWriteTools = true;

    const props = (
      toolDef.inputSchema as { properties?: Record<string, unknown> }
    ).properties;
    const paramNames = props ? Object.keys(props) : [];
    const requiresVersion = (
      prepared.annotations as {
        requiresVersion?: ToolSearchDoc["requiresVersion"];
      }
    ).requiresVersion;

    docs.push({
      name: prepared.name,
      title: prepared.title,
      toolset,
      description: prepared.description,
      readOnly,
      destructive,
      pinned,
      sandboxScoped: false,
      ...(prepared.taskSupport !== undefined
        ? { taskSupport: prepared.taskSupport }
        : {}),
      ...(requiresVersion !== undefined ? { requiresVersion } : {}),
      ...(prepared.keywords !== undefined
        ? { keywords: prepared.keywords }
        : {}),
      paramNames,
    });
  }

  const index = new ToolSearchIndex(docs);
  const metaTools = new Map<string, CompiledMetaTool>();

  // 1. tm1_search_tools
  {
    const strictInput = strictInputSchema(SEARCH_INPUT_SHAPE);
    const outputSchemaJson = buildOutputSchemaJson(SEARCH_OUTPUT_SCHEMA);
    const toolDef: Tool = {
      name: "tm1_search_tools",
      title: "Search Tools",
      description:
        "Search all enabled TM1 tools by task, TM1 term, toolset, or read/write access. Returns top matches with callVia routing.",
      inputSchema: buildInputSchemaJson(strictInput),
      annotations: SEARCH_META_ANNOTATIONS,
      outputSchema: outputSchemaJson,
    };

    metaTools.set("tm1_search_tools", {
      toolDef,
      strictInput,
      outputSchemaJson,
      invoke: (args, _ctx, lowLevel) => {
        const query =
          typeof args.query === "string" ? args.query.trim() : undefined;
        const toolset = args.toolset as ToolsetName | undefined;
        const access =
          (args.access as "all" | "read" | "write" | undefined) ?? "all";
        const limit = args.limit as number | undefined;

        const hasQuery = Boolean(query);
        const hasFilter = toolset !== undefined || access !== "all";
        const searchMode = hasQuery
          ? "search"
          : hasFilter
            ? "browse"
            : "overview";

        const rawMatches = index.search({
          ...(query !== undefined ? { query } : {}),
          ...(toolset !== undefined ? { toolset } : {}),
          access,
          ...(limit !== undefined ? { limit } : {}),
        });

        const matches = rawMatches.map(({ doc, score }) => ({
          name: doc.name,
          title: doc.title,
          toolset: doc.toolset,
          summary: summarizeDescription(doc.description, 160),
          readOnly: doc.readOnly,
          destructive: doc.destructive,
          pinned: doc.pinned,
          callVia: callViaFor(doc.pinned, doc.readOnly),
          ...(hasQuery ? { score: Number(score.toFixed(3)) } : {}),
          ...(doc.requiresVersion !== undefined
            ? { requiresVersion: doc.requiresVersion }
            : {}),
        }));

        const payload: Record<string, unknown> = {
          ...(hasQuery ? { query } : {}),
          mode: searchMode,
          totalIndexed: index.size,
          returned: matches.length,
          matches,
        };

        if (searchMode === "overview" || matches.length === 0) {
          payload.availableToolsets = index.toolsetCounts();
          payload.hint =
            searchMode === "overview"
              ? "Pass `query` (e.g. 'cube rules', 'TurboIntegrator', 'security') or filter by `toolset` / `access`."
              : "No matching tools found. Try broader TM1 terms, omit filters, or browse one of availableToolsets.";
        }

        const rawResult: McpToolResult = {
          content: [{ type: "text", text: JSON.stringify(payload) }],
        };
        const processed = postProcessToolResult("tm1_search_tools", rawResult, {
          outputSchema: SEARCH_OUTPUT_SCHEMA,
          responseMode: opts.responseMode,
          maxResponseChars: opts.maxResponseChars,
          sizeHint: "Narrow with toolset, access, or a smaller limit.",
          logger: opts.logger,
        });
        return Promise.resolve(
          lowLevel.projectCallToolResult(
            processed as CallToolResult,
            outputSchemaJson,
          ),
        );
      },
    });
  }

  // 2. tm1_describe_tool
  {
    const strictInput = strictInputSchema(DESCRIBE_INPUT_SHAPE);
    const outputSchemaJson = buildOutputSchemaJson(DESCRIBE_OUTPUT_SCHEMA);
    const toolDef: Tool = {
      name: "tm1_describe_tool",
      title: "Describe Tool",
      description:
        "Inspect a TM1 tool's full description, annotations, callVia routing, and JSON inputSchema before calling it.",
      inputSchema: buildInputSchemaJson(strictInput),
      annotations: SEARCH_META_ANNOTATIONS,
      outputSchema: outputSchemaJson,
    };

    metaTools.set("tm1_describe_tool", {
      toolDef,
      strictInput,
      outputSchemaJson,
      invoke: (args, _ctx, lowLevel) => {
        const toolName = String(args.toolName);
        const includeOutputSchema = args.includeOutputSchema === true;
        const entry = opts.toolsByName.get(toolName);
        if (!entry) {
          const suggestions = index
            .search({ query: toolName, limit: 3 })
            .map((m) => m.doc.name);
          const hint =
            suggestions.length > 0
              ? `Did you mean: ${suggestions.join(", ")}? Or call tm1_search_tools.`
              : "Call tm1_search_tools to find available TM1 tools.";
          return Promise.resolve(
            formatTm1ErrorResult(
              new TM1Error({
                code: TM1ErrorCode.NOT_FOUND,
                message: `Tool "${toolName}" is not available in this server configuration (mode=${opts.mode}).`,
                hint,
              }),
            ) as CallToolResult,
          );
        }

        const { prepared, toolDef: baseDef, toolset } = entry;
        const pinned = pinnedNames.has(toolName);
        const readOnly = prepared.annotations.readOnlyHint === true;
        const payload: Record<string, unknown> = {
          name: prepared.name,
          title: prepared.title,
          toolset,
          description: prepared.description,
          annotations: prepared.annotations,
          pinned,
          callVia: callViaFor(pinned, readOnly),
          ...(prepared.taskSupport !== undefined
            ? { taskSupport: prepared.taskSupport }
            : {}),
          inputSchema: baseDef.inputSchema,
          ...(includeOutputSchema && prepared.outputSchemaJson !== undefined
            ? { outputSchema: prepared.outputSchemaJson }
            : {}),
        };

        const rawResult: McpToolResult = {
          content: [{ type: "text", text: JSON.stringify(payload) }],
        };
        const processed = postProcessToolResult(
          "tm1_describe_tool",
          rawResult,
          {
            outputSchema: DESCRIBE_OUTPUT_SCHEMA,
            responseMode: opts.responseMode,
            maxResponseChars: opts.maxResponseChars,
            sizeHint: "Omit includeOutputSchema to keep the response compact.",
            logger: opts.logger,
          },
        );
        return Promise.resolve(
          lowLevel.projectCallToolResult(
            processed as CallToolResult,
            outputSchemaJson,
          ),
        );
      },
    });
  }

  // Helper for tm1_call_read_tool and tm1_call_write_tool
  const makeDispatchMetaTool = (kind: "read" | "write"): CompiledMetaTool => {
    const metaName =
      kind === "read" ? "tm1_call_read_tool" : "tm1_call_write_tool";
    const strictInput = strictInputSchema(CALL_TOOL_INPUT_SHAPE);
    const toolDef: Tool = {
      name: metaName,
      title: kind === "read" ? "Call Read Tool" : "Call Write Tool",
      description:
        kind === "read"
          ? "Invoke any read-only TM1 tool discovered via tm1_search_tools. Refuses write/mutating tools."
          : "Invoke any write or destructive TM1 tool discovered via tm1_search_tools. Refuses read-only tools.",
      inputSchema: buildInputSchemaJson(strictInput),
      annotations: kind === "read" ? READ_ONLY : DESTRUCTIVE,
    };

    return {
      toolDef,
      strictInput,
      invoke: async (args, ctx, lowLevel, trace) => {
        const targetName = String(args.toolName);
        const entry = opts.toolsByName.get(targetName);
        if (!entry) {
          const suggestions = index
            .search({ query: targetName, limit: 3 })
            .map((m) => m.doc.name);
          const hint =
            suggestions.length > 0
              ? `Did you mean: ${suggestions.join(", ")}? Or call tm1_search_tools.`
              : "Call tm1_search_tools to find available TM1 tools.";
          return formatTm1ErrorResult(
            new TM1Error({
              code: TM1ErrorCode.NOT_FOUND,
              message: `Tool "${targetName}" is not available in this server configuration (mode=${opts.mode}).`,
              hint,
            }),
          ) as CallToolResult;
        }

        const isReadOnly = entry.prepared.annotations.readOnlyHint === true;
        if (kind === "read" && !isReadOnly) {
          return formatTm1ErrorResult(
            new TM1Error({
              code: TM1ErrorCode.PERMISSION_DENIED,
              message: `Tool "${targetName}" is a write/mutating tool and cannot be invoked via tm1_call_read_tool.`,
              hint: "Use tm1_call_write_tool instead (or call directly if pinned).",
            }),
          ) as CallToolResult;
        }
        if (kind === "write" && isReadOnly) {
          return formatTm1ErrorResult(
            new TM1Error({
              code: TM1ErrorCode.VALIDATION_ERROR,
              message: `Tool "${targetName}" is a read-only tool and should be invoked via tm1_call_read_tool.`,
              hint: "Use tm1_call_read_tool instead (or call directly if pinned).",
            }),
          ) as CallToolResult;
        }

        const innerArgs =
          (args.arguments as Record<string, unknown> | undefined) ?? {};
        const validation =
          await entry.prepared.strictInput["~standard"].validate(innerArgs);
        if ("issues" in validation && validation.issues) {
          const msg = validation.issues.map((i) => i.message).join("; ");
          return formatTm1ErrorResult(
            new TM1Error({
              code: TM1ErrorCode.VALIDATION_ERROR,
              message: `Invalid arguments for ${targetName}: ${msg}`,
              hint: `Call tm1_describe_tool with toolName="${targetName}" to inspect its inputSchema.`,
            }),
          ) as CallToolResult;
        }

        const validatedArgs = validation.value as Record<string, unknown>;
        const result = (await runWithTraceContext(trace, () =>
          entry.prepared.wrappedCb(validatedArgs, ctx),
        )) as CallToolResult;
        return lowLevel.projectCallToolResult(
          result,
          entry.prepared.outputSchemaJson,
        );
      },
    };
  };

  metaTools.set("tm1_call_read_tool", makeDispatchMetaTool("read"));
  if (hasWriteTools) {
    metaTools.set("tm1_call_write_tool", makeDispatchMetaTool("write"));
  }

  const exposedTools: Tool[] = [
    ...pinnedTools,
    ...[...metaTools.values()].map((m) => m.toolDef),
  ];

  return {
    pinnedNames,
    hasWriteTools,
    exposedTools,
    metaTools,
    index,
  };
}
