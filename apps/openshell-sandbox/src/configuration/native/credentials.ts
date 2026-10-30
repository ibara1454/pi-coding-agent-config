import type { JsonObject } from "@bufbuild/protobuf";
import {
  boolean,
  enumeration,
  fields,
  int64,
  list,
  optional,
  port,
  string,
} from "./schema.ts";

const REFRESH_STRATEGIES = {
  "": 0,
  static: 1,
  external: 2,
  ["oauth2_refresh_token"]: 3,
  ["oauth2_client_credentials"]: 4,
  ["google_service_account_jwt"]: 5,
  ["aws_sts_assume_role"]: 6,
};

/** Decode native credential renewal capability metadata, never selecting or starting renewal.
 * @example refresh({strategy:"static"}, "refresh") preserves the native static enum.
 */
function refresh(value: unknown, field: string): JsonObject {
  return fields(value, field, {
    strategy: ["strategy", enumeration(REFRESH_STRATEGIES)],
    ["token_url"]: ["tokenUrl", string],
    scopes: ["scopes", list(string)],
    ["refresh_before_seconds"]: ["refreshBeforeSeconds", int64],
    ["max_lifetime_seconds"]: ["maxLifetimeSeconds", int64],
    material: [
      "material",
      list((input, path) =>
        fields(
          input,
          path,
          {
            name: ["name", string],
            description: ["description", string],
            required: ["required", boolean],
            secret: ["secret", boolean],
          },
          ["name"],
        ),
      ),
    ],
    ["additional_outputs"]: [
      "additionalOutputs",
      list((input, path) =>
        fields(
          input,
          path,
          {
            output: ["output", string],
            credential: ["credential", string],
          },
          ["output", "credential"],
        ),
      ),
    ],
  });
}

/** Decode the native token-grant schema, retaining its non-protobuf client_credentials default.
 * @example tokenGrant({token_endpoint:"https://auth.example/token"}, "grant") assigns grant type 1.
 */
function tokenGrant(value: unknown, field: string): JsonObject {
  const result = fields(
    value,
    field,
    {
      ["grant_type"]: [
        "grantType",
        enumeration({
          "": 1,
          ["client_credentials"]: 1,
          ["token_exchange"]: 2,
        }),
      ],
      ["token_endpoint"]: ["tokenEndpoint", string],
      audience: ["audience", string],
      ["jwt_svid_audience"]: ["jwtSvidAudience", string],
      ["client_assertion_type"]: ["clientAssertionType", string],
      scopes: ["scopes", list(string)],
      ["cache_ttl_seconds"]: ["cacheTtlSeconds", int64],
      ["requested_token_type"]: ["requestedTokenType", string],
      ["audience_overrides"]: [
        "audienceOverrides",
        list((input, path) =>
          fields(
            input,
            path,
            {
              host: ["host", string],
              port: ["port", port],
              path: ["path", string],
              audience: ["audience", string],
              scopes: ["scopes", list(string)],
            },
            ["audience"],
          ),
        ),
      ],
      ["subject_token"]: [
        "subjectToken",
        optional((input, path) =>
          fields(
            input,
            path,
            {
              source: ["source", string],
              credential: ["credential", string],
              ["subject_token_type"]: ["subjectTokenType", string],
            },
            ["source", "credential"],
          ),
        ),
      ],
    },
    ["token_endpoint"],
  );
  return { grantType: 1, ...result };
}

/** Decode all pinned profile credential fields; refresh is allowed only at this credential nesting.
 * @example credential({name:"token",env_vars:["TOKEN"],refresh:{strategy:"static"}}, "credential") retains metadata only.
 */
export function credential(value: unknown, field: string): JsonObject {
  return fields(
    value,
    field,
    {
      name: ["name", string],
      description: ["description", string],
      ["env_vars"]: ["envVars", list(string)],
      required: ["required", boolean],
      ["auth_style"]: ["authStyle", string],
      ["header_name"]: ["headerName", string],
      ["query_param"]: ["queryParam", string],
      ["path_template"]: ["pathTemplate", string],
      refresh: ["refresh", optional(refresh)],
      ["token_grant"]: ["tokenGrant", optional(tokenGrant)],
    },
    ["name"],
  );
}
