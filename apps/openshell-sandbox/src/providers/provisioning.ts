import { randomUUID } from "node:crypto";
import type { ProviderProfileResponse } from "@nvidia/openshell-sdk/raw";
import type {
  ProviderConfiguration,
  SandboxEnvironment,
} from "../configuration/index.ts";
import type { ManagedGateway } from "../gateway/index.ts";
import { type AcquisitionCapture, nativeFailure } from "../host/index.ts";
import { createNativeProvider } from "./native-provider.ts";
import { validateProvider } from "./validation.ts";

const GATEWAY_ID_PREFIX_LENGTH = 8;

interface ProviderSelection {
  readonly provider: ProviderConfiguration;
  readonly keys: readonly string[];
}

/** Fetches and validates native binding facts before any secret lookup.
 * @throws Safe errors on missing/mismatched profiles or unsupported declarations.
 * @example A logical credential name cannot substitute for its declared ENV key.
 */
async function selectProvider(
  gateway: ManagedGateway,
  provider: ProviderConfiguration,
): Promise<ProviderSelection> {
  let response: ProviderProfileResponse | undefined;
  try {
    response = await gateway.client.raw.getProviderProfile(
      { id: provider.profile, workspace: "default" },
      { signal: gateway.signal, timeoutMs: 30_000 },
    );
  } catch {
    response = undefined;
  }
  if (!response) {
    throw new Error("Unable to load the selected native provider profile.");
  }
  if (response.profile?.id !== provider.profile) {
    throw new Error("Native provider profile identity mismatch.");
  }
  return { provider, keys: validateProvider(response.profile, provider) };
}

/** Imports and validates profiles, then creates private native providers.
 * Capture owns each create before its RPC and releases it before gateway close.
 * Only explicitly mapped credentials are read; raw RPC failures never escape.
 * @param capture Receives each gateway-owned provider, including uncertain creates.
 * @returns Frozen configured-name to native attachment-name mapping, without credential values.
 * @throws On invalid profiles, missing credentials, cancellation, or bounded RPC failure.
 * @example await provisionProviders(gateway, environment, name => credentials[name], capture);
 */
export async function provisionProviders(
  gateway: ManagedGateway,
  environment: SandboxEnvironment,
  credentialSource: (name: string) => string | undefined,
  capture: AcquisitionCapture,
): Promise<Readonly<Record<string, string>>> {
  await importProfiles(gateway, environment);
  const selected = await Promise.allSettled(
    environment.providers.map((provider) => selectProvider(gateway, provider)),
  );
  const selections: ProviderSelection[] = [];
  for (const result of selected) {
    if (result.status === "rejected") {
      throw new Error(
        "Unable to validate the selected native provider profiles.",
      );
    }
    selections.push(result.value);
  }
  const keys = selections.flatMap((selection) => selection.keys);
  if (new Set(keys).size !== keys.length) {
    throw new Error("Provider workload environment keys must be unique.");
  }
  const nonce = selections.length > 0 ? randomUUID() : "";
  const providers = selections.map(({ provider }, index) => ({
    provider,
    name: `po-${gateway.instanceId.slice(0, GATEWAY_ID_PREFIX_LENGTH)}-${nonce}-${index}`,
  }));
  const created = await Promise.allSettled(
    providers.map((selection) =>
      createNativeProvider(gateway, selection, credentialSource, capture),
    ),
  );
  if (created.some((result) => result.status === "rejected")) {
    throw new Error(
      "Explicit provider creation failed; verify configured credential variables and native profile bindings.",
    );
  }
  return Object.freeze(
    Object.fromEntries(
      providers.map(({ provider, name }) => [provider.name, name]),
    ),
  );
}

/** Imports selected native profiles and requires exact acknowledgement before secret lookup.
 * Native import performs its own validation; partial profile state belongs to the gateway.
 * @example Empty custom profiles perform no import RPC.
 */
async function importProfiles(
  gateway: ManagedGateway,
  environment: SandboxEnvironment,
): Promise<void> {
  const profiles = environment.profiles.flatMap(({ sourcePath, sdkProfiles }) =>
    sdkProfiles.map((profile) => ({ profile, source: sourcePath })),
  );
  if (profiles.length === 0) {
    return;
  }
  try {
    const options = { signal: gateway.signal, timeoutMs: 30_000 };
    const result = await gateway.client.raw.importProviderProfiles(
      { profiles, workspace: "default" },
      options,
    );
    const expected = profiles.map(({ profile }) => profile.id);
    const actual = result.profiles.map(({ id }) => id);
    if (
      result.imported !== true ||
      actual.length !== expected.length ||
      new Set(actual).size !== actual.length ||
      expected.some((id) => !actual.includes(id))
    ) {
      throw new Error("invalid");
    }
  } catch (error) {
    throw nativeFailure(
      "Native provider profile validation or import failed; check selected profile declarations.",
      error,
    );
  }
}
