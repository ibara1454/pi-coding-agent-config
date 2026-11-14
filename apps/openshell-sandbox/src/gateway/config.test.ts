import { describe, expect, test as it } from "bun:test";
import {
  ChildProcess,
  type SpawnOptions,
  type spawn,
} from "node:child_process";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { TOML } from "bun";
import { unitRuntimeFixture as runtimeFixture } from "../runtime/test/index.helper.ts";
import { prepareGatewayTls, writeGatewayConfig } from "./config.ts";
import { createGatewayState } from "./state.ts";
import { withRead, withStats } from "./test/acquisition-effects.helper.ts";
import {
  GATEWAY_TEST_CERTIFICATES,
  MISSING_SAN_TEST_CERTIFICATES,
} from "./test/tls-certificates.helper.ts";
import type { GatewayHostContext as HostContext } from "./types.ts";

const FOREIGN_UID = 1001;
const FAILED_EXIT_CODE = 1;
const PRIVATE_GATEWAY_PORT = 43_123;
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("prepareGatewayTls", () => {
  it("should reject signed matching TLS material when private callback SANs are missing", async () => {
    const fixture = runtimeFixture();
    try {
      const state = await createGatewayState(
        fixture.effects.host,
        () => undefined,
        () => undefined,
      );
      const host = withRead(fixture.effects.host, (path, value) => {
        const leaf = path.slice(state.tlsDirectory.length + 1);
        const replacement = MISSING_SAN_TEST_CERTIFICATES[leaf];
        return replacement ? Buffer.from(replacement) : value;
      });
      try {
        await expect(
          prepareGatewayTls(host, state, fixture.activation.signal),
        ).rejects.toThrow("Private TLS certificate SANs are incomplete");
      } finally {
        await state.close();
      }
    } finally {
      fixture.clock.restore();
    }
  });
  it("should return verified synthetic mTLS credentials without reading CA or JWT secrets", async () => {
    const fixture = runtimeFixture();
    try {
      const state = await createGatewayState(
        fixture.effects.host,
        () => undefined,
        () => undefined,
      );
      const read: string[] = [];
      const host = withRead(fixture.effects.host, (path, value) => {
        read.push(path);
        return value;
      });
      const tls = await prepareGatewayTls(
        host,
        state,
        fixture.activation.signal,
      );
      expect(tls.clientCert.toString()).toContain("BEGIN CERTIFICATE");
      expect(tls.clientKey.toString()).toContain("BEGIN PRIVATE KEY");
      expect(read.every((path) => !path.includes("/jwt/"))).toBe(true);
      expect(read.some((path) => path.endsWith("/ca.key"))).toBe(false);
      await state.close();
    } finally {
      fixture.clock.restore();
    }
  });
  it.each([
    ["foreign directory", "", { uid: FOREIGN_UID }],
    [
      "symbolic-link file",
      "ca.crt",
      { isFile: () => false, isSymbolicLink: () => true },
    ],
    ["empty file", "ca.crt", { size: 0 }],
    ["empty CA key", "ca.key", { size: 0 }],
    ["empty JWT key", "jwt/signing.pem", { size: 0 }],
  ] as [string, string, Partial<Stats>][])(
    "should reject TLS material when it contains a %s",
    async (_condition, leaf, changed) => {
      const fixture = runtimeFixture();
      try {
        const state = await createGatewayState(
          fixture.effects.host,
          () => undefined,
          () => undefined,
        );
        const target = leaf
          ? join(state.tlsDirectory, leaf)
          : state.tlsDirectory;
        const host = withStats(fixture.effects.host, (path, stat) =>
          path === target ? ({ ...stat, ...changed } as Stats) : stat,
        );
        try {
          await expect(
            prepareGatewayTls(host, state, fixture.activation.signal),
          ).rejects.toThrow("Private TLS");
        } finally {
          await state.close();
        }
      } finally {
        fixture.clock.restore();
      }
    },
  );
  it("should reject a server certificate with a mismatched private key", async () => {
    const fixture = runtimeFixture();
    try {
      const state = await createGatewayState(
        fixture.effects.host,
        () => undefined,
        () => undefined,
      );
      const mismatchedKey = GATEWAY_TEST_CERTIFICATES["client/tls.key"];
      if (!mismatchedKey) {
        throw new Error("Synthetic client key is unavailable.");
      }
      const serverKeyHost = withRead(fixture.effects.host, (path, value) =>
        path.endsWith("/server/tls.key") ? Buffer.from(mismatchedKey) : value,
      );
      try {
        await expect(
          prepareGatewayTls(serverKeyHost, state, fixture.activation.signal),
        ).rejects.toThrow("chain or keys");
      } finally {
        await state.close();
      }
    } finally {
      fixture.clock.restore();
    }
  });
  it("should reject failed native certificate generation before reading TLS files", async () => {
    const fixture = runtimeFixture();
    try {
      const state = await createGatewayState(
        fixture.effects.host,
        () => undefined,
        () => undefined,
      );
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
            if (argv[0] !== "generate-certs") {
              return original(executable, argv, options);
            }
            const child = new ChildProcess();
            Object.defineProperties(child, {
              stdout: { value: new PassThrough() },
              stderr: { value: new PassThrough() },
            });
            queueMicrotask(() => {
              child.emit("spawn");
              Object.defineProperty(child, "exitCode", {
                value: FAILED_EXIT_CODE,
              });
              // biome-ignore lint/plugin/biome-rules/use-undefined: Node child close reports null when no termination signal was received.
              child.emit("close", FAILED_EXIT_CODE, null);
            });
            return child;
          }) as typeof spawn,
        },
      };
      try {
        await expect(
          prepareGatewayTls(host, state, fixture.activation.signal),
        ).rejects.toThrow("certificate generation failed");
      } finally {
        await state.close();
      }
    } finally {
      fixture.clock.restore();
    }
  });
  it("should request every private callback SAN in the owner-scoped certificate directory", async () => {
    const fixture = runtimeFixture();
    try {
      const state = await createGatewayState(
        fixture.effects.host,
        () => undefined,
        () => undefined,
      );
      try {
        await prepareGatewayTls(
          fixture.effects.host,
          state,
          fixture.activation.signal,
        );
        expect(
          fixture.native.calls.filter((args) => args[0] === "generate-certs"),
        ).toEqual([
          [
            "generate-certs",
            "--output-dir",
            state.tlsDirectory,
            "--server-san",
            "localhost",
            "--server-san",
            "127.0.0.1",
            "--server-san",
            "host.openshell.internal",
          ],
        ]);
      } finally {
        await state.close();
      }
    } finally {
      fixture.clock.restore();
    }
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite keeps one configuration artifact's trust-boundary assertions together.
describe("writeGatewayConfig", () => {
  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: One native configuration artifact carries the linked gateway trust boundaries.
  it("should write private schema-v2 Docker configuration without host credentials", async () => {
    const fixture = runtimeFixture();
    const providerSecret = "provider-secret-must-not-reach-config";
    const host: HostContext = {
      ...fixture.effects.host,
      environment: {
        ...fixture.effects.host.environment,
        ["PROVIDER_API_KEY"]: providerSecret,
      },
    };
    try {
      const state = await createGatewayState(
        host,
        () => undefined,
        () => undefined,
      );
      try {
        const configPath = await writeGatewayConfig(host, state, {
          namespace: "pi-test",
          port: PRIVATE_GATEWAY_PORT,
        });
        const contents = await host.filesystem.readFile(configPath, "utf8");
        const native = TOML.parse(contents);
        expect(native).toMatchObject({
          openshell: {
            version: 2,
            gateway: {
              ["bind_address"]: "127.0.0.1:43123",
              ["compute_driver"]: "docker",
              ["enable_loopback_service_http"]: false,
              ["guest_tls_ca"]: join(state.tlsDirectory, "ca.crt"),
              ["guest_tls_cert"]: join(state.tlsDirectory, "client/tls.crt"),
              ["guest_tls_key"]: join(state.tlsDirectory, "client/tls.key"),
              tls: {
                ["cert_path"]: join(state.tlsDirectory, "server/tls.crt"),
                ["key_path"]: join(state.tlsDirectory, "server/tls.key"),
                ["client_ca_path"]: join(state.tlsDirectory, "ca.crt"),
              },
              ["mtls_auth"]: { enabled: true },
              auth: { ["allow_unauthenticated_users"]: false },
            },
            drivers: {
              docker: {
                ["socket_path"]: host.dockerEndpoint.slice("unix://".length),
                ["grpc_endpoint"]: "https://127.0.0.1:43123",
                ["enable_bind_mounts"]: true,
                ["allow_driver_config"]: true,
                ["resource_admission"]: { enabled: false },
              },
            },
          },
        });
        expect(native).not.toHaveProperty(
          "openshell.drivers.docker.supervisor_bin",
        );
        expect(native).not.toHaveProperty(
          "openshell.drivers.docker.supervisor_image",
        );
        expect(native).not.toHaveProperty(
          "openshell.drivers.docker.sandbox_runtime_image",
        );
        expect(contents).not.toContain(providerSecret);
      } finally {
        await state.close();
      }
    } finally {
      fixture.clock.restore();
    }
  });
});
