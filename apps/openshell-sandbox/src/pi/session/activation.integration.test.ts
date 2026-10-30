import { describe, expect, test as it } from "bun:test";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProcessEffects } from "../../host/index.ts";
import { processScenario } from "../../host/test/index.helper.ts";
import {
  CLEANUP_TIMEOUT_MS,
  type SandboxRuntime,
} from "../../runtime/index.ts";
import { runtimeFixture } from "../../runtime/test/index.helper.ts";
import type { PiNativeCapabilities } from "../index.ts";
import {
  adapterFixture,
  adapterRuntimeFixture,
  cachedStatus,
  piUnitFixture,
} from "../test/index.helper.ts";
import { AdapterActivation } from "./activation.ts";

/** Supplies a handle whose teardown outcome is externally controlled, with no native resources. */
function failingRuntime(dispose: () => Promise<void>): SandboxRuntime {
  return {
    dispose,
    getStatus: () => cachedStatus(),
    exec: () => {
      throw new Error("unexpected execution");
    },
  };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("AdapterActivation.prepare", () => {
  it("should retain a usable runtime and dispose its owned resources when preparation succeeds", async () => {
    const f = adapterRuntimeFixture();
    const activation = new AdapterActivation(f.context);
    try {
      await activation.prepare(f.pi);
      const { runtime } = activation;
      if (!runtime) {
        throw new Error("Missing prepared runtime");
      }
      const terminal = await once(runtime.exec("fixture", "/project"), "exit");
      expect(terminal).toEqual([{ exitCode: 0 }]);
      expect(runtime.getStatus().phase).toBe("ready");
    } finally {
      await activation.dispose(f.pi);
    }
    expect(activation.runtime).toBeUndefined();
    expect(
      f.runtimes.every(
        (runtime) =>
          !(runtime.native.sandboxPresent || runtime.native.networkPresent),
      ),
    ).toBe(true);
  });
  it("should reach readiness and report the native command exit when controlled native preparation succeeds", async () => {
    const f = piUnitFixture();
    const activation = new AdapterActivation(f.context, f.native);
    try {
      await activation.prepare(f.pi);
      const { runtime } = activation;
      if (!runtime) {
        throw new Error("Missing prepared native runtime");
      }
      const terminal = await once(runtime.exec("fixture", "/project"), "exit");
      expect(terminal).toEqual([{ exitCode: 7 }]);
      expect(runtime.getStatus().phase).toBe("ready");
      expect(f.runtime.native.launches).toBe(1);
      expect(f.runtime.sdk.createCount).toBe(1);
    } finally {
      try {
        await activation.dispose(f.pi);
      } finally {
        f.restore();
      }
    }
    expect(activation.runtime).toBeUndefined();
    expect(f.runtime.sdk.deleteCount).toBe(1);
    expect(f.runtime.native.sandboxPresent).toBe(false);
    expect(f.runtime.native.networkPresent).toBe(false);
  });
  it.each([false, true])(
    "should remain blocked after settings failure when footer failure is %s",
    async (brokenFooter) => {
      const f = adapterRuntimeFixture();
      f.readSettings.mockRejectedValue(new Error("PRIVATE_SETTINGS"));
      if (brokenFooter) {
        f.setStatus.mockImplementation(() => {
          throw new Error("closed UI");
        });
      }
      const activation = new AdapterActivation(f.context);
      await activation.prepare(f.pi);
      expect(activation.runtime).toBeUndefined();
      expect(activation.failure.message).not.toContain("PRIVATE_SETTINGS");
      expect(f.notify.mock.calls[0]?.[1]).toBe("error");
      expect(f.factory).not.toHaveBeenCalled();
      await activation.dispose(f.pi);
    },
  );

  it("should ignore late settings failure when the activation has retired", async () => {
    const f = adapterRuntimeFixture();
    const read = Promise.withResolvers<never>();
    f.readSettings.mockImplementation(() => read.promise);
    const activation = new AdapterActivation(f.context);
    const pending = activation.prepare(f.pi);
    activation.retire();
    read.reject(new Error("PRIVATE_LATE_FAILURE"));
    await pending;
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("should skip runtime acquisition when retirement precedes successful settings completion", async () => {
    const f = adapterRuntimeFixture();
    const activation = new AdapterActivation(f.context);
    activation.retire();
    await activation.prepare(f.pi);
    expect(activation.runtime).toBeUndefined();
    expect(f.factory).not.toHaveBeenCalled();
  });
  it("should retain failed discovery ownership until observed close when shutdown cannot terminate the child", async () => {
    const f = piUnitFixture();
    const scenario = processScenario(() => undefined, false);
    const activation = activationForDiscovery(
      f.context,
      f.native,
      scenario.effects,
      (callback, milliseconds) => {
        if (milliseconds === DISCOVERY_DEADLINE_MS) {
          queueMicrotask(callback);
        }
        return scenario.effects.setTimer(callback, milliseconds);
      },
    );
    try {
      await activation.prepare(f.pi);
      expect(activation.runtime).toBeUndefined();
      expect(scenario.signals).toEqual(["SIGTERM", "SIGKILL"]);
      const notifications = f.notify.mock.calls.length;
      await expect(activation.dispose(f.pi)).rejects.toThrow(
        "OpenShell shutdown failed",
      );
      expect(scenario.signals).toEqual([
        "SIGTERM",
        "SIGKILL",
        "SIGTERM",
        "SIGKILL",
      ]);
      await expect(activation.dispose(f.pi)).rejects.toBeInstanceOf(Error);
      expect(scenario.signals).toEqual([
        "SIGTERM",
        "SIGKILL",
        "SIGTERM",
        "SIGKILL",
        "SIGTERM",
        "SIGKILL",
      ]);
      expect(f.notify).toHaveBeenCalledTimes(notifications);
      expect(f.sendMessage.mock.calls.at(-1)?.[0].content).toContain(
        "OpenShell shutdown failed",
      );
      const signalsBeforeClose = [...scenario.signals];
      scenario.child.emit("close", 0);
      await activation.dispose(f.pi);
      expect(scenario.signals).toEqual(signalsBeforeClose);
    } finally {
      scenario.child.emit("close", 0);
      try {
        await activation.dispose(f.pi);
      } finally {
        f.restore();
      }
    }
  });
  it("should clean up late discovery failure without stale publication when preflight outlives the shutdown budget", async () => {
    const f = piUnitFixture();
    const spawned = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const scenario = processScenario(() => spawned.resolve(), false);
    const oldTimer = delayCloseDeadlines(scenario.effects, release.promise);
    const older = activationForDiscovery(
      f.context,
      f.native,
      scenario.effects,
      oldTimer,
    );
    const preparing = older.prepare(f.pi);
    await spawned.promise;
    older.retire();
    const healthy = adapterRuntimeFixture();
    const newer = new AdapterActivation(f.context);
    try {
      await newer.prepare(f.pi);
      const { runtime } = newer;
      if (!runtime) {
        throw new Error("Missing newer runtime");
      }
      await once(runtime.exec("fixture", "/project"), "exit");
      const publications = f.setStatus.mock.calls.length;
      const notifications = f.notify.mock.calls.length;
      const closing = older.dispose(f.pi).catch((error: unknown) => error);
      await setImmediate();
      f.runtime.clock.advance(CLEANUP_TIMEOUT_MS + 1);
      f.runtime.clock.fire();
      expect(await closing).toBeInstanceOf(Error);
      release.resolve();
      await preparing;
      expect(scenario.signals).toEqual([
        "SIGTERM",
        "SIGKILL",
        "SIGTERM",
        "SIGKILL",
      ]);
      expect(newer.runtime).toBe(runtime);
      expect(f.setStatus).toHaveBeenCalledTimes(publications);
      expect(f.notify).toHaveBeenCalledTimes(notifications);
    } finally {
      release.resolve();
      scenario.child.emit("close", 0);
      try {
        await preparing;
        await older.dispose(f.pi);
        await newer.dispose(f.pi);
      } finally {
        healthy.factory.mockRestore();
        healthy.readSettings.mockRestore();
        f.restore();
      }
    }
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("AdapterActivation.dispose", () => {
  it("should bound shutdown and retain raw preflight when filesystem access outlives the cleanup budget", async () => {
    const f = piUnitFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.nativeAccess.mockImplementation(() => {
      entered.resolve();
      return release.promise;
    });
    const activation = new AdapterActivation(f.context, f.native);
    let preflightSettled = false;
    const starting = activation
      .startRuntime(f.pi, f.runtime.environment)
      .catch(() => undefined)
      .finally(() => {
        preflightSettled = true;
      });
    try {
      await entered.promise;
      const publications = f.setStatus.mock.calls.length;
      const notifications = f.notify.mock.calls.length;
      const closing = activation.dispose(f.pi).catch((error: unknown) => error);
      await setImmediate();
      expect(f.runtime.clock.pending()).toBe(1);
      f.runtime.clock.advance(CLEANUP_TIMEOUT_MS + 1);
      f.runtime.clock.fire();
      const failure = await closing;
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("OpenShell shutdown failed");
      expect(f.runtime.clock.pending()).toBe(0);
      expect(preflightSettled).toBe(false);
      expect(activation.runtime).toBeUndefined();

      // A second shutdown still waits on the same raw work, not a cleared owner.
      const retrying = activation.dispose(f.pi);
      await setImmediate();
      expect(f.runtime.clock.pending()).toBe(1);
      expect(preflightSettled).toBe(false);
      release.resolve();
      await Promise.all([starting, retrying]);
      expect(preflightSettled).toBe(true);
      expect(f.runtime.clock.pending()).toBe(0);
      expect(activation.runtime).toBeUndefined();
      expect(f.runtime.native.launches).toBe(0);
      expect(f.setStatus).toHaveBeenCalledTimes(publications);
      expect(f.notify).toHaveBeenCalledTimes(notifications);
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      try {
        await starting;
        await activation.dispose(f.pi);
      } finally {
        f.restore();
      }
    }
  });
  it("should always drop the failed handle while keeping admission retired when disposal rejects", async () => {
    const f = adapterFixture();
    const activation = new AdapterActivation(f.context);
    activation.runtime = failingRuntime(() =>
      Promise.reject(new Error("PRIVATE_CLEANUP")),
    );
    const failure = await activation
      .dispose(f.pi)
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("PRIVATE_CLEANUP");
    expect(activation.current).toBe(false);
    expect(activation.controller.signal.aborted).toBe(true);
    expect(activation.runtime).toBeUndefined();
    await activation.dispose(f.pi);
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("AdapterActivation.startRuntime", () => {
  it("should acquire no effects when the activation is already retired", async () => {
    const f = adapterRuntimeFixture();
    const activation = new AdapterActivation(f.context);
    activation.retire();
    await activation.startRuntime(f.pi, runtimeFixture().environment);
    expect(f.factory).not.toHaveBeenCalled();
    expect(activation.controller.signal.aborted).toBe(true);
  });
  it("should leave a retired activation unadopted when runtime effects settle late", async () => {
    const f = adapterRuntimeFixture();
    const runtime = runtimeFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<typeof runtime.effects>();
    const activation = new AdapterActivation(f.context);
    const effects = {
      ...runtime.effects,
      activationSignal: activation.controller.signal,
    };
    f.factory.mockImplementation(() => {
      entered.resolve();
      return release.promise;
    });
    try {
      const pending = activation.startRuntime(f.pi, runtime.environment);
      await entered.promise;
      activation.retire();
      release.resolve(effects);
      await pending;
      expect(f.factory).toHaveBeenCalledTimes(1);
      expect(activation.runtime).toBeUndefined();
      expect(runtime.sdk.createCount).toBe(0);
      expect(runtime.native.sandboxPresent).toBe(false);
      expect(runtime.native.networkPresent).toBe(false);
      expect(f.sendMessage).not.toHaveBeenCalled();
      expect(f.setStatus).not.toHaveBeenCalled();
    } finally {
      release.resolve(effects);
      await activation.dispose(f.pi);
    }
  });
  it("should dispose an adopted runtime after pending SDK creation settles without stale publication", async () => {
    const f = adapterRuntimeFixture();
    const runtime = runtimeFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const activation = new AdapterActivation(f.context);
    f.factory.mockResolvedValue({
      ...runtime.effects,
      activationSignal: activation.controller.signal,
    });
    runtime.sdk.beforeCreate = () => {
      entered.resolve();
      return release.promise;
    };
    try {
      const pending = activation.startRuntime(f.pi, runtime.environment);
      await entered.promise;
      await pending;
      expect(activation.runtime).toBeDefined();
      expect(runtime.native.sandboxPresent).toBe(true);
      const publications = f.setStatus.mock.calls.length;
      const closing = activation.dispose(f.pi);
      expect(activation.current).toBe(false);
      release.resolve();
      await closing;
      expect(activation.runtime).toBeUndefined();
      expect(runtime.sdk.deleteCount).toBe(1);
      expect(runtime.native.sandboxPresent).toBe(false);
      expect(runtime.native.networkPresent).toBe(false);
      expect(f.setStatus).toHaveBeenCalledTimes(publications);
      expect(f.sendMessage).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await activation.dispose(f.pi);
    }
  });
});

const DISCOVERY_DEADLINE_MS = 10_000;
const CLOSE_DEADLINE_MS = 2000;

/** Configures real Docker context discovery with a test-owned child instead of a Docker subprocess.
 * Removing DOCKER_HOST from this activation alone selects discovery; the newer fixture stays independent.
 * @param context - Pi UI context owning this activation.
 * @param native - Original host capture and runtime capabilities.
 * @param effects - Child effects whose close and signals remain externally controlled.
 * @param setTimer - Fake deadlines for this child's discovery and termination.
 * @returns An activation with the selected native discovery effects.
 * @example activationForDiscovery(context, native, scenario.effects, scenario.effects.setTimer) uses scenario.child on prepare.
 */
function activationForDiscovery(
  context: ExtensionContext,
  native: PiNativeCapabilities,
  effects: ProcessEffects,
  setTimer: ProcessEffects["setTimer"],
): AdapterActivation {
  const { capture } = native;
  if (!capture) {
    throw new Error("Missing captured fixture capabilities");
  }
  return new AdapterActivation(context, {
    ...native,
    capture: {
      ...capture,
      process: { ...capture.process, env: { ["PATH"]: "/fixture/bin" } },
      processEffects: { ...effects, setTimer },
    },
  });
}

/** Holds only the child's bounded close deadlines while a newer activation prepares.
 * @param effects - Ordinary timer effects of the controlled process.
 * @param released - Settles to allow TERM/KILL close deadlines to expire.
 * @returns A fake timer that retains close deadlines until released.
 * @example delayCloseDeadlines(scenario.effects, release.promise) leaves discovery open before release.resolve().
 */
function delayCloseDeadlines(
  effects: ProcessEffects,
  released: Promise<void>,
): ProcessEffects["setTimer"] {
  return (callback, milliseconds) => {
    if (milliseconds === CLOSE_DEADLINE_MS) {
      released.then(callback, callback);
      return {} as NodeJS.Timeout;
    }
    return effects.setTimer(callback, milliseconds);
  };
}
