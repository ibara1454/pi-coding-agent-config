import { failureError, safeFailure } from "../../diagnostics/index.ts";
import type { ManagedGateway } from "../../gateway/index.ts";
import { startPrivateGateway } from "../../gateway/index.ts";
import type { AcquisitionCapture, OwnedResource } from "../../host/index.ts";
import { DEFAULT_SANDBOX_IMAGE } from "../../image/index.ts";
import { provisionProviders } from "../../providers/index.ts";
import {
  type GitProcess,
  inspectWorkspace,
  type ProjectWorkspace,
} from "../../workspace/index.ts";
import { assertLive, type Deadline, waitBounded } from "../work/index.ts";
import { createNativeSandbox, isRejectedCreate } from "./provision.ts";
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

const MILLISECONDS_PER_SECOND = 1000;

export type GenerationWork = Readonly<{
  input: GenerationInput;
  effects: GenerationEffects;
  generation: SandboxGeneration;
  preparation: Deadline;
  capture: AcquisitionCapture;
  report: GenerationReport;
  step: <T>(operation: () => Promise<T>) => Promise<T>;
  gitProcess: GitProcess;
  prepareGateway: () => Promise<PreparedGateway>;
  createSandbox: (
    gateway: PreparedGateway,
    workspace: ProjectWorkspace,
    image: string,
  ) => Promise<string>;
}>;

/** Keeps local create validation known-unsent, then records uncertainty at the native RPC boundary.
 * A matching acknowledgment or genuine native rejection resolves an attempted create's ownership.
 * @param request Generation work and the owner's creation-outcome recorder.
 * @returns The identity-matching native sandbox ID, recorded before task settlement.
 * @throws The original local or native failure, retaining known-unsent or uncertain ownership as applicable.
 * @example An unknown credential binding sends no RPC and leaves the generation known-unsent.
 */
export async function createGenerationSandbox(
  request: Readonly<{
    work: GenerationWork;
    gateway: PreparedGateway;
    workspace: ProjectWorkspace;
    image: string;
    record: (outcome: CreationOutcome, id?: string) => void;
  }>,
): Promise<string> {
  const { work, gateway, workspace, image, record } = request;
  return await work.step(async () => {
    try {
      const id = await createNativeSandbox({
        input: work.input,
        gateway: gateway.handle,
        sandboxName: work.generation.sandboxName,
        workspace,
        image,
        providerNames: gateway.providerNames,
        signal: work.preparation.signal,
        onCreateAttempt: () => record("unknown"),
      });
      record("acknowledged", id);
      return id;
    } catch (error) {
      if (await isRejectedCreate(error)) {
        record("rejected");
      }
      throw error;
    }
  });
}

/** Separates bounded readiness from raw setup settlement and gives cleanup failure precedence.
 * @example a timed-out create holds its gateway until raw work settles or cleanup rejects.
 */
export async function awaitGenerationReadiness(
  input: Readonly<{
    setup: Promise<ReadySandbox>;
    preparation: Deadline;
    generation: SandboxGeneration;
    report: GenerationReport;
    invalidate: () => Promise<ConfirmedStop>;
  }>,
): Promise<ReadySandbox> {
  const { setup, preparation, generation, report, invalidate } = input;
  try {
    const resources = await waitBounded(setup, preparation.signal);
    assertLive(preparation.signal);
    report({ generation, kind: "ready", resources });
    return resources;
  } catch (error) {
    await invalidate();
    const failure = safeFailure(error, "preparation");
    report({ generation, kind: "preparation-failed", failure });
    throw failureError(failure, error);
  } finally {
    preparation.close();
  }
}

/** Acquires workspace, gateway, providers, and sandbox; returns the acknowledged SDK ID after readiness.
 * @example a same-name replacement after readiness cannot receive later model commands.
 */
export async function runGenerationSetup(
  work: GenerationWork,
): Promise<ReadySandbox> {
  const { input, effects, generation, preparation, step, report } = work;
  const workspace = await step(async () =>
    inspectWorkspace(
      input.environment.projectRoot,
      effects.host.paths,
      effects.filesystem,
      work.gitProcess,
    ),
  );
  report({ generation, kind: "workspace", workspace });
  const image = input.environment.image ?? DEFAULT_SANDBOX_IMAGE;
  report({ generation, kind: "image", image });
  const prepared = await work.prepareGateway();
  report({ generation, kind: "progress", step: "sandbox" });
  const sandboxId = await work.createSandbox(prepared, workspace, image);
  await checkSandbox(work, prepared.handle, sandboxId);
  assertLive(preparation.signal);
  return Object.freeze({
    gateway: prepared,
    sandboxId,
    workspace,
    environment: Object.freeze({
      ["LANG"]: "C.UTF-8",
      ["LC_ALL"]: "C.UTF-8",
    }),
  });
}

/** Verifies immutable SDK identity after waitReady before any workload runs.
 * @example a same-name replacement cannot be mistaken for our acknowledged sandbox.
 */
async function checkSandbox(
  work: GenerationWork,
  gateway: ManagedGateway,
  sandboxId: string,
): Promise<void> {
  const { generation, preparation, step } = work;
  const sandbox = await step(async () =>
    gateway.client.sandbox.waitReady(
      generation.sandboxName,
      preparation.remaining() / MILLISECONDS_PER_SECOND,
      { signal: preparation.signal },
    ),
  );
  if (
    sandbox.id !== sandboxId ||
    sandbox.name !== generation.sandboxName ||
    Object.entries(gateway.labels).some(
      ([key, value]) => sandbox.labels[key] !== value,
    )
  ) {
    throw new Error("Sandbox identity changed during readiness.");
  }
}

/** Publishes known gateway coordinates during acquisition; ownership transfers only after providers settle.
 * @example one failed provider create keeps gateway recovery facts and captured releases without a reusable bundle.
 */
export async function provisionGenerationGateway(
  work: GenerationWork,
): Promise<PreparedGateway> {
  const { input, effects, generation, preparation, step, capture, report } =
    work;
  report({ generation, kind: "progress", step: "gateway" });
  const handle = await step(async () =>
    startPrivateGateway(
      effects.host,
      preparation.signal,
      capture,
      (coordinates) =>
        report({ generation, kind: "gateway-acquired", coordinates }),
    ),
  );
  report({ generation, kind: "progress", step: "providers" });
  const providerResources: OwnedResource[] = [];
  const providerNames = await step(async () =>
    provisionProviders(
      handle,
      input.environment,
      effects.credentialSource,
      (resource) => {
        capture(resource);
        providerResources.push(resource);
      },
    ),
  );
  return Object.freeze({
    handle,
    providerNames,
    providerResources: Object.freeze(providerResources),
  });
}
