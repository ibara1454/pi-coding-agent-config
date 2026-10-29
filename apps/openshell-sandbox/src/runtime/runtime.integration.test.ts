import { describe, expect, test as it, spyOn } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { SandboxPolicySchema } from "@nvidia/openshell-sdk/raw";
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

const MILLISECONDS_PER_SECOND = 1000;
const SDK_WALL_NOW_MS = 1_790_146_374_435;
const FRACTIONAL_CLOCK_MS = 0.5;
const CLEANUP_CLOCK_MS = 1;
/** Models the published SDK's wall-clock deadline before Node checks integer timer delay.
 * @example 1.001 seconds yields 1001 integer ms after epoch addition, despite float roundoff.
 */
function requireIntegerSdkDeadline(seconds: number): void {
  const remainingMs =
    SDK_WALL_NOW_MS + seconds * MILLISECONDS_PER_SECOND - SDK_WALL_NOW_MS;
  if (!Number.isInteger(remainingMs)) {
    throw new RangeError("SDK poll requires an integer millisecond delay");
  }
}

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

const NATIVE_TIMEOUT_EXIT = 124;
const NONINTEGER_EXIT = 1.5;
const HOST_TIMER_OVERFLOW_SECONDS = 2_147_484;

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
  it("should defer one validation error without canceling preparation when a signal is already aborted", async () => {
    const fixture = runtimeFixture();
    const runtime = await createSandboxRuntime(
      fixture.environment,
      fixture.effects,
      fixture.observer,
    );
    const controller = new AbortController();
    controller.abort();
    try {
      const result = await completion(
        runtime.exec("ignored", "/project", { signal: controller.signal }),
      );
      expect(result.error?.name).toBe("AbortError");
      expect(result.terminals).toBe(1);
      expect(fixture.sdk.commands).toEqual([]);
      const allowed = await completion(runtime.exec("allowed", "/project"));
      expect(allowed.exitCode).toBe(COMMAND_EXIT_CODE);
    } finally {
      await runtime.dispose();
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
  it("should return cached status without publishing or performing native work", async () => {
    const fixture = await readyFixture();
    try {
      const before = fixture.native.calls.length;
      const publications = fixture.statuses.length;
      const first = fixture.runtime.getStatus();
      expect(fixture.runtime.getStatus()).toEqual(first);
      expect(first.phase).toBe("ready");
      expect(fixture.native.calls).toHaveLength(before);
      expect(fixture.statuses).toHaveLength(publications);
      expect(JSON.stringify(first)).not.toContain("credentials");
    } finally {
      try {
        await fixture.runtime.dispose();
      } finally {
        fixture.clock.restore();
      }
    }
  });

  it("should return the same cleanup promise and release the private gateway on success", async () => {
    const fixture = await readyFixture();
    try {
      const disposal = fixture.runtime.dispose();
      expect(fixture.runtime.dispose()).toBe(disposal);
      await disposal;
      expect(fixture.runtime.getStatus().phase).toBe("closed");
      expect(fixture.runtime.getStatus().recovery).toBeUndefined();
      expect(fixture.native.networkPresent).toBe(false);
      expect(fixture.clock.pending()).toBe(0);
    } finally {
      try {
        await fixture.runtime.dispose().catch(() => undefined);
      } finally {
        fixture.clock.restore();
      }
    }
  });
  it("should retain failure and block further commands when acknowledged deletion is uncertain", async () => {
    const fixture = await readyFixture();
    try {
      fixture.sdk.beforeDelete = () =>
        Promise.reject(new Error("private delete cause"));
      const disposal = fixture.runtime.dispose();
      await expect(disposal).rejects.toMatchObject({
        failure: { code: "cleanup" },
      });
      expect(fixture.runtime.dispose()).toBe(disposal);
      expect(fixture.runtime.getStatus().phase).toBe("recovery-required");
      expect(fixture.native.networkPresent).toBe(true);
      await expect(command(fixture.runtime, "refused")).rejects.toMatchObject({
        failure: { code: "admission" },
      });
      expect(JSON.stringify(fixture.runtime.getStatus())).not.toContain(
        "private delete cause",
      );
    } finally {
      try {
        await fixture.runtime.dispose().catch(() => undefined);
      } finally {
        fixture.clock.restore();
      }
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
  it("should await raw creation settlement before disposal releases the late acknowledged sandbox", async () => {
    const fixture = runtimeFixture();
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
    await entered.promise;
    let disposed = false;
    const disposal = runtime.dispose();
    disposal.then(
      () => {
        disposed = true;
      },
      () => {
        disposed = true;
      },
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(disposed).toBe(false);
      expect(fixture.sdk.deleteCount).toBe(0);
      release.resolve();
      await disposal;
      expect(fixture.sdk.deleteCount).toBe(1);
      expect(fixture.native.sandboxPresent).toBe(false);
      expect(runtime.getStatus().phase).toBe("closed");
    } finally {
      release.resolve();
      await disposal.catch(() => undefined);
    }
  });
  it("should prepare and dispose without SDK deadline rejection when monotonic time is fractional", async () => {
    const fixture = runtimeFixture();
    let clock = 0;
    const now = spyOn(performance, "now").mockImplementation(() => clock);
    fixture.sdk.beforeCreate = () => {
      clock = FRACTIONAL_CLOCK_MS;
      return Promise.resolve();
    };
    fixture.sdk.beforeDelete = () => {
      clock = CLEANUP_CLOCK_MS;
      return Promise.resolve();
    };
    const ready = fixture.sdk.client.sandbox.waitReady;
    fixture.sdk.client.sandbox.waitReady = async (...args) => {
      requireIntegerSdkDeadline(args[1]);
      return await ready(...args);
    };
    const deleted = fixture.sdk.client.sandbox.waitDeleted;
    fixture.sdk.client.sandbox.waitDeleted = async (...args) => {
      requireIntegerSdkDeadline(args[1]);
      return await deleted(...args);
    };
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
      await runtime.dispose();
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
  it.each([
    ["non-absolute working directory", "run", "relative", {}],
    ["NUL command", "run\0private", "/project", {}],
    ["NUL working directory", "run", "/project\0private", {}],
    ["nonpositive timeout", "run", "/project", { timeout: 0 }],
    [
      "nonfinite timeout",
      "run",
      "/project",
      { timeout: Number.POSITIVE_INFINITY },
    ],
    [
      "host timer overflow",
      "run",
      "/project",
      { timeout: HOST_TIMER_OVERFLOW_SECONDS },
    ],
  ])(
    "should refuse sandbox command execution when given %s",
    async (_condition, text, cwd, options) => {
      const fixture = runtimeFixture();
      const runtime = await createSandboxRuntime(
        fixture.environment,
        fixture.effects,
        fixture.observer,
      );
      try {
        const result = await completion(runtime.exec(text, cwd, options));
        expect(result.error).toMatchObject({ failure: { code: "validation" } });
        expect(result.terminals).toBe(1);
        expect(fixture.sdk.commands).toEqual([]);
      } finally {
        await runtime.dispose();
      }
    },
  );
  it("should preserve a native exit code of 124 as an ordinary command result", async () => {
    const fixture = runtimeFixture();
    fixture.sdk.execute = async function* () {
      await Promise.resolve();
      yield { stream: "stderr", data: Buffer.from("ordinary stderr") };
      yield { type: "exit", exitCode: NATIVE_TIMEOUT_EXIT };
    };
    const runtime = await createSandboxRuntime(
      fixture.environment,
      fixture.effects,
      fixture.observer,
    );
    try {
      expect(await completion(runtime.exec("exit 124", "/project"))).toEqual({
        output: "ordinary stderr",
        exitCode: NATIVE_TIMEOUT_EXIT,
        terminals: 1,
      });
      expect(runtime.getStatus().phase).toBe("ready");
    } finally {
      await runtime.dispose();
    }
  });
  it.each([
    [
      "no terminal exit",
      async function* () {
        await Promise.resolve();
        yield { stream: "stdout" as const, data: Buffer.from("partial") };
      },
    ],
    [
      "data after terminal exit",
      async function* () {
        await Promise.resolve();
        yield { type: "exit" as const, exitCode: 0 };
        yield { stream: "stdout" as const, data: Buffer.from("late") };
      },
    ],
    [
      "noninteger terminal exit",
      async function* () {
        await Promise.resolve();
        yield { type: "exit" as const, exitCode: NONINTEGER_EXIT };
      },
    ],
  ])(
    "should invalidate uncertain execution when native stream has %s",
    async (_condition, execute) => {
      const fixture = runtimeFixture();
      fixture.sdk.execute = execute;
      const runtime = await createSandboxRuntime(
        fixture.environment,
        fixture.effects,
        fixture.observer,
      );
      try {
        const result = await completion(runtime.exec("uncertain", "/project"));
        expect(result.error).toMatchObject({ failure: { code: "execution" } });
        expect(result.terminals).toBe(1);
        expect(fixture.sdk.deleteCount).toBe(1);
        expect(runtime.getStatus().phase).toBe("idle");
      } finally {
        await runtime.dispose();
      }
    },
  );
  it("should preserve ready admission when an external progress observer throws", async () => {
    const fixture = runtimeFixture();
    const observer = {
      ...fixture.observer,
      progress: () => {
        throw new Error("private observer state");
      },
    };
    const runtime = await createSandboxRuntime(
      fixture.environment,
      fixture.effects,
      observer,
    );
    try {
      const result = await completion(runtime.exec("still-owned", "/project"));
      expect(result.exitCode).toBe(COMMAND_EXIT_CODE);
      expect(runtime.getStatus().phase).toBe("ready");
    } finally {
      await runtime.dispose();
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
