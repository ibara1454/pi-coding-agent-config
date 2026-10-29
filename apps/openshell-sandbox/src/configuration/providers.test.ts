import { describe, expect, test as it } from "bun:test";
import {
  normalizeProviders,
  type ProviderDeclaration,
  parseProviders,
} from "./providers.ts";
import type { ProviderConfiguration } from "./selection.ts";
import { SandboxConfigurationError } from "./validation/index.ts";

const declaration: ProviderDeclaration = {
  name: "work",
  profile: "github",
  credentialsFromEnv: { ["GITHUB_TOKEN"]: "WORK_TOKEN" },
};

const malformedProviders: [string, unknown][] = [
  ["a malformed provider array", {}],
  // biome-ignore lint/plugin/biome-rules/use-undefined: Settings JSON may contain a null provider declaration; validation must reject it.
  ["a non-object declaration", [null]],
  ["an unknown declaration field", [{ ...declaration, refresh: true }]],
  ["an invalid provider name", [{ ...declaration, name: "../escape" }]],
  ["an invalid profile name", [{ ...declaration, profile: "bad profile" }]],
  [
    "an unknown credential mode",
    [{ ...declaration, credentialMode: "implicit" }],
  ],
  [
    "a malformed credential mapping",
    [{ ...declaration, credentialsFromEnv: [] }],
  ],
  [
    "an invalid credential key",
    [{ ...declaration, credentialsFromEnv: { ["BAD-KEY"]: "WORK_TOKEN" } }],
  ],
  [
    "an invalid credential source",
    [
      {
        ...declaration,
        credentialsFromEnv: { ["GITHUB_TOKEN"]: "BAD-SOURCE" },
      },
    ],
  ],
  [
    "an obsolete client setting",
    [{ ...declaration, client: { type: "git", host: "github.com" } }],
  ],
];

describe("parseProviders", () => {
  it.each(malformedProviders)(
    "should reject %s before native or credential access",
    (_condition, value) => {
      expect(() => parseProviders(value)).toThrow(SandboxConfigurationError);
    },
  );
});

describe("normalizeProviders", () => {
  it("should default a mapped declaration to explicit mode without mutating it", () => {
    const [result] = normalizeProviders([declaration]);
    const expected: ProviderConfiguration = {
      name: "work",
      profile: "github",
      credentialMode: "explicit",
      credentialsFromEnv: { ["GITHUB_TOKEN"]: "WORK_TOKEN" },
    };
    expect(result).toEqual(expected);
    expect(declaration.credentialMode).toBeUndefined();
  });

  it("should preserve an explicit empty override when no providers are selected", () => {
    expect(normalizeProviders([])).toEqual([]);
  });

  it("should prioritize unsupported renewal over another provider's missing credentials", () => {
    let failure: unknown;
    try {
      normalizeProviders([
        { name: "missing", profile: "github" },
        { ...declaration, name: "renew", credentialMode: "native-refresh" },
      ]);
      throw new Error("Expected unsupported mode");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "credential-mode-unsupported" });
  });
  it.each([
    ["missing credentials", [{ name: "missing", profile: "github" }]],
    ["an empty explicit mapping", [{ ...declaration, credentialsFromEnv: {} }]],
    ["duplicate provider names", [declaration, { ...declaration }]],
  ])(
    "should reject %s in the effective provider selection",
    (_condition, entries) => {
      expect(() => normalizeProviders(entries)).toThrow(
        SandboxConfigurationError,
      );
    },
  );
});
