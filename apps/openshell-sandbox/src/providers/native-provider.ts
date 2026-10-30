import type { ProviderResponse } from "@nvidia/openshell-sdk/raw";
import type { ProviderConfiguration } from "../configuration/index.ts";
import type { ManagedGateway } from "../gateway/index.ts";
import { type AcquisitionCapture, nativeFailure } from "../host/index.ts";

const PROVIDER_RPC_TIMEOUT_MS = 30_000;

/** Requires an acknowledged native ID under the exact requested name and workspace.
 * @throws On missing or mismatched identity.
 * @example acknowledgedProviderId(response, "po-a") returns "native-a" only for "po-a".
 */
function acknowledgedProviderId(
  response: ProviderResponse,
  name: string,
): string {
  const metadata = response.provider?.metadata;
  if (
    !metadata?.id ||
    metadata.name !== name ||
    metadata.workspace !== "default"
  ) {
    throw new Error("identity");
  }
  return metadata.id;
}

/** Reads the type only after the SDK confirms this name still belongs to the captured ID.
 * @throws On failed SDK lookup or changed native identity.
 * @example await getOwnedProviderType(gateway, "po-a", "native-a", signal) returns "registry".
 */
async function getOwnedProviderType(
  gateway: ManagedGateway,
  name: string,
  nativeId: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const found = await gateway.client.raw.getProvider(
    { name, workspace: "default" },
    { signal, timeoutMs: PROVIDER_RPC_TIMEOUT_MS },
  );
  if (acknowledgedProviderId(found, name) !== nativeId) {
    throw new Error("identity");
  }
  return found.provider?.type;
}

/** Deletes only an acknowledged native ID after rechecking its current SDK identity.
 * Uses a fresh timeout even when gateway creation was cancelled. An uncertain or
 * replaced provider stays owned by the private gateway instead of deleting by name.
 * @throws A sanitized error when ownership cannot be verified or deletion fails.
 * @example await deleteOwnedProvider(gateway, "po-activation-0", "native-id") deletes only that ID.
 */
async function deleteOwnedProvider(
  gateway: ManagedGateway,
  name: string,
  nativeId: string,
): Promise<void> {
  const signal = AbortSignal.timeout(PROVIDER_RPC_TIMEOUT_MS);
  const options = { signal, timeoutMs: PROVIDER_RPC_TIMEOUT_MS };
  try {
    await getOwnedProviderType(gateway, name, nativeId, signal);
    await gateway.client.raw.deleteProvider(
      { name, workspace: "default" },
      options,
    );
  } catch (error) {
    throw nativeFailure(
      "Native provider ownership or deletion failed; preserving private gateway.",
      error,
    );
  }
}

/** Owns selected credential reads, acquisition capture, native submission and erasure.
 * Cancellation precedes secret reads; lookup, capture and RPC failures all erase the local map.
 * @param capture Registers cleanup after credential lookup and before submitting the create RPC.
 * @returns The native response with credentials erased before identity or type lookup.
 * @throws Credential, capture or SDK failures, sanitized by the caller.
 * @example await createAndScrub(gateway, selection, source, capture) erases request credentials before returning.
 */
async function createAndScrub(
  gateway: ManagedGateway,
  { provider, name }: { provider: ProviderConfiguration; name: string },
  source: (name: string) => string | undefined,
  capture: () => void,
): Promise<ProviderResponse> {
  // biome-ignore lint/plugin/biome-rules/use-undefined: A null prototype preserves every native-valid environment key, including __proto__.
  const credentials: Record<string, string> = Object.create(null);
  try {
    gateway.signal.throwIfAborted();
    for (const [key, variable] of Object.entries(provider.credentialsFromEnv)) {
      const value = source(variable);
      if (!value) {
        throw new Error("missing");
      }
      credentials[key] = value;
    }
    capture();
    return await gateway.client.raw.createProvider(
      {
        workspace: "default",
        provider: {
          metadata: { name, workspace: "default" },
          type: provider.profile,
          profileWorkspace: "default",
          credentials,
        },
      },
      { signal: gateway.signal, timeoutMs: PROVIDER_RPC_TIMEOUT_MS },
    );
  } finally {
    for (const key of Object.keys(credentials)) {
      delete credentials[key];
    }
  }
}

/** Creates a uniquely named provider and captures its native ID for SDK-only cleanup.
 * An uncertain create cannot be deleted without an acknowledged ID; cleanup fails closed.
 * Selected environment keys remain own entries, including __proto__; credentials are erased on settlement.
 * @param capture Owns cleanup before the create RPC, even when its outcome is uncertain.
 * @throws A sanitized error on missing credentials, cancellation, or native failure.
 * @example await createNativeProvider(gateway, { provider, name: "po-a" }, source, capture) captures "po-a".
 */
export async function createNativeProvider(
  gateway: ManagedGateway,
  selection: { provider: ProviderConfiguration; name: string },
  source: (name: string) => string | undefined,
  capture: AcquisitionCapture,
): Promise<void> {
  const { provider, name } = selection;
  let nativeId: string | undefined;
  let released = false;
  try {
    const created = await createAndScrub(gateway, selection, source, () =>
      capture(
        Object.freeze({
          kind: "provider",
          release: async () => {
            if (released) {
              return;
            }
            if (!nativeId) {
              throw new Error(
                "Native provider identity is unknown; preserving private gateway.",
              );
            }
            await deleteOwnedProvider(gateway, name, nativeId);
            released = true;
          },
        }),
      ),
    );
    nativeId = acknowledgedProviderId(created, name);
    if (created.provider?.type !== provider.profile) {
      throw new Error("type");
    }
    if (
      (await getOwnedProviderType(gateway, name, nativeId, gateway.signal)) !==
      provider.profile
    ) {
      throw new Error("identity");
    }
  } catch (error) {
    throw nativeFailure(
      "Explicit provider creation failed; verify configured credential variables and native profile bindings.",
      error,
    );
  }
}
