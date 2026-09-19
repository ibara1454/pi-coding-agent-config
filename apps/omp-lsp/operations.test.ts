import { describe, expect, test } from "bun:test";
import {
  diagnosticsText,
  normalizeDiagnostics,
  resolvePosition,
  symbols,
} from "./operations.ts";

const CLEAN_STATUS = /\bOK\b/;

describe("resolvePosition", () => {
  test("should select the requested whole-identifier occurrence using UTF-16 columns", () => {
    expect(resolvePosition("\u{1f600} foobar foo + foo", 1, "foo#2")).toEqual({
      line: 0,
      character: 16,
    });
  });

  test("should fall back to case-insensitive matches only when no exact match exists", () => {
    expect(resolvePosition("FOO foo", 1, "foo")).toEqual({
      line: 0,
      character: 4,
    });
    expect(resolvePosition("FOO FOO", 1, "foo#2")).toEqual({
      line: 0,
      character: 4,
    });
  });

  test("should reject nonexistent occurrences and invalid lines instead of querying unrelated positions", () => {
    expect(() => resolvePosition("foo", 1, "foo#2")).toThrow("out of bounds");
    expect(() => resolvePosition("foo", 0, "foo")).toThrow("1-based");
    expect(() => resolvePosition("foo", 2, "foo")).toThrow("outside");
  });
});

describe("normalizeDiagnostics", () => {
  test("should merge equivalent server findings while retaining the most severe diagnostic", () => {
    const range = {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 3 },
    };
    const result = normalizeDiagnostics([
      { range, message: "Undefined variable", severity: 2, source: "lint" },
      { range, message: "Undefined variable", severity: 1, source: "semantic" },
    ]);
    expect(result).toEqual([
      { range, message: "Undefined variable", severity: 1, source: "semantic" },
    ]);
  });
});

describe("diagnosticsText", () => {
  test("should label empty unversioned publications as unverified rather than clean", () => {
    const text = diagnosticsText("/project/a.ts", [], "/project", [
      "legacy-server",
    ]);
    expect(text).toContain("freshness-unverified");
    expect(text).toContain("legacy-server");
    expect(text).not.toMatch(CLEAN_STATUS);
  });

  test("should retain findings when their publication freshness cannot be verified", () => {
    const diagnostics = [
      {
        range: {
          start: { line: 1, character: 2 },
          end: { line: 1, character: 3 },
        },
        message: "Undefined variable",
        severity: 1 as const,
      },
    ];
    const text = diagnosticsText("/project/a.ts", diagnostics, "/project", [
      "legacy-server",
    ]);
    expect(text).toContain("Undefined variable");
    expect(text).toContain("a.ts:2:3");
    expect(text).toContain("freshness-unverified");
  });
});

describe("symbols", () => {
  test("should leave workspace symbol positions unresolved when the server omits their ranges", () => {
    const result = symbols([
      { name: "Thing", kind: 5, location: { uri: "file:///project/a.ts" } },
    ]);
    expect(result[0]?.position).toBeUndefined();
  });
});
