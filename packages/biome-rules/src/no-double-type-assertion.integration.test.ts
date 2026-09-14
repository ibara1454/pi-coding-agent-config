import { describe, expect, test } from "bun:test";
import { lintRule } from "./test-utils";

const invalid = `
declare const value: object;
export const direct = value as unknown as Date;
export const parenthesized = (value as unknown) as Date;
export const nested = (((value as unknown))) as Date;
`;

const valid = `
declare const value: object;
export const single = value as Date;
export const unknown = value as unknown;
export const endingInUnknown = value as Date as unknown;
export const literal = { enabled: true } as const;
export const text = "value as unknown as Date";
`;

describe("no-double-type-assertion", () => {
  test("should reject nested assertions when the intermediate type is unknown", () => {
    expect(lintRule("no-double-type-assertion", invalid)).toEqual(
      ["value as unknown", "(value as unknown)", "(((value as unknown)))"].map(
        (source) => ({ category: "plugin", severity: "error", source }),
      ),
    );
  });

  test("should allow assertions without an unknown intermediate type", () => {
    expect(lintRule("no-double-type-assertion", valid)).toEqual([]);
  });
});
