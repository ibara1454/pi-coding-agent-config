import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import { invalid, object } from "../validation/index.ts";
import type { Decoder, Fields } from "./schema.ts";
import {
  dictionary,
  fields,
  list,
  mapEntries,
  optional,
  string,
} from "./schema.ts";

/** Preserve native scalar/glob/any matchers without confusing policy and profile object forms.
 * @example queryMatcher(false)({any:["org/*"]}, "query") retains the alternatives.
 */
function queryMatcher(profile: boolean): Decoder {
  return (value, field) => {
    if (typeof value === "string") {
      return { glob: value };
    }
    const schema: Fields = profile
      ? { glob: ["glob", string], any: ["any", list(string)] }
      : { any: ["any", list(string)] };
    const result = fields(value, field, schema);
    if (
      result["glob"] &&
      Array.isArray(result["any"]) &&
      result["any"].length > 0
    ) {
      invalid(field);
    }
    return result;
  };
}

/** Flatten the policy's nested MCP parameter syntax, rejecting collisions instead of dropping a restriction.
 * @throws A field-only configuration error for unsupported map keys or colliding flattened names.
 * @example policyParams({name:"search"}, "params") produces a name glob matcher.
 */
function policyParams(value: unknown, field: string, prefix = ""): JsonObject {
  const result: JsonObject = {};
  for (const [key, item] of mapEntries(value, field)) {
    const name = prefix ? `${prefix}.${key}` : key;
    const mapping = typeof item === "string" ? undefined : object(item, field);
    const leaves =
      !mapping || Object.keys(mapping).every((part) => part === "any")
        ? { [name]: queryMatcher(false)(item, field) }
        : policyParams(mapping, field, name);
    for (const [leaf, matcher] of Object.entries(leaves)) {
      if (Object.hasOwn(result, leaf)) {
        invalid(field);
      }
      result[leaf] = matcher;
    }
  }
  return result;
}

/** Convert native L7 selectors, preserving GraphQL/REST/command and MCP matcher restrictions.
 * @example selectors(false)({tool:"search"}, "allow") maps tool to params.name.
 */
export function selectors(profile: boolean): Decoder {
  return (value, field) => {
    const match = queryMatcher(profile);
    const result = fields(value, field, {
      method: ["method", string],
      path: ["path", string],
      command: ["command", string],
      ["operation_type"]: ["operationType", string],
      ["operation_name"]: ["operationName", string],
      fields: ["fields", list(string)],
      query: ["query", dictionary(match)],
      params: ["params", profile ? dictionary(match) : policyParams],
      tool: ["tool", optional(match)],
    });
    const { tool, ...matched } = result;
    if (tool !== undefined && tool !== null) {
      const params = object(matched["params"] ?? {}, field);
      if (Object.hasOwn(params, "name")) {
        invalid(`${field}.tool and params.name`);
      }
      matched["params"] = { ...params, name: tool };
    }
    return matched;
  };
}

/** Decode the allow wrapper; policy YAML requires it while profile YAML permits its omission.
 * @example rule(false)({allow:{method:"GET"}}, "rules") preserves that allow rule.
 */
export function rule(profile: boolean): Decoder {
  return (value, field) =>
    fields(
      value,
      field,
      {
        allow: [
          "allow",
          profile ? optional(selectors(true)) : selectors(false),
        ],
      },
      profile ? [] : ["allow"],
    );
}

/** Decode a GraphQL persisted-operation identity and field allowlist.
 * @example graphql({operation_type:"query",fields:["viewer"]}, "operation") retains viewer-only access.
 */
export function graphql(value: unknown, field: string): JsonValue {
  return fields(value, field, {
    ["operation_type"]: ["operationType", string],
    ["operation_name"]: ["operationName", string],
    fields: ["fields", list(string)],
  });
}
