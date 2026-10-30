export type ConfigurationFailureCode =
  | "configuration-invalid"
  | "configuration-read-failed"
  | "credential-mode-unsupported";

const CONTROL_CHARACTERS = /\p{Cc}/u;

/** Carries only configuration provenance/field guidance, never source text or native/parser payloads.
 * @example new SandboxConfigurationError("Invalid policy: /policy.yaml") is safe for sanitized UI rendering.
 */
export class SandboxConfigurationError extends Error {
  readonly safeMessage: string;
  readonly code: ConfigurationFailureCode;

  constructor(
    safeMessage: string,
    code: ConfigurationFailureCode = "configuration-invalid",
  ) {
    super(safeMessage);
    this.name = "SandboxConfigurationError";
    this.safeMessage = safeMessage;
    this.code = code;
  }
}

export type ConfigurationObject = Record<string, unknown>;

/** Reject invalid configuration without echoing untrusted values or document contents.
 * @example invalid("providers.credentialsFromEnv") throws a field-only diagnostic.
 */
export function invalid(field: string): never {
  throw new SandboxConfigurationError(
    `Invalid OpenShell configuration at ${field}`,
  );
}

/** Require a plain configuration mapping and optionally reject unknown keys.
 * @example object({ image: "dev" }, "settings", ["image"]) preserves its mapping.
 */
export function object(
  value: unknown,
  field: string,
  keys?: readonly string[],
): ConfigurationObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(field);
  }
  const result = value as ConfigurationObject;
  if (keys && Object.keys(result).some((key) => !keys.includes(key))) {
    invalid(field);
  }
  return result;
}

/** Validate configuration text without accepting terminal/configuration control characters.
 * @example text("github", "profile") returns "github".
 */
export function text(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    CONTROL_CHARACTERS.test(value)
  ) {
    invalid(field);
  }
  return value;
}

/** Validate an array without treating a present malformed value as absence.
 * @example array([], "providers") returns the explicit empty override.
 */
export function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    invalid(field);
  }
  return value;
}

/** Freeze the newly assembled snapshot recursively; callers retain no mutable descendants.
 * @example freeze({ paths: [] }) freezes both the object and its paths array.
 */
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      freeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
