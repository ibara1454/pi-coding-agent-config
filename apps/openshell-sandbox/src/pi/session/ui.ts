import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
  PreparationStep,
  RuntimeObserver,
  SanitizedRuntimeStatus,
} from "../../runtime/index.ts";

const statusTextWidth = 240;
// Runtime recovery fields are capped at 512 UTF-16 units, each at most two terminal cells.
const recoveryTextWidth = 1024;

const PREPARATION_LABELS: Record<PreparationStep, string> = {
  starting: "OpenShell · preparing",
  gateway: "OpenShell · starting gateway",
  providers: "OpenShell · configuring providers",
  sandbox: "OpenShell · creating and checking sandbox",
};

/** Removes terminal controls and bounds external text by terminal cells.
 * @param width - Maximum terminal cells; defaults to the compact status/footer limit.
 * @example inlineText("a\nb") returns "a b", never a second terminal line.
 */
export function inlineText(value: string, width = statusTextWidth): string {
  return truncateToWidth(
    stripVTControlCharacters(value).replace(
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
      " ",
    ),
    width,
    "…",
  );
}

/** Publishes only declared safe diagnostics; arbitrary exception payloads are never echoed.
 * Persistent transcript and current UI publication are attempted independently.
 * @param context - Current UI context, or undefined for retired transcript-only cleanup.
 * @param options - Operation label and final sanitized snapshot published before its retired owner is released.
 * @returns A safe model-facing error without clearing any runtime admission failure.
 * @example A raw SDK exception produces fixed troubleshooting guidance, not its payload.
 */
export function publishFailure(
  pi: ExtensionAPI,
  context: ExtensionContext | undefined,
  error: unknown,
  options: Readonly<{
    operation: string;
    status?: SanitizedRuntimeStatus | undefined;
  }>,
): Error {
  const { operation, status } = options;
  const diagnostic = status?.lastFailure ?? error;
  const detail =
    typeof diagnostic === "object" &&
    diagnostic !== null &&
    "safeMessage" in diagnostic &&
    typeof diagnostic.safeMessage === "string"
      ? inlineText(diagnostic.safeMessage)
      : `OpenShell ${operation} failed. Check settings/YAML, local Docker, and native OpenShell 0.0.116 prerequisites.`;
  const recovery =
    typeof diagnostic === "object" &&
    diagnostic !== null &&
    "recovery" in diagnostic &&
    typeof diagnostic.recovery === "string"
      ? inlineText(diagnostic.recovery)
      : "";
  const coordinates = status?.recovery;
  const message = [
    `${detail}${recovery ? ` ${recovery}` : ""} Model Bash remains fail-closed; user !/!! is unchanged. /sandbox shows cached status. Failed cleanup may leave owned resources alive.`,
    ...(coordinates
      ? [
          `Sandbox: ${inlineText(coordinates.sandboxName, recoveryTextWidth)}; creation: ${coordinates.createOutcome ?? "not started"}`,
          `Gateway: ${inlineText(coordinates.gatewayEndpoint ?? "unavailable", recoveryTextWidth)}`,
          `TLS bundle directory: ${inlineText(coordinates.tlsDirectory ?? "unavailable", recoveryTextWidth)}`,
          `Docker network ID: ${inlineText(coordinates.networkId ?? "unavailable", recoveryTextWidth)}`,
        ]
      : []),
  ].join("\n");
  try {
    pi.sendMessage({
      customType: "openshell-failure",
      content: message,
      display: true,
    });
  } catch {
    /* Immediate UI is an independent publication path. */
  }
  try {
    context?.ui.notify(message, "error");
  } catch {
    /* Publication failure never authorizes host fallback or clears runtime state. */
  }
  return new Error(message);
}

/** Binds Pi publication effects; the runtime owns observer detachment and callback errors.
 * @example Progress updates the footer while failure also publishes a persistent transcript.
 */
export function createRuntimeObserver(
  pi: ExtensionAPI,
  context: ExtensionContext,
): RuntimeObserver {
  return {
    progress(status) {
      const label =
        status.phase === "preparing" && status.preparationStep
          ? PREPARATION_LABELS[status.preparationStep]
          : `OpenShell · ${status.phase}`;
      context.ui.setStatus("openshell-sandbox", label);
    },
    failure(failure) {
      publishFailure(pi, context, failure, { operation: failure.operation });
    },
  };
}
