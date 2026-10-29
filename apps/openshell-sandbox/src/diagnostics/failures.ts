import type { FailureCode, SafeFailure } from "./types.ts";

const CONTROL_CHARACTER = /\p{Cc}/gu;
const SAFE_MESSAGE_LENGTH = 1024;
const RECOVERY_LENGTH = 2048;

/** Clips untrusted display text and removes terminal controls without exposing native payloads.
 * @example safeText("a\\nsecret", 1) returns "a".
 */
export function safeText(value: string, maxLength: number): string {
  return value.replace(CONTROL_CHARACTER, "").slice(0, maxLength);
}

/** An allowlisted runtime failure never embeds native errors or credential-bearing payloads. */
export class RuntimeFailure extends Error {
  readonly failure: SafeFailure;
  /** Creates an allowlisted error; only an already sanitized RuntimeFailure may be its cause.
   * @example new RuntimeFailure("timeout", "deadline", "Command timed out").name is "Error".
   */
  constructor(
    code: FailureCode,
    operation: string,
    safeMessage: string,
    options: Readonly<{ recovery?: string; cause?: RuntimeFailure }> = {},
  ) {
    super(
      safeText(safeMessage, SAFE_MESSAGE_LENGTH),
      options.cause ? { cause: options.cause } : undefined,
    );
    this.name = code === "aborted" ? "AbortError" : "Error";
    this.failure = Object.freeze({
      code,
      operation,
      safeMessage: this.message,
      ...(options.recovery
        ? { recovery: safeText(options.recovery, RECOVERY_LENGTH) }
        : {}),
    });
  }
}

/** Retains our safe classification; arbitrary external failures become constant diagnostics.
 * @example safeFailure(new Error("secret"), "execution").safeMessage contains no secret.
 */
export function safeFailure(error: unknown, code: FailureCode): SafeFailure {
  if (
    error instanceof RuntimeFailure &&
    (code !== "cleanup" || error.failure.code === "cleanup")
  ) {
    return error.failure;
  }
  return Object.freeze({
    code,
    operation: code,
    safeMessage: `OpenShell ${code} failed.`,
    recovery:
      "Inspect /sandbox; review the selected policy and native prerequisites.",
  });
}

/** Converts an allowlisted diagnostic back to an error without exposing raw native causes.
 * @example failureError(safeFailure(new Error("secret"), "cleanup"), raw).cause is undefined.
 */
export function failureError(
  failure: SafeFailure,
  original: unknown,
): RuntimeFailure {
  return new RuntimeFailure(
    failure.code,
    failure.operation,
    failure.safeMessage,
    {
      ...(failure.recovery === undefined ? {} : { recovery: failure.recovery }),
      ...(original instanceof RuntimeFailure ? { cause: original } : {}),
    },
  );
}
