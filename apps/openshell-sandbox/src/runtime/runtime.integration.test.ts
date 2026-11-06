import { describe, expect, test as it, spyOn } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { SandboxClient } from "@nvidia/openshell-sdk";
import {
  SandboxPhase,
  SandboxPolicySchema,
  SandboxResponseSchema,
} from "@nvidia/openshell-sdk/raw";
import { completion } from "./execution/test/index.helper.ts";
import { createSandboxRuntime } from "./runtime.ts";
import {
  heldExecutionFixture,
  unitRuntimeFixture,
} from "./test/index.helper.ts";
import {
  providerRuntimeFixture,
  runtimeFixture,
} from "./test/runtime.helper.ts";
import type { SandboxRuntime } from "./types.ts";

const COMMAND_EXIT_CODE = 7;
const SANDBOX_NAME_PREFIX = /^po-/;
const NETWORK_ID_HEX_LENGTH = 64;
const HTTPS_PORT = 443;

/** Prepares a runtime through a readiness-gated fixture command; callers own disposal.
 * @example readyFixture() resolves after a native fixture command proves readiness.
 */
async function readyFixture() {
  const fixture = unitRuntimeFixture();
  const runtime = await createSandboxRuntime(
    fixture.environment,
    fixture.effects,
    fixture.observer,
  );
  try {
    await command(runtime, "true");
    return { ...fixture, runtime };
  } catch (error) {
    try {
      await runtime.dispose().catch(() => undefined);
    } finally {
      fixture.clock.restore();
    }
    throw error;
  }
}

/** Collects one terminal command event through the public runtime handle.
 * @example command(runtime, "true") returns the native exit code.
 */
function command(runtime: SandboxRuntime, text: string): Promise<number> {
  const result = Promise.withResolvers<number>();
  runtime
    .exec(text, "/project")
    .on("exit", ({ exitCode }) => result.resolve(exitCode))
    .on("error", result.reject);
  return result.promise;
}

const SDK_WALL_NOW_MS = 1_790_146_374_435;
const FRACTIONAL_CLOCK_MS = 0.5;
const CLEANUP_CLOCK_MS = 1;

/** Starts a command while provider creation is held before its lost acknowledgment.
 * @returns Runtime, observed command result, and gates; the caller must release and dispose.
 * @example await fixture.entered.promise observes gateway acquisition before sandbox creation.
 */
async function lostProviderAcknowledgmentFixture() {
  const fixture = providerRuntimeFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  fixture.sdk.client.raw.createProvider = async () => {
    entered.resolve();
    await release.promise;
    throw new ConnectError("private lost acknowledgment", Code.Unavailable);
  };
  const runtime = await createSandboxRuntime(
    fixture.environment,
    fixture.effects,
    fixture.observer,
  );
  const result = completion(runtime.exec("never-executed", "/project"));
  return { fixture, entered, release, runtime, result };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("createSandboxRuntime", () => {
  it("should share readiness without guest setup and stream nonzero model results when commands arrive concurrently", async () => {
    const fixture = runtimeFixture();
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.sdk.beforeCreate = async () => {
      reached.resolve();
      await release.promise;
    };
    const runtime = await createSandboxRuntime(
      fixture.environment,
      fixture.effects,
      fixture.observer,
    );
    try {
      await reached.promise;
      expect(runtime.getStatus().phase).toBe("preparing");
      const first = completion(runtime.exec("first", "/project"));
      const second = completion(runtime.exec("second", "/project"));
      release.resolve();
      expect(await first).toEqual({
        output: "output",
        exitCode: 7,
        terminals: 1,
      });
      expect(await second).toEqual({
        output: "output",
        exitCode: 7,
        terminals: 1,
      });
      expect(fixture.sdk.createCount).toBe(1);
      expect(fixture.native.launches).toBe(1);
      const dockerCommands = fixture.native.calls.filter(
        (args) => args[0] === "--host",
      );
      expect(dockerCommands.length).toBeGreaterThan(0);
      expect(
        dockerCommands.every(
          (args) => args[2] === "info" || args[2] === "network",
        ),
      ).toBe(true);
      expect(runtime.getStatus().phase).toBe("ready");
      expect(fixture.sdk.commands).toEqual(["first", "second"]);
    } finally {
      release.resolve();
      await runtime.dispose();
    }
  });
  it("should retain sanitized recovery facts when provider release fails after confirmed sandbox deletion", async () => {
    const fixture = providerRuntimeFixture();
    const runtime = await createSandboxRuntime(
      fixture.environment,
      fixture.effects,
      fixture.observer,
    );
    try {
      expect(
        (await completion(runtime.exec("ready", "/project"))).error,
      ).toBeUndefined();
      const { recovery } = runtime.getStatus();
      expect(recovery?.gatewayEndpoint).toBeDefined();
      expect(recovery?.tlsDirectory).toBeDefined();
      expect(recovery?.networkId).toBeDefined();
      fixture.sdk.client.raw.deleteProvider = () =>
        Promise.reject(new Error("private provider cleanup payload"));
      await expect(runtime.dispose()).rejects.toThrow();
      expect(fixture.native.sandboxPresent).toBe(false);
      expect(fixture.native.networkPresent).toBe(true);
      expect(runtime.getStatus()).toMatchObject({
        phase: "recovery-required",
        recovery,
      });
      expect(Object.isFrozen(runtime.getStatus().recovery)).toBe(true);
      expect(JSON.stringify(runtime.getStatus())).not.toContain(
        "private provider",
      );
    } finally {
      await runtime.dispose().catch(() => undefined);
    }
  });
  it("should retain unknown SDK creation without deleting or replacing a possibly created sandbox", async () => {
    const fixture = runtimeFixture();
    fixture.sdk.beforeCreate = () =>
      Promise.reject(
        new ConnectError("sensitive transport payload", Code.Unavailable),
      );
    const runtime = await createSandboxRuntime(
      fixture.environment,
      fixture.effects,
      fixture.observer,
    );
    try {
      const first = await completion(runtime.exec("never", "/project"));
      expect(first.error?.message).not.toContain("sensitive");
      expect(runtime.getStatus().phase).toBe("recovery-required");
      expect(runtime.getStatus().recovery?.createOutcome).toBe("unknown");
      expect(fixture.native.sandboxPresent).toBe(true);
      expect(fixture.sdk.deleteCount).toBe(0);
      expect(fixture.sdk.stopCount).toBe(0);
      expect(
        (await completion(runtime.exec("again", "/project"))).error,
      ).toBeDefined();
      expect(fixture.sdk.createCount).toBe(1);
      const firstDisposal = runtime.dispose();
      expect(runtime.dispose()).toBe(firstDisposal);
      await expect(firstDisposal).rejects.toThrow();
      expect(
        fixture.failures.some((failure) => failure.code === "cleanup"),
      ).toBe(true);
    } finally {
      await runtime.dispose().catch(() => undefined);
    }
  });
  it("should preserve preparation failure without cleanup uncertainty when native create rejects invalid arguments", async () => {
    const fixture = runtimeFixture();
    fixture.sdk.beforeCreate = () => {
      fixture.native.sandboxPresent = false;
      return Promise.reject(
        new ConnectError("secret policy", Code.InvalidArgument),
      );
    };
    const runtime = await createSandboxRuntime(
      fixture.environment,
      fixture.effects,
      fixture.observer,
    );
    try {
      const result = await completion(runtime.exec("never", "/project"));
      expect(result.error).toBeDefined();
      expect(runtime.getStatus().phase).toBe("idle");
      expect(runtime.getStatus().lastFailure?.code).toBe("preparation");
      expect(fixture.sdk.deleteCount).toBe(0);
      expect(
        fixture.failures.some((failure) => failure.code === "preparation"),
      ).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });
  it("should capture late acknowledgment before cleaning canceled preparation and reuse the complete gateway", async () => {
    const fixture = runtimeFixture();
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.sdk.beforeCreate = async () => {
      reached.resolve();
      await release.promise;
    };
    const runtime = await createSandboxRuntime(
      fixture.environment,
      fixture.effects,
      fixture.observer,
    );
    const controller = new AbortController();
    const first = completion(
      runtime.exec("not-replayed", "/project", { signal: controller.signal }),
    );
    await reached.promise;
    controller.abort();
    release.resolve();
    expect((await first).error).toBeDefined();
    expect(runtime.getStatus().phase).toBe("idle");
    expect(runtime.getStatus().recovery).toMatchObject({
      createOutcome: "acknowledged",
      gatewayEndpoint: "https://127.0.0.1:43123",
    });
    expect(fixture.sdk.deleteCount).toBe(1);
    fixture.sdk.beforeCreate = async () => undefined;
    try {
      expect(
        (await completion(runtime.exec("fresh", "/project"))).exitCode,
      ).toBe(COMMAND_EXIT_CODE);
      expect(fixture.native.launches).toBe(1);
      expect(fixture.sdk.createCount).toBe(2);
      expect(fixture.sdk.commands).toEqual(["fresh"]);
    } finally {
      await runtime.dispose();
    }
  });
  it("should invalidate every concurrent command before one terminal error when execution is canceled", async () => {
    const fixture = runtimeFixture();
    const running = Promise.withResolvers<void>();
    fixture.sdk.execute = async function* (signal) {
      yield { stream: "stdout", data: Buffer.from("live") };
      running.resolve();
      const ended = Promise.withResolvers<void>();
      const abort = () => ended.resolve();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        ended.resolve();
      }
      try {
        await ended.promise;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    };
    const runtime = await createSandboxRuntime(
      fixture.environment,
      fixture.effects,
      fixture.observer,
    );
    const controller = new AbortController();
    const first = completion(
      runtime.exec("writer", "/project", { signal: controller.signal }),
    );
    const second = completion(runtime.exec("peer", "/project"));
    await running.promise;
    controller.abort();
    try {
      for (const result of await Promise.all([first, second])) {
        expect(result.error).toBeDefined();
        expect(result.terminals).toBe(1);
      }
      expect(fixture.sdk.stopCount).toBe(1);
      expect(fixture.sdk.deleteCount).toBe(1);
      expect(runtime.getStatus().phase).toBe("idle");
    } finally {
      await runtime.dispose();
    }
  });
  it("should block only the affected activation after deletion uncertainty", async () => {
    const fixture = runtimeFixture();
    fixture.sdk.execute = async function* () {
      await Promise.resolve();
      yield { stream: "stdout", data: Buffer.from("partial") };
    };
    fixture.sdk.beforeDelete = () => Promise.reject(new Error("lost delete"));
    const runtime = await createSandboxRuntime(
      fixture.environment,
      fixture.effects,
      fixture.observer,
    );
    expect(
      (await completion(runtime.exec("unknown-exit", "/project"))).error,
    ).toBeDefined();
    expect(runtime.getStatus().phase).toBe("recovery-required");
    await expect(runtime.dispose()).rejects.toThrow();
    const fresh = runtimeFixture();
    const replacement = await createSandboxRuntime(
      fresh.environment,
      fresh.effects,
      fresh.observer,
    );
    try {
      expect(
        (await completion(replacement.exec("new-activation", "/project")))
          .exitCode,
      ).toBe(COMMAND_EXIT_CODE);
    } finally {
      await replacement.dispose();
    }
  });

  it("should reuse a ready generation across commands and invalidate it after an incomplete stream", async () => {
    const fixture = await readyFixture();
    try {
      expect(await command(fixture.runtime, "first")).toBe(COMMAND_EXIT_CODE);
      expect(await command(fixture.runtime, "second")).toBe(COMMAND_EXIT_CODE);
      expect(fixture.sdk.createCount).toBe(1);
      fixture.sdk.execute = async function* () {
        await Promise.resolve();
        yield { stream: "stdout", data: Buffer.from("unterminated") };
      };
      await expect(
        command(fixture.runtime, "incomplete"),
      ).rejects.toMatchObject({ failure: { operation: "stream" } });
      expect(fixture.runtime.getStatus().phase).toBe("idle");
      expect(fixture.sdk.deleteCount).toBe(1);
      expect(fixture.native.networkPresent).toBe(true);
    } finally {
      try {
        await fixture.runtime.dispose();
      } finally {
        fixture.clock.restore();
      }
    }
  });
  it("should detach publication while raw native creation keeps the private gateway owned", async () => {
    const fixture = unitRuntimeFixture();
    try {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      fixture.sdk.beforeCreate = async () => {
        entered.resolve();
        await release.promise;
      };
      const runtime = await createSandboxRuntime(
        fixture.environment,
        fixture.effects,
        fixture.observer,
      );
      try {
        await entered.promise;
        const publications = fixture.statuses.length;
        fixture.activation.abort();
        const disposal = runtime.dispose();
        let disposed = false;
        disposal.then(
          () => {
            disposed = true;
          },
          () => {
            disposed = true;
          },
        );
        await Promise.resolve();
        expect(disposed).toBe(false);
        expect(fixture.native.networkPresent).toBe(true);
        expect(fixture.sdk.deleteCount).toBe(0);
        release.resolve();
        await disposal;
        expect(fixture.sdk.createCount).toBe(1);
        expect(fixture.sdk.deleteCount).toBe(1);
        expect(runtime.getStatus().phase).toBe("closed");
        expect(fixture.statuses).toHaveLength(publications);
      } finally {
        release.resolve();
        await runtime.dispose().catch(() => undefined);
      }
    } finally {
      fixture.clock.restore();
    }
  });
  it("should prepare and dispose without SDK deadline rejection when monotonic time is fractional", async () => {
    const fixture = runtimeFixture();
    let clock = 0;
    const now = spyOn(performance, "now").mockImplementation(() => clock);
    const wall = spyOn(Date, "now").mockReturnValue(SDK_WALL_NOW_MS);
    fixture.sdk.beforeCreate = () => {
      clock = FRACTIONAL_CLOCK_MS;
      return Promise.resolve();
    };
    fixture.sdk.beforeDelete = () => {
      clock = CLEANUP_CLOCK_MS;
      return Promise.resolve();
    };
    const { client } = fixture.sdk;
    client.raw.getSandbox = () => {
      if (!fixture.native.sandboxPresent) {
        return Promise.reject(new ConnectError("absent", Code.NotFound));
      }
      return Promise.resolve(
        create(SandboxResponseSchema, {
          sandbox: {
            metadata: {
              id: fixture.native.sandboxId ?? "",
              name: fixture.native.sandboxName ?? "",
              labels: fixture.native.labels,
            },
            status: {
              phase:
                fixture.native.phase === "stopped"
                  ? SandboxPhase.STOPPED
                  : SandboxPhase.READY,
            },
          },
        }),
      );
    };
    Object.assign(client, {
      sandbox: new SandboxClient(client.sandbox.transport, client.raw),
    });
    const runtime = await createSandboxRuntime(
      fixture.environment,
      fixture.effects,
      fixture.observer,
    );
    const exit = Promise.withResolvers<number>();
    runtime
      .exec("run", "/project")
      .on("exit", ({ exitCode }) => exit.resolve(exitCode))
      .on("error", exit.reject);
    try {
      expect(await exit.promise).toBe(COMMAND_EXIT_CODE);
      await runtime.dispose();
      expect(runtime.getStatus().phase).toBe("closed");
      expect(fixture.native.sandboxPresent).toBe(false);
      expect(fixture.native.networkPresent).toBe(false);
    } finally {
      try {
        await runtime.dispose().catch(() => undefined);
      } finally {
        now.mockRestore();
        wall.mockRestore();
      }
    }
  });
  it("should report preparation rather than a synthetic abort when native readiness fails", async () => {
    const fixture = runtimeFixture();
    fixture.sdk.beforeReady = () =>
      Promise.reject(new Error("sensitive native readiness"));
    const runtime = await createSandboxRuntime(
      fixture.environment,
      fixture.effects,
      fixture.observer,
    );
    const terminal = Promise.withResolvers<Error>();
    let terminals = 0;
    runtime
      .exec("never", "/project")
      .on("error", (error) => {
        terminals += 1;
        terminal.resolve(error);
      })
      .on("exit", () => terminal.reject(new Error("unexpected command exit")));
    try {
      const error = await terminal.promise;
      expect(error).toMatchObject({
        name: "Error",
        failure: { code: "preparation" },
      });
      expect(error.message).not.toContain("sensitive");
      expect(terminals).toBe(1);
      expect(runtime.getStatus().phase).toBe("idle");
      expect(fixture.native.sandboxPresent).toBe(false);
    } finally {
      await runtime.dispose().catch(() => undefined);
    }
  });
  it("should report caller cancellation after failed readiness cleanup settles when abort arrives during cleanup", async () => {
    const fixture = runtimeFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.sdk.beforeReady = () =>
      Promise.reject(new Error("sensitive native readiness"));
    fixture.sdk.beforeDelete = async () => {
      entered.resolve();
      await release.promise;
    };
    const runtime = await createSandboxRuntime(
      fixture.environment,
      fixture.effects,
      fixture.observer,
    );
    const controller = new AbortController();
    const terminal = Promise.withResolvers<Error>();
    let terminals = 0;
    runtime
      .exec("never", "/project", { signal: controller.signal })
      .on("error", (error) => {
        terminals += 1;
        terminal.resolve(error);
      })
      .on("exit", () => terminal.reject(new Error("unexpected command exit")));
    await entered.promise;
    try {
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(terminals).toBe(0);
      release.resolve();
      const error = await terminal.promise;
      expect(error).toMatchObject({
        name: "AbortError",
        failure: { code: "aborted" },
      });
      expect(error.message).not.toContain("sensitive");
      expect(terminals).toBe(1);
      expect(fixture.sdk.deleteCount).toBe(1);
      expect(fixture.native.sandboxPresent).toBe(false);
      expect(runtime.getStatus().phase).toBe("idle");
    } finally {
      release.resolve();
      await runtime.dispose().catch(() => undefined);
    }
  });
  it("should retain a late provider and private gateway until canceled setup and disposal settle", async () => {
    const fixture = providerRuntimeFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const created: string[] = [];
    const deleted: string[] = [];
    const { createProvider, deleteProvider } = fixture.sdk.client.raw;
    fixture.sdk.client.raw.createProvider = async (...args) => {
      created.push(args[0].provider?.metadata?.name ?? "");
      entered.resolve();
      await release.promise;
      return await createProvider(...args);
    };
    fixture.sdk.client.raw.deleteProvider = async (...args) => {
      const result = await deleteProvider(...args);
      const [{ name }] = args;
      if (!name) {
        throw new Error("Native provider deletion omitted its name.");
      }
      deleted.push(name);
      return result;
    };
    const runtime = await createSandboxRuntime(
      fixture.environment,
      fixture.effects,
      fixture.observer,
    );
    try {
      await entered.promise;
      const disposal = runtime.dispose();
      await Promise.resolve();
      expect(deleted).toEqual([]);
      expect(fixture.native.networkPresent).toBe(true);
      release.resolve();
      await disposal;
      expect(created).toHaveLength(1);
      expect(deleted).toEqual(created);
      expect(fixture.native.networkPresent).toBe(false);
      expect(fixture.sdk.createCount).toBe(0);
      expect(runtime.getStatus().phase).toBe("closed");
    } finally {
      release.resolve();
      await runtime.dispose().catch(() => undefined);
    }
  });
  it("should release providers and gateway without a create RPC when a policy binding names an unconfigured provider", async () => {
    const fixture = providerRuntimeFixture();
    const { raw } = fixture.sdk.client;
    const created = spyOn(raw, "createProvider");
    const deleted = spyOn(raw, "deleteProvider");
    const runtime = await createSandboxRuntime(
      {
        ...fixture.environment,
        policy: {
          sourcePath: "/policy.yaml",
          sdkPolicy: create(SandboxPolicySchema, {
            version: 1,
            networkPolicies: {
              registry: {
                name: "registry",
                binaries: [{ path: "/usr/bin/curl" }],
                endpoints: [
                  {
                    host: "npm.example",
                    ports: [HTTPS_PORT],
                    credentialBinding: { provider: "missing" },
                  },
                ],
              },
            },
          }),
        },
      },
      fixture.effects,
      fixture.observer,
    );
    try {
      const result = await completion(
        runtime.exec("never-executed", "/project"),
      );
      expect(result.error).toMatchObject({ failure: { code: "preparation" } });
      expect(runtime.getStatus().phase).toBe("idle");
      expect(fixture.sdk.createCount).toBe(0);
      expect(fixture.sdk.commands).toEqual([]);
      expect(fixture.native.launches).toBe(1);
      expect(created).toHaveBeenCalledTimes(1);
      await runtime.dispose();
      expect(deleted).toHaveBeenCalledTimes(1);
      const name = created.mock.calls[0]?.[0].provider?.metadata?.name;
      expect(deleted.mock.calls[0]?.[0].name).toBe(name);
      if (!name) {
        throw new Error("Missing created native provider name.");
      }
      await expect(raw.getProvider({ name })).rejects.toThrow(
        "Provider missing",
      );
      expect(runtime.getStatus().phase).toBe("closed");
      expect(fixture.native.networkPresent).toBe(false);
      expect(fixture.native.sandboxPresent).toBe(false);
    } finally {
      try {
        await runtime.dispose();
      } finally {
        created.mockRestore();
        deleted.mockRestore();
      }
    }
  });
  it("should retain acquired gateway coordinates when provider creation loses its acknowledgment", async () => {
    const { fixture, entered, release, runtime, result } =
      await lostProviderAcknowledgmentFixture();
    try {
      await entered.promise;
      const acquired = runtime.getStatus().recovery;
      expect(acquired).toEqual({
        sandboxName: expect.stringMatching(SANDBOX_NAME_PREFIX),
        gatewayEndpoint: "https://127.0.0.1:43123",
        tlsDirectory: `/state/pi-openshell-${fixture.effects.host.instanceId}/tls`,
        networkId: "d".repeat(NETWORK_ID_HEX_LENGTH),
      });
      expect(Object.isFrozen(acquired)).toBe(true);
      expect(fixture.sdk.createCount).toBe(0);
      release.resolve();
      expect((await result).error).toMatchObject({
        failure: { code: "cleanup" },
      });
      expect(runtime.getStatus()).toMatchObject({
        phase: "recovery-required",
        lastFailure: { code: "cleanup" },
        recovery: acquired,
      });
      expect(runtime.getStatus().recovery).not.toHaveProperty("createOutcome");
      expect(fixture.native.networkPresent).toBe(true);
      expect(fixture.native.launches).toBe(1);
      expect(fixture.sdk.createCount).toBe(0);
      expect(fixture.sdk.commands).toEqual([]);
      expect(
        (await completion(runtime.exec("refused", "/project"))).error,
      ).toMatchObject({ failure: { code: "admission" } });
      await expect(runtime.dispose()).rejects.toMatchObject({
        failure: { code: "cleanup" },
      });
      expect(runtime.getStatus().recovery).toEqual(acquired);
      expect(fixture.native.networkPresent).toBe(true);
      expect(JSON.stringify(runtime.getStatus())).not.toContain(
        "private-provider-secret",
      );
      expect(JSON.stringify(runtime.getStatus())).not.toContain(
        "private lost acknowledgment",
      );
    } finally {
      release.resolve();
      await result;
      await runtime.dispose().catch(() => undefined);
    }
  });
  it("should defer gateway disposal while canceled SDK execution remains unsettled", async () => {
    const { runtime, native, counts, entered, release, rawSettled } =
      await heldExecutionFixture();
    const caller = new AbortController();
    let disposed = false;
    const result = completion(
      runtime.exec("pending-native-rpc", "/project", { signal: caller.signal }),
    );
    let disposal: Promise<void> | undefined;
    try {
      await entered.promise;
      caller.abort();
      const cancelled = await result;
      expect(cancelled.error).toMatchObject({ name: "AbortError" });
      expect(cancelled.terminals).toBe(1);
      expect(native.networkPresent).toBe(true);
      disposal = runtime.dispose();
      disposal.then(
        () => {
          disposed = true;
        },
        () => {
          disposed = true;
        },
      );
      await Promise.resolve();
      expect(disposed).toBe(false);
      expect(counts.gatewaySignals).toBe(0);
      expect(native.networkPresent).toBe(true);
      release.resolve();
      await rawSettled.promise;
      await disposal;
      expect(counts.gatewaySignals).toBeGreaterThan(0);
      expect(native.networkPresent).toBe(false);
      expect(runtime.getStatus().phase).toBe("closed");
    } finally {
      caller.abort();
      release.resolve();
      await result;
      await (disposal ?? runtime.dispose());
    }
  });
});
