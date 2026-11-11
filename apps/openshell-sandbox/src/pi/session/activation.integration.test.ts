import { describe, expect, test as it, spyOn } from "bun:test";
import { once } from "node:events";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProcessEffects } from "../../host/index.ts";
import { processScenario } from "../../host/test/index.helper.ts";
// biome-ignore lint/performance/noNamespaceImport: Scoped spies isolate acquisition while retaining the real runtime.
import * as runtimeCapabilities from "../../runtime/index.ts";
import { runtimeFixture } from "../../runtime/test/index.helper.ts";
import type { PiNativeCapabilities } from "../index.ts";
import { adapterFixture, piUnitFixture } from "../test/index.helper.ts";
import { AdapterActivation } from "./activation.ts";

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("AdapterActivation.prepare", () => {
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
});

describe("AdapterActivation.startRuntime", () => {
  it("should dispose an adopted runtime after pending SDK creation settles without stale publication", async () => {
    const f = adapterFixture();
    const runtime = runtimeFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const activation = new AdapterActivation(f.context);
    const factory = spyOn(
      runtimeCapabilities,
      "createRuntimeEffects",
    ).mockResolvedValue({
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
      try {
        await activation.dispose(f.pi);
      } finally {
        factory.mockRestore();
      }
    }
  });
});

const DISCOVERY_DEADLINE_MS = 10_000;

/** Configures real Docker context discovery with a test-owned child instead of a Docker subprocess.
 * Removing DOCKER_HOST selects the real discovery path without launching a Docker subprocess.
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
