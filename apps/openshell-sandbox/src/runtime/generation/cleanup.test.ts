import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test as it,
  mock,
} from "bun:test";
import { type SandboxRef, SdkError } from "@nvidia/openshell-sdk";
import type { OwnedResource } from "../../host/index.ts";
import { unitRuntimeFixture } from "../test/index.helper.ts";
import { cleanupGeneration } from "./cleanup.ts";
import {
  type AcknowledgedCleanup,
  acknowledgedCleanup,
  pollingCleanupClock,
} from "./test/cleanup.helper.ts";
import { gateway, resources } from "./test/generation.helper.ts";
import type { GenerationResources } from "./types.ts";

const MISSING_IDENTITIES: [string, Partial<GenerationResources>, string][] = [
  [
    "the owned gateway is unavailable",
    { preparedGateway: undefined },
    "gateway",
  ],
  [
    "the acknowledged sandbox id is unavailable",
    { sandboxId: undefined },
    "identity",
  ],
];

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("cleanupGeneration", () => {
  it("should wait for raw setup before reading and releasing late acquisitions", async () => {
    const fixture = unitRuntimeFixture();
    const finished = Promise.withResolvers<void>();
    let snapshots = 0;
    let released = false;
    const cleanup = cleanupGeneration({
      tasksFinished: finished.promise,
      snapshot: () => {
        snapshots += 1;
        return resources(gateway(fixture), {
          ownedResources: [
            {
              kind: "provider",
              release: () => {
                released = true;
                return Promise.resolve();
              },
            },
          ],
        });
      },
      effects: fixture.effects,
    });
    try {
      await Promise.resolve();
      expect(snapshots).toBe(0);
      finished.resolve();
      expect(await cleanup).toEqual({ kind: "confirmed" });
      expect(snapshots).toBe(1);
      expect(released).toBe(true);
      expect(fixture.clock.pending()).toBe(0);
    } finally {
      finished.resolve();
      await cleanup.catch(() => undefined);
      fixture.clock.restore();
    }
  });

  it("should retain the gateway when raw setup has not settled by the cleanup deadline", async () => {
    const fixture = unitRuntimeFixture();
    let snapshots = 0;
    const cleanup = cleanupGeneration({
      tasksFinished: new Promise<void>(() => undefined),
      snapshot: () => {
        snapshots += 1;
        return resources(gateway(fixture));
      },
      effects: fixture.effects,
    });
    try {
      fixture.clock.fire();
      await expect(cleanup).rejects.toMatchObject({
        failure: { code: "timeout" },
      });
      expect(snapshots).toBe(0);
      expect(fixture.clock.pending()).toBe(0);
    } finally {
      fixture.clock.fire();
      await cleanup.catch(() => undefined);
      fixture.clock.restore();
    }
  });
  it("should release partially acquired capabilities in reverse order after rejected creation", async () => {
    const fixture = unitRuntimeFixture();
    const events: string[] = [];
    try {
      expect(
        await cleanupGeneration({
          tasksFinished: Promise.resolve(),
          snapshot: () =>
            resources(gateway(fixture), {
              ownedResources: ["first", "second"].map(
                (label): OwnedResource => ({
                  kind: "provider",
                  release: () => {
                    events.push(label);
                    return Promise.resolve();
                  },
                }),
              ),
            }),
          effects: fixture.effects,
        }),
      ).toEqual({ kind: "confirmed" });
      expect(events).toEqual(["second", "first"]);
      expect(fixture.sdk.deleteCount).toBe(0);
    } finally {
      fixture.clock.restore();
    }
  });

  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
  describe("resource ownership", () => {
    let setup: AcknowledgedCleanup;
    beforeEach(() => {
      setup = acknowledgedCleanup();
    });
    afterEach(() => {
      setup.fixture.clock.restore();
    });

    it("should retain a private gateway when sandbox creation is unacknowledged", async () => {
      const { fixture } = setup;
      let released = false;
      await expect(
        cleanupGeneration({
          tasksFinished: Promise.resolve(),
          snapshot: () =>
            resources(gateway(fixture), {
              createOutcome: "unknown",
              ownedResources: [
                {
                  kind: "provider",
                  release: () => {
                    released = true;
                    return Promise.resolve();
                  },
                },
              ],
            }),
          effects: fixture.effects,
        }),
      ).rejects.toMatchObject({ failure: { operation: "create-settlement" } });
      expect(fixture.sdk.stopCount).toBe(0);
      expect(fixture.sdk.deleteCount).toBe(0);
      expect(released).toBe(false);
      expect(fixture.clock.pending()).toBe(0);
    });

    it("should stop, delete, and confirm an acknowledged sandbox through SDK methods", async () => {
      expect(
        await cleanupGeneration({
          tasksFinished: Promise.resolve(),
          snapshot: () => setup.owned,
          effects: setup.fixture.effects,
        }),
      ).toEqual({ kind: "confirmed" });
      expect(setup.fixture.sdk.stopCount).toBe(1);
      expect(setup.fixture.sdk.deleteCount).toBe(1);
      expect(setup.release).toHaveBeenCalledTimes(1);
      expect(setup.fixture.clock.pending()).toBe(0);
    });
    it("should preserve a same-name replacement without stopping or deleting it", async () => {
      setup.fixture.native.sandboxId = "replacement";
      await expect(
        cleanupGeneration({
          tasksFinished: Promise.resolve(),
          snapshot: () => setup.owned,
          effects: setup.fixture.effects,
        }),
      ).rejects.toMatchObject({ failure: { operation: "identity" } });
      expect(setup.fixture.sdk.stopCount).toBe(0);
      expect(setup.fixture.sdk.deleteCount).toBe(0);
      expect(setup.release).not.toHaveBeenCalled();
    });
    it("should preserve a same-name replacement when ownership changes during stop", async () => {
      const { stopSandbox } = setup.fixture.sdk.client.raw;
      setup.fixture.sdk.client.raw.stopSandbox = mock(
        async (...args: Parameters<typeof stopSandbox>) => {
          const response = await stopSandbox(...args);
          setup.fixture.native.sandboxId = "replacement";
          return response;
        },
      );
      await expect(
        cleanupGeneration({
          tasksFinished: Promise.resolve(),
          snapshot: () => setup.owned,
          effects: setup.fixture.effects,
        }),
      ).rejects.toMatchObject({ failure: { operation: "identity" } });
      expect(setup.fixture.sdk.stopCount).toBe(1);
      expect(setup.fixture.sdk.deleteCount).toBe(0);
      expect(setup.fixture.native.sandboxPresent).toBe(true);
      expect(setup.release).not.toHaveBeenCalled();
    });

    it("should accept SDK not-found only after matching sandbox creation was acknowledged", async () => {
      setup.fixture.sdk.client.sandbox.get = () =>
        Promise.reject(new SdkError("not_found", "already absent"));
      expect(
        await cleanupGeneration({
          tasksFinished: Promise.resolve(),
          snapshot: () => setup.owned,
          effects: setup.fixture.effects,
        }),
      ).toEqual({ kind: "confirmed" });
      expect(setup.fixture.sdk.stopCount).toBe(0);
      expect(setup.fixture.sdk.deleteCount).toBe(0);
      expect(setup.release).toHaveBeenCalledTimes(1);
    });
    it("should wait for verified stopped state before deleting when a failed stop leaves sandbox ready", async () => {
      const stop = mock(() => Promise.reject(new Error("stop response lost")));
      setup.fixture.sdk.client.raw.stopSandbox = stop;
      const clock = pollingCleanupClock(setup.fixture.effects);
      const cleanup = cleanupGeneration({
        tasksFinished: Promise.resolve(),
        snapshot: () => setup.owned,
        effects: clock.effects,
      });
      let resume: (() => void) | undefined;
      try {
        resume = await Promise.race([
          clock.paused.promise,
          cleanup.then(() => {
            throw new Error("Cleanup finished before stop was confirmed.");
          }),
        ]);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(setup.fixture.sdk.deleteCount).toBe(0);
        expect(setup.release).not.toHaveBeenCalled();
        setup.fixture.native.phase = "stopped";
        resume();
        expect(await cleanup).toEqual({ kind: "confirmed" });
        expect(setup.fixture.sdk.deleteCount).toBe(1);
        expect(setup.release).toHaveBeenCalledTimes(1);
        expect(clock.cleared()).toBe(true);
      } finally {
        setup.fixture.native.phase = "stopped";
        resume?.();
        await cleanup.catch(() => undefined);
      }
    });
    it("should avoid duplicate deletion when a matching acknowledged sandbox disappears during stop", async () => {
      const { stopSandbox } = setup.fixture.sdk.client.raw;
      setup.fixture.sdk.client.raw.stopSandbox = mock(
        async (...args: Parameters<typeof stopSandbox>) => {
          const response = await stopSandbox(...args);
          setup.fixture.native.sandboxPresent = false;
          return response;
        },
      );
      const deleted = mock(setup.fixture.sdk.client.sandbox.waitDeleted);
      setup.fixture.sdk.client.sandbox.waitDeleted = deleted;
      expect(
        await cleanupGeneration({
          tasksFinished: Promise.resolve(),
          snapshot: () => setup.owned,
          effects: setup.fixture.effects,
        }),
      ).toEqual({ kind: "confirmed" });
      expect(setup.fixture.sdk.deleteCount).toBe(0);
      expect(deleted).not.toHaveBeenCalled();
      expect(setup.release).toHaveBeenCalledTimes(1);
    });
    it("should retain ownership when a failed stop is followed by an absent lookup", async () => {
      setup.fixture.sdk.client.raw.stopSandbox = mock(() => {
        setup.fixture.native.sandboxPresent = false;
        return Promise.reject(new Error("stop response lost"));
      });
      await expect(
        cleanupGeneration({
          tasksFinished: Promise.resolve(),
          snapshot: () => setup.owned,
          effects: setup.fixture.effects,
        }),
      ).rejects.toThrow("stop response lost");
      expect(setup.fixture.sdk.deleteCount).toBe(0);
      expect(setup.release).not.toHaveBeenCalled();
    });
    it.each(MISSING_IDENTITIES)(
      "should preserve SDK resources without mutation when %s",
      async (_condition, missing, operation) => {
        const lookup = mock(setup.fixture.sdk.client.sandbox.get);
        setup.fixture.sdk.client.sandbox.get = lookup;
        await expect(
          cleanupGeneration({
            tasksFinished: Promise.resolve(),
            snapshot: () => ({ ...setup.owned, ...missing }),
            effects: setup.fixture.effects,
          }),
        ).rejects.toMatchObject({ failure: { code: "cleanup", operation } });
        expect(lookup).not.toHaveBeenCalled();
        expect(setup.release).not.toHaveBeenCalled();
        expect(setup.fixture.sdk.stopCount).toBe(0);
        expect(setup.fixture.sdk.deleteCount).toBe(0);
      },
    );

    it("should preserve SDK resources when the native sandbox phase cannot prove safe deletion", async () => {
      const { get } = setup.fixture.sdk.client.sandbox;
      setup.fixture.sdk.client.sandbox.get = async (...args) => ({
        ...(await get(...args)),
        phase: "unrecognized" as SandboxRef["phase"],
      });
      await expect(
        cleanupGeneration({
          tasksFinished: Promise.resolve(),
          snapshot: () => setup.owned,
          effects: setup.fixture.effects,
        }),
      ).rejects.toMatchObject({ failure: { operation: "phase" } });
      expect(setup.release).not.toHaveBeenCalled();
      expect(setup.fixture.sdk.stopCount).toBe(0);
      expect(setup.fixture.sdk.deleteCount).toBe(0);
    });
  });
});
