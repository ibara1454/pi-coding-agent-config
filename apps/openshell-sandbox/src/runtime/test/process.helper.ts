import { ChildProcess, type spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import type { ProcessEffects } from "../../host/index.ts";
import { defaultProcessEffects } from "../../host/index.ts";

const DOCKER_ID_LENGTH = 64;
export const TEST_CONTAINER = "b".repeat(DOCKER_ID_LENGTH);
export const TEST_NETWORK = "d".repeat(DOCKER_ID_LENGTH);
export interface RuntimeNativeState {
  labels: Record<string, string>;
  sandboxId: string | undefined;
  sandboxName: string | undefined;
  networkId?: string;
  phase?: "ready" | "stopped";
  sandboxPresent: boolean;
  networkPresent: boolean;
  namespace: string;
  calls: string[][];
  launches: number;
}

/** Replaces only external spawn/signal; production argument construction and ownership checks remain real.
 * @example one managed launch remains alive across two confirmed sandbox generations.
 */
export function runtimeTestProcesses(
  state: RuntimeNativeState,
): ProcessEffects {
  const spawnEffect = ((_executable: string, argv: readonly string[]) => {
    state.calls.push([...argv]);
    const child = new ChildProcess();
    Object.defineProperties(child, {
      stdout: { value: new PassThrough() },
      stderr: { value: new PassThrough() },
    });
    const managed = argv[0] === "--config";
    if (managed) {
      state.launches += 1;
    }
    const stdout = managed ? "" : nativeOutput(state, argv);
    queueMicrotask(() => {
      child.emit("spawn");
      if (!managed) {
        child.stdout?.emit("data", Buffer.from(stdout));
        Object.defineProperty(child, "exitCode", { value: 0 });
        // biome-ignore lint/plugin/biome-rules/use-undefined: Node child close uses null for an absent termination signal.
        child.emit("close", 0, null);
      }
    });
    return child;
  }) as typeof spawn;
  return {
    ...defaultProcessEffects,
    spawn: spawnEffect,
    signal: (child, signal) => {
      Object.defineProperty(child, "signalCode", { value: signal });
      // biome-ignore lint/plugin/biome-rules/use-undefined: Node child close uses null for an absent exit code after signal termination.
      queueMicrotask(() => child.emit("close", null, signal));
    },
  };
}

/** Supplies gateway version and private-network Docker JSON, never SDK-owned sandbox discovery.
 * @example a network inspect reports the exact identity created by the previous subprocess.
 */
function nativeOutput(
  state: RuntimeNativeState,
  argv: readonly string[],
): string {
  if (argv[0] === "--version") {
    return "openshell-gateway 0.0.116";
  }
  if (argv[0] === "generate-certs") {
    return "";
  }
  const args = argv.slice(2);
  if (args[0] === "info") {
    return "test-daemon-identity";
  }
  return args[0] === "network" ? networkOutput(state, args) : "";
}

/** Preserves native labels and identity readback for the real network release policy.
 * @example a network inspect returns the exact ID created by the previous subprocess.
 */
function networkOutput(
  state: RuntimeNativeState,
  args: readonly string[],
): string {
  if (args[1] === "ls") {
    return state.networkPresent ? (state.networkId ?? TEST_NETWORK) : "";
  }
  if (args[1] === "create") {
    return createNetwork(state, args);
  }
  if (args[1] === "rm") {
    if (
      !state.networkPresent ||
      args[2] !== (state.networkId ?? TEST_NETWORK)
    ) {
      throw new Error("network identity changed");
    }
    state.networkPresent = false;
    return "";
  }
  return args[1] === "inspect" ? inspectNetwork(state, args[2]) : "";
}

/** Mimics the Docker create response and preserves its externally visible ownership. */
function createNetwork(
  state: RuntimeNativeState,
  args: readonly string[],
): string {
  state.labels = Object.fromEntries(
    args.flatMap((arg, index) =>
      arg === "--label" ? [(args[index + 1] ?? "").split("=")] : [],
    ),
  );
  state.namespace = args.at(-1) ?? "";
  state.networkPresent = true;
  return state.networkId ?? TEST_NETWORK;
}

/** Reports attached containers and the exact live network identity to production release. */
function inspectNetwork(
  state: RuntimeNativeState,
  id: string | undefined,
): string {
  if (!state.networkPresent || id !== (state.networkId ?? TEST_NETWORK)) {
    throw new Error("network missing");
  }
  return JSON.stringify([
    {
      ["Id"]: state.networkId ?? TEST_NETWORK,
      ["Name"]: state.namespace,
      ["Labels"]: state.labels,
      ["Containers"]: state.sandboxPresent ? { [TEST_CONTAINER]: {} } : {},
    },
  ]);
}
