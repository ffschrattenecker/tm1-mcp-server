import { describe, expect, it } from "vitest";
import { ConnectionRegistry } from "../../src/connections.js";
import { serverInstructions } from "../../src/server-instructions.js";
import type { TM1Client } from "../../src/tm1-client.js";

const client = { version: 11, connectionId: "h_1" } as unknown as TM1Client;

describe("serverInstructions", () => {
  it("tells the model about `connection` only when there are several", () => {
    const single = serverInstructions(ConnectionRegistry.single(client));
    const multi = serverInstructions(
      ConnectionRegistry.of([
        { name: "a", client },
        { name: "b", client },
      ]),
    );

    expect(single).not.toMatch(/connection/);
    expect(multi).toMatch(/tm1_list_connections/);
  });

  // Paid for by every session: a budget stops it growing unnoticed.
  it("stays under 500 characters", () => {
    const multi = serverInstructions(
      ConnectionRegistry.of([
        { name: "a", client },
        { name: "b", client },
      ]),
    );
    expect(multi.length).toBeLessThan(500);
  });
});
