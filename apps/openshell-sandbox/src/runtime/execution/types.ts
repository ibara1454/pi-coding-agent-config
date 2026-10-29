import type * as filesystem from "node:fs/promises";
import type { SandboxGeneration } from "../generation/index.ts";
import type { TimerEffects } from "../work/index.ts";

export interface ExecutionEvents {
  data: [chunk: Uint8Array];
  exit: [result: { exitCode: number }];
  error: [error: Error];
}
export type ExecutionOptions = Readonly<{
  signal?: AbortSignal;
  timeout?: number;
}>;

/** A request owns listener/timer waiting; the runtime retains each raw promise through settlement. */
export type ExecutionEffects = TimerEffects &
  Readonly<{
    activationSignal: AbortSignal;
    filesystem: Pick<typeof filesystem, "realpath" | "stat">;
  }>;

/** Runtime admission and raw-work retention are supplied without exposing controller state. */
export type RequestOwner = Readonly<{
  effects: ExecutionEffects;
  admit: () => SandboxGeneration;
  trackRaw: (raw: Promise<unknown>) => void;
}>;
