import { randomBytes } from "node:crypto";
import process from "node:process";
import type { HostContext } from "../host/index.ts";
import {
  captureHostContext,
  resolveDockerHost,
  runHostProcess,
  withGatewayExecutable,
} from "../host/index.ts";
import type { RuntimeEffects } from "./types.ts";

/** Native entropy, credential and timer adapters for one activation. */
export type RuntimeNativeCapabilities = Readonly<{
  execution?: Pick<
    RuntimeEffects,
    "credentialSource" | "randomBytes" | "setTimer" | "clearTimer"
  >;
}>;

/** Resolves local host prerequisites before giving the runtime its external effects.
 * @param controller - Adapter-owned activation cancellation, not a model request controller.
 * @param capturedHost - Captured host facts and owned filesystem/process adapters.
 * @param capabilities - Optional execution-native adapters owned by this activation.
 * @returns Native capabilities after local gateway and Docker context resolution.
 * @throws If activation closes or a required local prerequisite fails.
 * @example createRuntimeEffects(controller, host) resolves a local Docker endpoint.
 */
export async function createRuntimeEffects(
  controller: AbortController,
  capturedHost: HostContext = captureHostContext(),
  capabilities: RuntimeNativeCapabilities = {},
): Promise<RuntimeEffects> {
  const nativeHost = await withGatewayExecutable(capturedHost);
  if (controller.signal.aborted) {
    throw new Error("OpenShell activation was closed.");
  }
  const host = await resolveDockerHost(nativeHost, controller.signal);
  if (controller.signal.aborted) {
    throw new Error("OpenShell activation was closed.");
  }
  const execution: NonNullable<RuntimeNativeCapabilities["execution"]> =
    capabilities.execution ?? {
      credentialSource: (name) => process.env[name],
      randomBytes,
      setTimer: setTimeout,
      clearTimer: clearTimeout as RuntimeEffects["clearTimer"],
    };
  return {
    host,
    activationSignal: controller.signal,
    filesystem: host.filesystem,
    ...execution,
    gitProcess: (argv, signal) => {
      const environment: Record<string, string> = {};
      const { PATH: path = "/usr/local/bin:/usr/bin:/bin" } = host.environment;
      environment["PATH"] = path;
      environment["HOME"] = host.paths.home;
      environment["GIT_CONFIG_NOSYSTEM"] = "1";
      environment["GIT_CONFIG_GLOBAL"] = "/dev/null";
      return runHostProcess(
        "git",
        argv,
        {
          environment,
          mode: "finite",
          timeoutMs: 10_000,
          maxOutputBytes: 16_384,
          signal: signal ?? controller.signal,
        },
        host.processEffects,
      );
    },
  };
}
