import { describe, expect, test as it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { adapterFixture, cachedStatus } from "../test/index.helper.ts";
import { createRuntimeObserver, inlineText, publishFailure } from "./ui.ts";

const terminalControls = new RegExp(
  ["\u001b", "\u0000", "\u202e"].join("|"),
  "u",
);
const oversizedTextLength = 300;
const overflowingWideCharacters = 121;
const statusTextWidth = 240;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("publishFailure", () => {
  it.each([
    new Error("PRIVATE_TOKEN"),
    "PRIVATE_TOKEN",
    // biome-ignore lint/plugin/biome-rules/use-undefined: Pi/native exceptions are external unknown values; null must exercise the object guard.
    null,
    { safeMessage: 7 },
  ])("should conceal arbitrary diagnostics when failure is %j", (failure) => {
    const f = adapterFixture();
    const result = publishFailure(f.pi, f.context, failure, {
      operation: "preparation",
    });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).not.toContain("PRIVATE_TOKEN");
    expect(f.notify.mock.calls[0]?.[1]).toBe("error");
    expect(f.sendMessage.mock.calls[0]?.[0].content).not.toContain(
      "PRIVATE_TOKEN",
    );
  });

  it("should sanitize and bound declared diagnostics when recovery contains terminal controls", () => {
    const f = adapterFixture();
    const result = publishFailure(
      f.pi,
      f.context,
      {
        safeMessage: `\u001b[31mDENIED\u0000${"界".repeat(oversizedTextLength)}`,
        recovery: "retain\u202e /owned/state",
        secret: "PRIVATE_TOKEN",
      },
      { operation: "cleanup" },
    );
    expect(result.message).toContain("DENIED");
    expect(result.message).toContain("/owned/state");
    expect(result.message).not.toContain("\u001b[31m");
    expect(stripVTControlCharacters(result.message)).not.toMatch(
      terminalControls,
    );
    expect(result.message).not.toContain("PRIVATE_TOKEN");
    expect(result.message).not.toContain(
      "界".repeat(overflowingWideCharacters),
    );
  });
  it("should publish complete bounded cleanup coordinates when a retired runtime supplies its final snapshot", () => {
    const f = adapterFixture();
    const tlsDirectory = `/owned/${"x".repeat(oversizedTextLength)}/tls`;
    const status = cachedStatus({
      phase: "recovery-required",
      lastFailure: {
        code: "cleanup",
        operation: "cleanup",
        safeMessage: "OpenShell cleanup failed.",
      },
      recovery: {
        sandboxName: "old-sandbox",
        createOutcome: "acknowledged",
        gatewayEndpoint: "https://127.0.0.1:43123",
        tlsDirectory,
        networkId: "old-network",
      },
    });
    const failure = publishFailure(
      f.pi,
      undefined,
      new Error("PRIVATE_CLEANUP"),
      { operation: "shutdown", status },
    );
    expect(failure.message).toContain("OpenShell cleanup failed.");
    expect(failure.message).toContain("old-sandbox");
    expect(failure.message).toContain("https://127.0.0.1:43123");
    expect(failure.message).toContain(tlsDirectory);
    expect(failure.message).toContain("old-network");
    expect(failure.message).not.toContain("PRIVATE_CLEANUP");
    expect(f.sendMessage.mock.calls[0]?.[0].content).toBe(failure.message);
    expect(f.notify).not.toHaveBeenCalled();
  });
  it.each(["transcript", "notification"] as const)(
    "should retain the other diagnostic channel when %s publication fails",
    (channel) => {
      const f = adapterFixture();
      const unavailable = () => {
        throw new Error("unavailable");
      };
      if (channel === "transcript") {
        f.sendMessage.mockImplementation(unavailable);
      } else {
        f.notify.mockImplementation(unavailable);
      }
      const result = publishFailure(
        f.pi,
        f.context,
        { safeMessage: "SAFE_FAILURE" },
        { operation: "cleanup" },
      );
      const delivered =
        channel === "transcript"
          ? f.notify.mock.calls[0]?.[0]
          : f.sendMessage.mock.calls[0]?.[0].content;
      expect(delivered).toContain("SAFE_FAILURE");
      expect(result.message).toContain("SAFE_FAILURE");
    },
  );
  it("should report sanitized cleanup only in the transcript when the activation has retired", () => {
    const f = adapterFixture();
    const failure = publishFailure(
      f.pi,
      undefined,
      new Error("PRIVATE_CLEANUP"),
      { operation: "shutdown" },
    );
    expect(failure.message).not.toContain("PRIVATE_CLEANUP");
    expect(failure.cause).toBeUndefined();
    expect(f.sendMessage.mock.calls[0]?.[0].content).toBe(failure.message);
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.setStatus).not.toHaveBeenCalled();
  });
});

describe("createRuntimeObserver", () => {
  it("should publish persistent failures when notification UI throws", () => {
    const f = adapterFixture();
    const observer = createRuntimeObserver(f.pi, f.context);
    f.notify.mockImplementation(() => {
      throw new Error("closed UI");
    });
    observer.failure({
      code: "execution",
      operation: "exec",
      safeMessage: "RETAINED_FAILURE",
    });
    expect(f.sendMessage.mock.calls[0]?.[0].content).toContain(
      "RETAINED_FAILURE",
    );
  });
});

describe("inlineText", () => {
  it.each([
    ["plain", "plain"],
    ["a\nb\tc", "a b c"],
    ["\u001b[31mred\u001b[0m", "red"],
    ["a\u202eb\u2028c", "a b c"],
  ])(
    "should return bounded control-free text when input is %j",
    (input, expected) => {
      expect(inlineText(input)).toBe(expected);
    },
  );
  it("should truncate by terminal cells when wide text exceeds the footer limit", () => {
    const result = inlineText("界".repeat(oversizedTextLength));
    expect(visibleWidth(result)).toBeLessThanOrEqual(statusTextWidth);
  });
});
