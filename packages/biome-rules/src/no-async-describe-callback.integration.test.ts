import { describe, expect, test } from "bun:test";
import { lintRule } from "./test-utils.ts";

const invalid = `
describe("direct", async () => {});
describe.only("named callback", async function setup() {});
describe.each([[1]])("anonymous callback", async function () {});
describe.skip.each([[1]])("chained callback", async (value) => value);
`;

const valid = `
describe("group", () => {
  test("should allow asynchronous work", async () => {});
  beforeEach(async () => {});
});
describe.only("named callback", function setup() {});
describe.skip.each([[1]])("chained callback", (value) => value);
other.describe("unrelated function", async () => {});
`;

describe("no-async-describe-callback", () => {
  test("should reject asynchronous callbacks on describe chains", () => {
    expect(lintRule("no-async-describe-callback", invalid)).toEqual(
      [
        "async () => {}",
        "async function setup() {}",
        "async function () {}",
        "async (value) => value",
      ].map((source) => ({ category: "plugin", severity: "error", source })),
    );
  });

  test("should allow asynchronous tests and hooks inside synchronous groups", () => {
    expect(lintRule("no-async-describe-callback", valid)).toEqual([]);
  });
});
