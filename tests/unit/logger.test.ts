import { describe, it, expect } from "vitest";
import { createLogger } from "../../src/logger.js";
import { Writable } from "node:stream";

/**
 * Drive the REAL createLogger with an in-memory destination so masking is
 * asserted against the production redact config (not a hand-copied one).
 * Deleting a field from redactPaths() in src/logger.ts fails these tests.
 */
function logOne(fields: object): Record<string, unknown> {
  const lines: string[] = [];
  const dest = new Writable({
    write(chunk, _encoding, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger({ logLevel: "debug" }, dest);
  logger.info(fields, "test");
  logger.flush();
  return JSON.parse(lines.join("").trim().split("\n")[0]) as Record<
    string,
    unknown
  >;
}

describe("sensitive field masking", () => {
  // Logger entries are arbitrary objects; the accessor reads nested keys.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  it.each<[string, object, (e: Record<string, any>) => unknown, string]>([
    [
      "password",
      { password: "superSecret123" },
      (e) => e.password,
      "superSecret123",
    ],
    [
      "Authorization header",
      { headers: { Authorization: "Basic dXNlcjpwYXNz" } },
      (e) => e.headers.Authorization,
      "Basic dXNlcjpwYXNz",
    ],
    [
      "TM1SessionId",
      { TM1SessionId: "abc123sessiontoken" },
      (e) => e.TM1SessionId,
      "abc123sessiontoken",
    ],
    [
      "nested password",
      { request: { password: "nestedSecret" } },
      (e) => e.request.password,
      "nestedSecret",
    ],
    [
      "nested Authorization",
      { request: { Authorization: "Bearer tok" } },
      (e) => e.request.Authorization,
      "Bearer tok",
    ],
    [
      "nested TM1SessionId",
      { request: { TM1SessionId: "sess456" } },
      (e) => e.request.TM1SessionId,
      "sess456",
    ],
    [
      "v12 clientSecret",
      { config: { clientSecret: "v12ClientSecret" } },
      (e) => e.config.clientSecret,
      "v12ClientSecret",
    ],
    [
      "v12 accessToken",
      { config: { accessToken: "v12AccessToken" } },
      (e) => e.config.accessToken,
      "v12AccessToken",
    ],
    [
      "v12 apiKey",
      { config: { apiKey: "v12ApiKey" } },
      (e) => e.config.apiKey,
      "v12ApiKey",
    ],
  ])("masks %s", (_name, fields, read, secret) => {
    const entry = logOne(fields);
    expect(read(entry)).toBe("***");
    expect(JSON.stringify(entry)).not.toContain(secret);
  });

  it("does not mask clientId or ordinary fields", () => {
    const entry = logOne({
      config: { clientId: "public-client-id" },
      endpoint: "/api/v1/Cubes",
      status: 200,
    });
    const config = entry.config as Record<string, unknown>;
    expect(config.clientId).toBe("public-client-id");
    expect(entry.endpoint).toBe("/api/v1/Cubes");
    expect(entry.status).toBe(200);
  });
});
