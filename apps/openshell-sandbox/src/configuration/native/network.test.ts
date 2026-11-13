import { describe, expect, test as it } from "bun:test";
import { NetworkAccessPreset } from "@nvidia/openshell-sdk/raw";
import { binary, endpoint } from "./network.ts";

const HTTP_PORT = 80n;
const TLS_PORT = 443n;
const TLS_PORT_NUMBER = Number(TLS_PORT);

const INVALID_ENDPOINTS = [
  [
    "singular and plural policy ports conflict",
    false,
    { port: TLS_PORT, ports: [HTTP_PORT] },
  ],
  [
    "policy MCP and legacy JSON RPC options conflict",
    false,
    { protocol: "mcp", mcp: {}, ["json_rpc"]: {} },
  ],
  [
    "a policy credential binding is missing its provider",
    false,
    { ["credential_binding"]: {} },
  ],
  [
    "policy-only JSON RPC is present in a profile",
    true,
    { host: "x", ["json_rpc"]: {} },
  ],
  [
    "profile-only body limits are present in a policy",
    false,
    { ["json_rpc_max_body_bytes"]: 100n },
  ],
  ["a profile endpoint has no host", true, { port: 443n }],
  ["profile allow rules are explicitly empty", true, { host: "x", rules: [] }],
  [
    "profile deny rules are explicitly empty",
    true,
    { host: "x", ["deny_rules"]: [] },
  ],
  [
    "a profile MCP body limit is policy-only",
    true,
    { host: "x", mcp: { ["max_body_bytes"]: 100n } },
  ],
  [
    "a policy endpoint contains provenance metadata",
    false,
    { ["provider_credentialed"]: true },
  ],
  ["policy MCP options occur without MCP protocol", false, { mcp: {} }],
  [
    "policy MCP options occur on REST traffic",
    false,
    { protocol: "rest", mcp: {} },
  ],
  [
    "policy MCP options are null",
    false,
    JSON.parse('{"protocol":"mcp","mcp":null}'),
  ],
  ["profile MCP options are null", true, JSON.parse('{"host":"x","mcp":null}')],
  ["legacy JSON RPC options are null", false, JSON.parse('{"json_rpc":null}')],
  [
    "credential binding is null",
    false,
    JSON.parse('{"credential_binding":null}'),
  ],
  [
    "a policy MCP flag is null",
    false,
    JSON.parse('{"protocol":"mcp","mcp":{"strict_tool_names":null}}'),
  ],
  ["a TLS mode was removed", false, { tls: "terminate" }],
  [
    "a TLS mode was removed in a profile",
    true,
    { host: "x", tls: "passthrough" },
  ],
  ["an enforcement mode is not exact", false, { enforcement: "ENFORCE" }],
  ["an access mode is not exact", true, { host: "x", access: "read_only" }],
  ["an endpoint port is out of range", false, { port: 65536n }],
] as const;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Groups all endpoint cases for one operation.
describe("endpoint", () => {
  it("should lower policy port and MCP limits while retaining explicit false restrictions", () => {
    expect(
      endpoint(false)(
        {
          host: "tools.example",
          port: 443n,
          protocol: "mcp",
          mcp: { ["max_body_bytes"]: 8192n, ["strict_tool_names"]: false },
          rules: [{ allow: { method: "tools/call", tool: "search" } }],
        },
        "endpoint",
      ),
    ).toMatchObject({
      host: "tools.example",
      port: 443,
      ports: [Number(TLS_PORT)],
      jsonRpcMaxBodyBytes: 8192,
      mcp: { versions: ["2025-11-25"], strictToolNames: false },
      rules: [{ allow: { params: { name: { glob: "search" } } } }],
    });
  });
  it("should preserve plural policy ports and legacy JSON RPC limits without inventing MCP rules", () => {
    expect(
      endpoint(false)(
        {
          ports: [HTTP_PORT, TLS_PORT],
          ["json_rpc"]: { ["max_body_bytes"]: 4096n },
        },
        "endpoint",
      ),
    ).toMatchObject({
      ports: [Number(HTTP_PORT), Number(TLS_PORT)],
      port: Number(HTTP_PORT),
      jsonRpcMaxBodyBytes: 4096,
    });
    expect(endpoint(false)({}, "endpoint")).toMatchObject({
      ports: [],
      port: 0,
      jsonRpcMaxBodyBytes: 0,
    });
  });
  it("should retain profile port shape, explicit empty restrictions, and profile-only JSON RPC limits", () => {
    expect(
      endpoint(true)(
        {
          host: "api.example",
          port: 443n,
          rules: [{ allow: { path: "/v1" } }],
          ["json_rpc_max_body_bytes"]: 2048n,
          mcp: { ["strict_tool_names"]: false },
        },
        "endpoint",
      ),
    ).toMatchObject({
      host: "api.example",
      port: 443,
      jsonRpcMaxBodyBytes: 2048,
      rules: [{ allow: { path: "/v1" } }],
      mcp: { versions: ["2025-11-25"], strictToolNames: false },
    });
    expect(
      // biome-ignore lint/plugin/biome-rules/use-undefined: Native profile YAML permits null rules, distinct from the invalid explicit empty list.
      endpoint(true)({ host: "api.example", rules: null }, "endpoint"),
    ).toMatchObject({
      host: "api.example",
      // biome-ignore lint/plugin/biome-rules/use-undefined: Explicit native null rules must remain null in protobuf JSON before SDK decoding.
      rules: null,
    });
  });
  it("should retain policy credential binding without inventing MCP options", () => {
    expect(
      endpoint(false)(
        { ["credential_binding"]: { provider: "work" } },
        "endpoint",
      ),
    ).toMatchObject({ credentialBinding: { provider: "work" }, ports: [] });
  });
  it.each(INVALID_ENDPOINTS)(
    "should reject when %s",
    (_case, profile, input) => {
      expect(() => endpoint(profile)(input, "endpoint")).toThrow(
        "Invalid OpenShell",
      );
    },
  );

  it.each([
    ["absent ports", {}, { ports: [], port: 0, jsonRpcMaxBodyBytes: 0 }],
    [
      "zero singular port",
      { port: 0n },
      { ports: [], port: 0, jsonRpcMaxBodyBytes: 0 },
    ],
    [
      "empty plural alias",
      { port: TLS_PORT, ports: [] },
      {
        ports: [TLS_PORT_NUMBER],
        port: TLS_PORT_NUMBER,
        jsonRpcMaxBodyBytes: 0,
      },
    ],
    [
      "empty MCP options",
      { protocol: "mcp", mcp: {} },
      {
        protocol: "mcp",
        mcp: { versions: ["2025-11-25"] },
        ports: [],
        port: 0,
        jsonRpcMaxBodyBytes: 0,
      },
    ],
  ])(
    "should retain native alias defaults when a policy endpoint has %s",
    (_condition, input, expected) => {
      expect(endpoint(false)(input, "endpoint")).toEqual(expected);
    },
  );
  it.each([false, true])(
    "should materialize and sort exact MCP revisions when profile mode is %s",
    (profile) => {
      expect(
        endpoint(profile)(
          { host: "tools.example", protocol: "McP" },
          "endpoint",
        ),
      ).toMatchObject({ mcp: { versions: ["2025-11-25"] } });
      expect(
        endpoint(profile)(
          {
            host: "tools.example",
            protocol: "mcp",
            mcp: { versions: ["2025-11-25", "2025-03-26", "2025-06-18"] },
          },
          "endpoint",
        ),
      ).toMatchObject({
        mcp: { versions: ["2025-03-26", "2025-06-18", "2025-11-25"] },
      });
    },
  );
  it.each([
    ["empty", []],
    ["duplicate", ["2025-11-25", "2025-11-25"]],
    ["unsupported", ["latest"]],
    ["padded", [" 2025-11-25"]],
    ["null", JSON.parse("null")],
  ])(
    "should reject policy and profile MCP revisions when the allowlist is %s",
    (_condition, versions) => {
      for (const profile of [false, true]) {
        expect(() =>
          endpoint(profile)(
            { host: "tools.example", protocol: "mcp", mcp: { versions } },
            "endpoint",
          ),
        ).toThrow("Invalid OpenShell");
      }
    },
  );
  it.each([
    ["tls", "", 0],
    ["tls", "skip", 1],
    ["enforcement", "", 0],
    ["enforcement", "enforce", 1],
    ["enforcement", "audit", 2],
    ["access", "", 0],
    ["access", "read-only", 1],
    ["access", "read-write", 2],
    ["access", "full", NetworkAccessPreset.FULL],
  ] as const)(
    "should map policy and profile %s mode %s to SDK enum %s",
    (field, value, expected) => {
      for (const profile of [false, true]) {
        expect(
          endpoint(profile)(
            { host: "api.example", [field]: value },
            "endpoint",
          ),
        ).toMatchObject({ [field]: expected });
      }
    },
  );
});
describe("binary", () => {
  it("should retain profile string paths and policy or profile path objects", () => {
    expect(binary(true)("/usr/bin/git", "binary")).toEqual({
      path: "/usr/bin/git",
    });
    for (const profile of [false, true]) {
      expect(binary(profile)({ path: "/usr/bin/git" }, "binary")).toEqual({
        path: "/usr/bin/git",
      });
    }
  });
  it.each([
    ["policy binary is a string", false, "/usr/bin/git"],
    ["binary path is missing", true, { harness: true }],
    ["binary path is not a string", false, { path: 42 }],
    ["binary contains unknown metadata", true, { path: "git", secret: true }],
    [
      "removed policy harness metadata is supplied",
      false,
      { path: "git", harness: true },
    ],
    [
      "removed profile harness metadata is supplied",
      true,
      { path: "git", harness: false },
    ],
  ] as const)("should reject when %s", (_case, profile, input) => {
    expect(() => binary(profile)(input, "binary")).toThrow("Invalid OpenShell");
  });
});
