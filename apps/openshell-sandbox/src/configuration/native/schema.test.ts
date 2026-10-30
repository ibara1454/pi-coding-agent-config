import { describe, expect, test as it } from "bun:test";
import { SandboxConfigurationError } from "../validation/index.ts";
import {
  boolean,
  dictionary,
  enumeration,
  fields,
  int64,
  integer,
  list,
  optional,
  parseNativeYaml,
  port,
  string,
  uint32,
  uint64,
} from "./schema.ts";

const NUMERIC_USER_ID = 1000;
const MAX_NATIVE_YAML_BYTES = 1_048_576;
const EXCESSIVE_ALIAS_REFERENCES = 51;
const UNSAFE_EXACT_INTEGER = 9_007_199_254_740_993n;
const OUTSIDE_SMALL_INTEGER = 3n;
const NONINTEGER = 1.5;
const MAX_UINT32 = 4_294_967_295n;
const MAX_PORT = 65_535n;
const MIN_INT64 = -9_223_372_036_854_775_808n;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const INVALID_MEMBER = 4;

/** Require malformed inputs to raise a safe native configuration error.
 * @example invalid(() => boolean("false", "flag")) accepts only the expected rejection.
 */
function invalid(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    if (error instanceof SandboxConfigurationError) {
      return;
    }
    throw error;
  }
  throw new Error("Malformed schema input was accepted");
}

describe("parseNativeYaml", () => {
  it("should retain exact integers when parsing native YAML", () => {
    expect(
      parseNativeYaml("version: 18446744073709551615", "/policy.yaml"),
    ).toEqual({
      version: MAX_UINT64,
    });
  });
  it.each([
    ["duplicate keys", "version: 1\nversion: 2"],
    ["multiple documents", "version: 1\n---\nversion: 2"],
    ["unsupported tags", "version: !!js/function secret"],
    [
      "an alias expansion bomb",
      `a: &a RAW-SECRET\nb: [${new Array(EXCESSIVE_ALIAS_REFERENCES).fill("*a").join(",")}]`,
    ],
    [
      "an oversized document",
      `version: 1\n#${"x".repeat(MAX_NATIVE_YAML_BYTES)}`,
    ],
  ])("should reject %s without leaking document content", (_case, source) => {
    expect(() => parseNativeYaml(source, "/policy.yaml")).toThrow(
      "Invalid OpenShell native YAML: /policy.yaml",
    );
  });
});

describe("fields", () => {
  const schema = { enabled: ["isEnabled", boolean] } as const;
  it("should map explicit false when a known field is supplied", () => {
    expect(fields({ enabled: false }, "config", schema, ["enabled"])).toEqual({
      isEnabled: false,
    });
  });
  it.each([
    ["required keys are absent", {}],
    ["unknown keys are supplied", { enabled: true, secret: true }],
    ["the value is not a mapping", []],
    ["known field values have the wrong type", { enabled: "false" }],
  ])("should reject when %s", (_case, input) =>
    invalid(() => fields(input, "config", schema, ["enabled"])),
  );
});

describe("string", () => {
  it("should preserve numeric-looking identities when passed as strings", () => {
    expect(string("1000", "user")).toBe("1000");
  });
  // biome-ignore lint/plugin/biome-rules/use-undefined: Native YAML null is invalid for a required string, not an absent identity.
  it.each([NUMERIC_USER_ID, null, "a\0b"])(
    "should reject when the input is %p",
    (value) => invalid(() => string(value, "user")),
  );
});

describe("boolean", () => {
  it("should preserve explicit false when the input is a boolean", () =>
    expect(boolean(false, "flag")).toBe(false));
  // biome-ignore lint/plugin/biome-rules/use-undefined: Native YAML null is invalid for a required boolean, not explicit false.
  it.each(["false", 0, null])("should reject when the input is %p", (value) =>
    invalid(() => boolean(value, "flag")),
  );
});

describe("integer", () => {
  it("should retain both numeric and wide string representations when bounds permit", () => {
    expect(integer(-2n, 2n)(-2n, "number")).toBe(-2);
    expect(
      integer(0n, UNSAFE_EXACT_INTEGER, true)(UNSAFE_EXACT_INTEGER, "number"),
    ).toBe("9007199254740993");
  });
  it.each([
    OUTSIDE_SMALL_INTEGER,
    -OUTSIDE_SMALL_INTEGER,
    NONINTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
  ])(
    "should reject when the input %p exceeds bounds or is not an exact integer",
    (value) => invalid(() => integer(-2n, 2n)(value, "number")),
  );
});

describe("uint32", () => {
  it("should accept the maximum unsigned 32-bit value when in range", () =>
    expect(uint32(MAX_UINT32, "version")).toBe(Number(MAX_UINT32)));
  it.each([-1n, MAX_UINT32 + 1n])(
    "should reject when %p is outside the unsigned range",
    (value) => invalid(() => uint32(value, "version")),
  );
});

describe("port", () => {
  it("should accept the largest port when in range", () =>
    expect(port(MAX_PORT, "port")).toBe(Number(MAX_PORT)));
  it.each([-1n, MAX_PORT + 1n])(
    "should reject when %p is outside the port range",
    (value) => invalid(() => port(value, "port")),
  );
});

describe("int64", () => {
  it("should preserve signed extremes as decimal strings when in range", () => {
    expect(int64(MIN_INT64, "seconds")).toBe("-9223372036854775808");
    expect(int64(MAX_INT64, "seconds")).toBe("9223372036854775807");
  });
  it.each([MIN_INT64 - 1n, MAX_INT64 + 1n])(
    "should reject when %p exceeds signed 64-bit bounds",
    (value) => invalid(() => int64(value, "seconds")),
  );
});

describe("uint64", () => {
  it("should preserve the maximum unsigned version when in range", () =>
    expect(uint64(MAX_UINT64, "version")).toBe("18446744073709551615"));
  it.each([-1n, MAX_UINT64 + 1n])(
    "should reject when %p exceeds unsigned 64-bit bounds",
    (value) => invalid(() => uint64(value, "version")),
  );
});

describe("list", () => {
  it("should preserve empty lists and validate each member when supplied", () => {
    expect(list(string)([], "items")).toEqual([]);
    expect(list(string)(["a", "b"], "items")).toEqual(["a", "b"]);
  });
  // biome-ignore lint/plugin/biome-rules/use-undefined: Native YAML null is invalid for a required list and must not decode as an empty list.
  it.each([[null], [{}], [["ok", INVALID_MEMBER]]])(
    "should reject when members or list input are invalid: %p",
    (value) => invalid(() => list(string)(value, "items")),
  );
});

describe("dictionary", () => {
  it("should preserve map keys and decode each value when supplied", () =>
    expect(dictionary(boolean)({ first: false, second: true }, "map")).toEqual({
      first: false,
      second: true,
    }));
  // biome-ignore lint/plugin/biome-rules/use-undefined: Native YAML null is invalid for a required dictionary, not an empty mapping.
  it.each([[[]], [null], [{ first: "true" }]])(
    "should reject when the map or its values are invalid: %p",
    (value) => invalid(() => dictionary(boolean)(value, "map")),
  );
});

describe("optional", () => {
  it("should retain null as absence when the option is explicitly null", () =>
    // biome-ignore lint/plugin/biome-rules/use-undefined: Native optional YAML null must remain null in protobuf JSON until SDK decoding.
    expect(optional(boolean)(null, "flag")).toBeNull());
  it("should decode present values and reject malformed ones when supplied", () => {
    expect(optional(boolean)(false, "flag")).toBe(false);
    invalid(() => optional(boolean)("false", "flag"));
  });
});

describe("enumeration", () => {
  const decode = enumeration({ static: 1, ["token_exchange"]: 2 });
  it.each([
    ["STATIC", 1],
    ["token-exchange", 2],
    [" static ", 1],
  ] as const)(
    "should normalize %s to the configured enum value",
    (value, expected) => expect(decode(value, "strategy")).toBe(expected),
  );
  it.each(["unknown", 1, "__proto__"])(
    "should reject when %p is not an owned enum value",
    (value) => invalid(() => decode(value, "strategy")),
  );
});
