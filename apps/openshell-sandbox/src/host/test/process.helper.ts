import { ChildProcess, type spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import type { ProcessEffects } from "../process.ts";

const CLOSE_TIMEOUT_MS = 2000;

/** Simulate OS spawn, streams, signals and close timers without launching or signaling a process.
 * The caller emits output/close in onSpawn and can retain the child to settle uncertain ownership.
 * @param onSpawn - Called after the fake child reports spawn, to emit data or close.
 * @param closeOnSignal - Whether injected signalling emits raw close immediately.
 * @returns The owned fake child, injectable effects, and observed signal sequence.
 * @example processScenario(child => child.emit("close", 0, null)) simulates a successful finite run.
 */
export function processScenario(
  onSpawn: (child: ChildProcess) => void,
  closeOnSignal = true,
) {
  const child = new ChildProcess();
  Object.defineProperties(child, {
    stdout: { value: new PassThrough() },
    stderr: { value: new PassThrough() },
  });
  const signals: NodeJS.Signals[] = [];
  const effects: ProcessEffects = {
    spawn: (() => {
      queueMicrotask(() => {
        child.emit("spawn");
        onSpawn(child);
      });
      return child;
    }) as typeof spawn,
    signal(_child, signal) {
      signals.push(signal);
      if (closeOnSignal) {
        // biome-ignore lint/plugin/biome-rules/use-undefined: Node close reports a null exit code when termination is by signal.
        child.emit("close", null, signal);
      }
    },
    setTimer(callback, milliseconds) {
      const timer = {} as NodeJS.Timeout;
      if (milliseconds === CLOSE_TIMEOUT_MS) {
        queueMicrotask(callback);
      }
      return timer;
    },
    clearTimer: () => undefined,
  };
  return { child, effects, signals };
}
