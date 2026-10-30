import type { SandboxEnvironment } from "../configuration/index.ts";
import type { SafeFailure } from "../diagnostics/index.ts";
import { safeText } from "../diagnostics/index.ts";
import type { GatewayRecoveryCoordinates } from "../gateway/index.ts";
import type {
  CreationOutcome,
  PreparedGateway,
  SandboxGeneration,
} from "./generation/index.ts";
import type {
  RuntimeDiagnostics,
  RuntimeObserver,
  RuntimeState,
  SanitizedRuntimeStatus,
} from "./types.ts";

const MAX_STATUS_TEXT_LENGTH = 512;

/** Projects cached facts into bounded diagnostics and lossless native grants without I/O or observer effects.
 * @param input - Cached runtime facts, including a non-owning recovery snapshot until full cleanup succeeds.
 * @example confirmed sandbox deletion retains gateway coordinates if provider release subsequently fails.
 */
export function runtimeStatus(
  input: Readonly<{
    environment: SandboxEnvironment;
    state: RuntimeState;
    prepared: PreparedGateway | undefined;
    gatewayCoordinates: GatewayRecoveryCoordinates | undefined;
    creationOutcome: CreationOutcome | undefined;
    recoverySnapshot?: SanitizedRuntimeStatus["recovery"];
    requiredPaths: readonly string[];
    image: string | undefined;
    diagnostics: RuntimeDiagnostics;
  }>,
): SanitizedRuntimeStatus {
  const {
    state,
    environment,
    prepared,
    gatewayCoordinates,
    creationOutcome,
    recoverySnapshot,
    requiredPaths,
    image,
    diagnostics,
  } = input;
  const generation: SandboxGeneration | undefined =
    "generation" in state ? state.generation : undefined;
  const recovery =
    recoveryStatus(generation, creationOutcome, gatewayCoordinates, prepared) ??
    recoverySnapshot;
  return Object.freeze({
    phase: state.phase,
    ...(state.phase === "preparing"
      ? { preparationStep: state.preparationStep }
      : {}),
    policyPath: safeText(environment.policy.sourcePath, MAX_STATUS_TEXT_LENGTH),
    ...((image ?? environment.image)
      ? {
          image: safeText(
            image ?? environment.image ?? "",
            MAX_STATUS_TEXT_LENGTH,
          ),
        }
      : {}),
    requiredNativeReadWritePaths: Object.freeze([...requiredPaths]),
    lastFailure: diagnostics.lastFailure,
    ...(recovery ? { recovery } : {}),
  });
}

/** Projects known gateway facts independently of sandbox creation or resource transfer.
 * @example readmission reports retained gateway coordinates before another sandbox create starts.
 */
function recoveryStatus(
  generation: SandboxGeneration | undefined,
  creationOutcome: CreationOutcome | undefined,
  coordinates: GatewayRecoveryCoordinates | undefined,
  prepared: PreparedGateway | undefined,
): SanitizedRuntimeStatus["recovery"] {
  if (!(generation && (creationOutcome || coordinates || prepared))) {
    return undefined;
  }
  const gateway =
    coordinates ??
    (prepared
      ? {
          gatewayEndpoint: prepared.handle.endpoint,
          tlsDirectory: prepared.handle.tlsDirectory,
          networkId: prepared.handle.networkId,
        }
      : undefined);
  return Object.freeze({
    sandboxName: generation.sandboxName,
    ...(creationOutcome ? { createOutcome: creationOutcome } : {}),
    ...(gateway?.gatewayEndpoint !== undefined
      ? {
          gatewayEndpoint: safeText(
            gateway.gatewayEndpoint,
            MAX_STATUS_TEXT_LENGTH,
          ),
        }
      : {}),
    ...(gateway?.tlsDirectory !== undefined
      ? { tlsDirectory: safeText(gateway.tlsDirectory, MAX_STATUS_TEXT_LENGTH) }
      : {}),
    ...(gateway?.networkId !== undefined
      ? { networkId: safeText(gateway.networkId, MAX_STATUS_TEXT_LENGTH) }
      : {}),
  });
}

/** Publishes only to an attached observer; observer exceptions never affect native ownership.
 * @param observer - Active publication target, absent after activation retirement or disposal.
 * @param kind - Callback channel, including failures that must stop after detachment.
 * @param value - Bounded status or safe diagnostic delivered without mutation.
 * @example publishRuntimeObservation(undefined, "failure", failure) delivers nothing.
 */
export function publishRuntimeObservation<K extends keyof RuntimeObserver>(
  observer: RuntimeObserver | undefined,
  kind: K,
  value: Parameters<RuntimeObserver[K]>[0],
): void {
  if (!observer) {
    return;
  }
  try {
    if (kind === "progress") {
      observer.progress(value as SanitizedRuntimeStatus);
    } else {
      observer.failure(value as SafeFailure);
    }
  } catch {
    // Observer failure never changes ownership, admission or the cached diagnostic.
  }
}
