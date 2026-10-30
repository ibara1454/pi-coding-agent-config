import { describe, expect, test as it } from "bun:test";
import { graphql, rule, selectors } from "./matchers.ts";

const MALFORMED_FIELD = 4;
const MALFORMED_OPERATION_TYPE = 3;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Groups all selectors cases for one operation.
describe("selectors", () => {
  it.each([false, true])(
    "should convert scalar query strings into glob matchers when profile is %p",
    (profile) => {
      expect(selectors(profile)({ query: { q: "search*" } }, "allow")).toEqual({
        query: { q: { glob: "search*" } },
      });
    },
  );
  it("should flatten nested policy params and map a tool selector to the name restriction", () => {
    expect(
      selectors(false)(
        {
          method: "tools/call",
          tool: "search*",
          query: { q: { any: ["search", "lookup"] } },
          params: { request: { name: "public-*", tags: { any: ["safe"] } } },
        },
        "allow",
      ),
    ).toEqual({
      method: "tools/call",
      query: { q: { any: ["search", "lookup"] } },
      params: {
        "request.name": { glob: "public-*" },
        "request.tags": { any: ["safe"] },
        name: { glob: "search*" },
      },
    });
  });
  it("should retain profile query, param and operation selectors without policy flattening", () => {
    expect(
      selectors(true)(
        {
          ["operation_type"]: "query",
          ["operation_name"]: "Viewer",
          fields: ["viewer"],
          query: {
            q: { glob: "read*" },
            empty: { glob: "search", any: [] },
          },
          params: { id: { any: ["a", "b"] } },
          // biome-ignore lint/plugin/biome-rules/use-undefined: Native profile YAML permits a null tool selector, which must not add a name restriction.
          tool: null,
        },
        "allow",
      ),
    ).toEqual({
      operationType: "query",
      operationName: "Viewer",
      fields: ["viewer"],
      query: {
        q: { glob: "read*" },
        empty: { glob: "search", any: [] },
      },
      params: { id: { any: ["a", "b"] } },
    });
  });
  it.each([
    [
      "a flattened policy parameter collides with an existing dotted name",
      false,
      { params: { "a.b": "first", a: { b: "second" } } },
    ],
    [
      "a tool collides with a parameter named name",
      false,
      { tool: "search", params: { name: "other" } },
    ],
    [
      "a profile tool collides with a parameter named name",
      true,
      { tool: "search", params: { name: "other" } },
    ],
    [
      "a profile query has both glob and alternatives",
      true,
      { query: { q: { glob: "x", any: ["y"] } } },
    ],
    [
      "a policy query matcher uses a profile-only glob object",
      false,
      { query: { q: { glob: "search" } } },
    ],
    [
      "a policy query matcher has an unknown restriction",
      false,
      { query: { q: { except: "secret" } } },
    ],
  ] as const)("should reject when %s", (_case, profile, value) => {
    expect(() => selectors(profile)(value, "allow")).toThrow(
      "Invalid OpenShell",
    );
  });
});

describe("rule", () => {
  it("should preserve an allow restriction when policy requires the wrapper", () => {
    expect(rule(false)({ allow: { method: "GET" } }, "rule")).toEqual({
      allow: { method: "GET" },
    });
  });
  it("should reject when a policy rule has no allow wrapper", () =>
    expect(() => rule(false)({}, "rule")).toThrow("rule"));
  it("should retain profile optional and null allow wrappers when supplied", () => {
    expect(rule(true)({}, "rule")).toEqual({});
    // biome-ignore lint/plugin/biome-rules/use-undefined: Native profile allow options preserve explicit null in protobuf JSON rather than an invented selector.
    expect(rule(true)({ allow: null }, "rule")).toEqual({ allow: null });
    expect(rule(true)({ allow: { command: "git*" } }, "rule")).toEqual({
      allow: { command: "git*" },
    });
  });
});

describe("graphql", () => {
  it("should map a persisted operation identity and field allowlist when supplied", () => {
    expect(
      graphql(
        {
          ["operation_type"]: "query",
          ["operation_name"]: "Viewer",
          fields: ["viewer"],
        },
        "operation",
      ),
    ).toEqual({
      operationType: "query",
      operationName: "Viewer",
      fields: ["viewer"],
    });
  });
  it.each([
    { unknown: true },
    { fields: [MALFORMED_FIELD] },
    { ["operation_type"]: MALFORMED_OPERATION_TYPE },
  ])("should reject when operation restrictions are malformed: %p", (value) => {
    expect(() => graphql(value, "operation")).toThrow("operation");
  });
});
