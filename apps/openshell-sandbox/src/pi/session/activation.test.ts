import { describe, expect, test as it, mock, spyOn } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { HostProcessError, type ManagedProcess } from "../../host/index.ts";
import type { RuntimeEffects, SandboxRuntime } from "../../runtime/index.ts";
import { CLEANUP_TIMEOUT_MS } from "../../runtime/index.ts";
import {
  activationFixture,
  adapterFixture,
  cachedStatus,
} from "../test/index.helper.ts";
import { AdapterActivation } from "./activation.ts";

describe("AdapterActivation.constructor", () => {
  it("should begin fail-closed without acquiring resources", () => {
    const f = activationFixture();
    try {
      const activation = new AdapterActivation(f.context, f.native);
      expect(activation.context).toBe(f.context);
      expect(activation.current).toBe(true);
      expect(activation.runtime).toBeUndefined();
      expect(activation.controller.signal.aborted).toBe(false);
      expect(activation.failure.message).toContain("model Bash is blocked");
      expect(f.load).not.toHaveBeenCalled();
      expect(f.effects).not.toHaveBeenCalled();
    } finally {
      f.restore();
    }
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("AdapterActivation.prepare", () => {
  it("should adopt its initialized runtime when configuration succeeds", async () => {
    const f = activationFixture();
    const activation = new AdapterActivation(f.context, f.native);
    try {
      await activation.prepare(f.pi);
      expect(activation.runtime).toBe(f.handle);
      expect(activation.current).toBe(true);
    } finally {
      try {
        await activation.dispose(f.pi);
      } finally {
        f.restore();
      }
    }
  });
  it.each([
    ["available", (): undefined => undefined],
    [
      "unavailable",
      () => {
        throw new Error("closed UI");
      },
    ],
  ] as const)(
    "should publish sanitized failure and keep admission closed when settings fail and the footer is %s",
    async (_condition, setStatus) => {
      const f = activationFixture();
      f.load.mockRejectedValue(new Error("PRIVATE_CONFIGURATION"));
      f.setStatus.mockImplementation(setStatus);
      const activation = new AdapterActivation(f.context, f.native);
      try {
        await activation.prepare(f.pi);
        expect(activation.runtime).toBeUndefined();
        expect(activation.failure.message).not.toContain(
          "PRIVATE_CONFIGURATION",
        );
        expect(f.sendMessage).toHaveBeenCalledTimes(1);
        expect(f.notify.mock.calls[0]?.[1]).toBe("error");
        expect(f.effects).not.toHaveBeenCalled();
      } finally {
        try {
          await activation.dispose(f.pi);
        } finally {
          f.restore();
        }
      }
    },
  );
  it("should suppress obsolete failure publication when settings settle after retirement", async () => {
    const f = activationFixture();
    const read = Promise.withResolvers<never>();
    f.load.mockImplementation(() => read.promise);
    const activation = new AdapterActivation(f.context, f.native);
    const preparing = activation.prepare(f.pi);
    try {
      activation.retire();
      read.reject(new Error("PRIVATE_LATE_FAILURE"));
      await preparing;
      expect(f.sendMessage).not.toHaveBeenCalled();
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.effects).not.toHaveBeenCalled();
    } finally {
      read.reject(new Error("fixture cleanup"));
      await preparing;
      await activation.dispose(f.pi);
      f.restore();
    }
  });
  it("should skip acquisition when successful settings settle after retirement", async () => {
    const f = activationFixture();
    const read = Promise.withResolvers<typeof f.runtime.environment>();
    f.load.mockReturnValue(read.promise);
    const activation = new AdapterActivation(f.context, f.native);
    const preparing = activation.prepare(f.pi);
    try {
      activation.retire();
      read.resolve(f.runtime.environment);
      await preparing;
      expect(activation.runtime).toBeUndefined();
      expect(f.effects).not.toHaveBeenCalled();
    } finally {
      read.resolve(f.runtime.environment);
      await preparing;
      await activation.dispose(f.pi);
      f.restore();
    }
  });
  it("should publish sanitized failure without acquisition when host capture throws", async () => {
    const f = activationFixture();
    f.captureHome.mockImplementation(() => {
      throw new Error("PRIVATE_HOST_CAPTURE");
    });
    const activation = new AdapterActivation(f.context, f.native);
    try {
      await activation.prepare(f.pi);
      expect(activation.runtime).toBeUndefined();
      expect(activation.failure.message).not.toContain("PRIVATE_HOST_CAPTURE");
      expect(f.sendMessage.mock.calls[0]?.[0].content).toBe(
        activation.failure.message,
      );
      expect(f.effects).not.toHaveBeenCalled();
    } finally {
      try {
        await activation.dispose(f.pi);
      } finally {
        f.restore();
      }
    }
  });
  it("should capture fresh host facts for a new activation after preparation fails", async () => {
    const f = activationFixture();
    f.effects.mockRejectedValue(new Error("native executable unavailable"));
    const first = new AdapterActivation(f.context, f.native);
    const second = new AdapterActivation(f.context, f.native);
    try {
      f.captureHome.mockReturnValue("/home/first");
      await first.prepare(f.pi);
      await first.dispose(f.pi);
      f.captureHome.mockReturnValue("/home/second");
      await second.prepare(f.pi);
      const firstHost = f.effects.mock.calls[0]?.[1];
      const secondHost = f.effects.mock.calls[1]?.[1];
      expect(firstHost?.paths.home).toBe("/home/first");
      expect(secondHost?.paths.home).toBe("/home/second");
      expect(firstHost?.instanceId).not.toBe(secondHost?.instanceId);
      expect(second.runtime).toBeUndefined();
    } finally {
      try {
        await first.dispose(f.pi);
        await second.dispose(f.pi);
      } finally {
        f.restore();
      }
    }
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("AdapterActivation.startRuntime", () => {
  it("should acquire no native capabilities when already retired", async () => {
    const f = activationFixture();
    const activation = new AdapterActivation(f.context, f.native);
    try {
      activation.retire();
      await activation.startRuntime(f.pi, f.runtime.environment);
      expect(f.effects).not.toHaveBeenCalled();
      expect(activation.controller.signal.aborted).toBe(true);
    } finally {
      f.restore();
    }
  });
  it("should remain unadopted when runtime acquisition fails", async () => {
    const f = activationFixture();
    const failure = new Error("PRIVATE_NATIVE_ACCESS");
    f.effects.mockRejectedValue(failure);
    const activation = new AdapterActivation(f.context, f.native);
    try {
      await expect(
        activation.startRuntime(f.pi, f.runtime.environment),
      ).rejects.toBe(failure);
      expect(activation.runtime).toBeUndefined();
      expect(f.create).not.toHaveBeenCalled();
    } finally {
      f.restore();
    }
  });
  it("should skip runtime creation when acquisition settles after retirement", async () => {
    const f = activationFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<RuntimeEffects>();
    f.effects.mockImplementation(() => {
      entered.resolve();
      return release.promise;
    });
    const activation = new AdapterActivation(f.context, f.native);
    const starting = activation.startRuntime(f.pi, f.runtime.environment);
    try {
      await entered.promise;
      activation.retire();
      release.resolve(f.runtime.effects);
      await starting;
      expect(activation.runtime).toBeUndefined();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.sendMessage).not.toHaveBeenCalled();
      expect(f.setStatus).not.toHaveBeenCalled();
    } finally {
      release.resolve(f.runtime.effects);
      await starting;
      await activation.dispose(f.pi);
      f.restore();
    }
  });
  it("should dispose a late runtime and report failed cleanup when retired during creation", async () => {
    const f = activationFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<SandboxRuntime>();
    const dispose = mock(() =>
      Promise.reject(new Error("PRIVATE_LATE_CLEANUP")),
    );
    const created: SandboxRuntime = {
      ...f.handle,
      dispose,
      getStatus: () =>
        cachedStatus({ recovery: { sandboxName: "late-owned-sandbox" } }),
    };
    f.create.mockImplementation(() => {
      entered.resolve();
      return release.promise;
    });
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
      f.restore();
    }
  });
});

describe("AdapterActivation.retire", () => {
  it("should abort its effects and disable publication without disposing the runtime", () => {
    const f = adapterFixture();
    const activation = new AdapterActivation(f.context);
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
    activation.retire();
    activation.retire();
    expect(activation.current).toBe(false);
    expect(activation.controller.signal.aborted).toBe(true);
    expect(activation.runtime).toBeDefined();
    expect(dispose).not.toHaveBeenCalled();
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("AdapterActivation.dispose", () => {
  it.each([
    ["succeeds", () => Promise.resolve(), false],
    ["fails", () => Promise.reject(new Error("PRIVATE_TEARDOWN")), true],
  ] as const)(
    "should drop its handle and retire admission when teardown %s",
    async (_condition, dispose, fails) => {
      const f = activationFixture();
      f.dispose.mockImplementation(dispose);
      const activation = new AdapterActivation(f.context, f.native);
      activation.runtime = f.handle;
      try {
        const error = await activation
          .dispose(f.pi)
          .catch((failure: unknown) => failure);
        expect(activation.runtime).toBeUndefined();
        expect(activation.current).toBe(false);
        expect(activation.controller.signal.aborted).toBe(true);
        expect(error instanceof Error).toBe(fails);
        expect(String(error)).not.toContain("PRIVATE_TEARDOWN");
        await activation.dispose(f.pi);
        expect(f.dispose).toHaveBeenCalledTimes(1);
      } finally {
        f.restore();
      }
    },
  );
  it("should retain raw acquisition for retry when it outlives the shutdown budget", async () => {
    const f = activationFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<RuntimeEffects>();
    f.effects.mockImplementation(() => {
      entered.resolve();
      return release.promise;
    });
    const activation = new AdapterActivation(f.context, f.native);
    let settled = false;
    const starting = activation
      .startRuntime(f.pi, f.runtime.environment)
      .finally(() => {
        settled = true;
      });
    try {
      await entered.promise;
      const closing = activation.dispose(f.pi).catch((error: unknown) => error);
      await setImmediate();
      f.runtime.clock.advance(CLEANUP_TIMEOUT_MS + 1);
      f.runtime.clock.fire();
      expect(await closing).toBeInstanceOf(Error);
      expect(f.runtime.clock.pending()).toBe(0);
      expect(settled).toBe(false);
      const retrying = activation.dispose(f.pi);
      await setImmediate();
      expect(f.runtime.clock.pending()).toBe(1);
      expect(settled).toBe(false);
      release.resolve(f.runtime.effects);
      await Promise.all([starting, retrying]);
      expect(settled).toBe(true);
      expect(f.runtime.clock.pending()).toBe(0);
      expect(activation.runtime).toBeUndefined();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.setStatus).not.toHaveBeenCalled();
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve(f.runtime.effects);
      await starting;
      await activation.dispose(f.pi);
      f.restore();
    }
  });
  it("should bound pending acquisition when execution timers are not injected", async () => {
    const f = activationFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<RuntimeEffects>();
    f.effects.mockImplementation(() => {
      entered.resolve();
      return release.promise;
    });
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
        CLEANUP_TIMEOUT_MS,
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
      expect(f.create).not.toHaveBeenCalled();
      expect(activation.runtime).toBeUndefined();
    } finally {
      release.resolve(f.runtime.effects);
      await starting;
      await activation.dispose(f.pi);
      clear.mockRestore();
      timer.mockRestore();
      f.restore();
    }
  });
  it("should retain a late failed prerequisite child without disturbing a newer activation after bounded shutdown", async () => {
    const f = activationFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<RuntimeEffects>();
    const closed = Promise.withResolvers<Awaited<ManagedProcess["closed"]>>();
    const terminate = mock(() =>
      Promise.reject(new Error("PRIVATE_UNCONFIRMED_CLOSE")),
    );
    const child: ManagedProcess = { closed: closed.promise, terminate };
    f.effects.mockImplementationOnce(() => {
      entered.resolve();
      return release.promise;
    });
    const older = new AdapterActivation(f.context, f.native);
    const newer = new AdapterActivation(f.context, f.native);
    const preparing = older.prepare(f.pi);
    try {
      await entered.promise;
      const closing = older.dispose(f.pi).catch((error: unknown) => error);
      await setImmediate();
      f.runtime.clock.advance(CLEANUP_TIMEOUT_MS + 1);
      f.runtime.clock.fire();
      expect(await closing).toBeInstanceOf(Error);
      await newer.prepare(f.pi);
      release.reject(new HostProcessError("discovery failed", child));
      await preparing;
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(newer.runtime).toBe(f.handle);
      expect(f.notify).not.toHaveBeenCalled();
      expect(f.setStatus).not.toHaveBeenCalled();
      await expect(older.dispose(f.pi)).rejects.toBeInstanceOf(Error);
      expect(terminate).toHaveBeenCalledTimes(2);
      closed.resolve({ exitCode: 0, signal: "" });
      await closed.promise;
      await older.dispose(f.pi);
      expect(terminate).toHaveBeenCalledTimes(2);
      expect(newer.runtime).toBe(f.handle);
    } finally {
      release.reject(new Error("fixture cleanup"));
      closed.resolve({ exitCode: 0, signal: "" });
      await preparing;
      await older.dispose(f.pi);
      await newer.dispose(f.pi);
      f.restore();
    }
  });
});
