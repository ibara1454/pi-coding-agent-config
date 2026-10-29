import type { PreparedGateway, SandboxGeneration } from "./generation/index.ts";
import type { RuntimeEffects } from "./types.ts";
import { CLEANUP_TIMEOUT_MS, deadline, waitBounded } from "./work/index.ts";

/** Bounds raw requests, generation deletion, SDK providers, and gateway close together.
 * An unsettled native request cannot surrender its private gateway on caller timeout.
 * @example timed-out raw execution leaves gateway open until request actually settles.
 */
export async function settleRuntimeDisposal(
  input: Readonly<{
    effects: RuntimeEffects;
    generation: SandboxGeneration | undefined;
    rawRequests: ReadonlySet<Promise<unknown>>;
    prepared: () => PreparedGateway | undefined;
    generationStopped: () => boolean;
  }>,
): Promise<void> {
  const { effects, generation, rawRequests, prepared, generationStopped } =
    input;
  const limit = deadline(effects, CLEANUP_TIMEOUT_MS);
  try {
    if (generation) {
      await waitBounded(generation.invalidate(), limit.signal);
    }
    await waitBounded(Promise.allSettled([...rawRequests]), limit.signal);
    if (generation && !generationStopped()) {
      throw new Error("Generation cleanup unconfirmed.");
    }
    const gateway = prepared();
    if (gateway) {
      await gateway.providerResources
        .toReversed()
        .reduce<Promise<void>>(async (previous, provider) => {
          await previous;
          await waitBounded(provider.release(), limit.signal);
        }, Promise.resolve());
      await waitBounded(gateway.handle.close(), limit.signal);
    }
  } finally {
    limit.close();
  }
}
