import { spyOn } from "bun:test";
import { runtimeFixture } from "./runtime.helper.ts";

/** Owns a scoped monotonic clock spy and deterministic entropy; timers fire only on explicit request.
 * The caller restores the clock in finally after disposing asynchronous work.
 * @returns Runtime effects, controlled timer callbacks, and the owned clock restoration.
 * @example try { fixture.clock.fire(); } finally { fixture.clock.restore(); }
 */
export function unitRuntimeFixture() {
  const fixture = runtimeFixture();
  const callbacks = new Map<object, () => void>();
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  let entropy = 0;
  const timers = {
    setTimer: (callback: () => void) => {
      const handle = {} as NodeJS.Timeout;
      callbacks.set(handle, callback);
      return handle;
    },
    clearTimer: (handle: unknown) => {
      callbacks.delete(handle as object);
    },
  };
  return {
    ...fixture,
    effects: {
      ...fixture.effects,
      ...timers,
      host: {
        ...fixture.effects.host,
        processEffects: { ...fixture.effects.host.processEffects, ...timers },
      },
      randomBytes: (size: number) => {
        entropy += 1;
        return Buffer.alloc(size, entropy);
      },
    },
    clock: {
      advance: (milliseconds: number) => {
        now += milliseconds;
      },
      fire: () => {
        for (const callback of [...callbacks.values()]) {
          callback();
        }
      },
      pending: () => callbacks.size,
      restore: () => clock.mockRestore(),
    },
  };
}
