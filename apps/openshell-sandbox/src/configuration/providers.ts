import type { ProviderConfiguration } from "./selection.ts";
import {
  array,
  invalid,
  object,
  SandboxConfigurationError,
  text,
} from "./validation/index.ts";

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u;
const ENVIRONMENT_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export interface ProviderDeclaration {
  readonly name: string;
  readonly profile: string;
  readonly credentialMode?: "explicit" | "native-refresh";
  readonly credentialsFromEnv?: Readonly<Record<string, string>>;
}

/** Validate identifiers and names before use in native requests.
 * @example identifier("work-github", "name") returns the provider identity.
 */
function identifier(value: unknown, field: string): string {
  const result = text(value, field);
  if (!IDENTIFIER.test(result)) {
    invalid(field);
  }
  return result;
}

/** Validate environment-variable bindings without reading their values.
 * @example bindings({ TOKEN: "WORK_TOKEN" }) retains explicit selection only.
 */
function bindings(value: unknown): Readonly<Record<string, string>> {
  const entries = object(value, "providers.credentialsFromEnv");
  return Object.fromEntries(
    Object.entries(entries).map(([key, source]) => {
      const name = text(source, "providers.credentialsFromEnv");
      if (
        !(ENVIRONMENT_VARIABLE.test(key) && ENVIRONMENT_VARIABLE.test(name))
      ) {
        invalid("providers.credentialsFromEnv");
      }
      return [key, name];
    }),
  );
}

/** Parse declarations before layering; defer unsupported-mode and required-mapping checks.
 * @example parseProviders([{name:"work",profile:"github",credentialMode:"native-refresh"}]) preserves that request.
 */
export function parseProviders(value: unknown): readonly ProviderDeclaration[] {
  return array(value, "providers").map((item) => {
    const entry = object(item, "providers", [
      "name",
      "profile",
      "credentialMode",
      "credentialsFromEnv",
    ]);
    const name = identifier(entry["name"], "providers.name");
    const profile = identifier(entry["profile"], "providers.profile");
    const mode = entry["credentialMode"];
    if (
      mode !== undefined &&
      mode !== "explicit" &&
      mode !== "native-refresh"
    ) {
      invalid("providers.credentialMode");
    }
    return {
      name,
      profile,
      ...(mode === undefined ? {} : { credentialMode: mode }),
      ...(entry["credentialsFromEnv"] === undefined
        ? {}
        : { credentialsFromEnv: bindings(entry["credentialsFromEnv"]) }),
    };
  });
}

/** Normalize only effective declarations; all renewal errors precede explicit credential requirements.
 * @throws Unsupported-mode or ambiguous provider configuration errors.
 * @example normalizeProviders([]) returns an anonymous provider selection.
 */
export function normalizeProviders(
  entries: readonly ProviderDeclaration[],
): readonly ProviderConfiguration[] {
  const unsupported = entries.find(
    (entry) => entry.credentialMode === "native-refresh",
  );
  if (unsupported) {
    throw new SandboxConfigurationError(
      `Provider "${unsupported.name}" requests unsupported credentialMode "native-refresh"; configure explicit with credentialsFromEnv, or remove this provider.`,
      "credential-mode-unsupported",
    );
  }
  const names = new Set<string>();
  return entries.map((entry) => {
    if (names.has(entry.name)) {
      invalid("providers.name (duplicate)");
    }
    names.add(entry.name);
    if (
      !entry.credentialsFromEnv ||
      Object.keys(entry.credentialsFromEnv).length === 0
    ) {
      invalid("providers.credentialsFromEnv (required for explicit mode)");
    }
    return {
      ...entry,
      credentialMode: "explicit",
      credentialsFromEnv: entry.credentialsFromEnv,
    };
  });
}
