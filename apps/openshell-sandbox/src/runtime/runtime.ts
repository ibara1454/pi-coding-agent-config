import type { EventEmitter } from "node:events";
import type { SandboxEnvironment } from "../configuration/index.ts";
import { failureError, safeFailure } from "../diagnostics/index.ts";
import type { GatewayRecoveryCoordinates } from "../gateway/index.ts";
import { settleRuntimeDisposal } from "./disposal.ts";
import type { ExecutionEvents, ExecutionOptions } from "./execution/index.ts";
import { executeRequest } from "./execution/index.ts";
import type {
  CreationOutcome,
  GenerationEvent,
  PreparedGateway,
  SandboxGeneration,
} from "./generation/index.ts";
import { prepareGeneration } from "./generation/index.ts";
import {
  closingState,
  failedDisposalState,
  projectGenerationEvent,
  selectGeneration,
} from "./state.ts";
import { publishRuntimeObservation, runtimeStatus } from "./status.ts";
import type {
  RuntimeDiagnostics,
  RuntimeEffects,
  RuntimeObserver,
  RuntimeState,
  SandboxRuntime,
  SanitizedRuntimeStatus,
} from "./types.ts";

/** Starts one observed generation without waiting for its SDK readiness.
 * @param environment - Session-specific sandbox image, workspace and validated policy.
 * @param effects - Captured private host capabilities owned for this activation.
 * @param observer - Publication callbacks detached on activation cancellation or disposal.
 * @returns Promise of the runtime that owns native generation and gateway cleanup.
 * @throws Rejects if constructing or starting the runtime fails before a handle exists.
 * @example createSandboxRuntime(env, effects, observer) resolves while sandbox creation runs.
 */
export function createSandboxRuntime(
  environment: SandboxEnvironment,
  effects: RuntimeEffects,
  observer: RuntimeObserver,
): Promise<SandboxRuntime> {
  let owner: RuntimeController | undefined;
  try {
    owner = new RuntimeController(environment, effects);
    owner.observe(observer);
    owner.start();
    return Promise.resolve(owner.handle);
  } catch (error) {
    owner?.detachObserver();
    return Promise.reject(error);
  }
}

class RuntimeController {
  readonly environment: SandboxEnvironment;
  readonly effects: RuntimeEffects;
  observer: RuntimeObserver | undefined;
  readonly diagnostics: RuntimeDiagnostics = { lastFailure: undefined };
  readonly rawRequests = new Set<Promise<unknown>>();
  state: RuntimeState = { phase: "idle" };
  prepared: PreparedGateway | undefined;
  creationOutcome: CreationOutcome | undefined;
  gatewayCoordinates: GatewayRecoveryCoordinates | undefined;
  recoverySnapshot: SanitizedRuntimeStatus["recovery"];
  requiredPaths: readonly string[] = [];
  image: string | undefined;
  recentGeneration: SandboxGeneration | undefined;

  /** Detaches callbacks without relinquishing ownership of unsettled native work.
   * @example activation abort releases Pi callbacks while raw create stays owned.
   */
  readonly detachObserver = (): void => {
    this.observer = undefined;
    this.effects.activationSignal.removeEventListener(
      "abort",
      this.detachObserver,
    );
  };

  /** Stable handle shares this controller's native cleanup across repeated calls.
   * @example two dispose calls return the same cleanup promise.
   */
  readonly handle: SandboxRuntime = Object.freeze({
    exec: (command: string, cwd: string, options: ExecutionOptions = {}) =>
      this.exec(command, cwd, options),
    getStatus: () => runtimeStatus(this),
    dispose: () => this.dispose(),
  });

  constructor(environment: SandboxEnvironment, effects: RuntimeEffects) {
    this.environment = environment;
    this.effects = effects;
    effects.activationSignal.addEventListener("abort", this.detachObserver, {
      once: true,
    });
    if (effects.activationSignal.aborted) {
      this.detachObserver();
    }
  }

  /** Installs observer only while the activation remains live.
   * @example pre-aborted activation cannot retain a Pi notification callback.
   */
  observe(observer: RuntimeObserver): void {
    if (!this.effects.activationSignal.aborted) {
      this.observer = observer;
    }
  }

  /** Refuses admission before native preparation if the activation was already canceled.
   * @example an already closed session never opens a private gateway.
   */
  start(): void {
    if (this.effects.activationSignal.aborted) {
      const failure = safeFailure(
        new Error("Activation invalidated."),
        "admission",
      );
      this.diagnostics.lastFailure = failure;
      this.state = {
        phase: "recovery-required",
        scope: "session",
        failure,
        disposal: undefined,
      };
      this.publish("failure", failure);
      return;
    }
    this.admit();
  }

  /** Installs a new generation synchronously so concurrent requests share its readiness.
   * @example ready/preparing returns its handle; idle allocates one named sandbox.
   */
  admit(): SandboxGeneration {
    const existing = selectGeneration(this.state);
    if (existing) {
      return existing;
    }
    const input = Object.freeze({
      environment: this.environment,
      preparedGateway: this.prepared,
      signal: this.effects.activationSignal,
    });
    const generation = prepareGeneration(input, this.effects, (event) =>
      this.report(event),
    );
    this.recentGeneration = generation;
    this.creationOutcome = undefined;
    this.gatewayCoordinates = undefined;
    this.recoverySnapshot = undefined;
    this.state = {
      phase: "preparing",
      preparationStep: "starting",
      generation,
    };
    this.publish("progress", runtimeStatus(this));
    return generation;
  }

  /** Keeps matching recovery facts separate from gateway transfer, including during closing.
   * @example late acquisition during cancellation reports coordinates without reviving readiness.
   */
  report(event: GenerationEvent): void {
    if (event.kind === "gateway-prepared") {
      this.prepared = event.gateway;
      return;
    }
    if (event.kind === "preparation-failed") {
      if (
        this.recentGeneration === event.generation &&
        !("disposal" in this.state && this.state.disposal !== undefined)
      ) {
        this.diagnostics.lastFailure = event.failure;
        this.publish("failure", event.failure);
        this.publish("progress", runtimeStatus(this));
      }
      return;
    }
    if (
      !(
        "generation" in this.state && this.state.generation === event.generation
      )
    ) {
      return;
    }
    if (event.kind === "gateway-acquired") {
      this.gatewayCoordinates = event.coordinates;
      this.publish("progress", runtimeStatus(this));
      return;
    }
    if (event.kind === "creation") {
      this.creationOutcome = event.outcome;
      this.publish("progress", runtimeStatus(this));
      return;
    }
    const live = !event.generation.signal.aborted;
    if (event.kind === "stopped") {
      this.recoverySnapshot = this.prepared
        ? runtimeStatus(this).recovery
        : undefined;
      this.creationOutcome = undefined;
      this.gatewayCoordinates = undefined;
    }
    const projected = projectGenerationEvent({
      state: this.state,
      event,
      live,
      requiredPaths: this.requiredPaths,
      image: this.image,
    });
    this.state = projected.state;
    this.requiredPaths = projected.requiredPaths;
    this.image = projected.image;
    if (event.kind === "cleanup-failed") {
      this.diagnostics.lastFailure = event.failure;
      this.publish("failure", event.failure);
    }
    this.publish("progress", runtimeStatus(this));
  }

  /** Isolates observer failures from native admission and resource ownership.
   * @example a failed Pi notification never clears recovery-required state.
   */
  publish<K extends keyof RuntimeObserver>(
    kind: K,
    value: Parameters<RuntimeObserver[K]>[0],
  ): void {
    publishRuntimeObservation(this.observer, kind, value);
  }

  /** Starts deferred execution without allowing model commands to bypass admission.
   * @example a normal nonzero exit leaves the ready sandbox reusable.
   */
  exec(
    command: string,
    cwd: string,
    options: ExecutionOptions,
  ): EventEmitter<ExecutionEvents> {
    return executeRequest(command, cwd, options, {
      effects: this.effects,
      admit: () => this.admit(),
      trackRaw: (raw) => {
        this.rawRequests.add(raw);
        const retire = () => this.rawRequests.delete(raw);
        raw.then(retire, retire);
      },
    });
  }

  /** Installs the closing state before native cleanup can reenter this controller.
   * @example repeated dispose returns the same rejection after uncertain deletion.
   */
  dispose(): Promise<void> {
    if ("disposal" in this.state && this.state.disposal) {
      return this.state.disposal;
    }
    const completion = Promise.withResolvers<void>();
    this.detachObserver();
    this.state = closingState(this.state, completion.promise);
    completion.promise.catch(() => undefined);
    this.teardown(completion.promise).then(
      completion.resolve,
      completion.reject,
    );
    return completion.promise;
  }

  /** Deletes SDK providers after sandbox cleanup, then closes the private gateway.
   * @example an unresolved create retains gateway and provider ownership for recovery.
   */
  async teardown(disposal: Promise<void>): Promise<void> {
    try {
      const generation =
        "generation" in this.state ? this.state.generation : undefined;
      await settleRuntimeDisposal({
        effects: this.effects,
        generation,
        rawRequests: this.rawRequests,
        prepared: () => this.prepared,
      });
      this.prepared = undefined;
      this.creationOutcome = undefined;
      this.gatewayCoordinates = undefined;
      this.recoverySnapshot = undefined;
      this.state = { phase: "closed", disposal };
    } catch (error) {
      const failure = safeFailure(error, "cleanup");
      this.diagnostics.lastFailure = failure;
      this.state = failedDisposalState(this.state, failure, disposal);
      this.publish("failure", failure);
      throw failureError(failure, error);
    }
  }
}
