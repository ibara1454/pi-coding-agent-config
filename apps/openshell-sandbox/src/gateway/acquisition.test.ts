import { describe, expect, test as it, spyOn } from "bun:test";
import type { SpawnOptions, spawn } from "node:child_process";
import process from "node:process";
import type { OwnedResource } from "../host/index.ts";
import { nativeResponseChild } from "../host/test/index.helper.ts";
import {
  unitRuntimeFixture as runtimeFixture,
  TEST_NETWORK,
} from "../runtime/test/index.helper.ts";
import { startPrivateGateway } from "./acquisition.ts";
import {
  directory,
  withDockerOutput,
  withStats,
} from "./test/acquisition-effects.helper.ts";
import { failedGatewayLaunch } from "./test/process.helper.ts";
import type {
  GatewayHostContext,
  GatewayRecoveryCoordinates,
} from "./types.ts";

const RESERVED_PORT = 43_123;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("startPrivateGateway", () => {
  it("should reject admission without acquiring resources when Node is older than the supported release", async () => {
    const fixture = runtimeFixture();
    const nodeVersion = Object.getOwnPropertyDescriptor(
      process.versions,
      "node",
    );
    if (!nodeVersion) {
      throw new Error("Node version descriptor is unavailable.");
    }
    try {
      Object.defineProperty(process.versions, "node", { value: "20.0.0" });
      const captured: OwnedResource[] = [];
      await expect(
        startPrivateGateway(
          fixture.effects.host,
          fixture.activation.signal,
          (item) => captured.push(item),
          () => undefined,
        ),
      ).rejects.toThrow("Private OpenShell gateway preparation failed");
      expect(captured).toEqual([]);
      expect(fixture.native.calls).toEqual([]);
      expect(fixture.filesystem.files.size).toBe(0);
    } finally {
      Object.defineProperty(process.versions, "node", nodeVersion);
      fixture.clock.restore();
    }
  });
  it.each([
    ["unsupported platform", { platform: "win32" }],
    ["unsupported architecture", { architecture: "riscv64" }],
  ] as const)(
    "should reject admission without acquiring state when the host has an %s",
    async (_condition, overrides) => {
      const fixture = runtimeFixture();
      try {
        const captured: OwnedResource[] = [];
        await expect(
          startPrivateGateway(
            { ...fixture.effects.host, ...overrides },
            fixture.activation.signal,
            (item) => captured.push(item),
            () => undefined,
          ),
        ).rejects.toThrow("Private OpenShell gateway preparation failed");
        expect(captured).toEqual([]);
        expect(fixture.native.calls).toEqual([]);
        expect(fixture.filesystem.files.size).toBe(0);
      } finally {
        fixture.clock.restore();
      }
    },
  );
  it("should reject admission without invoking native prerequisites when cancellation is already requested", async () => {
    const fixture = runtimeFixture();
    try {
      fixture.activation.abort(new Error("secret cancellation"));
      const failure = await startPrivateGateway(
        fixture.effects.host,
        fixture.activation.signal,
        () => undefined,
        () => undefined,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain("secret cancellation");
      expect(fixture.native.calls).toEqual([]);
    } finally {
      fixture.clock.restore();
    }
  });
  it("should refuse unpinned prerequisite output before creating a private namespace", async () => {
    const fixture = runtimeFixture();
    try {
      const original = fixture.effects.host.processEffects.spawn;
      const host = {
        ...fixture.effects.host,
        processEffects: {
          ...fixture.effects.host.processEffects,
          spawn: ((
            executable: string,
            args: readonly string[],
            options: SpawnOptions,
          ) =>
            args[0] === "--version"
              ? nativeResponseChild(
                  "openshell-gateway 0.0.999 secret-native-payload",
                )
              : original(executable, args, options)) as typeof spawn,
        },
      };
      const captured: OwnedResource[] = [];
      const failure = await startPrivateGateway(
        host,
        fixture.activation.signal,
        (item) => captured.push(item),
        () => undefined,
      ).catch((error: unknown) => error);
      expect(String(failure)).toContain(
        "Private OpenShell gateway preparation failed",
      );
      expect(String(failure)).not.toContain("secret-native-payload");
      expect(captured).toEqual([]);
      expect(fixture.native.networkPresent).toBe(false);
    } finally {
      fixture.clock.restore();
    }
  });
  it("should retain recovery coordinates and provisional state when initial identity readback fails", async () => {
    const fixture = runtimeFixture();
    try {
      const captured: OwnedResource[] = [];
      const coordinates: GatewayRecoveryCoordinates[] = [];
      const host = withStats(fixture.effects.host, (path, stat) => {
        if (path === directory) {
          throw new Error("identity unavailable");
        }
        return stat;
      });
      await expect(
        startPrivateGateway(
          host,
          fixture.activation.signal,
          (item) => captured.push(item),
          (known) => coordinates.push(known),
        ),
      ).rejects.toThrow("Private OpenShell gateway preparation failed");
      expect(coordinates).toEqual([{ tlsDirectory: `${directory}/tls` }]);
      expect(Object.isFrozen(coordinates[0])).toBe(true);
      expect(captured.map((item) => item.kind)).toEqual(["state"]);
      const [provisional] = captured;
      if (!provisional) {
        throw new Error("Provisional state was not captured.");
      }
      await expect(provisional.release()).rejects.toThrow(
        "cleanup could not be confirmed",
      );
      expect(
        (await fixture.effects.host.filesystem.lstat(directory)).isDirectory(),
      ).toBe(true);
      expect(fixture.native.calls).toEqual([["--version"]]);
    } finally {
      fixture.clock.restore();
    }
  });
  it("should derive immutable owned namespace labels and scope the native environment independently of host secrets", async () => {
    const fixture = runtimeFixture();
    const nativeSpawn = spyOn(fixture.effects.host.processEffects, "spawn");
    try {
      const stateDirectory = `/state/pi-openshell-${fixture.effects.host.instanceId}`;
      const host = {
        ...fixture.effects.host,
        environment: {
          ["PATH"]: "/selected/bin",
          ["SECRET_TOKEN"]: "host-only",
        },
      };
      const captured: OwnedResource[] = [];
      const gateway = await startPrivateGateway(
        host,
        fixture.activation.signal,
        (item) => captured.push(item),
        () => undefined,
      );
      try {
        expect(gateway.endpoint).toBe("https://127.0.0.1:43123");
        expect(gateway.networkId).toBe(TEST_NETWORK);
        expect(gateway.labels).toEqual({
          "io.pi.openshell-sandbox.managed-by": "pi-openshell-sandbox",
          "io.pi.openshell-sandbox.owner-uid": "1000",
          "io.pi.openshell-sandbox.instance-id": "abcdefghijklmnop",
        });
        const environment = nativeSpawn.mock.calls.find(
          ([, args]) => args?.[0] === "--config",
        )?.[2]?.env;
        expect(environment).toMatchObject({
          ["PATH"]: "/selected/bin",
          ["HOME"]: `${stateDirectory}/home`,
        });
        expect(environment?.["SECRET_TOKEN"]).toBeUndefined();
        expect(host.environment["SECRET_TOKEN"]).toBe("host-only");
        expect(Object.isFrozen(gateway)).toBe(true);
        expect(Object.isFrozen(gateway.labels)).toBe(true);
        expect(captured.map((item) => item.kind)).toEqual([
          "state",
          "network",
          "process",
        ]);
        expect(fixture.native.launches).toBe(1);
        expect(fixture.native.networkPresent).toBe(true);
      } finally {
        await gateway.close();
      }
      expect(fixture.native.networkPresent).toBe(false);
      await expect(host.filesystem.lstat(stateDirectory)).rejects.toMatchObject(
        { code: "ENOENT" },
      );
    } finally {
      nativeSpawn.mockRestore();
      fixture.clock.restore();
    }
  });
  it("should retain captured recovery capabilities and redact connection payloads when infrastructure cleanup cannot prove ownership", async () => {
    const fixture = runtimeFixture();
    try {
      const inspected = withDockerOutput(
        fixture.effects.host,
        "network inspect",
        "[]",
      );
      const host: GatewayHostContext = {
        ...inspected,
        gatewayEffects: {
          reservePort: () => Promise.resolve(RESERVED_PORT),
          connect: () => Promise.reject(new Error("secret SDK payload")),
        },
      };
      const captured: OwnedResource[] = [];
      const coordinates: GatewayRecoveryCoordinates[] = [];
      const failure = await startPrivateGateway(
        host,
        fixture.activation.signal,
        (item) => captured.push(item),
        (known) => coordinates.push(known),
      ).catch((error: unknown) => error);
      expect(String(failure)).toContain(
        "owned recovery resources were retained",
      );
      expect(String(failure)).not.toContain("secret SDK payload");
      expect(coordinates.at(-1)).toEqual({
        tlsDirectory: "/state/pi-openshell-abcdefghijklmnop/tls",
        networkId: TEST_NETWORK,
        gatewayEndpoint: `https://127.0.0.1:${RESERVED_PORT}`,
      });
      expect(captured.some((item) => item.kind === "process")).toBe(true);
      expect(fixture.native.networkPresent).toBe(true);
      expect(
        (
          await host.filesystem.lstat("/state/pi-openshell-abcdefghijklmnop")
        ).isDirectory(),
      ).toBe(true);
    } finally {
      fixture.clock.restore();
    }
  });
  it("should retain uncertain prerequisite children before state allocation and release them after termination becomes provable", async () => {
    const setup = failedGatewayLaunch();
    let closed = false;
    setup.scenario.child.once("close", () => {
      closed = true;
    });
    const captured: OwnedResource[] = [];
    try {
      const failure = await startPrivateGateway(
        setup.host,
        setup.fixture.activation.signal,
        (item) => captured.push(item),
        () => undefined,
      ).catch((error: unknown) => error);
      expect(String(failure)).toContain(
        "Private OpenShell gateway preparation failed",
      );
      expect(String(failure)).not.toContain("private launch detail");
      expect(captured).toHaveLength(1);
      expect(captured[0]?.kind).toBe("process");
      expect(setup.fixture.filesystem.files.size).toBe(0);
      await expect(captured[0]?.release()).rejects.toThrow(
        "Native process termination could not be confirmed",
      );
      expect(closed).toBe(false);
    } finally {
      try {
        setup.allowTermination();
        await Promise.all(captured.map((item) => item.release()));
      } finally {
        setup.fixture.clock.restore();
      }
    }
    expect(closed).toBe(true);
    expect(setup.scenario.signals).toEqual(["SIGTERM"]);
  });
  it("should publish acquired recovery facts before gated port reservation and authentication settle", async () => {
    const fixture = runtimeFixture();
    const portEntered = Promise.withResolvers<void>();
    const port = Promise.withResolvers<number>();
    const connectionEntered = Promise.withResolvers<void>();
    const connection = Promise.withResolvers<typeof fixture.sdk.client>();
    const coordinates: GatewayRecoveryCoordinates[] = [];
    const host: GatewayHostContext = {
      ...fixture.effects.host,
      gatewayEffects: {
        reservePort: () => {
          portEntered.resolve();
          return port.promise;
        },
        connect: () => {
          connectionEntered.resolve();
          return connection.promise;
        },
      },
    };
    const starting = startPrivateGateway(
      host,
      fixture.activation.signal,
      () => undefined,
      (known) => coordinates.push(known),
    );
    try {
      await portEntered.promise;
      const tlsDirectory = "/state/pi-openshell-abcdefghijklmnop/tls";
      expect(coordinates).toEqual([
        { tlsDirectory },
        { tlsDirectory, networkId: TEST_NETWORK },
      ]);
      expect(fixture.native.launches).toBe(0);
      port.resolve(RESERVED_PORT);
      await connectionEntered.promise;
      expect(coordinates.at(-1)).toEqual({
        tlsDirectory,
        networkId: TEST_NETWORK,
        gatewayEndpoint: `https://127.0.0.1:${RESERVED_PORT}`,
      });
      expect(coordinates.every(Object.isFrozen)).toBe(true);
      expect(fixture.native.launches).toBe(1);
      expect(fixture.sdk.createCount).toBe(0);
      connection.resolve(fixture.sdk.client);
      await (await starting).close();
      expect(fixture.native.networkPresent).toBe(false);
    } finally {
      port.resolve(RESERVED_PORT);
      connection.resolve(fixture.sdk.client);
      await starting.then(
        (gateway) => gateway.close(),
        () => undefined,
      );
      fixture.clock.restore();
    }
  });
  it("should retain acknowledged network coordinates without starting TLS when cancellation arrives after create completes", async () => {
    const fixture = runtimeFixture();
    const host = withDockerOutput(
      fixture.effects.host,
      "network inspect",
      "[]",
    );
    const { clearTimer } = host.processEffects;
    const nativeSpawn = spyOn(host.processEffects, "spawn");
    const coordinates: GatewayRecoveryCoordinates[] = [];
    spyOn(host.processEffects, "clearTimer").mockImplementation((timer) => {
      clearTimer(timer);
      if (fixture.native.networkPresent) {
        fixture.activation.abort();
      }
    });
    try {
      await expect(
        startPrivateGateway(
          host,
          fixture.activation.signal,
          () => undefined,
          (known) => coordinates.push(known),
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(fixture.activation.signal.aborted).toBe(true);
      expect(coordinates.at(-1)).toEqual({
        tlsDirectory: "/state/pi-openshell-abcdefghijklmnop/tls",
        networkId: TEST_NETWORK,
      });
      expect(fixture.native.networkPresent).toBe(true);
      expect(fixture.native.launches).toBe(0);
      expect(nativeSpawn.mock.calls.map(([, argv]) => argv?.[0])).not.toContain(
        "generate-certs",
      );
    } finally {
      fixture.clock.restore();
      nativeSpawn.mockRestore();
    }
  });
});
