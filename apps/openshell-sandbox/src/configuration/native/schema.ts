// Explicit schema mapping targets NVIDIA/OpenShell v0.0.116:
// crates/openshell-policy/src/{lib,middleware}.rs and crates/openshell-providers/src/profiles.rs.
// Protobuf decoding supplies only defaults already established by those native serde definitions.
import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import { parseDocument } from "yaml";
import {
  invalid,
  object,
  SandboxConfigurationError,
} from "../validation/index.ts";

const MAX_YAML_BYTES = 1_048_576;
const MAX_ALIAS_COUNT = 50;
const UINT32_MAX = 4_294_967_295n;
const PORT_MAX = 65_535n;
const INT64_MIN = -9_223_372_036_854_775_808n;
const INT64_MAX = 9_223_372_036_854_775_807n;
const UINT64_MAX = 18_446_744_073_709_551_615n;

export type Decoder = (value: unknown, field: string) => JsonValue;
export type Fields = Readonly<Record<string, readonly [string, Decoder]>>;

/** Parse bounded YAML with limited alias expansion, rejecting duplicate keys and custom tags.
 * @throws A document-only diagnostic, never parser snippets containing credentials.
 * @example parseNativeYaml("version: 1", "/policy.yaml") returns a mapping with an exact integer.
 */
export function parseNativeYaml(source: string, path: string): unknown {
  let result: unknown;
  let failed = false;
  try {
    if (Buffer.byteLength(source, "utf8") > MAX_YAML_BYTES) {
      invalid("document size");
    }
    const document = parseDocument(source, {
      uniqueKeys: true,
      intAsBigInt: true,
      schema: "core",
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      invalid("YAML syntax");
    }
    result = document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch {
    failed = true;
  }
  if (failed) {
    throw new SandboxConfigurationError(
      `Invalid OpenShell native YAML: ${path}`,
    );
  }
  return result;
}

/** Map only explicitly enumerated native fields; unknown fields cannot silently lose restrictions.
 * @example fields({read_only:[]}, "fs", {read_only:["readOnly",list(string)]}) preserves emptiness.
 */
export function fields(
  value: unknown,
  field: string,
  schema: Fields,
  required: readonly string[] = [],
): JsonObject {
  const input = object(value, field, Object.keys(schema));
  if (required.some((key) => !(key in input))) {
    invalid(field);
  }
  return Object.fromEntries(
    Object.entries(input).map(([key, item]) => {
      const definition = schema[key];
      if (!definition) {
        return invalid(field);
      }
      return [definition[0], definition[1](item, `${field}.${key}`)];
    }),
  );
}

/** Decode a native string without converting numeric identities into names.
 * @example string("1000", "process.run_as_user") preserves its string type.
 */
export function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    invalid(field);
  }
  return value;
}

/** Decode native booleans without treating strings or integers as truth values.
 * @example boolean(false, "include_workdir") preserves explicit false.
 */
export function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    invalid(field);
  }
  return value;
}

/** Check exact integer range before producing protobuf JSON numeric/string representation.
 * @example integer(0n, 65535n)(443n, "port") returns 443.
 */
export function integer(
  minimum: bigint,
  maximum: bigint,
  wide = false,
): Decoder {
  return (value, field) => {
    if (
      typeof value !== "bigint" &&
      (typeof value !== "number" || !Number.isSafeInteger(value))
    ) {
      invalid(field);
    }
    const number = BigInt(value);
    if (number < minimum || number > maximum) {
      invalid(field);
    }
    return wide ? number.toString() : Number(number);
  };
}

export const uint32 = integer(0n, UINT32_MAX);
export const port = integer(0n, PORT_MAX);
export const int64 = integer(INT64_MIN, INT64_MAX, true);
export const uint64 = integer(0n, UINT64_MAX, true);

/** Decode explicit arrays without merging, inventing entries, or conflating null with omission.
 * @example list(string)([], "read_only") preserves the explicit empty list.
 */
export function list(decode: Decoder): Decoder {
  return (value, field) => {
    if (!Array.isArray(value)) {
      invalid(field);
    }
    return value.map((item) => decode(item, `${field}[]`));
  };
}

/** Read native map entries without accepting keys the pinned SDK silently omits.
 * @returns Own entries unchanged, leaving values for the owning native decoder.
 * @throws A field-only configuration error for non-mappings or unsupported keys.
 * @example mapEntries({constructor:"value"}, "annotations") retains the named entry.
 */
export function mapEntries(value: unknown, field: string): [string, unknown][] {
  const entries = Object.entries(object(value, field));
  // Protobuf JSON/Struct decoding assigns into ordinary objects, invoking this setter.
  if (entries.some(([key]) => key === "__proto__")) {
    invalid(field);
  }
  return entries;
}

/** Decode keyed native maps with bounded diagnostics that do not echo untrusted keys.
 * @throws A field-only configuration error for unsupported keys or invalid values.
 * @example dictionary(string)({name:"value"}, "annotations") preserves the key/value pair.
 */
export function dictionary(decode: Decoder): Decoder {
  return (value, field) =>
    Object.fromEntries(
      mapEntries(value, field).map(([key, item]) => [
        key,
        decode(item, `${field}.*`),
      ]),
    );
}

/** Preserve a native option's null-as-absence semantics in protobuf JSON.
 * @example optional(boolean)(null, "mcp.strict_tool_names") remains absent after protobuf decoding.
 */
export function optional(decode: Decoder): Decoder {
  // biome-ignore lint/plugin/biome-rules/use-undefined: Native serde options accept explicit null, which protobuf JSON preserves as an unset field.
  return (value, field) => (value === null ? null : decode(value, field));
}

/** Match the pinned serde enum spelling normalization, rejecting unrecognized selections.
 * @example enumeration({static:1})("STATIC", "refresh.strategy") returns 1.
 */
export function enumeration(values: Readonly<Record<string, number>>): Decoder {
  return (value, field) => {
    const name = string(value, field).trim().toLowerCase().replaceAll("-", "_");
    if (!Object.hasOwn(values, name)) {
      invalid(field);
    }
    return values[name] ?? invalid(field);
  };
}
