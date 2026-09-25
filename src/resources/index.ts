// MCP Resources — read-only data assets exposed via URI. Complements the
// tool surface so IDE clients (Kiro, VSCode Copilot Chat) can:
//   - reference TM1 objects in chat as `#tm1://process/foo/code`
//   - browse a sidebar tree
//   - subscribe to updates without polling
//
// Each resource maps to an existing TM1 service call — same backend logic
// as the get_* tools, different MCP entry point.
import {
  type McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../tm1-client.js";
import { asRegistry, type ClientSource } from "../tools/define-tool.js";
import { maskCode } from "../lib/mask-secrets.js";
import type { CatalogEntry, ResourceCatalog } from "./list-handler.js";

interface ReadResult {
  [x: string]: unknown;
  contents: Array<{ uri: string; mimeType?: string; text: string }>;
}

function asJsonContent(uri: URL, payload: unknown): ReadResult {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/** How one connection's resources are addressed and reached. */
interface ConnectionResourceContext {
  /** URI prefix: `tm1://` alone, or `tm1://<connection>/` with several. */
  base: string;
  /** Resource-name prefix keeping names unique across connections. */
  key: string;
  titlePrefix: string;
  client: () => Promise<TM1Client>;
  /**
   * Whether list callbacks may enumerate TM1 objects. With several
   * connections a resources/list must not log in to every server, so only
   * connections that are already connected are enumerated.
   */
  enumerate: () => boolean;
}

export function registerAllResources(
  server: McpServer,
  source: ClientSource,
): ResourceCatalog {
  // Build a parallel catalog as we go so installPaginatedListHandler can
  // override SDK's default ListResourcesRequestSchema with cursor support.
  // registerResource still wires the read callbacks; we just keep our own
  // listing source of truth.
  const entries: CatalogEntry[] = [];
  const registry = asRegistry(source);
  for (const name of registry.usableNames) {
    const single = registry.isSingle;
    registerConnectionResources(server, entries, {
      base: single ? "tm1://" : `tm1://${name}/`,
      key: single ? "" : `${name}:`,
      titlePrefix: single ? "" : `${name}: `,
      client: () => registry.get(name),
      enumerate: () => single || registry.isConnected(name),
    });
  }
  return { entries };
}

/** URIs of every connection's server-state resource, keyed by connectionId. */
export function stateResourceUris(source: ClientSource): Map<string, string> {
  const registry = asRegistry(source);
  const uris = new Map<string, string>();
  for (const name of registry.usableNames) {
    const uri = registry.isSingle
      ? "tm1://server/state"
      : `tm1://${name}/server/state`;
    uris.set(uri, registry.info(name)?.connectionId ?? "");
  }
  return uris;
}

function registerConnectionResources(
  server: McpServer,
  entries: CatalogEntry[],
  ctx: ConnectionResourceContext,
): void {
  // ── Static endpoints ────────────────────────────────────────────────
  server.registerResource(
    `${ctx.key}server-info`,
    `${ctx.base}server/info`,
    {
      title: `${ctx.titlePrefix}TM1 Server Info`,
      description:
        "TM1 server configuration snapshot: name, version, data directory, timezone, integrated security mode.",
      mimeType: "application/json",
    },
    async (uri) => {
      // Project to the documented identity fields only. getInfo().extra
      // carries the full merged /Configuration body, which can include
      // sensitive settings — resources have no params, so unlike the
      // curated tm1_get_server_info tool there is no place to opt in.
      const info = await (await ctx.client()).server.getInfo();
      return asJsonContent(uri, {
        serverName: info.serverName,
        productVersion: info.productVersion,
        productEdition: info.productEdition,
        adminHost: info.adminHost,
        dataDirectory: info.dataDirectory,
        timeZoneId: info.timeZoneId,
        integratedSecurityMode: info.integratedSecurityMode,
      });
    },
  );
  entries.push({
    kind: "static",
    resource: {
      uri: `${ctx.base}server/info`,
      name: `${ctx.key}server-info`,
      title: `${ctx.titlePrefix}TM1 Server Info`,
      description:
        "TM1 server configuration snapshot: name, version, data directory, timezone, integrated security mode.",
      mimeType: "application/json",
    },
  });

  server.registerResource(
    `${ctx.key}server-state`,
    `${ctx.base}server/state`,
    {
      title: `${ctx.titlePrefix}TM1 Server State`,
      description:
        "Health-check snapshot: connection state, version, capability flags, object counts (cubes/dimensions/processes/chores/clients).",
      mimeType: "application/json",
    },
    async (uri) => {
      const [info, cubes, dims, procs, chores, clients] = await Promise.all([
        (await ctx.client()).server.getInfo(),
        (await ctx.client()).cubes.list(),
        (await ctx.client()).dimensions.list(),
        (await ctx.client()).processes.list(),
        (await ctx.client()).chores.list(),
        (await ctx.client()).security.listClients(),
      ]);
      return asJsonContent(uri, {
        connected: (await ctx.client()).isConnected(),
        server: {
          name: info.serverName,
          productVersion: info.productVersion,
          dataDirectory: info.dataDirectory,
          timeZoneId: info.timeZoneId,
        },
        counts: {
          cubes: cubes.length,
          dimensions: dims.length,
          processes: procs.length,
          chores: chores.length,
          clients: clients.length,
        },
      });
    },
  );
  entries.push({
    kind: "static",
    resource: {
      uri: `${ctx.base}server/state`,
      name: `${ctx.key}server-state`,
      title: `${ctx.titlePrefix}TM1 Server State`,
      description:
        "Health-check snapshot: connection state, version, capability flags, object counts (cubes/dimensions/processes/chores/clients).",
      mimeType: "application/json",
    },
  });

  // ── Resource templates ──────────────────────────────────────────────
  // Process source code — `tm1://[<connection>/]process/{name}/code`
  server.registerResource(
    `${ctx.key}process-code`,
    new ResourceTemplate(`${ctx.base}process/{name}/code`, {
      list: async () => {
        if (!ctx.enumerate()) return { resources: [] };
        const procs = await (await ctx.client()).processes.list();
        return {
          resources: procs
            .filter((p) => !p.name.startsWith("}"))
            .map((p) => ({
              name: `${ctx.key}process-code-${p.name}`,
              uri: `${ctx.base}process/${encodeURIComponent(p.name)}/code`,
              title: `${ctx.titlePrefix}TI: ${p.name}`,
              description: `Source code (Prolog/Metadata/Data/Epilog) of TI process '${p.name}'.`,
              mimeType: "application/json",
            })),
        };
      },
      complete: {
        name: async (value: string) => {
          const procs = await (await ctx.client()).processes.list();
          const lower = value.toLowerCase();
          return procs
            .filter(
              (p) =>
                !p.name.startsWith("}") && p.name.toLowerCase().includes(lower),
            )
            .map((p) => p.name)
            .slice(0, 100);
        },
      },
    }),
    {
      title: `${ctx.titlePrefix}TI Process Source Code`,
      description: `Source code of any TurboIntegrator process by name. URI: ${ctx.base}process/{name}/code.`,
      mimeType: "application/json",
    },
    async (uri, vars) => {
      const raw = vars.name;
      const name = decodeURIComponent(
        Array.isArray(raw) ? raw[0]! : (raw ?? ""),
      );
      const code = await (await ctx.client()).processes.getCode(name);
      // Hard-mask credential literals unconditionally: resources take no
      // parameters, so unlike tm1_get_process_code there is no maskSecrets
      // opt-out — returning the code verbatim would bypass the tool-path
      // redaction (ODBCOpen passwords, credential assignments).
      return asJsonContent(uri, {
        prolog: maskCode(code.prolog),
        metadata: maskCode(code.metadata),
        data: maskCode(code.data),
        epilog: maskCode(code.epilog),
      });
    },
  );
  entries.push({
    kind: "template",
    templateMetadata: {
      title: `${ctx.titlePrefix}TI Process Source Code`,
      description: `Source code of any TurboIntegrator process by name. URI: ${ctx.base}process/{name}/code.`,
      mimeType: "application/json",
    },
    list: async () => {
      if (!ctx.enumerate()) return { resources: [] };
      const procs = await (await ctx.client()).processes.list();
      return {
        resources: procs
          .filter((p) => !p.name.startsWith("}"))
          .map((p) => ({
            name: `${ctx.key}process-code-${p.name}`,
            uri: `${ctx.base}process/${encodeURIComponent(p.name)}/code`,
            title: `${ctx.titlePrefix}TI: ${p.name}`,
            description: `Source code (Prolog/Metadata/Data/Epilog) of TI process '${p.name}'.`,
            mimeType: "application/json",
          })),
      };
    },
  });

  // Cube rules — `tm1://[<connection>/]cube/{name}/rules`
  server.registerResource(
    `${ctx.key}cube-rules`,
    new ResourceTemplate(`${ctx.base}cube/{name}/rules`, {
      list: async () => {
        if (!ctx.enumerate()) return { resources: [] };
        // Filter to cubes that actually carry rules — avoids cluttering
        // the resource tree with rule-less cubes whose body is "".
        const cubes = await (
          await ctx.client()
        ).cubes.list({ includeRules: true });
        return {
          resources: cubes
            .filter((c) => !c.name.startsWith("}") && c.hasRules)
            .map((c) => ({
              name: `${ctx.key}cube-rules-${c.name}`,
              uri: `${ctx.base}cube/${encodeURIComponent(c.name)}/rules`,
              title: `${ctx.titlePrefix}Rules: ${c.name}`,
              description: `Rules text of cube '${c.name}' (SKIPCHECK + FEEDERS sections).`,
              mimeType: "text/plain",
            })),
        };
      },
      complete: {
        name: async (value: string) => {
          const cubes = await (await ctx.client()).cubes.list();
          const lower = value.toLowerCase();
          return cubes
            .filter(
              (c) =>
                !c.name.startsWith("}") && c.name.toLowerCase().includes(lower),
            )
            .map((c) => c.name)
            .slice(0, 100);
        },
      },
    }),
    {
      title: `${ctx.titlePrefix}Cube Rules Text`,
      description: `Rules text of any TM1 cube by name. URI: ${ctx.base}cube/{name}/rules. Returns plain text.`,
      mimeType: "text/plain",
    },
    async (uri, vars) => {
      const raw = vars.name;
      const name = decodeURIComponent(
        Array.isArray(raw) ? raw[0]! : (raw ?? ""),
      );
      const rules = await (await ctx.client()).cubes.getRules(name);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text: rules.rulesText,
          },
        ],
      };
    },
  );
  entries.push({
    kind: "template",
    templateMetadata: {
      title: `${ctx.titlePrefix}Cube Rules Text`,
      description: `Rules text of any TM1 cube by name. URI: ${ctx.base}cube/{name}/rules. Returns plain text.`,
      mimeType: "text/plain",
    },
    list: async () => {
      if (!ctx.enumerate()) return { resources: [] };
      const cubes = await (
        await ctx.client()
      ).cubes.list({ includeRules: true });
      return {
        resources: cubes
          .filter((c) => !c.name.startsWith("}") && c.hasRules)
          .map((c) => ({
            name: `${ctx.key}cube-rules-${c.name}`,
            uri: `${ctx.base}cube/${encodeURIComponent(c.name)}/rules`,
            title: `${ctx.titlePrefix}Rules: ${c.name}`,
            description: `Rules text of cube '${c.name}' (SKIPCHECK + FEEDERS sections).`,
            mimeType: "text/plain",
          })),
      };
    },
  });
}
