import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import {
  failureError,
  RuntimeFailure,
  safeFailure,
} from "../../diagnostics/index.ts";
import { mapCommandDirectory } from "../../workspace/index.ts";
import type { ReadySandbox, SandboxGeneration } from "../generation/index.ts";
import type { Deadline } from "../work/index.ts";
import { assertLive, deadline, waitBounded } from "../work/index.ts";
import type {
  ExecutionEffects,
  ExecutionEvents,
  ExecutionOptions,
  RequestOwner,
} from "./types.ts";

type Outcome =
  | { kind: "exit"; exitCode: number }
  | { kind: "error"; error: Error };
const MILLISECONDS_PER_SECOND = 1000;
const MAX_HOST_TIMER_MS = 2_147_483_647;

/** Starts only after synchronous listener attachment, streams live bytes, then delivers one terminal event.
 * Admission is a runtime-owned operation; this request owns timers/listeners/raw work and no runtime state.
 * @example ordinary exit 124 is an exit, not a timeout and not a policy warning.
 */
export function executeRequest(
  command: string,
  cwd: string,
  options: ExecutionOptions,
  owner: RequestOwner,
): EventEmitter<ExecutionEvents> {
  const request = new ExecutionRequest(command, cwd, options, owner);
  queueMicrotask(() => {
    request
      .run()
      .then((outcome) =>
        queueMicrotask(() => {
          if (outcome.kind === "exit") {
            request.emitter.emit("exit", { exitCode: outcome.exitCode });
          } else {
            request.emitter.emit("error", outcome.error);
          }
        }),
      )
      .catch((error: unknown) => {
        const failure = safeFailure(error, "execution");
        queueMicrotask(() =>
          request.emitter.emit("error", failureError(failure, error)),
        );
      });
  });
  return request.emitter;
}

class ExecutionRequest {
  readonly emitter = new EventEmitter<ExecutionEvents>();
  readonly requestedAt: number;
  readonly command: string;
  readonly cwd: string;
  readonly options: ExecutionOptions;
  readonly effects: ExecutionEffects;
  readonly admit: () => SandboxGeneration;
  readonly trackRaw: (raw: Promise<unknown>) => void;
  generation: SandboxGeneration | undefined;
  limit: Deadline | undefined;
  signal: AbortSignal | undefined;
  executionStarted: boolean;
  terminal: boolean;

  constructor(
    command: string,
    cwd: string,
    options: ExecutionOptions,
    owner: RequestOwner,
  ) {
    this.executionStarted = false;
    this.command = command;
    this.cwd = cwd;
    this.options = options;
    this.effects = owner.effects;
    this.admit = owner.admit;
    this.trackRaw = owner.trackRaw;
    this.requestedAt = performance.now();
    this.terminal = false;
  }

  /** Validates before admission; timeout starts when exec was called, including readiness and cwd checks.
   * @returns The stored live signal combining the admitted generation, caller, and deadline.
   * @example an already-aborted signal fails without acquiring or canceling an unrelated generation.
   */
  initialize(): AbortSignal {
    const { timeout, signal } = this.options;
    if (
      typeof this.command !== "string" ||
      this.command.includes("\0") ||
      typeof this.cwd !== "string" ||
      !isAbsolute(this.cwd) ||
      this.cwd.includes("\0")
    ) {
      throw new RuntimeFailure(
        "validation",
        "execution",
        "Invalid sandbox command or absolute working directory.",
      );
    }
    if (
      timeout !== undefined &&
      (!Number.isFinite(timeout) ||
        timeout <= 0 ||
        timeout * MILLISECONDS_PER_SECOND > MAX_HOST_TIMER_MS)
    ) {
      throw new RuntimeFailure(
        "validation",
        "timeout",
        "Sandbox timeout must be a finite positive number within host timer limits.",
      );
    }
    if (signal) {
      assertLive(signal);
    }
    if (timeout !== undefined) {
      const remaining =
        timeout * MILLISECONDS_PER_SECOND -
        (performance.now() - this.requestedAt);
      if (remaining <= 0) {
        throw new RuntimeFailure("timeout", "deadline", "Command timed out");
      }
      this.limit = deadline(this.effects, remaining);
      assertLive(this.limit.signal);
    }
    this.generation = this.admit();
    this.signal = AbortSignal.any([
      ...(this.limit ? [this.limit.signal] : []),
      ...(signal ? [signal] : []),
      this.generation.signal,
    ]);
    assertLive(this.signal);
    return this.signal;
  }

  /** Converts operational failure once; required generation cleanup precedes the terminal result.
   * @example a thrown data listener invalidates unknown execution but never causes two terminal events.
   */
  async run(): Promise<Outcome> {
    try {
      const signal = this.initialize();
      const raw = this.execute(signal);
      this.trackRaw(raw);
      const exitCode = await waitBounded(raw, signal);
      assertLive(signal);
      return { kind: "exit", exitCode };
    } catch (error) {
      let failure = await this.recoverPreparationFailure(error);
      if (this.generation && (this.signal?.aborted || this.executionStarted)) {
        try {
          await this.generation.invalidate();
        } catch (cleanupError) {
          failure = cleanupError;
        }
      }
      const safe = safeFailure(failure, "execution");
      return { kind: "error", error: failureError(safe, failure) };
    } finally {
      this.terminal = true;
      this.limit?.close();
    }
  }

  /** Recovers the preparation error hidden by generation cleanup's own abort.
   * Independent caller and lifecycle signals can still end this extra wait.
   */
  async recoverPreparationFailure(error: unknown): Promise<unknown> {
    const { generation } = this;
    if (
      this.executionStarted ||
      !generation?.signal.aborted ||
      !(error instanceof RuntimeFailure) ||
      error.failure.code !== "aborted" ||
      error.failure.operation !== "cancellation"
    ) {
      return error;
    }
    const independent = AbortSignal.any([
      ...(this.options.signal ? [this.options.signal] : []),
      ...(this.limit ? [this.limit.signal] : []),
      this.effects.activationSignal,
    ]);
    try {
      await waitBounded(generation.readiness, independent);
    } catch (readinessError) {
      return readinessError;
    }
    return error;
  }

  /** Raw operations remain tracked through actual settlement even after the caller stops waiting.
   * @example a canceled realpath response cannot admit a later native command.
   */
  async execute(signal: AbortSignal): Promise<number> {
    const { generation } = this;
    if (!generation) {
      throw new RuntimeFailure(
        "admission",
        "execution",
        "Sandbox generation unavailable.",
      );
    }
    const resources = await generation.readiness;
    assertLive(signal);
    const resolved = await this.effects.filesystem.realpath(this.cwd);
    assertLive(signal);
    const stat = await this.effects.filesystem.stat(resolved);
    assertLive(signal);
    if (!stat.isDirectory()) {
      throw new RuntimeFailure(
        "validation",
        "cwd",
        "Sandbox working directory is not a directory.",
      );
    }
    const workdir = mapCommandDirectory(
      resources.workspace,
      this.cwd,
      resolved,
    );
    assertLive(signal);
    return await this.streamExecution(resources, workdir, signal);
  }

  /** Streams bytes from the acknowledged immutable ID; never resolves a mutable sandbox name.
   * Retains raw work through settlement; missing, duplicate, or late terminal data invalidates execution.
   * @example data arrives before the single terminal result even if the name now refers to another sandbox.
   */
  async streamExecution(
    resources: ReadySandbox,
    workdir: string,
    signal: AbortSignal,
  ): Promise<number> {
    this.executionStarted = true;
    const stream = resources.gateway.handle.client.raw.execSandbox(
      {
        sandboxId: resources.sandboxId,
        command: ["/bin/bash", "-c", this.command],
        workdir,
        environment: resources.environment,
        timeoutSeconds: 0,
        stdin: new Uint8Array(),
        tty: false,
      },
      { signal },
    );
    let exitCode: number | undefined;
    for await (const event of stream) {
      assertLive(signal);
      if (this.terminal) {
        throw new RuntimeFailure("aborted", "execution", "aborted");
      }
      if (exitCode !== undefined) {
        throw new RuntimeFailure(
          "execution",
          "stream",
          "Execution data followed its terminal result.",
        );
      }
      const { payload } = event;
      if (payload.case === "exit") {
        ({ exitCode } = payload.value);
      } else if (payload.case === "stdout" || payload.case === "stderr") {
        const { data } = payload.value;
        this.emitter.emit("data", data);
      }
    }
    if (exitCode === undefined || !Number.isInteger(exitCode)) {
      throw new RuntimeFailure(
        "execution",
        "stream",
        "Execution ended without a terminal exit result.",
      );
    }
    assertLive(signal);
    return exitCode;
  }
}
