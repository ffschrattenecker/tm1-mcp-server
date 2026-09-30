import { createServer, type Server } from "node:http";
import {
  createServer as createTcp,
  connect,
  type Server as TcpServer,
} from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetch } from "undici";
import { getTm1Dispatcher } from "../../src/tm1-client/dispatcher.js";
import { baseTestConfig } from "../helpers/tm1-config.js";

// Minimal no-auth SOCKS5 server: greeting, CONNECT (domain or IPv4), then pipe.
function startSocks(seen: string[]): Promise<TcpServer> {
  const server = createTcp((client) => {
    client.once("data", () => {
      client.write(Buffer.from([0x05, 0x00]));
      client.once("data", (req) => {
        let host: string;
        let off: number;
        if (req[3] === 0x03) {
          host = req.subarray(5, 5 + req[4]).toString();
          off = 5 + req[4];
        } else {
          host = [...req.subarray(4, 8)].join(".");
          off = 8;
        }
        const port = req.readUInt16BE(off);
        seen.push(`${host}:${port}`);
        const upstream = connect(port, "127.0.0.1", () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
      });
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

describe("getTm1Dispatcher with a SOCKS5 proxy", () => {
  let http: Server;
  let socks: TcpServer;
  const seen: string[] = [];

  beforeAll(async () => {
    http = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    socks = await startSocks(seen);
  });
  afterAll(() => {
    http.close();
    socks.close();
  });

  it("tunnels the request to the target named in baseUrl", async () => {
    const proxy = `socks5://127.0.0.1:${(socks.address() as AddressInfo).port}`;
    const port = (http.address() as AddressInfo).port;
    const dispatcher = getTm1Dispatcher({ ...baseTestConfig, proxy });
    const res = await fetch(`http://tm1.internal:${port}/x`, { dispatcher });
    expect(await res.text()).toBe("ok");
    expect(seen).toContain(`tm1.internal:${port}`);
  });

  it("caches one agent per verify+proxy pair", () => {
    const a = getTm1Dispatcher({
      ...baseTestConfig,
      proxy: "socks5://127.0.0.1:1",
    });
    const b = getTm1Dispatcher({
      ...baseTestConfig,
      proxy: "socks5://127.0.0.1:1",
    });
    const c = getTm1Dispatcher(baseTestConfig);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
