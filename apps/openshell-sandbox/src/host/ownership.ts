import {
  nativeFailure,
  type ProcessResult,
  runHostProcess,
} from "./process.ts";
import { HostProcessError } from "./process-types.ts";
import type { HostContext } from "./types.ts";

const DOCKER_TIMEOUT_MS = 15_000;
const MAX_DOCKER_OUTPUT_BYTES = 1_048_576;

/** Runs a bounded Docker operation on one explicit local daemon with safe failures.
 * @param host - Captured endpoint already admitted by resolveDockerHost.
 * @example await dockerCommand(host, ['network', 'inspect', networkId])
 */
export async function dockerCommand(
  host: HostContext,
  argv: readonly string[],
  signal?: AbortSignal,
): Promise<ProcessResult> {
  if (host.dockerEndpoint.includes("\n")) {
    throw new Error("OpenShell Docker endpoint must not contain a newline.");
  }
  try {
    const result = await runHostProcess(
      host.dockerExecutable,
      ["--host", host.dockerEndpoint, ...argv],
      {
        environment: host.environment,
        mode: "finite",
        timeoutMs: DOCKER_TIMEOUT_MS,
        maxOutputBytes: MAX_DOCKER_OUTPUT_BYTES,
        ...(signal ? { signal } : {}),
      },
      host.processEffects,
    );
    if (result.exitCode !== 0) {
      throw new Error("Docker operation failed.");
    }
    return result;
  } catch (error) {
    if (error instanceof HostProcessError) {
      throw error;
    }
    throw nativeFailure("Required private Docker operation failed.", error);
  }
}
