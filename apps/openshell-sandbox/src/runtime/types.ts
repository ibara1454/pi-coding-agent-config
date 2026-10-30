import type { EventEmitter } from "node:events";
import type { SafeFailure } from "../diagnostics/index.ts";
import type { ExecutionEvents, ExecutionOptions } from "./execution/index.ts";
import type {
  CreationOutcome,
  GenerationEffects,
  PreparationStep,
  SandboxGeneration,
} from "./generation/index.ts";

export type SandboxRuntime = Readonly<{
  exec: (
    command: string,
    cwd: string,
    options?: ExecutionOptions,
  ) => EventEmitter<ExecutionEvents>;
  getStatus: () => SanitizedRuntimeStatus;
  dispose: () => Promise<void>;
}>;
export type SanitizedRuntimeStatus = Readonly<{
  phase: RuntimeState["phase"];
  preparationStep?: PreparationStep;
  policyPath: string;
  image?: string;
  requiredNativeReadWritePaths: readonly string[];
  lastFailure: SafeFailure | undefined;
  recovery?: Readonly<{
    sandboxName: string;
    /** Absent until sandbox creation starts; provider failure alone proves no create outcome. */
    createOutcome?: CreationOutcome;
    gatewayEndpoint?: string;
    tlsDirectory?: string;
    networkId?: string;
  }>;
}>;
export type RuntimeObserver = Readonly<{
  progress: (status: SanitizedRuntimeStatus) => void;
  failure: (failure: SafeFailure) => void;
}>;

/** Complete host/runtime capabilities, with activation cancellation owned by its adapter. */
export type RuntimeEffects = GenerationEffects &
  Readonly<{ activationSignal: AbortSignal }>;

export type RuntimeState =
  | { phase: "idle" }
  | {
      phase: "preparing";
      preparationStep: PreparationStep;
      generation: SandboxGeneration;
    }
  | {
      phase: "ready";
      generation: SandboxGeneration;
    }
  | { phase: "stopping"; generation: SandboxGeneration }
  | {
      phase: "closing";
      stage: "generation";
      generation: SandboxGeneration;
      disposal: Promise<void>;
    }
  | { phase: "closing"; stage: "session"; disposal: Promise<void> }
  | { phase: "closed"; disposal: Promise<void> }
  | {
      phase: "recovery-required";
      scope: "generation";
      generation: SandboxGeneration;
      failure: SafeFailure;
      disposal: Promise<void> | undefined;
    }
  | {
      phase: "recovery-required";
      scope: "session";
      failure: SafeFailure;
      disposal: Promise<void> | undefined;
    };
export interface RuntimeDiagnostics {
  lastFailure: SafeFailure | undefined;
}
