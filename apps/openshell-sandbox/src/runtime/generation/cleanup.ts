import type { SandboxRef } from "@nvidia/openshell-sdk";
import { RuntimeFailure } from "../../diagnostics/index.ts";
import {
  assertLive,
  CLEANUP_TIMEOUT_MS,
  type Deadline,
  deadline,
  waitBounded,
} from "../work/index.ts";
import type {
  CleanupEffects,
  ConfirmedStop,
  GenerationResources,
} from "./types.ts";

const MILLISECONDS_PER_SECOND = 1000;
const STOP_POLL_INTERVAL_MS = 100;

/** Bounds raw setup settlement and native release under one cleanup deadline.
 * @param input - Raw quiescence and a snapshot read only after its settlement.
 * @returns Confirmation only when sandbox and partial acquisitions are released.
 * @throws On unknown creation, unresolved work, or unconfirmed native cleanup.
 * @example a never-settling create retains its gateway and rejects at the cleanup deadline.
 */
export async function cleanupGeneration(
  input: Readonly<{
    tasksFinished: Promise<void>;
    snapshot: () => GenerationResources;
    effects: CleanupEffects;
  }>,
): Promise<ConfirmedStop> {
  const limit = deadline(input.effects, CLEANUP_TIMEOUT_MS);
  try {
    await waitBounded(input.tasksFinished, limit.signal);
    return await waitBounded(
      invalidateGeneration(input.snapshot(), input.effects, limit),
      limit.signal,
    );
  } finally {
    limit.close();
  }
}

/** Deletes only acknowledged SDK identity, then releases partial acquisitions in reverse order.
 * @param resources - Settled generation ownership to verify before native deletion.
 * @param effects - Timer operations used for bounded stop polling.
 * @param limit - Shared deadline already bounding raw-work settlement.
 * @returns Confirmation after native deletion and reverse-order resource release.
 * @throws When creation, ownership, deletion, or resource release cannot be confirmed.
 * @example transport loss during create cannot justify deleting a same-name sandbox.
 */
async function invalidateGeneration(
  resources: GenerationResources,
  effects: CleanupEffects,
  limit: Deadline,
): Promise<ConfirmedStop> {
  assertLive(limit.signal);
  if (resources.createOutcome === "unknown") {
    throw new RuntimeFailure(
      "cleanup",
      "create-settlement",
      "Sandbox creation could not be confirmed; preserving private gateway resources.",
    );
  }
  if (resources.createOutcome === "acknowledged") {
    await deleteAcknowledged(resources, effects, limit);
  }
  await resources.ownedResources
    .toReversed()
    .reduce<Promise<void>>(async (previous, resource) => {
      await previous;
      assertLive(limit.signal);
      await resource.release();
    }, Promise.resolve());
  return Object.freeze({ kind: "confirmed" });
}

/** Reads only the acknowledged name and verifies immutable ID and labels before deletion.
 * @example a same-name replacement causes cleanup failure instead of deleting another owner's sandbox.
 */
async function lookup(
  resources: GenerationResources,
  limit: Deadline,
): Promise<SandboxRef | undefined> {
  const gateway = resources.preparedGateway;
  if (!(gateway && resources.sandboxId)) {
    throw new RuntimeFailure(
      "cleanup",
      "identity",
      "Sandbox identity is unavailable.",
    );
  }
  try {
    const sandbox = await gateway.handle.client.sandbox.get(
      resources.sandboxName,
      { signal: limit.signal, timeoutMs: limit.remaining() },
    );
    if (
      sandbox.id !== resources.sandboxId ||
      sandbox.name !== resources.sandboxName ||
      Object.entries(gateway.handle.labels).some(
        ([key, value]) => sandbox.labels[key] !== value,
      )
    ) {
      throw new RuntimeFailure(
        "cleanup",
        "identity",
        "Sandbox ownership changed; preserving the replacement.",
      );
    }
    return sandbox;
  } catch (error) {
    // Dynamic SDK load preserves fail-closed Bash registration before native code loads.
    const { SdkError } = await import("@nvidia/openshell-sdk");
    if (error instanceof SdkError && error.code === "not_found") {
      return undefined;
    }
    throw error;
  }
}

/** Reobserves stop/delete races within one deadline before confirming SDK deletion.
 * @example an already stopped sandbox skips stop and is deleted by acknowledged name.
 */
async function deleteAcknowledged(
  resources: GenerationResources,
  effects: CleanupEffects,
  limit: Deadline,
): Promise<void> {
  const gateway = resources.preparedGateway;
  if (!gateway) {
    throw new RuntimeFailure(
      "cleanup",
      "gateway",
      "Owned gateway is unavailable.",
    );
  }
  const sandbox = await lookup(resources, limit);
  if (!sandbox) {
    return;
  }
  if (sandbox.phase === "ready" || sandbox.phase === "stopping") {
    await stopAndReobserve(resources, effects, limit);
    return;
  }
  if (
    !["provisioning", "error", "stopped", "deleting"].includes(sandbox.phase)
  ) {
    throw new RuntimeFailure(
      "cleanup",
      "phase",
      "Sandbox phase does not prove safe cleanup.",
    );
  }
  if (sandbox.phase !== "deleting") {
    await gateway.handle.client.raw.deleteSandbox(
      { name: resources.sandboxName, workspace: "default" },
      { signal: limit.signal, timeoutMs: limit.remaining() },
    );
  }
  await gateway.handle.client.sandbox.waitDeleted(
    resources.sandboxName,
    limit.remaining() / MILLISECONDS_PER_SECOND,
    { signal: limit.signal },
  );
}

/** Requeries acknowledged identity after stop, never treating stop transport errors as deletion proof.
 * @example a raced stopped response still permits verified delete; unknown phase remains retained.
 */
async function stopAndReobserve(
  resources: GenerationResources,
  effects: CleanupEffects,
  limit: Deadline,
): Promise<void> {
  const gateway = resources.preparedGateway;
  if (!gateway) {
    throw new RuntimeFailure(
      "cleanup",
      "gateway",
      "Owned gateway is unavailable.",
    );
  }
  assertLive(limit.signal);
  let stopError: unknown;
  try {
    await gateway.handle.client.raw.stopSandbox(
      { name: resources.sandboxName, workspace: "default" },
      { signal: limit.signal, timeoutMs: limit.remaining() },
    );
  } catch (error) {
    stopError = error;
    assertLive(limit.signal);
  }
  const sandbox = await lookup(resources, limit);
  if (!sandbox) {
    if (stopError) {
      throw stopError;
    }
    return;
  }
  if (sandbox.phase === "ready" || sandbox.phase === "stopping") {
    const paused = Promise.withResolvers<void>();
    const timer = effects.setTimer(
      paused.resolve,
      Math.min(STOP_POLL_INTERVAL_MS, limit.remaining()),
    );
    try {
      await waitBounded(paused.promise, limit.signal);
    } finally {
      effects.clearTimer(timer);
    }
  }
  await deleteAcknowledged(resources, effects, limit);
}
