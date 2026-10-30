import type { EventEmitter } from "node:events";
import process from "node:process";
import type {
  BashOperations,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { RuntimeFailure } from "../diagnostics/index.ts";
import type { ExecutionEvents } from "../runtime/index.ts";
import type { AdapterActivation } from "./session/index.ts";

interface BashResult {
  exitCode: number;
}
type BashOptions = Parameters<BashOperations["exec"]>[2];

/** Owns stream subscriptions through the single terminal event, without buffering output.
 * Adapts classified timeouts to Pi's seconds-based formatter contract; caller abort wins
 * over timeout, but other failures (including cleanup) retain their runtime precedence.
 * @example A timeout with timeout: 3 rejects as timeout:3 so Pi retains prior output.
 */
function subscribeExecution(
  execution: EventEmitter<ExecutionEvents>,
  options: BashOptions,
): Promise<BashResult> {
  const { promise, resolve, reject } = Promise.withResolvers<BashResult>();
  const detach = () => {
    execution.off("data", onData);
    execution.off("exit", onExit);
    execution.off("error", onError);
  };
  const onData = (chunk: Uint8Array) =>
    options.onData(
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    );
  const onExit = (result: BashResult) => {
    detach();
    resolve(result);
  };
  const onError = (error: Error) => {
    detach();
    reject(
      error instanceof RuntimeFailure &&
        error.failure.code === "timeout" &&
        options.timeout !== undefined
        ? new Error(
            options.signal?.aborted ? "aborted" : `timeout:${options.timeout}`,
          )
        : error,
    );
  };
  execution.on("data", onData);
  execution.once("exit", onExit);
  execution.once("error", onError);
  return promise;
}

/** Adapts one deferred execution without forwarding Pi's host environment.
 * @throws The sanitized runtime failure or Pi-compatible timeout/abort error; never replays commands.
 * @example Shell text beginning with ! stays sandboxed when invoked through model Bash.
 */
function executeModelBash(
  activation: AdapterActivation | undefined,
  command: string,
  cwd: string,
  options: BashOptions,
): Promise<BashResult> {
  if (!(activation?.current && activation.runtime)) {
    return Promise.reject(
      activation?.failure ??
        new Error("OpenShell has not started; model Bash is blocked."),
    );
  }
  const execution = activation.runtime.exec(command, cwd, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
  return subscribeExecution(execution, options);
}

/** Registers Pi's normal Bash result formatting with only its model execution entry replaced.
 * @example User !/!! never calls these operations; no user_bash hook is installed.
 */
export function registerModelBash(
  pi: ExtensionAPI,
  current: () => AdapterActivation | undefined,
): void {
  const operations: BashOperations = {
    exec: (command, cwd, options) =>
      executeModelBash(current(), command, cwd, options),
  };
  const bash = createBashTool(process.cwd(), {
    operations,
    exposeSessionEnvironment: false,
  });
  pi.registerTool({
    ...bash,
    label: "bash (OpenShell)",
    execute: (...[id, parameters, signal, onUpdate, context]) =>
      createBashTool(context.cwd, {
        operations,
        exposeSessionEnvironment: false,
      }).execute(id, parameters, signal, onUpdate),
  });
}
