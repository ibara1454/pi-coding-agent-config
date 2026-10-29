import type { ChildProcess, spawn } from "node:child_process";

/** External process operations; callers supply these rather than inheriting global state. */
export interface ProcessEffects {
  readonly spawn: typeof spawn;
  readonly signal: (child: ChildProcess, signal: NodeJS.Signals) => void;
  readonly setTimer: (
    callback: () => void,
    milliseconds: number,
  ) => NodeJS.Timeout;
  readonly clearTimer: (timer: NodeJS.Timeout) => void;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessClose {
  // biome-ignore lint/plugin/biome-rules/use-undefined: Node close reports a null exit code when the child exits by signal.
  readonly exitCode: number | null;
  // biome-ignore lint/plugin/biome-rules/use-undefined: Node close reports a null signal when the child exits with a numeric code.
  readonly signal: string | null;
}

/** An exclusively owned direct child retained through its close and termination capabilities.
 * Concurrent termination shares one attempt; an uncertain result can be retried.
 * Termination succeeds only after observing close, not after signalling.
 * @example const child = await runHostProcess("/bin/tool", [], { environment: {}, mode: "managed", timeoutMs: 1000 }, effects); await child.terminate()
 */
export interface ManagedProcess {
  readonly closed: Promise<ProcessClose>;
  readonly terminate: () => Promise<void>;
}

export interface ProcessOptions {
  readonly environment: Readonly<Record<string, string>>;
  readonly mode: "finite" | "managed";
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
}

/** Safe diagnostics with retained ownership when process termination is uncertain. */
export class HostProcessError extends Error {
  readonly process?: ManagedProcess;

  constructor(
    message: string,
    process?: ManagedProcess,
    options?: ErrorOptions,
  ) {
    super(message, options);
    if (process) {
      this.process = process;
    }
    this.name = "HostProcessError";
  }
}
