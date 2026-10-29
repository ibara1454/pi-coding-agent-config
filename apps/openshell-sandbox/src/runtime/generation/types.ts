import type * as filesystem from "node:fs/promises";
import type { SandboxEnvironment } from "../../configuration/index.ts";
import type { SafeFailure } from "../../diagnostics/index.ts";
import type {
  GatewayHostContext,
  GatewayRecoveryCoordinates,
  ManagedGateway,
} from "../../gateway/index.ts";
import type { OwnedResource } from "../../host/index.ts";
import type { GitProcess, ProjectWorkspace } from "../../workspace/index.ts";
import type { TimerEffects } from "../work/index.ts";

/** SDK generation acquisition capabilities, excluding runtime phase and disposal. */
export type GenerationEffects = TimerEffects &
  Readonly<{
    host: GatewayHostContext;
    filesystem: typeof filesystem;
    gitProcess: GitProcess;
    credentialSource: (name: string) => string | undefined;
    randomBytes: (size: number) => Uint8Array;
  }>;
/** Cleanup owns its bounded timer, not runtime disposal or new acquisitions. */
export type CleanupEffects = TimerEffects;

export type PreparationStep = "starting" | "gateway" | "providers" | "sandbox";
export type CreationOutcome =
  | "not-sent"
  | "unknown"
  | "rejected"
  | "acknowledged";
export type PreparedGateway = Readonly<{
  handle: ManagedGateway;
  providerNames: Readonly<Record<string, string>>;
  providerResources: readonly OwnedResource[];
}>;
/** Readiness retains the create acknowledgment ID; workload RPCs must never re-resolve sandboxName. */
export type ReadySandbox = Readonly<{
  gateway: PreparedGateway;
  sandboxId: string;
  workspace: ProjectWorkspace;
  environment: Readonly<Record<string, string>>;
}>;
export type ConfirmedStop = Readonly<{ kind: "confirmed" }>;
export type SandboxGeneration = Readonly<{
  sandboxName: string;
  signal: AbortSignal;
  readiness: Promise<ReadySandbox>;
  invalidate: () => Promise<ConfirmedStop>;
}>;
export type GenerationInput = Readonly<{
  environment: SandboxEnvironment;
  preparedGateway: PreparedGateway | undefined;
  signal: AbortSignal;
}>;
export type GenerationEvent = Readonly<
  { generation: SandboxGeneration } & (
    | { kind: "progress"; step: PreparationStep }
    | { kind: "gateway-acquired"; coordinates: GatewayRecoveryCoordinates }
    | { kind: "gateway-prepared"; gateway: PreparedGateway }
    | { kind: "ready"; resources: ReadySandbox }
    | { kind: "stopping" | "stopped" }
    | { kind: "workspace"; workspace: ProjectWorkspace }
    | { kind: "creation"; outcome: CreationOutcome }
    | { kind: "preparation-failed" | "cleanup-failed"; failure: SafeFailure }
    | { kind: "image"; image: string }
  )
>;
export type GenerationReport = (event: GenerationEvent) => void;
export type GenerationResources = Readonly<{
  sandboxName: string;
  sandboxId: string | undefined;
  createOutcome: CreationOutcome;
  preparedGateway: PreparedGateway | undefined;
  ownedResources: readonly OwnedResource[];
}>;
