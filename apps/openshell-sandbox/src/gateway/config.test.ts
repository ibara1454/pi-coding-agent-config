import { describe, expect, test as it } from "bun:test";
import {
  ChildProcess,
  type SpawnOptions,
  type spawn,
} from "node:child_process";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { unitRuntimeFixture as runtimeFixture } from "../runtime/test/index.helper.ts";
import { prepareGatewayTls, writeGatewayConfig } from "./config.ts";
import { createGatewayState } from "./state.ts";
import {
  network,
  withRead,
  withStats,
} from "./test/acquisition-effects.helper.ts";
import {
  GATEWAY_TEST_CERTIFICATES,
  MISSING_SAN_TEST_CERTIFICATES,
} from "./test/tls-certificates.helper.ts";
import type { GatewayHostContext as HostContext } from "./types.ts";

const FOREIGN_UID = 1001;
const FAILED_EXIT_CODE = 1;
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
  it("should return verified synthetic mTLS credentials without reading JWT secrets", async () => {
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

describe("writeGatewayConfig", () => {
  it("should write private-only loopback mTLS configuration without provider credentials", async () => {
    const fixture = runtimeFixture();
    try {
      const state = await createGatewayState(
        fixture.effects.host,
        () => undefined,
        () => undefined,
      );
      const configPath = await writeGatewayConfig(fixture.effects.host, state, {
        namespace: network.name,
        port: 43_123,
      });
      const contents = await fixture.effects.host.filesystem.readFile(
        configPath,
        "utf8",
      );
      expect(contents).toContain('bind_address = "127.0.0.1:43123"');
      expect(contents).toContain(
        'grpc_endpoint = "https://host.openshell.internal:43123"',
      );
      expect(contents).toContain("allow_unauthenticated_users = false");
      expect(contents).not.toContain("supervisor_bin");
      expect(contents).not.toContain("supervisor_image");
      expect(contents).not.toContain("provider_api_key");
      await state.close();
    } finally {
      fixture.clock.restore();
    }
  });
});
