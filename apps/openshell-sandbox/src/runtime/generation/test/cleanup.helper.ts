import { mock } from "bun:test";
import { runtimeFixture } from "../../test/index.helper.ts";
import type { CleanupEffects } from "../types.ts";
import { gateway, resources } from "./generation.helper.ts";

const STOP_POLL_MS = 100;

/** Supplies an acknowledged SDK identity and a separately owned release capability.
 * @returns Isolated effects, acknowledged identity, and an observable release callback.
 * @example acknowledgedCleanup().fixture.native.phase = "stopped" selects direct deletion.
 */
export function acknowledgedCleanup() {
  const fixture = runtimeFixture();
  const prepared = gateway(fixture);
  fixture.native.sandboxId = "sandbox-1";
  fixture.native.sandboxName = "test-sandbox";
  fixture.native.sandboxPresent = true;
  fixture.native.namespace = `pi-openshell-${fixture.effects.host.instanceId}`;
  fixture.native.labels = { ...prepared.handle.labels };
  const release = mock(() => Promise.resolve());
  const owned = resources(prepared, {
    createOutcome: "acknowledged",
    sandboxId: "sandbox-1",
    ownedResources: [{ kind: "provider", release }],
  });
  return { fixture, owned, release };
}

/** Holds only the stop-poll callback while delegating ordinary deadline timers.
 * @param original - External clock to delegate all other timers to.
 * @returns Poll barrier and a record of timer release.
 * @example const resume = await pollingCleanupClock(effects).paused.promise; resume();
 */
export function pollingCleanupClock(original: CleanupEffects) {
  const paused = Promise.withResolvers<() => void>();
  const pollHandle = Symbol("poll");
  let cleared = false;
  const effects: CleanupEffects = {
    ...original,
    setTimer: (callback, milliseconds) => {
      if (milliseconds === STOP_POLL_MS) {
        paused.resolve(callback);
        return pollHandle;
      }
      return original.setTimer(callback, milliseconds);
    },
    clearTimer: (handle) => {
      if (handle === pollHandle) {
        cleared = true;
      } else {
        original.clearTimer(handle);
      }
    },
  };
  return { effects, paused, cleared: () => cleared };
}
