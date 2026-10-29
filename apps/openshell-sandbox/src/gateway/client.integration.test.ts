import { describe, expect, test as it } from "bun:test";
import { createServer } from "node:net";
import { reserveGatewayPort } from "./client.ts";

describe("reserveGatewayPort", () => {
  it("should release the test-owned loopback reservation before returning a bindable port", async () => {
    const port = await reserveGatewayPort();
    const server = createServer();
    const listening = Promise.withResolvers<void>();
    server.once("error", listening.reject);
    server.listen(port, "127.0.0.1", listening.resolve);
    try {
      await listening.promise;
      expect(server.address()).toMatchObject({ port });
    } finally {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    }
  });
});
