import { describe, expect, test as it } from "bun:test";
import type { OwnedResource } from "../host/index.ts";
import { runtimeFixture } from "../runtime/test/index.helper.ts";
import { startPrivateGateway } from "./acquisition.ts";
import type { GatewayHostContext as HostContext } from "./types.ts";

const SECOND_PORT = 43_124;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("startPrivateGateway", () => {
  it("should isolate namespace state and endpoint between concurrent activations", async () => {
    const first = runtimeFixture();
    const second = runtimeFixture();
    const secondHost: HostContext = {
      ...second.effects.host,
      instanceId: "qrstuvwxyzabcdef",
      filesystem: first.effects.host.filesystem,
      gatewayEffects: {
        connect: async () => second.sdk.client,
        reservePort: async () => SECOND_PORT,
      },
    };
    const firstStateDirectory = `/state/pi-openshell-${first.effects.host.instanceId}`;
    const secondStateDirectory = `/state/pi-openshell-${secondHost.instanceId}`;
    const [left, right] = await Promise.all([
      startPrivateGateway(
        first.effects.host,
        first.activation.signal,
        () => undefined,
        () => undefined,
      ),
      startPrivateGateway(
        secondHost,
        second.activation.signal,
        () => undefined,
        () => undefined,
      ),
    ]);
    try {
      expect(left.labels).not.toEqual(right.labels);
      expect(left.endpoint).not.toBe(right.endpoint);
      await left.close();
      await expect(
        first.effects.host.filesystem.lstat(firstStateDirectory),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await secondHost.filesystem.lstat(secondStateDirectory)).isDirectory(),
      ).toBe(true);
    } finally {
      await Promise.all([left.close(), right.close()]);
    }
  });
  it("should release launched gateway and state when authenticated connection fails", async () => {
    const fixture = runtimeFixture();
    const effects = fixture.effects.host.gatewayEffects;
    if (!effects) {
      throw new Error("Expected synthetic gateway effects.");
    }
    const host: HostContext = {
      ...fixture.effects.host,
      gatewayEffects: {
        ...effects,
        connect: () =>
          Promise.reject(new Error("secret SDK connection detail")),
      },
    };
    const captured: OwnedResource[] = [];
    const failure: unknown = await startPrivateGateway(
      host,
      fixture.activation.signal,
      (item) => captured.push(item),
      () => undefined,
    ).then(
      () => {
        throw new Error("Expected connection failure.");
      },
      (error: unknown) => error,
    );
    if (!(failure instanceof Error)) {
      throw new Error("Connection failure was not an Error.");
    }
    expect(failure.message).toContain(
      "Private OpenShell gateway preparation failed",
    );
    expect(failure.message).not.toContain("secret SDK");
    expect(captured.map((item) => item.kind)).toEqual(["state", "process"]);
    expect(fixture.native.launches).toBe(1);
    await expect(
      host.filesystem.lstat("/state/pi-openshell-abcdefghijklmnop"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
