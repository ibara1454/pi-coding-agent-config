import { describe, expect, test as it } from "bun:test";
import type { SpawnOptions, spawn } from "node:child_process";
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import type { OwnedResource } from "../host/index.ts";
import { runtimeFixture } from "../runtime/test/index.helper.ts";
import { startPrivateGateway } from "./acquisition.ts";
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
      expect(left.networkId).not.toBe(right.networkId);
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
      await right.close();
    }
  });
  it("should preserve transferred gateway lifetime after generation abort", async () => {
    const fixture = runtimeFixture();
    const stateDirectory = `/state/pi-openshell-${fixture.effects.host.instanceId}`;
    const gateway = await startPrivateGateway(
      fixture.effects.host,
      fixture.activation.signal,
      () => undefined,
      () => undefined,
    );
    fixture.activation.abort();
    expect(fixture.native.networkPresent).toBe(true);
    expect(
      await fixture.effects.host.filesystem.readFile(
        `${stateDirectory}/gateway.toml`,
        "utf8",
      ),
    ).toContain(fixture.native.namespace);
    await gateway.close();
    expect(fixture.native.networkPresent).toBe(false);
    await expect(
      fixture.effects.host.filesystem.lstat(stateDirectory),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await gateway.close();
  });

  it("should reject mismatched gateway control readback without disclosing native payloads", async () => {
    const fixture = runtimeFixture();
    const original = fixture.sdk.client.raw.getGatewayConfig;
    fixture.sdk.client.raw.getGatewayConfig = async (...args) => {
      const response = await original(...args);
      const setting = response.settings["providers_v2_enabled"];
      if (setting) {
        setting.value = { case: "boolValue", value: true };
      }
      return response;
    };
    const owned: OwnedResource[] = [];
    const failure = await startPrivateGateway(
      fixture.effects.host,
      fixture.activation.signal,
      (resource) => owned.push(resource),
      () => undefined,
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(owned.some((resource) => resource.kind === "process")).toBe(true);
    await expect(
      fixture.effects.host.filesystem.lstat(
        "/state/pi-openshell-abcdefghijklmnop",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("should retain private recovery state when immutable network ownership changes", async () => {
    const fixture = runtimeFixture();
    const stateDirectory = `/state/pi-openshell-${fixture.effects.host.instanceId}`;
    const gateway = await startPrivateGateway(
      fixture.effects.host,
      fixture.activation.signal,
      () => undefined,
      () => undefined,
    );
    fixture.native.labels["io.pi.openshell-sandbox.instance-id"] =
      "foreign-instance";
    await expect(gateway.close()).rejects.toBeInstanceOf(Error);
    expect(
      await fixture.effects.host.filesystem.readFile(
        `${stateDirectory}/gateway.toml`,
        "utf8",
      ),
    ).toContain(fixture.native.namespace);
    fixture.native.labels["io.pi.openshell-sandbox.instance-id"] =
      gateway.instanceId;
    await gateway.close();
  });
  it("should retain unresolved network acquisitions when create acknowledgement is missing", async () => {
    const fixture = runtimeFixture();
    const original = fixture.effects.host.processEffects.spawn;
    const spawnEffect = ((
      executable: string,
      args: readonly string[],
      options: SpawnOptions,
    ) => {
      if (args[2] !== "network" || args[3] !== "create") {
        return original(executable, args, options);
      }
      const child = new ChildProcess();
      queueMicrotask(() => {
        child.emit("spawn");
        Object.defineProperty(child, "exitCode", { value: 1 });
        // biome-ignore lint/plugin/biome-rules/use-undefined: Node child close reports null when no termination signal was received.
        child.emit("close", 1, null);
      });
      return child;
    }) as typeof spawn;
    const host = {
      ...fixture.effects.host,
      processEffects: {
        ...fixture.effects.host.processEffects,
        spawn: spawnEffect,
      },
    };
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
  it("should never remove a same-name replacement state directory", async () => {
    const fixture = runtimeFixture();
    const stateDirectory = `/state/pi-openshell-${fixture.effects.host.instanceId}`;
    const gateway = await startPrivateGateway(
      fixture.effects.host,
      fixture.activation.signal,
      () => undefined,
      () => undefined,
    );
    fixture.filesystem.replace(stateDirectory);
    await expect(gateway.close()).rejects.toBeInstanceOf(Error);
    expect(
      (
        await fixture.effects.host.filesystem.lstat(stateDirectory)
      ).isDirectory(),
    ).toBe(true);
  });

  it("should reject an unsupported native release without allocating gateway state", async () => {
    const fixture = runtimeFixture();
    const original = fixture.effects.host.processEffects.spawn;
    const host: HostContext = {
      ...fixture.effects.host,
      processEffects: {
        ...fixture.effects.host.processEffects,
        spawn: ((
          executable: string,
          argv: readonly string[],
          options: SpawnOptions,
        ) => {
          if (argv[0] !== "--version") {
            return original(executable, argv, options);
          }
          const child = new ChildProcess();
          Object.defineProperties(child, {
            stdout: { value: new PassThrough() },
            stderr: { value: new PassThrough() },
          });
          queueMicrotask(() => {
            child.emit("spawn");
            child.stdout?.emit(
              "data",
              Buffer.from("openshell-gateway 0.0.115"),
            );
            Object.defineProperty(child, "exitCode", { value: 0 });
            // biome-ignore lint/plugin/biome-rules/use-undefined: Node child close reports null when no termination signal was received.
            child.emit("close", 0, null);
          });
          return child;
        }) as typeof spawn,
      },
    };
    await expect(
      startPrivateGateway(
        host,
        fixture.activation.signal,
        () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow("Private OpenShell gateway preparation failed");
    expect(fixture.native.networkPresent).toBe(false);
    expect(fixture.filesystem.files.size).toBe(0);
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
