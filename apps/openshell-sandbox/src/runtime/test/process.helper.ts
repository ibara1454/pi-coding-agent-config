import { ChildProcess, type spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import type { ProcessEffects } from "../../host/index.ts";
import { defaultProcessEffects } from "../../host/index.ts";

export interface RuntimeNativeState {
  labels: Record<string, string>;
  sandboxId: string | undefined;
  sandboxName: string | undefined;
  phase?: "ready" | "stopped";
  sandboxPresent: boolean;
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
    const stdout = argv[0] === "--version" ? "openshell-gateway 0.1.0" : "";
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
