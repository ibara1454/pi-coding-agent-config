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
    "refresh metadata is outside a credential",
    "id: work\ndisplay_name: Work\nrefresh: {strategy: static}",
  ],
  [
    "a profile include is unsupported",
    "id: work\ndisplay_name: Work\ninclude: ./untrusted.yaml",
  ],
  [
    "a profile endpoint contains a policy-only credential binding",
    "id: work\ndisplay_name: Work\nendpoints: [{host: example.com, credential_binding: {provider: work}}]",
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
    "binary harness metadata was removed",
    "id: work\ndisplay_name: Work\nbinaries: [{path: /usr/bin/git, harness: false}]",
  ],
  [
    "MCP options are explicitly null",
    "id: work\ndisplay_name: Work\nendpoints: [{host: tools.example, protocol: mcp, mcp: null}]",
  ],
  [
    "a duration is malformed",
    "id: work\ndisplay_name: Work\ncredentials: [{name: token, refresh: {refresh_before: secret}}]",
  ],
  [
    "a duration contains trailing text",
    "id: work\ndisplay_name: Work\ncredentials: [{name: token, refresh: {refresh_before: 1secret}}]",
  ],
  [
    "a duration contains trailing whitespace",
    'id: work\ndisplay_name: Work\ncredentials: [{name: token, refresh: {refresh_before: "1s\\n"}}]',
  ],
  [
    "a duration loses nanosecond precision",
    "id: work\ndisplay_name: Work\ncredentials: [{name: token, token_grant: {token_endpoint: https://auth.example, cache_ttl: 0.1234567891s}}]",
  ],
  [
    "legacy duration seconds exceed the protobuf representation",
    "id: work\ndisplay_name: Work\ncredentials: [{name: token, refresh: {refresh_before_seconds: 9223372036854775807}}]",
  ],
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
  it("should retain canonical MCP versions and native mode enums through the SDK wire format", async () => {
    const [profile] = await decodeNativeProfiles(
      `id: work
display_name: Work
endpoints:
  - host: tools.example
    protocol: McP
    enforcement: enforce
    access: read-only
    mcp:
      versions: ["2025-11-25", "2025-03-26"]
      strict_tool_names: false
      allow_all_known_mcp_methods: null
  - host: defaults.example
    protocol: mcp
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
    expect(roundtripped.endpoints[0]).toMatchObject({
      enforcement: 1,
      access: 1,
      mcp: { versions: ["2025-03-26", "2025-11-25"], strictToolNames: false },
    });
    expect(
      roundtripped.endpoints[0]?.mcp?.allowAllKnownMcpMethods,
    ).toBeUndefined();
    expect(roundtripped.endpoints[1]?.mcp?.versions).toEqual(["2025-11-25"]);
  });
  it.each([
    ["compatibility seconds are omitted", "", undefined],
    ["compatibility seconds are zero", "refresh_before_seconds: 0", undefined],
    [
      "compatibility seconds are nonzero",
      "refresh_before_seconds: 60",
      { seconds: 60n, nanos: 0 },
    ],
    ["explicit WKT is zero", 'refresh_before: "0s"', { seconds: 0n, nanos: 0 }],
    [
      "explicit WKT has nanoseconds",
      'refresh_before: "1.000000001s"',
      { seconds: 1n, nanos: 1 },
    ],
    [
      "explicit WKT accompanies zero compatibility seconds",
      'refresh_before: "0.500s", refresh_before_seconds: 0',
      { seconds: 0n, nanos: 500_000_000 },
    ],
  ] as const)(
    "should preserve native duration presence and precision through the wire when %s",
    async (_condition, fields, expected) => {
      const [profile] = await decodeNativeProfiles(
        `id: work
display_name: Work
credentials:
  - name: token
    refresh: {max_lifetime: "1.250s", max_lifetime_seconds: 0, ${fields}}
    token_grant:
      token_endpoint: https://auth.example/token
      cache_ttl: "0.500s"
      cache_ttl_seconds: 0
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
      const duration = roundtripped.credentials[0]?.refresh?.refreshBefore;
      expect(duration?.seconds).toBe(expected?.seconds);
      expect(duration?.nanos).toBe(expected?.nanos);
      expect(roundtripped.credentials[0]?.refresh?.maxLifetime).toMatchObject({
        seconds: 1n,
        nanos: 250_000_000,
      });
      expect(roundtripped.credentials[0]?.tokenGrant?.cacheTtl).toMatchObject({
        seconds: 0n,
        nanos: 500_000_000,
      });
    },
  );
  it.each([
    [
      "refresh_before repeats a nonzero value",
      "refresh: {strategy: static, refresh_before: '60s', refresh_before_seconds: 60}",
    ],
    [
      "refresh_before differs from compatibility seconds",
      "refresh: {strategy: static, refresh_before: '3600s', refresh_before_seconds: 60}",
    ],
    [
      "max_lifetime repeats a nonzero value",
      "refresh: {strategy: static, max_lifetime: '60s', max_lifetime_seconds: 60}",
    ],
    [
      "max_lifetime differs from compatibility seconds",
      "refresh: {strategy: static, max_lifetime: '3600s', max_lifetime_seconds: 60}",
    ],
    [
      "cache_ttl repeats a nonzero value",
      "token_grant: {token_endpoint: 'https://auth.example/token', cache_ttl: '60s', cache_ttl_seconds: 60}",
    ],
    [
      "cache_ttl differs from compatibility seconds",
      "token_grant: {token_endpoint: 'https://auth.example/token', cache_ttl: '3600s', cache_ttl_seconds: 60}",
    ],
  ])(
    "should reject conflicting duration declarations when %s",
    async (_condition, metadata) => {
      await expect(
        decodeNativeProfiles(
          `id: work\ndisplay_name: Work\ncredentials:\n  - name: token\n    ${metadata}`,
          "/profile.yaml",
        ),
      ).rejects.toMatchObject({ code: "configuration-invalid" });
    },
  );
});
