import { describe, expect, test } from "bun:test";
import { lintRule } from "./test-utils.ts";

const diagnostic = {
  category: "plugin",
  severity: "error",
  source: "null",
} as const;

describe("use-undefined", () => {
  test.each([
    ["a value initializer", "const value = null;"],
    ["an absence type", "type Value = null;"],
    ["a nullable member", "interface State { value: string | null; }"],
    ["an assignment", "value = null;"],
    ["an argument", "send(null);"],
    ["a return", "function read() { return null; }"],
    ["a numeric comparison", "value >= null;"],
    ["a default parameter", "function value(input = null) { return input; }"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code for the parser, not interpolated test data.
    ["a template expression", "const value = `${null}`;"],
  ])("should report an error when null appears in %s", (_label, source) => {
    expect(lintRule("use-undefined", source)).toEqual([diagnostic]);
  });

  test.each(["==", "!=", "===", "!=="])(
    "should allow null on either side of %s",
    (operator) => {
      expect(
        lintRule(
          "use-undefined",
          `value ${operator} null; null ${operator} value;`,
        ),
      ).toEqual([]);
    },
  );

  test("should allow parenthesized and nested null checks in boolean results", () => {
    expect(
      lintRule(
        "use-undefined",
        `
        const missing = value === ((null));
        function hasValue(value) { return ((null)) !== value; }
        send(value !== null);
        (value === null) === (other !== null);
        `,
      ),
    ).toEqual([]);
  });

  test.each([
    ["an argument", "null === send(null);"],
    ["an object value", "null === { value: null };"],
    ["a fallback", "value === (other ?? null);"],
    ["a type assertion", "null === (value as null);"],
    ["a nested return", "null === (() => { return null; });"],
  ])("should reject null used as %s inside a comparison", (_label, source) => {
    expect(lintRule("use-undefined", source)).toEqual([diagnostic]);
  });

  test("should allow undefined and null text that is not a literal or type", () => {
    expect(
      lintRule(
        "use-undefined",
        `
        // null is allowed in comments and text, not as an absence value.
        type Value = string | undefined;
        const value = undefined;
        const text = "null";
        const template = \`null\`;
        const expression = /null/;
        const object = { null: "value" };
        `,
      ),
    ).toEqual([]);
  });

  test("should allow a documented protocol exception without suppressing the next value", () => {
    expect(
      lintRule(
        "use-undefined",
        `
        // biome-ignore lint/plugin/use-undefined: JSON-RPC requires a null result.
        const response = { result: null };
        const absent = null;
        `,
      ),
    ).toEqual([diagnostic]);
  });

  test("should allow a documented nullable external type", () => {
    expect(
      lintRule(
        "use-undefined",
        `
        // biome-ignore lint/plugin/use-undefined: LSP uses null for an unversioned document.
        interface Document { version: number | null; }
        `,
      ),
    ).toEqual([]);
  });
});
