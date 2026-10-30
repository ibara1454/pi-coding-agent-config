import { describe, expect, test as it } from "bun:test";
import { plannedRealpath, unitRuntimeFixture } from "../test/index.helper.ts";
import { prepareGeneration } from "./preparation.ts";
import { gateway, input } from "./test/generation.helper.ts";
import type { GenerationEvent } from "./types.ts";

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("prepareGeneration", () => {
  it("should allocate no preparation lifetime when entropy throws", async () => {
    const fixture = unitRuntimeFixture();
    const events: GenerationEvent[] = [];
    try {
      expect(() =>
        prepareGeneration(
          input(fixture),
          {
            ...fixture.effects,
            randomBytes: () => {
              throw new Error("private entropy failure");
            },
          },
          (event) => events.push(event),
        ),
      ).toThrow();
      await Promise.resolve();
      expect(fixture.clock.pending()).toBe(0);
      expect(events).toEqual([]);
      expect(fixture.native.launches).toBe(0);
    } finally {
      fixture.clock.restore();
    }
  });
  it("should assign unique immutable sandbox names before queued setup begins", async () => {
    const fixture = unitRuntimeFixture();
    try {
      fixture.activation.abort();
      const first = prepareGeneration(
        input(fixture),
        fixture.effects,
        () => undefined,
      );
      const second = prepareGeneration(
        input(fixture),
        fixture.effects,
        () => undefined,
      );
      expect(Object.isFrozen(first)).toBe(true);
      expect(first.sandboxName.startsWith("po-")).toBe(true);
      expect(first.sandboxName).not.toBe(second.sandboxName);
      await expect(first.readiness).rejects.toThrow();
      await expect(second.readiness).rejects.toThrow();
      expect(fixture.native.launches).toBe(0);
      expect(fixture.clock.pending()).toBe(0);
    } finally {
      fixture.clock.restore();
    }
  });

  it("should hold raw workspace setup through cancellation before deleting acquired resources", async () => {
    const fixture = unitRuntimeFixture();
    try {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<string>();
      const generation = prepareGeneration(
        input(fixture),
        {
          ...fixture.effects,
          filesystem: {
            ...fixture.effects.filesystem,
            realpath: plannedRealpath(() => {
              entered.resolve();
              return release.promise;
            }),
          },
        },
        () => undefined,
      );
      await entered.promise;
      const cleanup = generation.invalidate();
      expect(generation.invalidate()).toBe(cleanup);
      await Promise.resolve();
      expect(fixture.native.launches).toBe(0);
      release.resolve("/project");
      expect(await cleanup).toEqual({ kind: "confirmed" });
      await expect(generation.readiness).rejects.toThrow();
      expect(fixture.clock.pending()).toBe(0);
    } finally {
      fixture.clock.restore();
    }
  });
  it("should report unconfirmed cleanup when raw setup outlives the deadline", async () => {
    const fixture = unitRuntimeFixture();
    try {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<string>();
      const events: GenerationEvent[] = [];
      const generation = prepareGeneration(
        input(fixture),
        {
          ...fixture.effects,
          filesystem: {
            ...fixture.effects.filesystem,
            realpath: plannedRealpath(() => {
              entered.resolve();
              return release.promise;
            }),
          },
        },
        (event) => events.push(event),
      );
      await entered.promise;
      const cleanup = generation.invalidate();
      fixture.clock.fire();
      await expect(cleanup).rejects.toMatchObject({
        failure: { code: "cleanup" },
      });
      await expect(generation.readiness).rejects.toMatchObject({
        failure: { code: "cleanup" },
      });
      expect(events.some((event) => event.kind === "stopped")).toBe(false);
      release.resolve("/project");
    } finally {
      fixture.clock.restore();
    }
  });
  it("should share SDK readiness and delete an acknowledged sandbox once", async () => {
    const fixture = unitRuntimeFixture();
    try {
      const prepared = gateway(fixture);
      fixture.native.namespace = `pi-openshell-${fixture.effects.host.instanceId}`;
      fixture.native.labels = { ...prepared.handle.labels };
      const events: GenerationEvent[] = [];
      const generation = prepareGeneration(
        input(fixture, prepared),
        fixture.effects,
        (event) => events.push(event),
      );
      try {
        expect((await generation.readiness).gateway).toBe(prepared);
        expect(
          events.some(
            (event) =>
              event.kind === "creation" && event.outcome === "acknowledged",
          ),
        ).toBe(true);
        const stopped = generation.invalidate();
        expect(generation.invalidate()).toBe(stopped);
        expect(await stopped).toEqual({ kind: "confirmed" });
        expect(fixture.sdk.deleteCount).toBe(1);
        expect(events.filter((event) => event.kind === "stopped")).toHaveLength(
          1,
        );
      } finally {
        await generation.invalidate().catch(() => undefined);
      }
    } finally {
      fixture.clock.restore();
    }
  });
});
