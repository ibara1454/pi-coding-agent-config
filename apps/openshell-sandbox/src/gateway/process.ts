import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  HostProcessError,
  type ManagedProcess,
  nativeFailure,
  runHostProcess,
} from "../host/index.ts";
import type { GatewayState } from "./state.ts";
import type { GatewayHostContext as HostContext } from "./types.ts";

/** Launches one private gateway and captures its owned direct-child handle before readiness.
 * A failed launch with uncertain termination also retains that handle for retryable cleanup;
 * signalling never establishes close or control over descendants.
 * Database path characters remain filename data rather than SQLite URL query syntax.
 * @returns The process handle whose close and termination remain observable.
 * @throws A sanitized launch failure after retaining any uncertain process.
 * @example const child = await launchGateway(host, state, "/state/gateway.toml", signal); await child.terminate()
 */
export async function launchGateway(
  host: HostContext,
  state: GatewayState,
  configPath: string,
  signal: AbortSignal,
): Promise<ManagedProcess> {
  let child: ManagedProcess;
  try {
    child = await runHostProcess(
      host.gatewayExecutable,
      [
        "--config",
        configPath,
        "--db-url",
        `sqlite://${pathToFileURL(join(state.directory, "gateway.db")).pathname}`,
      ],
      {
        environment: state.environment,
        mode: "managed",
        timeoutMs: 10_000,
        signal,
        maxOutputBytes: 0,
      },
      host.processEffects,
    );
  } catch (error) {
    if (error instanceof HostProcessError && error.process) {
      state.capture({
        kind: "process",
        release: error.process.terminate,
      });
    }
    throw nativeFailure("Private gateway process launch failed.", error);
  }
  state.capture({ kind: "process", release: child.terminate });
  return child;
}
