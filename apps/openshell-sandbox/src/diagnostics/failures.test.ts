import { describe, expect, test as it } from "bun:test";
import {
  failureError,
  RuntimeFailure,
  safeFailure,
  safeText,
} from "./failures.ts";

const STRING_CLIP_LENGTH = 3;

describe("safeText", () => {
  it("should remove terminal controls before clipping untrusted text", () => {
    expect(safeText("ab\u001b\ncd", STRING_CLIP_LENGTH)).toBe("abc");
  });
});

describe("RuntimeFailure.constructor", () => {
  it("should preserve abort classification and a safe nested cause", () => {
    const error = new RuntimeFailure("aborted", "cancellation", "aborted", {
      recovery:
        "Inspect /sandbox; review selected policy and native prerequisites.",
    });
    expect(error.name).toBe("AbortError");
    expect(error.failure).toEqual({
      code: "aborted",
      operation: "cancellation",
      safeMessage: "aborted",
      recovery:
        "Inspect /sandbox; review selected policy and native prerequisites.",
    });
    expect(error.cause).toBeUndefined();
    expect(Object.isFrozen(error.failure)).toBe(true);
    const nested = new RuntimeFailure("cleanup", "cleanup", "Failed", {
      cause: error,
    });
    expect(nested.cause).toBe(error);
    expect(nested.name).toBe("Error");
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
