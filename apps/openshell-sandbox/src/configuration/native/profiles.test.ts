import { describe, expect, test as it } from "bun:test";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { ProviderProfileSchema } from "@nvidia/openshell-sdk/raw";
import { decodeNativeProfiles } from "./profiles.ts";

const INVALID_PROFILES = [
  ["id is missing", "display_name: Work"],
  ["display name is missing", "id: work"],
  ["id is empty after decoding", "id: ''\ndisplay_name: Work"],
  [
    "ids repeat within a list",
    "- {id: work, display_name: Work}\n- {id: work, display_name: Another}",
  ],
  [
    "category is unrecognized",
    "id: work\ndisplay_name: Work\ncategory: unrestricted",
  ],
  [
    "a resource version is negative",
    "id: work\ndisplay_name: Work\nresource_version: -1",
  ],
  [
    "a resource version exceeds uint64",
    "id: work\ndisplay_name: Work\nresource_version: 18446744073709551616",
  ],
  [
    "annotations contain non-strings",
    "id: work\ndisplay_name: Work\nannotations: {owner: 1}",
  ],
  [
    "a credential contains unsupported refresh fields",
    "id: work\ndisplay_name: Work\ncredentials: [{name: token, refresh: {value: secret}}]",
  ],
  [
    "an endpoint has no host",
    "id: work\ndisplay_name: Work\nendpoints: [{port: 443}]",
  ],
  ["a binary lacks its path", "id: work\ndisplay_name: Work\nbinaries: [{}]"],
  [
    "a discovery reference is not a string",
    "id: work\ndisplay_name: Work\ndiscovery: {credentials: [1]}",
  ],
  ["a list member is malformed", "- {id: work, display_name: Work}\n- secret"],
];

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Groups all decodeNativeProfiles cases for one operation.
describe("decodeNativeProfiles", () => {
  it("should convert a single profile with exact version, references and explicit restrictions", async () => {
    const [profile] = await decodeNativeProfiles(
      `id: work
display_name: Work
resource_version: 18446744073709551615
category: source-control
annotations: {owner: team}
inference_capable: false
source: managed
scope: organization
credentials:
  - name: access
    env_vars: [WORK_TOKEN]
    refresh: {strategy: static}
discovery: {credentials: [access]}
endpoints:
  - host: packages.example
    port: 443
    access: read-only
    rules: [{allow: {path: /packages}}]
binaries: [/usr/local/bin/node]
`,
      "/profile.yaml",
    );
    expect(profile).toMatchObject({
      id: "work",
      displayName: "Work",
      category: 4,
      resourceVersion: 18_446_744_073_709_551_615n,
      annotations: { owner: "team" },
      inferenceCapable: false,
      source: "managed",
      scope: "organization",
      credentials: [
        { name: "access", envVars: ["WORK_TOKEN"], refresh: { strategy: 1 } },
      ],
      discovery: { credentials: ["access"] },
      endpoints: [
        {
          host: "packages.example",
          port: 443,
          rules: [{ allow: { path: "/packages" } }],
        },
      ],
      binaries: [{ path: "/usr/local/bin/node" }],
    });
  });
  it("should preserve each profile in a list and normalize empty discovery instead of inventing references", async () => {
    const profiles = await decodeNativeProfiles(
      "- {id: first, display_name: First, discovery: {credentials: []}}\n- {id: second, display_name: Second, discovery: {}}",
      "/profiles.yaml",
    );
    expect(
      profiles.map(({ id, category, discovery }) => ({
        id,
        category,
        discovery,
      })),
    ).toEqual([
      { id: "first", category: 1, discovery: undefined },
      { id: "second", category: 1, discovery: undefined },
    ]);
    expect(await decodeNativeProfiles("[]", "/profiles.yaml")).toEqual([]);
  });
  it.each(INVALID_PROFILES)(
    "should reject when %s without leaking credential values",
    async (_case, source) => {
      let failure: unknown;
      try {
        await decodeNativeProfiles(source, "/profiles.yaml");
        throw new Error("invalid profile accepted");
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "configuration-invalid" });
      expect(String(failure)).toContain("/profiles.yaml");
      expect(String(failure)).not.toContain("secret");
    },
  );
  it.each([
    ["annotations", "annotations: {'__proto__': secret}"],
    [
      "REST query restrictions",
      "endpoints: [{host: example.com, rules: [{allow: {method: GET, path: /resource, query: {'__proto__': secret}}}]}]",
    ],
    [
      "MCP parameter restrictions",
      "endpoints: [{host: example.com, rules: [{allow: {params: {'__proto__': secret}}}]}]",
    ],
    [
      "persisted GraphQL queries",
      "endpoints: [{host: example.com, graphql_persisted_queries: {'__proto__': {fields: [secret]}}}]",
    ],
  ])(
    "should reject without leaking document content when %s contain unsupported keys",
    async (_case, document) => {
      let failure: unknown;
      try {
        await decodeNativeProfiles(
          `id: work\ndisplay_name: Work\n${document}`,
          "/profile.yaml",
        );
        throw new Error("unrepresentable profile accepted");
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "configuration-invalid" });
      expect(String(failure)).toContain("/profile.yaml");
      expect(String(failure)).not.toContain("__proto__");
      expect(String(failure)).not.toContain("secret");
    },
  );
  it("should retain neighboring profile map keys and null options through the SDK wire format when representable", async () => {
    const [profile] = await decodeNativeProfiles(
      `id: work
display_name: Work
annotations: {constructor: allowed, prototype: allowed, toString: allowed, __proto: allowed, __proto___: allowed}
endpoints:
  - host: example.com
    rules:
      - allow:
          method: GET
          path: /resource
          query: {constructor: allowed, prototype: allowed, toString: allowed, __proto: allowed, __proto___: allowed}
          params: {constructor: allowed, prototype: allowed, toString: allowed, __proto: allowed, __proto___: allowed}
    deny_rules: null
    mcp: {strict_tool_names: null}
`,
      "/profile.yaml",
    );
    if (!profile) {
      throw new Error("Expected the decoded work profile.");
    }
    const roundtripped = fromBinary(
      ProviderProfileSchema,
      toBinary(ProviderProfileSchema, profile),
    );
    const allow = roundtripped.endpoints[0]?.rules[0]?.allow;
    const keys = [
      "constructor",
      "prototype",
      "toString",
      "__proto",
      "__proto___",
    ];
    expect(new Set(Object.keys(roundtripped.annotations))).toEqual(
      new Set(keys),
    );
    for (const map of [allow?.query, allow?.params]) {
      expect(new Set(Object.keys(map ?? {}))).toEqual(new Set(keys));
      for (const key of keys) {
        expect(map?.[key]?.glob).toBe("allowed");
      }
    }
    expect(roundtripped.endpoints[0]?.denyRules).toEqual([]);
    expect(roundtripped.endpoints[0]?.mcp?.strictToolNames).toBeUndefined();
  });
});
