import { describe, expect, test as it, spyOn } from "bun:test";
import { getEventListeners } from "node:events";
import { safeFailure } from "../diagnostics/index.ts";
// biome-ignore lint/performance/noNamespaceImport: Scoped spies isolate disposal outcomes without native cleanup.
import * as disposalBoundary from "./disposal.ts";
import { completion } from "./execution/test/index.helper.ts";
// biome-ignore lint/performance/noNamespaceImport: Scoped spies isolate generation events without native preparation.
import * as generationBoundary from "./generation/index.ts";
import { gateway, generation } from "./generation/test/index.helper.ts";
import type { GenerationReport } from "./generation/types.ts";
import { createSandboxRuntime } from "./runtime.ts";
import { unitRuntimeFixture } from "./test/index.helper.ts";

/** Starts only runtime ownership with a controlled generation boundary; callers dispose and restore.
 * @returns Preparing runtime and its generation-event publisher without native preparation.
 * @example fixture.report({ generation: fixture.generation, kind: "stopped" }) retires that generation.
 */
async function isolatedRuntimeFixture() {
  const fixture = unitRuntimeFixture();
  const prepared = gateway(fixture);
  const current = generation(fixture, prepared);
  const captured = Promise.withResolvers<GenerationReport>();
  const prepare = spyOn(
    generationBoundary,
    "prepareGeneration",
  ).mockImplementation((_input, _effects, report) => {
    captured.resolve(report);
    return current;
  });
  try {
    const runtime = await createSandboxRuntime(
      fixture.environment,
      fixture.effects,
      fixture.observer,
    );
    return {
      ...fixture,
      runtime,
      prepared,
      generation: current,
      report: await captured.promise,
      restore: () => {
        prepare.mockRestore();
        fixture.clock.restore();
      },
    };
  } catch (error) {
    prepare.mockRestore();
    fixture.clock.restore();
    throw error;
  }
}

/** Publishes readiness from the controlled generation; callers dispose and restore.
 * @example readyFixture() exposes ready status without workspace, gateway, or SDK setup.
 */
async function readyFixture() {
  const fixture = await isolatedRuntimeFixture();
  fixture.report({
    generation: fixture.generation,
    kind: "gateway-prepared",
    gateway: fixture.prepared,
  });
  fixture.report({
    generation: fixture.generation,
    kind: "ready",
    resources: await fixture.generation.readiness,
  });
  return fixture;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("createSandboxRuntime", () => {
  it("should release activation observation when generation construction throws", async () => {
    const fixture = unitRuntimeFixture();
    const prepare = spyOn(
      generationBoundary,
      "prepareGeneration",
    ).mockImplementation(() => {
      throw new Error("private generation failure");
    });
    try {
      const listeners = getEventListeners(
        fixture.activation.signal,
        "abort",
      ).length;
      await expect(
        createSandboxRuntime(
          fixture.environment,
          fixture.effects,
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
      prepare.mockRestore();
      fixture.clock.restore();
    }
  });
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
    const fixture = await isolatedRuntimeFixture();
    try {
      fixture.report({ generation: fixture.generation, kind: "stopping" });
      fixture.report({ generation: fixture.generation, kind: "stopped" });
      fixture.report({
        generation: fixture.generation,
        kind: "preparation-failed",
        failure: safeFailure(
          new Error("private workspace path"),
          "preparation",
        ),
      });
      expect(fixture.runtime.getStatus().lastFailure?.code).toBe("preparation");
      expect(fixture.runtime.getStatus().phase).toBe("idle");
      expect(fixture.native.launches).toBe(0);
    } finally {
      try {
        await fixture.runtime.dispose();
      } finally {
        fixture.restore();
      }
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
    } finally {
      try {
        await fixture.runtime.dispose();
      } finally {
        fixture.restore();
      }
    }
  });

  it("should return the same cleanup promise and clear recovery facts when disposal succeeds", async () => {
    const fixture = await readyFixture();
    try {
      const disposal = fixture.runtime.dispose();
      expect(fixture.runtime.dispose()).toBe(disposal);
      await disposal;
      expect(fixture.runtime.getStatus().phase).toBe("closed");
      expect(fixture.runtime.getStatus().recovery).toBeUndefined();
      expect(fixture.clock.pending()).toBe(0);
    } finally {
      try {
        await fixture.runtime.dispose().catch(() => undefined);
      } finally {
        fixture.restore();
      }
    }
  });
  it("should retain failure and block further commands when disposal cannot confirm cleanup", async () => {
    const fixture = await readyFixture();
    const settle = spyOn(
      disposalBoundary,
      "settleRuntimeDisposal",
    ).mockRejectedValue(new Error("private delete cause"));
    const { recovery } = fixture.runtime.getStatus();
    try {
      const disposal = fixture.runtime.dispose();
      await expect(disposal).rejects.toMatchObject({
        failure: { code: "cleanup" },
      });
      expect(fixture.runtime.dispose()).toBe(disposal);
      expect(fixture.runtime.getStatus().phase).toBe("recovery-required");
      expect(fixture.runtime.getStatus().recovery).toEqual(recovery);
      const refused = await completion(
        fixture.runtime.exec("refused", "/project"),
      );
      expect(refused.error).toMatchObject({ failure: { code: "admission" } });
      expect(JSON.stringify(fixture.runtime.getStatus())).not.toContain(
        "private delete cause",
      );
    } finally {
      try {
        await fixture.runtime.dispose().catch(() => undefined);
      } finally {
        settle.mockRestore();
        fixture.restore();
      }
    }
  });
  it("should preserve readiness when an external progress observer throws", async () => {
    const fixture = await isolatedRuntimeFixture();
    const progress = spyOn(fixture.observer, "progress").mockImplementation(
      () => {
        throw new Error("private observer state");
      },
    );
    try {
      fixture.report({
        generation: fixture.generation,
        kind: "ready",
        resources: await fixture.generation.readiness,
      });
      expect(fixture.runtime.getStatus().phase).toBe("ready");
    } finally {
      try {
        await fixture.runtime.dispose();
      } finally {
        progress.mockRestore();
        fixture.restore();
      }
    }
  });
});
