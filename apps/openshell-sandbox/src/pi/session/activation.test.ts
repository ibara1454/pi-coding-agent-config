import { describe, expect, test as it, mock, spyOn } from "bun:test";
import { setImmediate } from "node:timers/promises";
import type { RuntimeEffects, SandboxRuntime } from "../../runtime/index.ts";
// biome-ignore lint/performance/noNamespaceImport: Scoped spies replace runtime acquisition without native effects.
import * as runtime from "../../runtime/index.ts";
import { cachedStatus, piUnitFixture } from "../test/index.helper.ts";
import { AdapterActivation } from "./activation.ts";

describe("AdapterActivation.constructor", () => {
  it("should begin fail-closed without acquiring resources", () => {
    const f = piUnitFixture();
    try {
      const activation = new AdapterActivation(f.context, f.native);
      expect(activation.context).toBe(f.context);
      expect(activation.current).toBe(true);
      expect(activation.runtime).toBeUndefined();
      expect(activation.controller.signal.aborted).toBe(false);
      expect(activation.failure.message).toContain("model Bash is blocked");
      expect(f.read).not.toHaveBeenCalled();
      expect(f.nativeAccess).not.toHaveBeenCalled();
    } finally {
      f.restore();
    }
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("AdapterActivation.prepare", () => {
  it("should adopt only its own initialized runtime when configuration succeeds", async () => {
    const f = piUnitFixture();
    const activation = new AdapterActivation(f.context, f.native);
    try {
      await activation.prepare(f.pi);
      expect(activation.runtime).toBeDefined();
      expect(f.nativeAccess).toHaveBeenCalled();
    } finally {
      try {
        await activation.dispose(f.pi);
      } finally {
        f.restore();
      }
    }
  });
  it("should publish sanitized failure and keep admission closed when host reads fail", async () => {
    const f = piUnitFixture();
    f.read.mockRejectedValue(new Error("PRIVATE_CONFIGURATION"));
    const activation = new AdapterActivation(f.context, f.native);
    try {
      await activation.prepare(f.pi);
      expect(activation.runtime).toBeUndefined();
      expect(activation.failure.message).not.toContain("PRIVATE_CONFIGURATION");
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
      expect(f.setStatus.mock.calls).toContainEqual([
        "openshell-sandbox",
        "OpenShell · error",
      ]);
      expect(f.nativeAccess).not.toHaveBeenCalled();
    } finally {
      try {
        await activation.dispose(f.pi);
      } finally {
        f.restore();
      }
    }
  });
  it("should suppress obsolete failure publication when configuration settles after retirement", async () => {
    const f = piUnitFixture();
    const read = Promise.withResolvers<never>();
    f.read.mockImplementation(() => read.promise);
    const activation = new AdapterActivation(f.context, f.native);
    try {
      const preparing = activation.prepare(f.pi);
      activation.retire();
      read.reject(new Error("late failure"));
      await preparing;
      expect(f.sendMessage).not.toHaveBeenCalled();
      expect(f.nativeAccess).not.toHaveBeenCalled();
    } finally {
      try {
        await activation.dispose(f.pi);
      } finally {
        f.restore();
      }
    }
  });
  it("should publish sanitized failure without native preparation when host capture throws", async () => {
    const f = piUnitFixture();
    f.captureHome.mockImplementation(() => {
      throw new Error("PRIVATE_HOST_CAPTURE");
    });
    const activation = new AdapterActivation(f.context, f.native);
    try {
      await activation.prepare(f.pi);
      expect(activation.runtime).toBeUndefined();
      expect(activation.failure.message).not.toContain("PRIVATE_HOST_CAPTURE");
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
      expect(f.sendMessage.mock.calls[0]?.[0].content).toBe(
        activation.failure.message,
      );
      expect(f.nativeAccess).not.toHaveBeenCalled();
    } finally {
      try {
        await activation.dispose(f.pi);
      } finally {
        f.restore();
      }
    }
  });

  it("should capture fresh host facts for a new activation after preparation fails", async () => {
    const f = piUnitFixture();
    const factory = spyOn(runtime, "createRuntimeEffects").mockRejectedValue(
      new Error("native executable unavailable"),
    );
    const first = new AdapterActivation(f.context, f.native);
    const second = new AdapterActivation(f.context, f.native);
    try {
      f.captureHome.mockReturnValue("/home/first");
      await first.prepare(f.pi);
      await first.dispose(f.pi);
      f.captureHome.mockReturnValue("/home/second");
      await second.prepare(f.pi);
      const firstHost = factory.mock.calls[0]?.[1];
      const secondHost = factory.mock.calls[1]?.[1];
      expect(firstHost?.paths.home).toBe("/home/first");
      expect(secondHost?.paths.home).toBe("/home/second");
      expect(firstHost?.instanceId).not.toBe(secondHost?.instanceId);
      expect(second.runtime).toBeUndefined();
    } finally {
      try {
        await first.dispose(f.pi);
        await second.dispose(f.pi);
      } finally {
        factory.mockRestore();
        f.restore();
      }
    }
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: suite groups one operation's cases.
describe("AdapterActivation.startRuntime", () => {
  it("should acquire no native capabilities when already retired", async () => {
    const f = piUnitFixture();
    const activation = new AdapterActivation(f.context, f.native);
    try {
      activation.retire();
      await activation.startRuntime(f.pi, f.runtime.environment);
      expect(f.nativeAccess).not.toHaveBeenCalled();
    } finally {
      f.restore();
    }
  });
  it("should remain unadopted when native executable inspection fails", async () => {
    const f = piUnitFixture();
    f.nativeAccess.mockRejectedValue(new Error("PRIVATE_NATIVE_ACCESS"));
    const activation = new AdapterActivation(f.context, f.native);
    try {
      await expect(
        activation.startRuntime(f.pi, f.runtime.environment),
      ).rejects.toBeInstanceOf(Error);
      expect(activation.runtime).toBeUndefined();
      expect(f.runtime.native.launches).toBe(0);
    } finally {
      f.restore();
    }
  });
  it("should dispose a late runtime and report failed cleanup when retired during creation", async () => {
    const f = piUnitFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<SandboxRuntime>();
    const status = cachedStatus({
      recovery: { sandboxName: "late-owned-sandbox" },
    });
    const dispose = mock(() =>
      Promise.reject(new Error("PRIVATE_LATE_CLEANUP")),
    );
    const created: SandboxRuntime = {
      dispose,
      getStatus: () => status,
      exec: () => {
        throw new Error("unexpected exec");
      },
    };
    const effects = spyOn(runtime, "createRuntimeEffects").mockResolvedValue(
      f.runtime.effects,
    );
    const factory = spyOn(runtime, "createSandboxRuntime").mockImplementation(
      () => {
        entered.resolve();
        return release.promise;
      },
    );
    const activation = new AdapterActivation(f.context, f.native);
    const starting = activation.startRuntime(f.pi, f.runtime.environment);
    try {
      await entered.promise;
      await activation.dispose(f.pi);
      release.resolve(created);
      await starting;
      expect(activation.runtime).toBeUndefined();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(f.setStatus).not.toHaveBeenCalled();
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
      const message = f.sendMessage.mock.calls[0]?.[0].content;
      expect(message).toContain("late-owned-sandbox");
      expect(message).not.toContain("PRIVATE_LATE_CLEANUP");
    } finally {
      release.resolve(created);
      await starting;
      await activation.dispose(f.pi);
      factory.mockRestore();
      effects.mockRestore();
      f.restore();
    }
  });
});

describe("AdapterActivation.retire", () => {
  it("should abort its effects and disable publication without disposing the runtime", () => {
    const f = piUnitFixture();
    const activation = new AdapterActivation(f.context, f.native);
    const dispose = mock(() => Promise.resolve());
    activation.runtime = {
      dispose,
      exec: () => {
        throw new Error("unexpected exec");
      },
      getStatus: () => {
        throw new Error("unexpected status");
      },
    };
    try {
      activation.retire();
      activation.retire();
      expect(activation.current).toBe(false);
      expect(activation.controller.signal.aborted).toBe(true);
      expect(activation.runtime).toBeDefined();
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      f.restore();
    }
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: suite groups one operation's cases.
describe("AdapterActivation.dispose", () => {
  it.each([false, true])(
    "should drop its handle and retire admission when teardown fails %s",
    async (fails) => {
      const f = piUnitFixture();
      const activation = new AdapterActivation(f.context, f.native);
      activation.runtime = {
        dispose: () =>
          fails
            ? Promise.reject(new Error("PRIVATE_TEARDOWN"))
            : Promise.resolve(),
        exec: () => {
          throw new Error("unexpected exec");
        },
        getStatus: () => {
          throw new Error("unexpected status");
        },
      };
      try {
        const error = await activation
          .dispose(f.pi)
          .catch((failure: unknown) => failure);
        expect(activation.runtime).toBeUndefined();
        expect(activation.current).toBe(false);
        expect(activation.controller.signal.aborted).toBe(true);
        expect(error instanceof Error).toBe(fails);
        expect(String(error)).not.toContain("PRIVATE_TEARDOWN");
      } finally {
        f.restore();
      }
    },
  );
  it("should bound pending preflight disposal when execution timers are not injected", async () => {
    const f = piUnitFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<RuntimeEffects>();
    const effects = spyOn(runtime, "createRuntimeEffects").mockImplementation(
      () => {
        entered.resolve();
        return release.promise;
      },
    );
    const factory = spyOn(runtime, "createSandboxRuntime").mockRejectedValue(
      new Error("unexpected runtime creation"),
    );
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(
      f.runtime.effects.setTimer as typeof globalThis.setTimeout,
    );
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(
      f.runtime.effects.clearTimer,
    );
    const { runtime: _runtime, ...native } = f.native;
    const activation = new AdapterActivation(f.context, native);
    const starting = activation.startRuntime(f.pi, f.runtime.environment);
    try {
      await entered.promise;
      const closing = activation.dispose(f.pi).catch((error: unknown) => error);
      await setImmediate();
      expect(timer).toHaveBeenCalledWith(
        expect.any(Function),
        runtime.CLEANUP_TIMEOUT_MS,
      );
      expect(f.runtime.clock.pending()).toBe(1);
      f.runtime.clock.fire();
      expect(await closing).toBeInstanceOf(Error);
      expect(f.runtime.clock.pending()).toBe(0);
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
      expect(f.notify).not.toHaveBeenCalled();
      expect(activation.controller.signal.aborted).toBe(true);
      release.resolve(f.runtime.effects);
      await starting;
      expect(factory).not.toHaveBeenCalled();
      expect(activation.runtime).toBeUndefined();
    } finally {
      release.resolve(f.runtime.effects);
      await starting;
      await activation.dispose(f.pi);
      clear.mockRestore();
      timer.mockRestore();
      factory.mockRestore();
      effects.mockRestore();
      f.restore();
    }
  });
});
