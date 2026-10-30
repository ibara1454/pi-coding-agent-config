import type { ProviderProfile } from "@nvidia/openshell-sdk/raw";
import type { ProviderConfiguration } from "../configuration/index.ts";

/** Validates selected credential declarations without reading secrets or mutating inputs.
 * @param provider Frozen explicit declaration already admitted by settings validation.
 * @throws On undeclared keys, missing required credentials, or ambiguous aliases.
 * @example validateProvider(profile, declaration) returns the selected workload ENV keys.
 */
export function validateProvider(
  profile: ProviderProfile,
  provider: ProviderConfiguration,
): readonly string[] {
  const keys = Object.keys(provider.credentialsFromEnv);
  for (const key of keys) {
    const declarations = profile.credentials.filter((credential) =>
      credential.envVars.includes(key),
    );
    if (declarations.length !== 1) {
      throw new Error(
        "Provider environment key is not uniquely declared by its profile.",
      );
    }
  }
  for (const credential of profile.credentials) {
    const selected = credential.envVars.filter((key) => keys.includes(key));
    if (selected.length > 1 || (credential.required && selected.length !== 1)) {
      throw new Error(
        "Provider credential declaration needs exactly one explicit environment mapping.",
      );
    }
  }
  return Object.freeze(keys);
}
