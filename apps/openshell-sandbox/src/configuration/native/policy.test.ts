import { describe, expect, test as it } from "bun:test";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { SandboxPolicySchema } from "@nvidia/openshell-sdk/raw";
import { decodeNativePolicy } from "./policy.ts";

const EXAMPLE_PORT = 443;
const MIDDLEWARE_CHOICE = 2.5;
const BEYOND_MAX_JSON_DEPTH = 65;
const SMALL_MCP_BODY_LIMIT = 4096;
const LARGE_MCP_BODY_LIMIT = 8192;
interface McpProjection {
  readonly present: boolean;
  readonly strictToolNames?: boolean;
  readonly allowAllKnownMcpMethods?: boolean;
  readonly bodyLimit: number;
}

const MCP_PROJECTIONS: readonly [string, string, McpProjection][] = [
  ["MCP options are omitted", "", { present: false, bodyLimit: 0 }],
  ["MCP options are empty", "mcp: {}", { present: false, bodyLimit: 0 }],
  [
    "strict-tool flag is null",
    "mcp: {strict_tool_names: null}",
    { present: false, bodyLimit: 0 },
  ],
  [
    "known-method flag is null",
    "mcp: {allow_all_known_mcp_methods: null}",
    { present: false, bodyLimit: 0 },
  ],
  [
    "both flags are null with a body limit",
    `mcp: {strict_tool_names: null, allow_all_known_mcp_methods: null, max_body_bytes: ${SMALL_MCP_BODY_LIMIT}}`,
    { present: false, bodyLimit: SMALL_MCP_BODY_LIMIT },
  ],
  [
    "strict-tool flag is false and known-method flag is null",
    "mcp: {strict_tool_names: false, allow_all_known_mcp_methods: null}",
    { present: true, strictToolNames: false, bodyLimit: 0 },
  ],
  [
    "known-method flag is false and strict-tool flag is null",
    "mcp: {strict_tool_names: null, allow_all_known_mcp_methods: false}",
    { present: true, allowAllKnownMcpMethods: false, bodyLimit: 0 },
  ],
  [
    "strict-tool flag is true with a body limit",
    `mcp: {strict_tool_names: true, max_body_bytes: ${LARGE_MCP_BODY_LIMIT}}`,
    { present: true, strictToolNames: true, bodyLimit: LARGE_MCP_BODY_LIMIT },
  ],
];

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Groups all decodeNativePolicy cases for one operation.
describe("decodeNativePolicy", () => {
  it("should preserve explicit filesystem, process, landlock and network restrictions when supplied", async () => {
    const policy = await decodeNativePolicy(
      `version: 1
filesystem_policy: {include_workdir: false, read_only: [/usr], read_write: []}
process: {run_as_user: sandbox, run_as_group: sandbox}
landlock: {compatibility: hard_requirement}
network_policies:
  outbound:
    endpoints: [{host: api.example, port: 443, protocol: https}]
    binaries: [{path: /usr/bin/curl, harness: true}]
`,
      "/policy.yaml",
    );
    expect(policy.filesystem).toMatchObject({
      includeWorkdir: false,
      readOnly: ["/usr"],
      readWrite: [],
    });
    expect(policy.process).toMatchObject({
      runAsUser: "sandbox",
      runAsGroup: "sandbox",
    });
    expect(policy.landlock).toMatchObject({
      compatibility: "hard_requirement",
    });
    expect(policy.networkPolicies["outbound"]).toMatchObject({
      name: "outbound",
      endpoints: [{ host: "api.example", ports: [EXAMPLE_PORT] }],
      binaries: [{ path: "/usr/bin/curl" }],
    });
  });
  it("should preserve middleware selectors and JSON configuration when a named middleware is supplied", async () => {
    const policy = await decodeNativePolicy(
      `version: 1
network_middlewares:
  audit:
    middleware: audit
    order: -1
    on_error: deny
    endpoints: {include: [api.example], exclude: [private.example]}
    config: {nested: {enabled: true, count: 3}, choices: [null, false, 2.5]}
`,
      "/policy.yaml",
    );
    expect(policy.networkMiddlewares["audit"]).toMatchObject({
      name: "audit",
      middleware: "audit",
      order: -1,
      onError: "deny",
      endpoints: { include: ["api.example"], exclude: ["private.example"] },
      config: {
        nested: { enabled: true, count: 3 },
        // biome-ignore lint/plugin/biome-rules/use-undefined: Middleware configuration is arbitrary JSON and must preserve null array leaves.
        choices: [null, false, MIDDLEWARE_CHOICE],
      },
    });
  });
  it("should preserve explicit names and supply empty middleware configuration when omitted", async () => {
    const policy = await decodeNativePolicy(
      "version: 1\nnetwork_policies: {external: {name: public}}\nnetwork_middlewares: {audit: {name: recorder, middleware: audit}}",
      "/policy.yaml",
    );
    expect(policy.networkPolicies["external"]).toMatchObject({
      name: "public",
    });
    expect(policy.networkMiddlewares["audit"]).toMatchObject({
      name: "recorder",
      config: {},
    });
  });
  it.each([
    ["policy version is absent", "filesystem_policy: {}"],
    ["policy version exceeds uint32", "version: 4294967296"],
    ["a policy field is unknown", "version: 1\nallow_everything: true"],
    [
      "network policy entry is not an object",
      "version: 1\nnetwork_policies: {outbound: []}",
    ],
    ["network policy is not a map", "version: 1\nnetwork_policies: []"],
    [
      "middleware name is missing",
      "version: 1\nnetwork_middlewares: {audit: {order: 0}}",
    ],
    [
      "middleware order is out of signed range",
      "version: 1\nnetwork_middlewares: {audit: {middleware: audit, order: 2147483648}}",
    ],
    [
      "middleware config is not a mapping",
      "version: 1\nnetwork_middlewares: {audit: {middleware: audit, config: []}}",
    ],
    [
      "middleware config integer loses precision",
      "version: 1\nnetwork_middlewares: {audit: {middleware: audit, config: {secret: 9007199254740992}}}",
    ],
    [
      "middleware config is nested too deeply",
      `version: 1\nnetwork_middlewares: {audit: {middleware: audit, config: ${"{a: ".repeat(BEYOND_MAX_JSON_DEPTH)}true${"}".repeat(BEYOND_MAX_JSON_DEPTH)}}}`,
    ],
    [
      "middleware endpoint selectors are malformed",
      "version: 1\nnetwork_middlewares: {audit: {middleware: audit, endpoints: {include: [4]}}}",
    ],
    ["policy YAML is malformed", "version: [secret"],
  ])(
    "should reject when %s without leaking document content",
    async (_case, source) => {
      let failure: unknown;
      try {
        await decodeNativePolicy(source, "/policy.yaml");
        throw new Error("invalid policy accepted");
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "configuration-invalid" });
      expect(String(failure)).toContain("/policy.yaml");
      expect(String(failure)).not.toContain("secret");
    },
  );
  it("should preserve null boolean string and numeric middleware leaves when nested JSON is representable", async () => {
    const result = await decodeNativePolicy(
      "version: 1\nnetwork_middlewares: {audit: {middleware: audit, endpoints: null, config: {nothing: null, enabled: false, label: text, count: -2, ratio: 1.5, entries: [null, true]}}}",
      "/policy.yaml",
    );
    const audit = Object.values(result.networkMiddlewares).find(
      (middleware) => middleware.name === "audit",
    );
    if (!audit) {
      throw new Error("Expected the decoded audit middleware.");
    }
    expect(audit.config).toEqual(
      JSON.parse(
        '{"nothing":null,"enabled":false,"label":"text","count":-2,"ratio":1.5,"entries":[null,true]}',
      ),
    );
    expect(audit.endpoints).toBeUndefined();
  });
  it.each([".inf", "-.inf", ".nan"])(
    "should reject unrepresentable middleware numbers when the value is %s",
    async (value) => {
      await expect(
        decodeNativePolicy(
          `version: 1\nnetwork_middlewares: {audit: {middleware: audit, config: {value: ${value}}}}`,
          "/policy.yaml",
        ),
      ).rejects.toMatchObject({ code: "configuration-invalid" });
    },
  );
  it("should preserve absent policy sections when only a version is supplied", async () => {
    const result = await decodeNativePolicy("version: 1", "/policy.yaml");
    expect(result.filesystem).toBeUndefined();
    expect(result.process).toBeUndefined();
    expect(result.landlock).toBeUndefined();
    expect(result.networkPolicies).toEqual({});
    expect(result.networkMiddlewares).toEqual({});
  });
  it.each([
    [
      "network policy names",
      "network_policies: {'__proto__': {endpoints: []}}",
    ],
    [
      "network middleware names",
      "network_middlewares: {'__proto__': {middleware: audit}}",
    ],
    [
      "nested REST query restrictions",
      "network_policies: {outbound: {endpoints: [{host: example.com, port: 443, protocol: rest, enforcement: enforce, rules: [{allow: {method: GET, path: /resource, query: {'__proto__': secret}}}]}], binaries: [{path: /usr/bin/curl}]}}",
    ],
    [
      "MCP parameter restrictions",
      "network_policies: {outbound: {endpoints: [{host: example.com, rules: [{allow: {params: {'__proto__': secret}}}]}]}}",
    ],
    [
      "nested MCP parameter restrictions",
      "network_policies: {outbound: {endpoints: [{host: example.com, rules: [{allow: {params: {request: {'__proto__': secret}}}}]}]}}",
    ],
    [
      "middleware Struct fields",
      "network_middlewares: {audit: {middleware: audit, config: {'__proto__': secret}}}",
    ],
    [
      "middleware Struct fields nested in arrays",
      "network_middlewares: {audit: {middleware: audit, config: {entries: [{nested: {'__proto__': secret}}]}}}",
    ],
  ])(
    "should reject without leaking document content when %s contain unsupported keys",
    async (_case, document) => {
      let failure: unknown;
      try {
        await decodeNativePolicy(`version: 1\n${document}`, "/policy.yaml");
        throw new Error("unrepresentable policy accepted");
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "configuration-invalid" });
      expect(String(failure)).toContain("/policy.yaml");
      expect(String(failure)).not.toContain("__proto__");
      expect(String(failure)).not.toContain("secret");
    },
  );
  it("should retain neighboring map keys and Struct nulls through the SDK wire format when representable", async () => {
    const policy = await decodeNativePolicy(
      `version: 1
network_policies:
  constructor:
    endpoints:
      - host: example.com
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow:
              method: GET
              path: /resource
              query: {constructor: allowed, prototype: allowed, toString: allowed, __proto: allowed, __proto___: allowed}
    binaries: [{path: /usr/bin/curl}]
network_middlewares:
  prototype:
    middleware: audit
    endpoints: null
    config: {entries: [{constructor: allowed, prototype: allowed, toString: allowed, __proto: allowed, __proto___: allowed, nothing: null}]}
`,
      "/policy.yaml",
    );
    const roundtripped = fromBinary(
      SandboxPolicySchema,
      toBinary(SandboxPolicySchema, policy),
    );
    const query =
      roundtripped.networkPolicies["constructor"]?.endpoints[0]?.rules[0]?.allow
        ?.query;
    expect(new Set(Object.keys(query ?? {}))).toEqual(
      new Set([
        "constructor",
        "prototype",
        "toString",
        "__proto",
        "__proto___",
      ]),
    );
    for (const key of Object.keys(query ?? {})) {
      expect(query?.[key]?.glob).toBe("allowed");
    }
    expect(roundtripped.networkMiddlewares["prototype"]?.config).toEqual(
      JSON.parse(
        '{"entries":[{"constructor":"allowed","prototype":"allowed","toString":"allowed","__proto":"allowed","__proto___":"allowed","nothing":null}]}',
      ),
    );
    expect(
      roundtripped.networkMiddlewares["prototype"]?.endpoints,
    ).toBeUndefined();
  });
  it.each(MCP_PROJECTIONS)(
    "should preserve native MCP presence and body limits through the wire when %s",
    async (_condition, options, expected) => {
      const policy = await decodeNativePolicy(
        `version: 1
network_policies:
  api:
    endpoints:
      - host: api.example.com
        port: 443
        protocol: rest
        enforcement: enforce
        access: read-only
        ${options}
    binaries: [{path: /usr/bin/curl}]
`,
        "/policy.yaml",
      );
      const wirePolicy = fromBinary(
        SandboxPolicySchema,
        toBinary(SandboxPolicySchema, policy),
      );
      for (const decoded of [policy, wirePolicy]) {
        const endpoint = decoded.networkPolicies["api"]?.endpoints[0];
        expect(endpoint).toBeDefined();
        expect(endpoint?.mcp !== undefined).toBe(expected.present);
        expect(endpoint?.mcp?.strictToolNames).toBe(expected.strictToolNames);
        expect(endpoint?.mcp?.allowAllKnownMcpMethods).toBe(
          expected.allowAllKnownMcpMethods,
        );
        expect(endpoint?.jsonRpcMaxBodyBytes).toBe(expected.bodyLimit);
      }
    },
  );
});
