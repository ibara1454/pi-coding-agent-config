import { describe, expect, test as it } from "bun:test";
import type { OwnedResource } from "../../host/index.ts";
import { unitRuntimeFixture } from "../test/index.helper.ts";
import { cleanupGeneration } from "./cleanup.ts";
import { gateway, resources } from "./test/generation.helper.ts";

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
});
