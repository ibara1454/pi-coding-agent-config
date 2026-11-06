import { describe, expect, test as it, spyOn } from "bun:test";
import { HostProcessError, type ProcessClose } from "../../host/index.ts";
import { unitRuntimeFixture } from "../test/index.helper.ts";
import { prepareGeneration } from "./preparation.ts";
// biome-ignore lint/performance/noNamespaceImport: Scoped spies must replace the live setup boundary.
import * as setupBoundary from "./setup.ts";
import { input } from "./test/generation.helper.ts";
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

  it("should hold raw setup through cancellation before confirming cleanup", async () => {
    const fixture = unitRuntimeFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const setup = spyOn(setupBoundary, "runGenerationSetup").mockImplementation(
      (current) =>
        current.step(async () => {
          entered.resolve();
          await release.promise;
          throw new Error("Setup canceled.");
        }),
    );
    const generation = prepareGeneration(
      input(fixture),
      fixture.effects,
      () => undefined,
    );
    try {
      await entered.promise;
      const cleanup = generation.invalidate();
      expect(generation.invalidate()).toBe(cleanup);
      let settled = false;
      const trackedCleanup = cleanup.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      release.resolve();
      expect(await trackedCleanup).toEqual({ kind: "confirmed" });
      await expect(generation.readiness).rejects.toThrow();
      expect(fixture.clock.pending()).toBe(0);
    } finally {
      release.resolve();
      await generation.invalidate().catch(() => undefined);
      setup.mockRestore();
      fixture.clock.restore();
    }
  });
  it("should report unconfirmed cleanup when raw setup outlives the deadline", async () => {
    const fixture = unitRuntimeFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const events: GenerationEvent[] = [];
    const setup = spyOn(setupBoundary, "runGenerationSetup").mockImplementation(
      (current) =>
        current.step(async () => {
          entered.resolve();
          try {
            await release.promise;
            throw new Error("Setup canceled.");
          } finally {
            finished.resolve();
          }
        }),
    );
    const generation = prepareGeneration(
      input(fixture),
      fixture.effects,
      (event) => events.push(event),
    );
    try {
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
    } finally {
      release.resolve();
      await finished.promise;
      await generation.invalidate().catch(() => undefined);
      setup.mockRestore();
      fixture.clock.restore();
    }
  });
  it("should wait for captured Git child closure before confirming canceled setup", async () => {
    const fixture = unitRuntimeFixture();
    const closed = Promise.withResolvers<ProcessClose>();
    const entered = Promise.withResolvers<void>();
    const events: GenerationEvent[] = [];
    const setup = spyOn(setupBoundary, "runGenerationSetup").mockImplementation(
      async (current) => {
        await current.step(() => current.gitProcess(["rev-parse"]));
        throw new Error("Expected Git failure.");
      },
    );
    const generation = prepareGeneration(
      input(fixture),
      {
        ...fixture.effects,
        gitProcess: () => {
          entered.resolve();
          return Promise.reject(
            new HostProcessError("Git child failed", {
              closed: closed.promise,
              terminate: async () => undefined,
            }),
          );
        },
      },
      (event) => events.push(event),
    );
    try {
      await entered.promise;
      const stopping = generation.invalidate();
      let settled = false;
      const onSettled = () => {
        settled = true;
      };
      const observed = stopping.then(onSettled, onSettled);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(events.some((event) => event.kind === "stopped")).toBe(false);
      // biome-ignore lint/plugin/biome-rules/use-undefined: Node reports null for a normal numeric child exit.
      closed.resolve({ exitCode: 1, signal: null });
      expect(await stopping).toEqual({ kind: "confirmed" });
      await observed;
      await expect(generation.readiness).rejects.toThrow();
      expect(events.filter((event) => event.kind === "stopped")).toHaveLength(
        1,
      );
      expect(fixture.native.launches).toBe(0);
    } finally {
      // biome-ignore lint/plugin/biome-rules/use-undefined: Node reports null for a normal numeric child exit.
      closed.resolve({ exitCode: 1, signal: null });
      await generation.invalidate().catch(() => undefined);
      setup.mockRestore();
      fixture.clock.restore();
    }
  });
});
