import { describe, expect, test as it } from "bun:test";
import { createServer } from "node:net";
import { reserveGatewayPort } from "./client.ts";

describe("reserveGatewayPort", () => {
  it("should return the allocated port after the test-owned loopback listener closes", async () => {
    const server = createServer();
    let address: unknown;
    let closed = false;
    server.once("listening", () => {
      address = server.address();
    });
    server.once("close", () => {
      closed = true;
    });
    try {
      const port = await reserveGatewayPort(() => server);
      expect(address).toMatchObject({ port });
      expect(closed).toBe(true);
      expect(server.listening).toBe(false);
    } finally {
      const cleanup = Promise.withResolvers<void>();
      server.close(() => cleanup.resolve());
      await cleanup.promise;
    }
  });
});
