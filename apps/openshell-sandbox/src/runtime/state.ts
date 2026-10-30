import type { SafeFailure } from "../diagnostics/index.ts";
import { RuntimeFailure } from "../diagnostics/index.ts";
import type { GenerationEvent, SandboxGeneration } from "./generation/index.ts";
import type { RuntimeState } from "./types.ts";

/** Pure admission: only idle can allocate; preparing and ready share their existing generation.
 * @example selectGeneration({phase:"idle"}) returns undefined without starting work.
 */
export function selectGeneration(
  state: RuntimeState,
): SandboxGeneration | undefined {
  if (state.phase === "idle") {
    return undefined;
  }
  if (state.phase === "preparing" || state.phase === "ready") {
    return state.generation;
  }
  throw new RuntimeFailure(
    "admission",
    "execution",
    `OpenShell refuses commands while ${state.phase}.`,
    {
      recovery:
        "Inspect /sandbox; restart the session if cleanup cannot be confirmed.",
    },
  );
}

/** Calculates complete phase variants from generation facts, never adopting ownership or publishing UI.
 * @example a late ready event leaves a closing state unchanged.
 */
function transitionGeneration(
  state: RuntimeState,
  event: GenerationEvent,
  live: boolean,
): RuntimeState {
  switch (event.kind) {
    case "progress":
      return state.phase === "preparing" && live
        ? { ...state, preparationStep: event.step }
        : state;
    case "ready":
      return state.phase === "preparing" && live
        ? {
            phase: "ready",
            generation: event.generation,
          }
        : state;
    case "stopping":
      return state.phase === "preparing" || state.phase === "ready"
        ? { phase: "stopping", generation: event.generation }
        : state;
    case "stopped":
      return stoppedState(state);
    case "cleanup-failed":
      return {
        phase: "recovery-required",
        scope: "generation",
        generation: event.generation,
        failure: event.failure,
        disposal: "disposal" in state ? state.disposal : undefined,
      };
    default:
      return state;
  }
}

/** Reduces a matching generation event into phase and cached facts.
 * @example an aborted workspace event cannot replace the last live required paths.
 */
export function projectGenerationEvent(
  input: Readonly<{
    state: RuntimeState;
    event: GenerationEvent;
    live: boolean;
    requiredPaths: readonly string[];
    image: string | undefined;
  }>,
): Readonly<{
  state: RuntimeState;
  requiredPaths: readonly string[];
  image: string | undefined;
}> {
  const { state, event, live, requiredPaths, image } = input;
  const nextState = transitionGeneration(state, event, live);
  let nextPaths = requiredPaths;
  if (live && event.kind === "workspace") {
    nextPaths = event.workspace.requiredNativeReadWritePaths;
  } else if (event.kind === "ready" && nextState.phase === "ready") {
    nextPaths = event.resources.workspace.requiredNativeReadWritePaths;
  }
  return {
    state: nextState,
    requiredPaths: nextPaths,
    image: live && event.kind === "image" ? event.image : image,
  };
}

/** Successful cleanup drops the generation field but preserves activation failure/disposal facts.
 * @example stopping becomes idle; closing/generation becomes closing/session.
 */
function stoppedState(state: RuntimeState): RuntimeState {
  if (state.phase === "stopping") {
    return { phase: "idle" };
  }
  if (state.phase === "closing") {
    return { phase: "closing", stage: "session", disposal: state.disposal };
  }
  if (state.phase === "recovery-required") {
    return {
      phase: "recovery-required",
      scope: "session",
      failure: state.failure,
      disposal: state.disposal,
    };
  }
  return state;
}

/** Installs the closing generation/session variant synchronously before cleanup can reenter.
 * @example a preparing generation remains attached until cleanup proves it stopped.
 */
export function closingState(
  state: RuntimeState,
  disposal: Promise<void>,
): RuntimeState {
  return "generation" in state
    ? {
        phase: "closing",
        stage: "generation",
        generation: state.generation,
        disposal,
      }
    : { phase: "closing", stage: "session", disposal };
}

/** Retains a failed disposal's generation until cleanup is independently proven.
 * @example an uncertain create remains generation-scoped recovery rather than closed.
 */
export function failedDisposalState(
  state: RuntimeState,
  failure: SafeFailure,
  disposal: Promise<void>,
): RuntimeState {
  return "generation" in state
    ? {
        phase: "recovery-required",
        scope: "generation",
        generation: state.generation,
        failure,
        disposal,
      }
    : { phase: "recovery-required", scope: "session", failure, disposal };
}
