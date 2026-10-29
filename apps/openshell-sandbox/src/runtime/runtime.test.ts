import { describe, expect, test as it } from "bun:test";
import { getEventListeners } from "node:events";
import { createSandboxRuntime } from "./runtime.ts";
import { plannedRealpath, unitRuntimeFixture } from "./test/index.helper.ts";

const INVALID_ENTROPY_LENGTH = 9;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("createSandboxRuntime", () => {
  it.each([
    [
      "throws",
      () => {
        throw new Error("private entropy failure");
      },
    ],
    ["returns too few bytes", () => new Uint8Array(INVALID_ENTROPY_LENGTH)],
  ] as const)(
    "should release activation observation without starting preparation when entropy %s",
    async (_condition, randomBytes) => {
      const fixture = unitRuntimeFixture();
      try {
        const listeners = getEventListeners(
          fixture.activation.signal,
          "abort",
        ).length;
        await expect(
          createSandboxRuntime(
            fixture.environment,
            { ...fixture.effects, randomBytes },
            fixture.observer,
          ),
        ).rejects.toThrow();
        expect(fixture.clock.pending()).toBe(0);
        expect(
          getEventListeners(fixture.activation.signal, "abort"),
        ).toHaveLength(listeners);
        expect(fixture.statuses).toEqual([]);
        expect(fixture.failures).toEqual([]);
        expect(fixture.native.launches).toBe(0);
      } finally {
        fixture.clock.restore();
      }
    },
  );
  it("should expose a frozen fail-closed handle without native work for an already canceled activation", async () => {
    const fixture = unitRuntimeFixture();
    try {
      fixture.activation.abort();
      const runtime = await createSandboxRuntime(
        fixture.environment,
        fixture.effects,
        fixture.observer,
      );
      expect(Object.isFrozen(runtime)).toBe(true);
      expect(runtime.getStatus().phase).toBe("recovery-required");
      expect(fixture.native.launches).toBe(0);
      expect(fixture.statuses).toHaveLength(0);
      await runtime.dispose();
      expect(runtime.getStatus().phase).toBe("closed");
    } finally {
      fixture.clock.restore();
    }
  });

  it("should record a preparation failure after confirmed cleanup without opening a gateway", async () => {
    const fixture = unitRuntimeFixture();
    try {
      const reported = Promise.withResolvers<void>();
      const runtime = await createSandboxRuntime(
        fixture.environment,
        {
          ...fixture.effects,
          filesystem: {
            ...fixture.effects.filesystem,
            realpath: plannedRealpath(() =>
              Promise.reject(new Error("private workspace path")),
            ),
          },
        },
        {
          ...fixture.observer,
          failure: (failure) => {
            fixture.observer.failure(failure);
            reported.resolve();
          },
        },
      );
      try {
        await reported.promise;
        expect(runtime.getStatus().lastFailure?.code).toBe("preparation");
        expect(runtime.getStatus().phase).toBe("idle");
        expect(fixture.native.launches).toBe(0);
        expect(JSON.stringify(runtime.getStatus())).not.toContain(
          "private workspace path",
        );
      } finally {
        await runtime.dispose();
      }
    } finally {
      fixture.clock.restore();
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
});
