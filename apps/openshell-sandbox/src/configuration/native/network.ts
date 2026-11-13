import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import { invalid, object } from "../validation/index.ts";
import { graphql, rule, selectors } from "./matchers.ts";
import {
  boolean,
  type Decoder,
  dictionary,
  type Fields,
  fields,
  list,
  optional,
  port,
  string,
  uint32,
} from "./schema.ts";

const COMMON: Fields = {
  host: ["host", string],
  path: ["path", string],
  port: ["port", port],
  ports: ["ports", list(port)],
  protocol: ["protocol", string],
  tls: ["tls", mode({ "": 0, skip: 1 })],
  enforcement: ["enforcement", mode({ "": 0, enforce: 1, audit: 2 })],
  access: ["access", mode({ "": 0, "read-only": 1, "read-write": 2, full: 3 })],
  ["allowed_ips"]: ["allowedIps", list(string)],
  ["allow_encoded_slash"]: ["allowEncodedSlash", boolean],
  ["websocket_credential_rewrite"]: ["websocketCredentialRewrite", boolean],
  ["request_body_credential_rewrite"]: [
    "requestBodyCredentialRewrite",
    boolean,
  ],
  ["allow_uninspected_credentials"]: ["allowUninspectedCredentials", boolean],
  ["persisted_queries"]: ["persistedQueries", string],
  ["graphql_persisted_queries"]: [
    "graphqlPersistedQueries",
    dictionary(graphql),
  ],
  ["graphql_max_body_bytes"]: ["graphqlMaxBodyBytes", uint32],
  ["credential_signing"]: ["credentialSigning", string],
  ["signing_service"]: ["signingService", string],
  ["signing_region"]: ["signingRegion", string],
};

const DEFAULT_MCP_VERSION = "2025-11-25";
const MCP_VERSIONS = [
  "2025-03-26",
  "2025-06-18",
  DEFAULT_MCP_VERSION,
  "2026-07-28",
];

/** Map exact native endpoint modes to protobuf enums without accepting normalized aliases.
 * @throws A field-only diagnostic for unknown or removed modes.
 * @example mode({enforce:1})("enforce", "enforcement") returns 1.
 */
function mode(values: Readonly<Record<string, number>>): Decoder {
  return (value, field) => {
    const selected = string(value, field);
    return Object.hasOwn(values, selected)
      ? (values[selected] ?? invalid(field))
      : invalid(field);
  };
}

/** Validate exact MCP revisions before canonical ordering can hide duplicates.
 * @throws A field-only diagnostic for empty, duplicate, padded, or unsupported revisions.
 * @example versions(["2025-11-25", "2025-03-26"], "mcp.versions") returns ascending revisions.
 */
function versions(value: unknown, field: string): JsonValue {
  const selected = list(string)(value, field) as string[];
  if (
    selected.length === 0 ||
    new Set(selected).size !== selected.length ||
    selected.some((revision) => !MCP_VERSIONS.includes(revision))
  ) {
    invalid(field);
  }
  return selected.sort((left, right) => left.localeCompare(right));
}

/** Decode MCP options with distinct native policy/profile syntax.
 * @example mcp(false)({strict_tool_names:false}, "mcp") preserves explicit false.
 */
function mcp(profile: boolean): Decoder {
  return (value, field) => ({
    versions: [DEFAULT_MCP_VERSION],
    ...fields(value, field, {
      versions: ["versions", versions],
      ["strict_tool_names"]: [
        "strictToolNames",
        profile ? optional(boolean) : boolean,
      ],
      ["allow_all_known_mcp_methods"]: [
        "allowAllKnownMcpMethods",
        profile ? optional(boolean) : boolean,
      ],
      ...(profile
        ? {}
        : { ["max_body_bytes"]: ["maxBodyBytes", uint32] as const }),
    }),
  });
}

/** Reject profile list emptiness that native pre-lowering validation rejects before protobuf erases presence.
 * @example profileRules(rule(true))([], "rules") rejects the otherwise lossy conversion.
 */
function profileRules(decode: Decoder): Decoder {
  return (value, field) => {
    if (value === null) {
      // biome-ignore lint/plugin/biome-rules/use-undefined: Native profile rules accept explicit null, which protobuf JSON decodes as an unset list.
      return null;
    }
    const result = list(decode)(value, field);
    if (Array.isArray(result) && result.length === 0) {
      invalid(`${field} (explicit empty list)`);
    }
    return result;
  };
}

/** Map native endpoints using explicit field mappings and policy-specific port/body-limit lowering.
 * @example endpoint(false)({host:"github.com",port:443n}, "endpoint") promotes port to ports.
 */
export function endpoint(profile: boolean): Decoder {
  return (value, field) => {
    const result = fields(
      value,
      field,
      {
        ...COMMON,
        rules: [
          "rules",
          profile ? profileRules(rule(true)) : list(rule(false)),
        ],
        ["deny_rules"]: [
          "denyRules",
          profile ? profileRules(selectors(true)) : list(selectors(false)),
        ],
        mcp: ["mcp", mcp(profile)],
        ...(profile
          ? {
              ["json_rpc_max_body_bytes"]: [
                "jsonRpcMaxBodyBytes",
                uint32,
              ] as const,
            }
          : {
              ["json_rpc"]: [
                "jsonRpc",
                (input, path) =>
                  fields(input, path, {
                    ["max_body_bytes"]: ["maxBodyBytes", uint32],
                  }),
              ] as const,
              ["credential_binding"]: [
                "credentialBinding",
                (input, path) =>
                  fields(input, path, { provider: ["provider", string] }, [
                    "provider",
                  ]),
              ] as const,
            }),
      },
      profile ? ["host"] : [],
    );
    if (profile) {
      return typeof result["protocol"] === "string" &&
        result["protocol"].toLowerCase() === "mcp" &&
        result["mcp"] === undefined
        ? { ...result, mcp: { versions: [DEFAULT_MCP_VERSION] } }
        : result;
    }
    return lowerPolicyEndpoint(result, field);
  };
}

/** Resolve native port aliases, rejecting a supplied plural/singular conflict.
 * @example policyPorts({port:443}, "endpoint") returns the single explicit port.
 */
function policyPorts(result: JsonObject, field: string): JsonValue[] {
  const ports = Array.isArray(result["ports"]) ? result["ports"] : [];
  if (ports.length > 0 && result["port"]) {
    invalid(`${field}.port and ports`);
  }
  if (ports.length > 0) {
    return ports;
  }
  return result["port"] ? [result["port"]] : [];
}

/** Lower policy aliases and materialize the pinned MCP contract only for MCP endpoints.
 * @throws A field-only diagnostic when MCP options occur on non-MCP traffic.
 * @example lowerPolicyEndpoint({port:443}, "endpoint") returns ports:[443].
 */
function lowerPolicyEndpoint(result: JsonObject, field: string): JsonObject {
  const selectedPorts = policyPorts(result, field);
  const nativeMcp = result["mcp"];
  const { jsonRpc: nativeRpc, ...mapped } = result;
  const mcpOptions =
    nativeMcp === undefined || nativeMcp === null
      ? undefined
      : object(nativeMcp, field);
  const rpcOptions =
    nativeRpc === undefined || nativeRpc === null
      ? undefined
      : object(nativeRpc, field);
  if (mcpOptions && rpcOptions) {
    invalid(`${field}.json_rpc and mcp`);
  }
  mapped["ports"] = selectedPorts;
  mapped["port"] = selectedPorts[0] ?? 0;
  const isMcp =
    typeof result["protocol"] === "string" &&
    result["protocol"].toLowerCase() === "mcp";
  if (mcpOptions && !isMcp) {
    invalid(`${field}.mcp`);
  }
  if (isMcp) {
    const { maxBodyBytes, ...mcpConfiguration } = mcpOptions ?? {};
    mapped["jsonRpcMaxBodyBytes"] = (maxBodyBytes ??
      rpcOptions?.["maxBodyBytes"] ??
      0) as JsonValue;
    mapped["mcp"] = {
      versions: [DEFAULT_MCP_VERSION],
      ...mcpConfiguration,
    } as JsonObject;
  } else {
    mapped["jsonRpcMaxBodyBytes"] = (rpcOptions?.["maxBodyBytes"] ??
      0) as JsonValue;
  }
  return mapped;
}

/** Convert policy binary objects and profile string/object forms; removed metadata is rejected.
 * @example binary(true)("/usr/bin/git", "binaries") creates the native binary path.
 */
export function binary(profile: boolean): Decoder {
  return (value, field) => {
    if (profile && typeof value === "string") {
      return { path: value };
    }
    const result = fields(value, field, { path: ["path", string] }, ["path"]);
    const path = result["path"];
    if (typeof path !== "string") {
      invalid(`${field}.path`);
    }
    return profile ? result : { path };
  };
}
