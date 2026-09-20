import { describe, expect, test } from "bun:test";
import { lintRule } from "./test-utils.ts";

const invalid = `
test("missing prefix", () => {});
it.only('another missing prefix', () => {});
test.skip.each([[1]])("missing prefix for %s", () => {});
it(\`template without a prefix\`, () => {});
test("should", () => {});
test("Should use lowercase", () => {});
`;

const valid = `
test("should accept a quoted title", () => {});
it.only('should accept a single-quoted title', () => {});
it.each([["not a title"]])("should accept a table row %s", () => {});
test.skip.each([["not a title"]])(\`should accept a chained template\`, () => {});
test(dynamicTitle, () => {});
it(makeTitle(), () => {});
describe("group without a prefix", () => {});
other.test("unrelated function", () => {});
`;

describe("use-should-test-title", () => {
  test("should reject literal titles without the exact should prefix", () => {
    expect(lintRule("use-should-test-title", invalid)).toEqual(
      [
        '"missing prefix"',
        "'another missing prefix'",
        '"missing prefix for %s"',
        "`template without a prefix`",
        '"should"',
        '"Should use lowercase"',
      ].map((source) => ({ category: "plugin", severity: "error", source })),
    );
  });

  test("should allow prefixed and dynamic titles without inspecting table data", () => {
    expect(lintRule("use-should-test-title", valid)).toEqual([]);
  });
});
