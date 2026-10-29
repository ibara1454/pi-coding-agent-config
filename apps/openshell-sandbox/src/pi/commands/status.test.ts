import { describe, expect, test as it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parse } from "yaml";
import { DEFAULT_SANDBOX_IMAGE } from "../../image/index.ts";
import type { SanitizedRuntimeStatus } from "../../runtime/index.ts";
import { AdapterActivation, AdapterSession } from "../session/index.ts";
import { adapterFixture, cachedStatus } from "../test/index.helper.ts";
import { registerSandboxStatus } from "./status.ts";

const terminalControls = new RegExp(
  ["\u001b", "\u0000", "\u202e"].join("|"),
  "u",
);
const oversizedTextLength = 300;
const maximumPolicyLineWidth = 270;
const longPathSegments = 90;
const quotedAsciiScalar = /^"[\u0020-\u007e]*"$/;

/** Captures /sandbox against an optional cached activation without preparing native resources.
 * @example await f.commands.get("sandbox")?.("", f.context) reports the supplied cached status.
 */
function statusFixture(status?: SanitizedRuntimeStatus, failure?: Error) {
  const f = adapterFixture();
  const session = new AdapterSession(f.pi);
  if (status || failure) {
    const activation = new AdapterActivation(f.context);
    if (status) {
      activation.runtime = {
        getStatus: () => status,
        exec: () => {
          throw new Error("unexpected execution");
        },
        dispose: () => Promise.resolve(),
      };
    }
    if (failure) {
      activation.failure = failure;
    }
    session.activation = activation;
  }
  registerSandboxStatus(f.pi, session);
  return { ...f, session };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("registerSandboxStatus", () => {
  it.each([undefined, new Error("WAIT\u001b[31m\nFOR_SETUP")])(
    "should report blocked admission without terminal controls when no runtime exists and failure is %j",
    async (failure) => {
      const f = statusFixture(undefined, failure);
      try {
        await f.commands.get("sandbox")?.("", f.context);
        expect(f.notify.mock.calls[0]?.[1]).toBe("warning");
        expect(f.notify.mock.calls[0]?.[0]).not.toMatch(terminalControls);
      } finally {
        await f.session.shutdown();
      }
    },
  );
  it("should keep policy summaries compact while retaining recovery coordinates when diagnostics are long", async () => {
    const f = statusFixture(
      cachedStatus({
        phase: "recovery-required",
        policyPath: `/policy/${"界".repeat(oversizedTextLength)}`,
        image: "selected-image",
        requiredNativeReadWritePaths: ["/mount/"],
        lastFailure: {
          code: "cleanup",
          operation: "cleanup",
          safeMessage: "UNSETTLED",
        },
        recovery: {
          sandboxName: "owned-sandbox",
          createOutcome: "unknown",
          gatewayEndpoint: "https://gateway",
          tlsDirectory: "/owned/tls",
          networkId: "owned-network",
        },
      }),
    );
    try {
      await f.commands.get("sandbox")?.("", f.context);
      const message = f.notify.mock.calls[0]?.[0] ?? "";
      expect(message).toContain('  "/mount/"');
      expect(message).toContain("UNSETTLED");
      expect(message).toContain("selected-image");
      expect(message).toContain("owned-sandbox");
      expect(message).toContain("/owned/tls");
      expect(message).toContain("owned-network");
      const policyLine = message
        .split("\n")
        .find((line) => line.includes("/policy/"));
      expect(visibleWidth(policyLine ?? "")).toBeLessThanOrEqual(
        maximumPolicyLineWidth,
      );
    } finally {
      await f.session.shutdown();
    }
  });
  it.each([
    [
      "canonical path exceeds 512 UTF-16 units",
      `/work/${"nested/".repeat(longPathSegments)}project/.git`,
    ],
    [
      "path contains terminal controls, Unicode, quotes and backslashes",
      '/work/\u001b[31m\u001b]8;;https://example.invalid\u0007\r\n\t\u0000\u007f\u009b31m\u202e\u2066\u2028\u2029界e\u0301😀"\\metadata',
    ],
  ])(
    "should preserve exact JSON and YAML policy grants when the %s",
    async (_condition, path) => {
      const f = statusFixture(
        cachedStatus({ requiredNativeReadWritePaths: [path] }),
      );
      try {
        await f.commands.get("sandbox")?.("", f.context);
        const message = f.notify.mock.calls[0]?.[0] ?? "";
        const scalar =
          message
            .split("\n")
            .find((line) => line.startsWith('  "'))
            ?.trim() ?? "";
        expect(scalar).toMatch(quotedAsciiScalar);
        expect(JSON.parse(scalar)).toBe(path);
        expect(parse(scalar)).toBe(path);
      } finally {
        await f.session.shutdown();
      }
    },
  );
  it.each([
    undefined,
    { sandboxName: "pending", createOutcome: "not-sent" as const },
  ])(
    "should show usable ready status when optional recovery coordinates are %j",
    async (recovery) => {
      const f = statusFixture(cachedStatus(recovery ? { recovery } : {}));
      try {
        await f.commands.get("sandbox")?.("", f.context);
        expect(f.notify.mock.calls[0]?.[1]).toBe("info");
        expect(f.notify.mock.calls[0]?.[0]).not.toContain("undefined");
        expect(f.notify.mock.calls[0]?.[0]).toContain(DEFAULT_SANDBOX_IMAGE);
        expect(f.notify.mock.calls[0]?.[0]).toContain("/project/policy.yaml");
      } finally {
        await f.session.shutdown();
      }
    },
  );
  it.each([
    ["not started", undefined],
    ["unknown", "unknown"],
    ["acknowledged", "acknowledged"],
  ] as const)(
    "should describe sandbox creation as %s without inventing an outcome",
    async (shownOutcome, createOutcome) => {
      const f = statusFixture(
        cachedStatus({
          phase: "recovery-required",
          recovery: {
            sandboxName: "reserved-name",
            ...(createOutcome ? { createOutcome } : {}),
            gatewayEndpoint: "https://127.0.0.1:43123",
            tlsDirectory: "/private/tls",
            networkId: "private-network",
          },
        }),
      );
      try {
        await f.commands.get("sandbox")?.("", f.context);
        const message = f.notify.mock.calls[0]?.[0] ?? "";
        expect(message).toContain(
          `Sandbox: reserved-name; creation: ${shownOutcome}`,
        );
        expect(message).toContain("Gateway: https://127.0.0.1:43123");
        expect(message).toContain("TLS bundle directory: /private/tls");
        expect(message).toContain("Docker network ID: private-network");
        expect(message.includes("independent backend-settlement proof")).toBe(
          createOutcome === "unknown",
        );
        expect(message).not.toContain("undefined");
        expect(f.notify.mock.calls[0]?.[1]).toBe("warning");
      } finally {
        await f.session.shutdown();
      }
    },
  );
});
