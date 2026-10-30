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
  tls: ["tls", string],
  enforcement: ["enforcement", string],
  access: ["access", string],
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

/** Decode MCP options with distinct native policy/profile syntax.
 * @example mcp(false)({strict_tool_names:false}, "mcp") preserves explicit false.
 */
function mcp(profile: boolean): Decoder {
  return (value, field) =>
    fields(value, field, {
      ["strict_tool_names"]: ["strictToolNames", optional(boolean)],
      ["allow_all_known_mcp_methods"]: [
        "allowAllKnownMcpMethods",
        optional(boolean),
      ],
      ...(profile
        ? {}
        : { ["max_body_bytes"]: ["maxBodyBytes", uint32] as const }),
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
        mcp: ["mcp", optional(mcp(profile))],
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
                optional((input, path) =>
                  fields(input, path, {
                    ["max_body_bytes"]: ["maxBodyBytes", uint32],
                  }),
                ),
              ] as const,
              ["credential_binding"]: [
                "credentialBinding",
                optional((input, path) =>
                  fields(input, path, { provider: ["provider", string] }, [
                    "provider",
                  ]),
                ),
              ] as const,
            }),
      },
      profile ? ["host"] : [],
    );
    return profile ? result : lowerPolicyEndpoint(result, field);
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

/** Lower native policy aliases, treating null MCP flags as absent while preserving false and body limits.
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
  if (mcpOptions) {
    const { maxBodyBytes, ...mcpConfiguration } = mcpOptions;
    mapped["jsonRpcMaxBodyBytes"] = (maxBodyBytes ?? 0) as JsonValue;
    mapped["mcp"] = Object.values(mcpConfiguration).some(
      (value) => typeof value === "boolean",
    )
      ? (mcpConfiguration as JsonObject)
      : // biome-ignore lint/plugin/biome-rules/use-undefined: Protobuf JSON null leaves MCP unset when native lowering retains no non-null flags.
        null;
  } else {
    mapped["jsonRpcMaxBodyBytes"] = (rpcOptions?.["maxBodyBytes"] ??
      0) as JsonValue;
  }
  return mapped;
}

/** Convert policy binary objects and profile string/object forms; harness is deprecated native metadata.
 * @example binary(true)("/usr/bin/git", "binaries") creates the native binary path.
 */
export function binary(profile: boolean): Decoder {
  return (value, field) => {
    if (profile && typeof value === "string") {
      return { path: value };
    }
    const result = fields(
      value,
      field,
      { path: ["path", string], harness: ["harness", boolean] },
      ["path"],
    );
    const path = result["path"];
    if (typeof path !== "string") {
      invalid(`${field}.path`);
    }
    return profile ? result : { path };
  };
}
