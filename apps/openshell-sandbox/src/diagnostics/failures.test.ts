import { describe, expect, test as it } from "bun:test";
import {
  failureError,
  RuntimeFailure,
  safeFailure,
  safeText,
} from "./failures.ts";

const STRING_CLIP_LENGTH = 3;
const SAFE_MESSAGE_LENGTH = 1024;
const RECOVERY_LENGTH = 2048;

describe("safeText", () => {
  it("should remove terminal controls before clipping untrusted text", () => {
    expect(safeText("ab\u001b\ncd", STRING_CLIP_LENGTH)).toBe("abc");
  });
});

describe("RuntimeFailure.constructor", () => {
  it("should sanitize display and recovery diagnostics without retaining a raw cause", () => {
    const error = new RuntimeFailure(
      "aborted",
      "cancellation",
      "bad\u001b\nmessage",
      { recovery: "safe\u0000route" },
    );
    expect(error.name).toBe("AbortError");
    expect(error.failure).toEqual({
      code: "aborted",
      operation: "cancellation",
      safeMessage: "badmessage",
      recovery: "saferoute",
    });
    expect(error.cause).toBeUndefined();
    const nested = new RuntimeFailure("cleanup", "cleanup", "Failed", {
      cause: error,
    });
    expect(nested.cause).toBe(error);
  });
  it("should bound message and recovery independently when safe guidance exceeds display limits", () => {
    const error = new RuntimeFailure(
      "execution",
      "command",
      "m".repeat(SAFE_MESSAGE_LENGTH + 1),
      {
        recovery: "r".repeat(RECOVERY_LENGTH + 1),
      },
    );
    expect(error.name).toBe("Error");
    expect(error.message).toBe("m".repeat(SAFE_MESSAGE_LENGTH));
    expect(error.failure.recovery).toBe("r".repeat(RECOVERY_LENGTH));
    expect(Object.isFrozen(error.failure)).toBe(true);
  });
  it("should omit empty recovery when no actionable guidance is supplied", () => {
    expect(
      new RuntimeFailure("execution", "command", "Failed", { recovery: "" })
        .failure,
    ).not.toHaveProperty("recovery");
  });
});

describe("safeFailure", () => {
  it("should retain an allowlisted classification but reclassify failed cleanup", () => {
    const known = new RuntimeFailure(
      "preparation",
      "readiness",
      "Safe readiness failure",
    );
    expect(safeFailure(known, "execution")).toBe(known.failure);
    const cleanup = safeFailure(known, "cleanup");
    expect(cleanup.code).toBe("cleanup");
    expect(cleanup.safeMessage).not.toContain("readiness");
  });
  it("should replace arbitrary external failure details with constant diagnostics", () => {
    const failure = safeFailure(
      new Error("secret native credential"),
      "execution",
    );
    expect(failure).toMatchObject({
      code: "execution",
      operation: "execution",
    });
    expect(JSON.stringify(failure)).not.toContain("secret");
  });
  it("should retain cleanup classification when the original failure already owns cleanup", () => {
    const error = new RuntimeFailure("cleanup", "dispose", "Safe cleanup");
    expect(safeFailure(error, "cleanup")).toBe(error.failure);
  });
});

describe("failureError", () => {
  it("should not expose native causes but retain a sanitized runtime cause", () => {
    const diagnostic = safeFailure(new Error("secret"), "execution");
    expect(failureError(diagnostic, new Error("secret")).cause).toBeUndefined();
    const known = new RuntimeFailure("aborted", "cancellation", "aborted");
    expect(failureError(diagnostic, known).cause).toBe(known);
  });
  it("should preserve an allowlisted diagnostic without recovery when none is present", () => {
    const error = failureError(
      {
        code: "execution",
        operation: "command",
        safeMessage: "Safe command failure",
      },
      undefined,
    );
    expect(error.failure).toEqual({
      code: "execution",
      operation: "command",
      safeMessage: "Safe command failure",
    });
    expect(error.cause).toBeUndefined();
  });
});
