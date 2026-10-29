import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_SANDBOX_IMAGE } from "../../image/index.ts";
import type { SanitizedRuntimeStatus } from "../../runtime/index.ts";
import { type AdapterSession, inlineText } from "../session/index.ts";

const HEX_RADIX = 16;
const UNICODE_ESCAPE_DIGITS = 4;

/** Registers cached /sandbox status without loading native implementations or starting work.
 * @param pi Pi registration API receiving the status command.
 * @param session Owner whose current activation provides the cached result.
 * @example /sandbox reports blocked admission before the first session_start.
 */
export function registerSandboxStatus(
  pi: ExtensionAPI,
  session: AdapterSession,
): void {
  pi.registerCommand("sandbox", {
    description: "Show cached OpenShell policy, readiness and recovery status",
    handler: (_args, context) => {
      showSandboxStatus(
        context,
        session.activation?.runtime?.getStatus(),
        session.activation?.failure,
      );
      return Promise.resolve();
    },
  });
}

/** Renders cached diagnostic facts only; never reloads settings or starts native work.
 * @param status Current sanitized snapshot; absent before runtime preparation succeeds.
 * @param failure Sanitized preparation error shown only without a runtime snapshot.
 * @example /sandbox while configuration is invalid still explains fail-closed model Bash.
 */
function showSandboxStatus(
  context: ExtensionContext,
  status: SanitizedRuntimeStatus | undefined,
  failure: Error | undefined,
): void {
  const lines = status
    ? [
        `OpenShell: ${status.phase}`,
        `Selected policy snapshot: ${inlineText(status.policyPath)}`,
        `Image: ${inlineText(status.image ?? DEFAULT_SANDBOX_IMAGE)}`,
        "Required explicit native read_write grants:",
        ...status.requiredNativeReadWritePaths.map(
          (path) => `  ${quotePolicyPath(path)}`,
        ),
        ...(status.lastFailure
          ? [inlineText(status.lastFailure.safeMessage)]
          : []),
        ...recoveryLines(status),
      ]
    : [
        "OpenShell: model Bash blocked",
        inlineText(failure?.message ?? "Session preparation has not started."),
      ];
  lines.push(
    "User !/!!, Pi, file tools, and model traffic remain host-side.",
    "Select a policy file in settings, then /reload to apply it. Each start owns fresh resources.",
  );
  context.ui.notify(
    lines.join("\n"),
    status?.phase === "ready" ? "info" : "warning",
  );
}

/** Encodes a complete policy grant as an ASCII-only JSON/YAML quoted scalar.
 * @param path Exact canonical path, without normalization or clipping.
 * @returns A terminal-safe scalar whose JSON decoding restores every UTF-16 unit.
 * @example JSON.parse(quotePolicyPath("/work/界")) equals "/work/界".
 */
function quotePolicyPath(path: string): string {
  return JSON.stringify(path).replace(
    /[\u007f-\uffff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(HEX_RADIX).padStart(UNICODE_ESCAPE_DIGITS, "0")}`,
  );
}

/** Projects nonsecret recovery coordinates without claiming that sandbox creation started.
 * @example provider failure shows its gateway and "not started", never certificate bytes.
 */
function recoveryLines(status: SanitizedRuntimeStatus): string[] {
  const { recovery } = status;
  if (!recovery) {
    return [];
  }
  return [
    `Sandbox: ${inlineText(recovery.sandboxName)}; creation: ${recovery.createOutcome ?? "not started"}`,
    `Gateway: ${inlineText(recovery.gatewayEndpoint ?? "unavailable")}`,
    `TLS bundle directory: ${inlineText(recovery.tlsDirectory ?? "unavailable")}`,
    `Docker network ID: ${inlineText(recovery.networkId ?? "unavailable")}`,
    ...(recovery.createOutcome === "unknown"
      ? [
          "Unknown creation requires independent backend-settlement proof; Ready/NotFound is insufficient.",
        ]
      : []),
  ];
}
