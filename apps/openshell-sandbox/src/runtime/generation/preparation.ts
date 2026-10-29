import {
  failureError,
  RuntimeFailure,
  safeFailure,
} from "../../diagnostics/index.ts";
import type { OwnedResource } from "../../host/index.ts";
import { HostProcessError } from "../../host/index.ts";
import { assertLive, deadline, SETUP_TIMEOUT_MS } from "../work/index.ts";
import { cleanupGeneration } from "./cleanup.ts";
import { randomIdentity } from "./identity.ts";
import {
  awaitGenerationReadiness,
  createGenerationSandbox,
  type GenerationWork,
  provisionGenerationGateway,
  runGenerationSetup,
} from "./setup.ts";
import type {
  ConfirmedStop,
  CreationOutcome,
  GenerationEffects,
  GenerationInput,
  GenerationReport,
  PreparedGateway,
  ReadySandbox,
  SandboxGeneration,
} from "./types.ts";

/** Creates one inaccessible owner before scheduling setup after the caller installs its phase.
 * @param input - Immutable environment, reusable gateway, and activation cancellation.
 * @param effects - External acquisition capabilities whose raw work stays owned through settlement.
 * @param report - Synchronous runtime state facts; no UI observer is captured.
 * @returns Shared readiness handle with idempotent native cleanup.
 * @throws Invalid entropy rejects before allocating deadlines, readiness work or native resources.
 * @example concurrent requests share the same generation readiness promise.
 */
export function prepareGeneration(
  input: GenerationInput,
  effects: GenerationEffects,
  report: GenerationReport,
): SandboxGeneration {
  return new GenerationPreparation(input, effects, report).handle;
}

class GenerationPreparation {
  readonly input: GenerationInput;
  readonly effects: GenerationEffects;
  readonly report: GenerationReport;
  readonly controller = new AbortController();
  readonly tasks = Promise.withResolvers<void>();
  readonly setup = Promise.withResolvers<ReadySandbox>();
  readonly handle: SandboxGeneration;
  readonly preparation;
  pendingTasks = 1;
  resources: OwnedResource[] = [];
  prepared: PreparedGateway | undefined;
  outcome: CreationOutcome = "not-sent";
  sandboxId: string | undefined;
  stop: Promise<ConfirmedStop> | undefined;

  constructor(
    input: GenerationInput,
    effects: GenerationEffects,
    report: GenerationReport,
  ) {
    const sandboxName = `po-${randomIdentity(effects)}`;
    this.input = input;
    this.effects = effects;
    this.report = report;
    this.prepared = input.preparedGateway;
    this.preparation = deadline(effects, SETUP_TIMEOUT_MS, [
      input.signal,
      this.controller.signal,
    ]);
    const readiness = Promise.resolve().then(() =>
      awaitGenerationReadiness({
        setup: this.setup.promise,
        preparation: this.preparation,
        generation: this.handle,
        report,
        invalidate: () => this.invalidate(),
      }),
    );
    this.handle = Object.freeze({
      sandboxName,
      signal: AbortSignal.any([input.signal, this.controller.signal]),
      readiness,
      invalidate: () => this.invalidate(),
    });
    readiness.catch(() => undefined);
    queueMicrotask(() => {
      this.performSetup().then(this.setup.resolve, this.setup.reject);
    });
  }

  /** Owns acquired release capabilities until gateway transfer or confirmed native cleanup.
   * @example provider create failure leaves each prior provider and gateway resource captured.
   */
  capture(resource: OwnedResource): void {
    this.resources.push(resource);
  }

  /** Admits only live setup operations and counts raw work until actual settlement.
   * @example a pending create cannot become quiescent when preparation times out.
   */
  async step<T>(operation: () => Promise<T>): Promise<T> {
    assertLive(this.controller.signal);
    if (this.pendingTasks === 0) {
      throw new RuntimeFailure(
        "admission",
        "preparation",
        "Generation setup already settled.",
      );
    }
    assertLive(this.preparation.signal);
    return await this.trackTask(operation);
  }

  /** Tracks raw work, including a child whose failed termination has not closed.
   * @example cancellation does not release the private gateway while a Git child is unsettled.
   */
  async trackTask<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingTasks += 1;
    try {
      return await operation();
    } finally {
      this.finishTask();
    }
  }

  /** Settles one raw step or the setup sentinel; zero proves quiescence.
   * @example a still-pending sibling keeps the task barrier unresolved.
   */
  finishTask(): void {
    this.pendingTasks -= 1;
    if (this.pendingTasks === 0) {
      this.tasks.resolve();
    }
  }

  /** Acquires one dependency chain without touching runtime phase or Pi observer state.
   * @example provider failure never publishes a reusable gateway bundle.
   */
  async performSetup(): Promise<ReadySandbox> {
    const work: GenerationWork = {
      input: this.input,
      effects: this.effects,
      generation: this.handle,
      preparation: this.preparation,
      capture: (resource) => this.capture(resource),
      report: this.report,
      step: (operation) => this.step(operation),
      gitProcess: async (argv) => {
        try {
          return await this.effects.gitProcess(argv, this.preparation.signal);
        } catch (error) {
          if (error instanceof HostProcessError && error.process) {
            const child = error.process;
            await this.trackTask(() => child.closed);
          }
          throw error;
        }
      },
      prepareGateway: async () => this.prepareGateway(work),
      createSandbox: async (gateway, workspace, image) =>
        createGenerationSandbox({
          work,
          gateway,
          workspace,
          image,
          record: (outcome, id) => {
            this.outcome = outcome;
            if (id) {
              this.sandboxId = id;
            }
            this.report({ generation: this.handle, kind: "creation", outcome });
          },
        }),
    };
    try {
      return await runGenerationSetup(work);
    } finally {
      this.finishTask();
    }
  }

  /** Transfers the entire gateway group after providers settle, leaving partial setup owned here.
   * @example cancellation after provider success retains SDK provider releases until runtime disposal.
   */
  async prepareGateway(work: GenerationWork): Promise<PreparedGateway> {
    if (this.prepared) {
      return this.prepared;
    }
    const prepared = await provisionGenerationGateway(work);
    this.prepared = prepared;
    this.report({
      generation: this.handle,
      kind: "gateway-prepared",
      gateway: prepared,
    });
    this.resources = [];
    return prepared;
  }

  /** Installs one shared cleanup promise before reporting cancellation or running callbacks.
   * @example simultaneous timeouts receive the identical stop promise.
   */
  invalidate(): Promise<ConfirmedStop> {
    if (this.stop !== undefined) {
      return this.stop;
    }
    const completion = Promise.withResolvers<ConfirmedStop>();
    this.stop = completion.promise;
    this.stop.catch(() => undefined);
    this.controller.abort();
    this.report({ generation: this.handle, kind: "stopping" });
    this.cleanup().then(completion.resolve, completion.reject);
    return this.stop;
  }

  /** Waits for raw tasks before releasing native sandbox and any partial acquisitions.
   * @example an unsettled create blocks gateway release and marks cleanup unconfirmed.
   */
  async cleanup(): Promise<ConfirmedStop> {
    try {
      const proof = await cleanupGeneration({
        tasksFinished: this.tasks.promise,
        snapshot: () =>
          Object.freeze({
            sandboxName: this.handle.sandboxName,
            sandboxId: this.sandboxId,
            createOutcome: this.outcome,
            preparedGateway: this.prepared,
            ownedResources: Object.freeze([...this.resources]),
          }),
        effects: this.effects,
      });
      this.resources = [];
      this.report({ generation: this.handle, kind: "stopped" });
      return proof;
    } catch (error) {
      const failure = safeFailure(error, "cleanup");
      this.report({ generation: this.handle, kind: "cleanup-failed", failure });
      throw failureError(failure, error);
    }
  }
}
