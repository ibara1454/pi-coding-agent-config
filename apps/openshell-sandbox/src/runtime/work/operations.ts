import { RuntimeFailure } from "../../diagnostics/index.ts";
import type { TimerEffects } from "./types.ts";

export const SETUP_TIMEOUT_MS = 600_000;
export const CLEANUP_TIMEOUT_MS = 30_000;
export const RPC_TIMEOUT_MS = 30_000;

/** Throws a constant cancellation error rather than exposing an arbitrary signal reason.
 * @example assertLive(abortedSignal) throws an AbortError.
 */
export function assertLive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RuntimeFailure("aborted", "cancellation", "aborted");
  }
}

export type Deadline = Readonly<{
  signal: AbortSignal;
  remaining: () => number;
  close: () => void;
}>;
/** Owns a bounded timer and returns a nonnegative, floored integer millisecond budget.
 * Flooring never extends native RPC or SDK waits beyond the monotonic deadline.
 * @example with 4.8ms left, deadline(effects, 1000).remaining() returns 4.
 */
export function deadline(
  effects: TimerEffects,
  milliseconds: number,
  signals: readonly AbortSignal[] = [],
): Deadline {
  const controller = new AbortController();
  const expires = performance.now() + milliseconds;
  const timer = effects.setTimer(
    () =>
      controller.abort(
        new RuntimeFailure("timeout", "deadline", "Command timed out"),
      ),
    Math.max(0, milliseconds),
  );
  return Object.freeze({
    signal: AbortSignal.any([...signals, controller.signal]),
    remaining: () => Math.max(0, Math.floor(expires - performance.now())),
    close: () => effects.clearTimer(timer),
  });
}

/** Bounds caller waiting without pretending the raw operation settled; its owner retains the raw task.
 * An already-aborted signal wins over an already-settled operation; both remain observed.
 * @throws The operation's error, or a sanitized cancellation/deadline failure.
 * @example waitBounded(rawRpc, signal) rejects on cancellation while rawRpc remains observed.
 */
export async function waitBounded<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const aborted = Promise.withResolvers<never>();
  const abort = () =>
    aborted.reject(
      signal.reason instanceof RuntimeFailure
        ? signal.reason
        : new RuntimeFailure("aborted", "cancellation", "aborted"),
    );
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  try {
    return await Promise.race([aborted.promise, operation]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
