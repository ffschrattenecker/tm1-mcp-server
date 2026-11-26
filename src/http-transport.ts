import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  isLegacyRequest,
  localhostAllowedHostnames,
  WebStandardStreamableHTTPServerTransport,
  type McpServer,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type pino from "pino";
import type { ServerSettings } from "./config.js";

// Streamable HTTP transport (stateless JSON, single /mcp endpoint).
//
// Migrated to @modelcontextprotocol/server v2 (2026-07-28 stateless spec) with
// stateless 2025 fallback via isLegacyRequest(). Both eras share one server
// factory backed by the memoized tool surface and process-wide Tm1TaskManager.
//
// Cap on a single /mcp request body. Sized above the biggest legitimate payload:
// tm1_files_write accepts 32 MB of bytes (~43 MB base64 plus JSON framing).
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function extractHostname(hostOrHostPort: string): string {
  try {
    return new URL(`http://${hostOrHostPort}`).hostname;
  } catch {
    return hostOrHostPort;
  }
}

function buildAllowedHosts(config: ServerSettings): {
  allowedHostnames: string[];
  exactHostPorts: Set<string>;
} {
  const hostnames = new Set<string>(localhostAllowedHostnames());
  const exactHostPorts = new Set<string>();
  const h = config.httpHost.trim();
  if (h && h !== "0.0.0.0" && h !== "::" && h !== "[::]") {
    hostnames.add(extractHostname(h));
  }
  for (const entry of config.httpAllowedHosts) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    hostnames.add(extractHostname(trimmed).toLowerCase());
    if (trimmed.includes(":")) {
      exactHostPorts.add(trimmed.toLowerCase());
    }
  }
  return {
    allowedHostnames: [...hostnames],
    exactHostPorts,
  };
}

function isOriginAllowed(
  originHeader: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!originHeader) return true;
  if (allowedOrigins.length === 0) return true;
  const normalized = originHeader.trim().toLowerCase();
  return allowedOrigins.some((o) => o.trim().toLowerCase() === normalized);
}

export async function startHttpTransport(
  buildServer: () => McpServer,
  config: ServerSettings,
  logger: pino.Logger,
): Promise<() => Promise<void>> {
  const { allowedHostnames, exactHostPorts } = buildAllowedHosts(config);

  if (!config.httpToken) {
    logger.warn(
      "HTTP transport has no TM1_MCP_HTTP_TOKEN set — /mcp requests are unauthenticated. " +
        "Bind loopback only, or front the server with an authenticating reverse proxy.",
    );
  }

  const modernHandler = createMcpHandler(() => buildServer(), {
    legacy: "reject",
    responseMode: "auto",
    maxRequestBodySize: MAX_BODY_BYTES,
    onerror: (err) => {
      logger.error({ err }, "MCP HTTP handler error");
    },
  });

  const serveLegacyStateless = async (
    webReq: Request,
    parsedBody: unknown,
  ): Promise<Response> => {
    const server = buildServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      // sessionIdGenerator omitted → stateless mode (single-use per request)
      enableJsonResponse: true,
      maxRequestBodySize: MAX_BODY_BYTES,
    });
    const teardown = () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    };
    webReq.signal.addEventListener("abort", teardown, { once: true });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(webReq, { parsedBody });
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        teardown();
      }
      return response;
    } catch (err) {
      teardown();
      throw err;
    }
  };

  const nodeHandler = toNodeHandler(
    {
      fetch: async (webReq: Request): Promise<Response> => {
        const hostRejected = hostHeaderValidationResponse(
          webReq,
          allowedHostnames,
        );
        if (hostRejected) {
          return hostRejected;
        }
        const rawHost = webReq.headers.get("host")?.toLowerCase();
        if (rawHost && exactHostPorts.size > 0) {
          const hostname = extractHostname(rawHost);
          const isLoopback = localhostAllowedHostnames().includes(hostname);
          const isConfiguredBare =
            hostname === extractHostname(config.httpHost).toLowerCase() ||
            config.httpAllowedHosts.some(
              (h) =>
                !h.includes(":") &&
                extractHostname(h).toLowerCase() === hostname,
            );
          if (
            !isLoopback &&
            !isConfiguredBare &&
            !exactHostPorts.has(rawHost)
          ) {
            return new Response(
              JSON.stringify({ error: `Invalid Host: ${rawHost}` }),
              {
                status: 403,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
        }

        const originHeader = webReq.headers.get("origin") ?? undefined;
        if (!isOriginAllowed(originHeader, config.httpAllowedOrigins)) {
          return new Response(
            JSON.stringify({ error: `Invalid Origin: ${originHeader}` }),
            {
              status: 403,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        const text = await webReq.text();
        let parsedBody: unknown;
        if (text) {
          try {
            parsedBody = JSON.parse(text);
          } catch (err) {
            logger.warn({ err }, "Bad JSON in /mcp body");
            return new Response(JSON.stringify({ error: "Invalid JSON" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
        }

        // Reconstruct a fresh Request with the buffered text because
        // webReq.text() consumed the body stream.
        const replayReq = new Request(webReq.url, {
          method: webReq.method,
          headers: webReq.headers,
          body: text || null,
          signal: webReq.signal,
        });

        if (await isLegacyRequest(replayReq, parsedBody)) {
          return serveLegacyStateless(replayReq, parsedBody);
        }
        return modernHandler.fetch(replayReq, { parsedBody });
      },
    },
    {
      maxRequestBodySize: MAX_BODY_BYTES,
      onerror: (err) => {
        logger.error({ err }, "Transport handleRequest threw");
      },
    },
  );

  const httpServer = createServer(
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- async request handler intentional; pre-checks run before delegating to toNodeHandler
    async (req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url ?? "").split(/[?#]/, 1)[0] ?? "";
      if (path !== "/mcp" && !path.startsWith("/mcp/")) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Not found. Use POST /mcp." }));
        return;
      }
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({ error: "Method not allowed. Use POST /mcp." }),
        );
        return;
      }
      if (config.httpToken) {
        const expected = createHash("sha256")
          .update(`Bearer ${config.httpToken}`)
          .digest();
        const provided = createHash("sha256")
          .update(req.headers.authorization ?? "")
          .digest();
        if (!timingSafeEqual(expected, provided)) {
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("WWW-Authenticate", "Bearer");
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        logger.warn(
          { declared, limit: MAX_BODY_BYTES },
          "Request body too large",
        );
        res.statusCode = 413;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Connection", "close");
        res.end(
          JSON.stringify({
            error: `Request body exceeds ${MAX_BODY_BYTES} bytes`,
          }),
        );
        return;
      }

      await nodeHandler(
        req as unknown as Parameters<typeof nodeHandler>[0],
        res,
      );
    },
  );

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.httpPort, config.httpHost, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  logger.info(
    {
      host: config.httpHost,
      port: config.httpPort,
      endpoint: "/mcp",
      allowedHosts: allowedHostnames,
      allowedOrigins: config.httpAllowedOrigins,
      dnsRebindingProtection: true,
    },
    "MCP server listening on HTTP (Streamable v2, stateless)",
  );

  return async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
}
