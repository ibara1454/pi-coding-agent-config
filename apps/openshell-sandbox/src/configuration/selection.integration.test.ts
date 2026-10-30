import { describe, expect, test as it } from "bun:test";
import { loadSandboxEnvironment } from "./selection.ts";

const CONTEXT = { agentDir: "/agent", cwd: "/project", projectTrusted: false };
const EXPECTED_MCP_PORT = 443;
const EXPECTED_MCP_BODY_BYTES = 8192;
const MAX_RESOURCE_VERSION = 18_446_744_073_709_551_615n;

const MCP_POLICY = `version: 1
network_policies:
  tool_server:
    endpoints:
      - host: tools.example
        port: 443
        protocol: mcp
        mcp:
          max_body_bytes: 8192
          strict_tool_names: false
          allow_all_known_mcp_methods: false
        rules:
          - allow:
              method: tools/call
              tool: {any: [search, lookup]}
              params:
                request:
                  name: "public-*"
        deny_rules:
          - method: tools/call
            tool: "delete*"
`;

const REFRESH_PROFILE = `id: work
display_name: Work
resource_version: 18446744073709551615
credentials:
  - name: access
    env_vars: [WORK_TOKEN]
    required: true
    auth_style: bearer
    refresh:
      strategy: oauth2-refresh-token
      token_url: https://auth.example/token
      refresh_before_seconds: 60
      material:
        - name: refresh_token
          required: true
          secret: true
      additional_outputs:
        - output: session_token
          credential: session
    token_grant:
      token_endpoint: https://auth.example/grant
      scopes: []
discovery:
  credentials: [access]
endpoints:
  - host: packages.example
    port: 443
    protocol: rest
    access: read-only
binaries: [/usr/local/bin/node]
`;

/** Exercise native conversion through the owning environment interface using only in-memory reads.
 * @example environment("version: 1") returns a policy snapshot without filesystem grants.
 */
async function environment(policy: string, profile?: string) {
  const documents: Record<string, string> = {
    "/agent/settings.json": JSON.stringify({
      openShellSandbox: {
        policyPath: "policy.yaml",
        profilePaths: profile === undefined ? [] : ["profile.yaml"],
      },
    }),
    "/agent/policy.yaml": policy,
    ...(profile === undefined ? {} : { "/agent/profile.yaml": profile }),
  };
  return await loadSandboxEnvironment(CONTEXT, {
    readFile(path) {
      const source = documents[path];
      if (source === undefined) {
        return Promise.reject(new Error("unexpected read"));
      }
      return Promise.resolve(source);
    },
  });
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Groups all loadSandboxEnvironment cases for one operation.
describe("loadSandboxEnvironment", () => {
  it("should preserve absent sections and explicit empty filesystem grants without granting the project", async () => {
    const absent = await environment("version: 1");
    const empty = await environment(
      "version: 1\nfilesystem_policy:\n  include_workdir: false\n  read_only: []\n  read_write: []",
    );
    expect(absent.policy.sdkPolicy.filesystem).toBeUndefined();
    expect(empty.policy.sdkPolicy.filesystem).toMatchObject({
      includeWorkdir: false,
      readOnly: [],
      readWrite: [],
    });
    expect(empty.policy.sdkPolicy.networkPolicies).toEqual({});
  });
  it("should retain nested MCP restrictions and explicit false options in SDK policy", async () => {
    const result = await environment(MCP_POLICY);
    const endpoint =
      result.policy.sdkPolicy.networkPolicies["tool_server"]?.endpoints[0];
    expect(endpoint?.ports).toEqual([EXPECTED_MCP_PORT]);
    expect(endpoint?.jsonRpcMaxBodyBytes).toBe(EXPECTED_MCP_BODY_BYTES);
    expect(endpoint?.mcp).toMatchObject({
      strictToolNames: false,
      allowAllKnownMcpMethods: false,
    });
    expect(endpoint?.rules[0]?.allow?.params).toMatchObject({
      name: { any: ["search", "lookup"] },
      "request.name": { glob: "public-*" },
    });
    expect(endpoint?.denyRules[0]?.params["name"]?.glob).toBe("delete*");
  });
  it("should preserve credential references, exact versions, and native profile defaults without selecting renewal", async () => {
    const result = await environment("version: 1", REFRESH_PROFILE);
    const profile = result.profiles[0]?.sdkProfiles[0];
    expect(profile?.resourceVersion).toBe(MAX_RESOURCE_VERSION);
    expect(profile?.category).toBe(1);
    expect(profile?.credentials[0]?.refresh).toMatchObject({
      strategy: 3,
      refreshBeforeSeconds: 60n,
      material: [{ name: "refresh_token", required: true, secret: true }],
      additionalOutputs: [{ output: "session_token", credential: "session" }],
    });
    expect(profile?.credentials[0]?.tokenGrant?.grantType).toBe(1);
    expect(profile?.discovery?.credentials).toEqual(["access"]);
    expect(result.providers).toEqual([]);
  });
  it.each([
    ["duplicate keys", "version: 1\nversion: 2"],
    ["unknown construction tags", "version: !!js/function 'payload'"],
    ["multiple documents", "version: 1\n---\nversion: 2"],
    [
      "unsupported policy include directive",
      "version: 1\ninclude: ./untrusted.yaml",
    ],
    ["unknown security fields", "version: 1\nallow_everything: true"],
    ["numeric process identity", "version: 1\nprocess: {run_as_user: 1000}"],
    [
      "invalid boolean type",
      "version: 1\nfilesystem_policy: {include_workdir: 'false'}",
    ],
    [
      "invalid port range",
      "version: 1\nnetwork_policies: {test: {endpoints: [{port: 65536}]}}",
    ],
    [
      "conflicting port selectors",
      "version: 1\nnetwork_policies: {test: {endpoints: [{port: 443, ports: [80]}]}}",
    ],
    [
      "internal provenance fields",
      "version: 1\nnetwork_policies: {test: {endpoints: [{provider_credentialed: true}]}}",
    ],
    [
      "unknown nested restrictions",
      "version: 1\nnetwork_policies: {test: {endpoints: [{rules: [{allow: {query: {x: {except: secret}}}}]}]}}",
    ],
    [
      "colliding flattened restrictions",
      "version: 1\nnetwork_policies: {test: {endpoints: [{rules: [{allow: {params: {'a.b': first, a: {b: second}}}}]}]}}",
    ],
  ])(
    "should reject policy conversion when YAML contains %s",
    async (_label, source) => {
      await expect(environment(source)).rejects.toMatchObject({
        code: "configuration-invalid",
      });
    },
  );
  it.each([
    ["misplaced refresh", "refresh: {strategy: static}"],
    [
      "unknown refresh strategy",
      "credentials: [{name: token, refresh: {strategy: magic}}]",
    ],
    [
      "unknown refresh material fields",
      "credentials: [{name: token, refresh: {material: [{name: token, value: secret}]}}]",
    ],
    ["unknown category", "category: unrestricted"],
    ["unsupported profile include directive", "include: ./untrusted.yaml"],
    [
      "empty explicit allow rules",
      "endpoints: [{host: example.com, port: 443, rules: []}]",
    ],
    [
      "empty explicit deny rules",
      "endpoints: [{host: example.com, port: 443, deny_rules: []}]",
    ],
    [
      "conflicting query matchers",
      "endpoints: [{host: example.com, rules: [{allow: {query: {q: {glob: one, any: [two]}}}}]}]",
    ],
    [
      "policy-only credential binding",
      "endpoints: [{host: example.com, credential_binding: {provider: work}}]",
    ],
  ])(
    "should reject profile conversion when YAML contains %s",
    async (_label, source) => {
      await expect(
        environment("version: 1", `id: work\ndisplay_name: Work\n${source}`),
      ).rejects.toMatchObject({ code: "configuration-invalid" });
    },
  );
});
