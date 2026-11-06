import { describe, expect, test as it } from "bun:test";
import type { OwnedResource } from "../host/index.ts";
import { runtimeFixture } from "../runtime/test/index.helper.ts";
import { startPrivateGateway } from "./acquisition.ts";
import { withDockerOutput } from "./test/acquisition-effects.helper.ts";
import type {
  GatewayRecoveryCoordinates,
  GatewayHostContext as HostContext,
} from "./types.ts";

const NATIVE_ID_LENGTH = 64;
const SECOND_PORT = 43_124;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("startPrivateGateway", () => {
  it("should isolate namespace state and endpoint between concurrent activations", async () => {
    const first = runtimeFixture();
    const second = runtimeFixture();
    second.native.networkId = "e".repeat(NATIVE_ID_LENGTH);
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
      expect(first.native.namespace).not.toBe(second.native.namespace);
      expect(left.endpoint).not.toBe(right.endpoint);
      await left.close();
      await expect(
        first.effects.host.filesystem.lstat(firstStateDirectory),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(second.native.networkPresent).toBe(true);
      expect(
        await secondHost.filesystem.readFile(
          `${secondStateDirectory}/gateway.toml`,
          "utf8",
        ),
      ).toContain(second.native.namespace);
    } finally {
      await Promise.all([left.close(), right.close()]);
    }
  });
  it("should retain unresolved network acquisitions when create acknowledgement is missing", async () => {
    const fixture = runtimeFixture();
    const host = withDockerOutput(
      fixture.effects.host,
      "network create",
      "",
      1,
    );
    const resources: OwnedResource[] = [];
    const coordinates: GatewayRecoveryCoordinates[] = [];
    await expect(
      startPrivateGateway(
        host,
        fixture.activation.signal,
        (resource) => resources.push(resource),
        (known) => coordinates.push(known),
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(coordinates).toEqual([
      { tlsDirectory: "/state/pi-openshell-abcdefghijklmnop/tls" },
    ]);
    const network = resources.find((resource) => resource.kind === "network");
    expect(network).toBeDefined();
    await expect(network?.release()).rejects.toBeInstanceOf(Error);
    expect(
      (
        await host.filesystem.lstat("/state/pi-openshell-abcdefghijklmnop")
      ).isDirectory(),
    ).toBe(true);
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
    expect(captured.map((item) => item.kind)).toEqual([
      "state",
      "network",
      "process",
    ]);
    expect(fixture.native.launches).toBe(1);
    expect(fixture.native.networkPresent).toBe(false);
    await expect(
      host.filesystem.lstat("/state/pi-openshell-abcdefghijklmnop"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
