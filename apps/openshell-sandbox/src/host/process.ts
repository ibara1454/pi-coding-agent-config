import { type ChildProcess, spawn } from "node:child_process";
import {
  HostProcessError,
  type ManagedProcess,
  type ProcessClose,
  type ProcessEffects,
  type ProcessOptions,
  type ProcessResult,
} from "./process-types.ts";

export type {
  ManagedProcess,
  ProcessEffects,
  ProcessOptions,
  ProcessResult,
} from "./process-types.ts";

const CLOSE_TIMEOUT_MS = 2000;
const DEFAULT_OUTPUT_BYTES = 65_536;
/** Shell-free defaults; signal only the captured direct child, never its descendants. */
export const defaultProcessEffects: ProcessEffects = {
  spawn,
  /** Signal only this direct child handle; the owner must still await raw close.
   * @param child - Captured child returned by spawn.
   * @param signal - TERM or KILL requested by the owner.
   * @throws If the direct child handle rejects the requested signal.
   * @example defaultProcessEffects.signal(child, "SIGKILL") calls child.kill("SIGKILL").
   */
  signal(child, signal) {
    child.kill(signal);
  },
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimer: (timer) => clearTimeout(timer),
};

/** Redact raw native, SDK and filesystem errors from internal gateway causes.
 * A safe HostProcessError remains internal; callers capture its process first.
 * @example nativeFailure("Private gateway failed.", new Error("secret")).cause === undefined
 */
export function nativeFailure(message: string, error: unknown): Error {
  return new Error(message, { cause: nativeCause(error) });
}

function nativeCause(error: unknown): HostProcessError | undefined {
  return error instanceof HostProcessError ? error : undefined;
}

/** Preserve an uncertain child and only an already-safe native cause after an effect fails.
 * @example processFailure("Native failed.", new Error("secret"), child).process === child
 */
function processFailure(
  message: string,
  error: unknown,
  ownedProcess?: ManagedProcess,
): HostProcessError {
  const cause = nativeCause(error);
  return new HostProcessError(message, ownedProcess ?? cause?.process, {
    cause,
  });
}

interface ChildOwner {
  readonly process: ManagedProcess;
  readonly spawned: Promise<void>;
  readonly failed: Promise<never>;
  readonly output: () => { stdout: string; stderr: string };
}

/** Waits for observed close, not merely a successful signal syscall. */
async function waitForClose(
  closed: Promise<ProcessClose>,
  effects: ProcessEffects,
  isClosed: () => boolean,
): Promise<boolean> {
  const timeout = Promise.withResolvers<boolean>();
  const timer = effects.setTimer(
    () => timeout.resolve(false),
    CLOSE_TIMEOUT_MS,
  );
  try {
    return (
      (await Promise.race([closed.then(() => true), timeout.promise])) ||
      isClosed()
    );
  } finally {
    effects.clearTimer(timer);
  }
}

/** Signals only the captured direct child with bounded TERM/KILL and awaits raw close.
 * @param child - Direct spawn handle; no PID discovery or descendant signalling.
 * @param closed - Promise resolved by the child's observed close.
 * @param effects - Direct-child signalling and bounded-close timers.
 * @param isClosed - Synchronous observation of close, including races with signal failures.
 * @returns Resolves only after close has been observed.
 * @throws HostProcessError while the child remains open after a failed or timed-out attempt.
 * @example await stopChild(child, childClosed, effects, () => didClose)
 */
async function stopChild(
  child: ChildProcess,
  closed: Promise<ProcessClose>,
  effects: ProcessEffects,
  isClosed: () => boolean,
): Promise<void> {
  try {
    effects.signal(child, "SIGTERM");
    if (isClosed() || (await waitForClose(closed, effects, isClosed))) {
      return;
    }
    if (!isClosed()) {
      effects.signal(child, "SIGKILL");
      if (isClosed() || (await waitForClose(closed, effects, isClosed))) {
        return;
      }
    }
  } catch (error) {
    if (isClosed()) {
      return;
    }
    throw processFailure(
      "Native process termination could not be confirmed.",
      error,
    );
  }
  if (isClosed()) {
    return;
  }
  throw new HostProcessError(
    "Native process termination could not be confirmed.",
  );
}

/** Installs child lifetime observers before transferring an exclusively owned handle.
 * @param child - Direct child returned by the spawn effect; never a process-table lookup.
 * @param maximum - Combined output retention limit, in bytes.
 * @param effects - Child signalling and bounded-close timers.
 * @returns A managed handle with observed close and shared in-flight termination.
 * @example ownChild(spawn("/bin/tool"), 1024, effects).process.closed resolves only after "close".
 */
function ownChild(
  child: ChildProcess,
  maximum: number,
  effects: ProcessEffects,
): ChildOwner {
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  let remaining = maximum;
  const closed = Promise.withResolvers<ProcessClose>();
  const spawned = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<never>();
  let finished = false;
  child.once("close", (exitCode, signal) => {
    finished = true;
    closed.resolve({ exitCode, signal });
  });
  child.once("spawn", spawned.resolve);
  child.on("error", () =>
    failed.reject(new HostProcessError("Native process failed.")),
  );
  failed.promise.catch(() => undefined);
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.on("error", () =>
      failed.reject(new HostProcessError("Native output failed.")),
    );
    // biome-ignore lint/suspicious/noLoopFunc: Both block-scoped stream handlers intentionally share the child's combined output budget.
    child[stream]?.on("data", (data: Buffer) => {
      if (remaining > 0) {
        const retained =
          data.length > remaining
            ? Buffer.from(data.subarray(0, remaining))
            : data;
        chunks[stream].push(retained);
        remaining -= retained.length;
      }
    });
  }
  let termination: Promise<void> | undefined;
  return {
    process: {
      closed: closed.promise,
      terminate: () => {
        if (termination !== undefined) {
          return termination;
        }
        if (finished) {
          return Promise.resolve();
        }
        const stop = stopChild(child, closed.promise, effects, () => finished);
        termination = stop.finally(() => {
          termination = undefined;
        });
        return termination;
      },
    },
    spawned: spawned.promise,
    failed: failed.promise,
    output: () => ({
      stdout: Buffer.concat(chunks.stdout).toString("utf8"),
      stderr: Buffer.concat(chunks.stderr).toString("utf8"),
    }),
  };
}

/** Runs one shell-free direct child with ignored stdin, returning output on close or transferring its handle after spawn.
 * @param executable - Selected native executable; no shell interpretation.
 * @param argv - Literal arguments supplied to the child.
 * @param options - Finite or managed lifetime, private environment, cancellation, and byte/deadline limits.
 * @param effects - Injectable spawn, direct-child signalling, clock and timer effects.
 * @returns Finite output after close, or a managed child owning its own termination and close.
 * @throws HostProcessError with the retained handle if termination cannot be confirmed.
 * @example await runHostProcess('/usr/bin/git', ['--version'], { environment: { PATH: '/usr/bin' }, mode: 'finite', timeoutMs: 1000 }, defaultProcessEffects)
 */
export function runHostProcess(
  executable: string,
  argv: readonly string[],
  options: ProcessOptions & { mode: "finite" },
  effects: ProcessEffects,
): Promise<ProcessResult>;
export function runHostProcess(
  executable: string,
  argv: readonly string[],
  options: ProcessOptions & { mode: "managed" },
  effects: ProcessEffects,
): Promise<ManagedProcess>;
export async function runHostProcess(
  executable: string,
  argv: readonly string[],
  options: ProcessOptions,
  effects: ProcessEffects,
): Promise<ProcessResult | ManagedProcess> {
  if (
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.signal?.aborted
  ) {
    throw new HostProcessError(
      "Native process launch cancelled or deadline invalid.",
    );
  }
  const maximum = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new HostProcessError("Native output limit is invalid.");
  }
  let child: ChildProcess;
  try {
    child = effects.spawn(executable, [...argv], {
      env: { ...options.environment },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw processFailure("Native process could not be launched.", error);
  }
  const owner = ownChild(child, maximum, effects);
  return await settleOperation(owner, options, effects);
}

/** Releases launch cancellation at handoff; managed lifetime belongs only to its handle. */
async function settleOperation(
  owner: ChildOwner,
  options: ProcessOptions,
  effects: ProcessEffects,
): Promise<ProcessResult | ManagedProcess> {
  const interrupted = Promise.withResolvers<never>();
  const cancel = () =>
    interrupted.reject(
      new HostProcessError("Native process cancelled or timed out."),
    );
  const timer = effects.setTimer(cancel, options.timeoutMs);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) {
    cancel();
  }
  try {
    await Promise.race([owner.failed, interrupted.promise, owner.spawned]);
    if (options.signal?.aborted) {
      throw new HostProcessError("Native process launch cancelled.");
    }
    if (options.mode === "managed") {
      return owner.process;
    }
    const result = await Promise.race([
      owner.failed,
      interrupted.promise,
      owner.process.closed,
    ]);
    if (result.exitCode === null) {
      throw new HostProcessError("Native process exited without a status.");
    }
    return { exitCode: result.exitCode, ...owner.output() };
  } catch (error) {
    try {
      await owner.process.terminate();
    } catch (terminationError) {
      throw processFailure(
        "Native process cleanup is uncertain.",
        terminationError,
        owner.process,
      );
    }
    throw processFailure(
      "Native process failed, timed out, or was cancelled.",
      error,
    );
  } finally {
    effects.clearTimer(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
