import { describe, expect, test as it } from "bun:test";
import { credential } from "./credentials.ts";

const INVALID_CREDENTIALS = [
  ["credential name is missing", { ["env_vars"]: ["TOKEN"] }],
  [
    "refresh strategy is unknown",
    { name: "token", refresh: { strategy: "magic" } },
  ],
  [
    "refresh material name is missing",
    { name: "token", refresh: { material: [{ secret: true }] } },
  ],
  [
    "refresh output credential is missing",
    { name: "token", refresh: { ["additional_outputs"]: [{ output: "new" }] } },
  ],
  [
    "refresh material leaks a value field",
    {
      name: "token",
      refresh: { material: [{ name: "key", value: "secret" }] },
    },
  ],
  [
    "token grant endpoint is missing",
    { name: "token", ["token_grant"]: { ["grant_type"]: "token_exchange" } },
  ],
  [
    "token grant strategy is unknown",
    {
      name: "token",
      ["token_grant"]: {
        ["grant_type"]: "magic",
        ["token_endpoint"]: "https://auth.example",
      },
    },
  ],
  [
    "audience override is missing audience",
    {
      name: "token",
      ["token_grant"]: {
        ["token_endpoint"]: "https://auth.example",
        ["audience_overrides"]: [{ host: "api.example" }],
      },
    },
  ],
  [
    "subject token is missing a credential",
    {
      name: "token",
      ["token_grant"]: {
        ["token_endpoint"]: "https://auth.example",
        ["subject_token"]: { source: "credential" },
      },
    },
  ],
  [
    "audience port exceeds its range",
    {
      name: "token",
      ["token_grant"]: {
        ["token_endpoint"]: "https://auth.example",
        ["audience_overrides"]: [{ audience: "api", port: 65536n }],
      },
    },
  ],
] as const;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Groups all credential cases for one operation.
describe("credential", () => {
  it("should preserve refresh capabilities and token grant metadata without selecting renewal", () => {
    expect(
      credential(
        {
          name: "access",
          ["env_vars"]: ["ACCESS_TOKEN"],
          required: true,
          refresh: {
            strategy: "oauth2-refresh-token",
            ["refresh_before_seconds"]: 60n,
            material: [{ name: "refresh_token", required: true, secret: true }],
            ["additional_outputs"]: [
              { output: "session_token", credential: "session" },
            ],
          },
          ["token_grant"]: {
            ["token_endpoint"]: "https://auth.example/token",
            scopes: [],
            ["audience_overrides"]: [
              { audience: "registry", host: "registry.example", port: 443n },
            ],
            ["subject_token"]: { source: "credential", credential: "access" },
          },
        },
        "credential",
      ),
    ).toMatchObject({
      name: "access",
      envVars: ["ACCESS_TOKEN"],
      required: true,
      refresh: {
        strategy: 3,
        refreshBeforeSeconds: "60",
        material: [{ name: "refresh_token", required: true, secret: true }],
        additionalOutputs: [{ output: "session_token", credential: "session" }],
      },
      tokenGrant: {
        grantType: 1,
        tokenEndpoint: "https://auth.example/token",
        scopes: [],
        audienceOverrides: [
          { audience: "registry", host: "registry.example", port: 443 },
        ],
        subjectToken: { source: "credential", credential: "access" },
      },
    });
  });
  it("should select explicit token exchange grants while preserving null optional metadata", () => {
    expect(
      credential(
        {
          name: "token",
          // biome-ignore lint/plugin/biome-rules/use-undefined: Native credential YAML permits explicit null refresh metadata as an unset protobuf option.
          refresh: null,
          ["token_grant"]: {
            ["grant_type"]: "TOKEN-EXCHANGE",
            ["token_endpoint"]: "https://auth.example/token",
            ["cache_ttl_seconds"]: 30n,
            // biome-ignore lint/plugin/biome-rules/use-undefined: Native token-grant YAML permits an explicit null subject-token option.
            ["subject_token"]: null,
          },
        },
        "credential",
      ),
    ).toMatchObject({
      name: "token",
      // biome-ignore lint/plugin/biome-rules/use-undefined: The protobuf JSON mapping must retain native null refresh metadata until SDK decoding.
      refresh: null,
      // biome-ignore lint/plugin/biome-rules/use-undefined: The protobuf JSON mapping must retain the explicit null subject-token option.
      tokenGrant: { grantType: 2, cacheTtlSeconds: "30", subjectToken: null },
    });
  });
  it.each(INVALID_CREDENTIALS)("should reject when %s", (_case, input) => {
    expect(() => credential(input, "credential")).toThrow("Invalid OpenShell");
  });
});
