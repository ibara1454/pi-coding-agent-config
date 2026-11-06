import { describe, expect, it, spyOn } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: Bun spies must intercept the live named filesystem import used by the package reader.
import * as fs from "node:fs";
import {
  mergeWithDefaultPackageJson,
  type PackageCollectionMode,
  type PackageJson,
  readPackageJson,
} from "./package-json.ts";

const PACKAGE_JSON_PATH = "/unit/package/package.json";

describe("readPackageJson", () => {
  it.each([
    ["the JSON is malformed", "{"],
    ["the package root is null", "null"],
    ["the package root is a scalar", "false"],
    ["the package root is an array", "[]"],
    ["pi is absent", '{"name":"tool"}'],
    ["pi is null", '{"pi":null}'],
    ["pi is a scalar", '{"pi":false}'],
    ["pi is an array", '{"pi":[]}'],
  ])("should return no Pi metadata when %s", (_condition, contents) => {
    spyOn(fs, "readFileSync").mockReturnValue(contents);
    expect(readPackageJson(PACKAGE_JSON_PATH)).toEqual({});
  });

  it("should return no Pi metadata when the file cannot be read", () => {
    spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("metadata unavailable");
    });
    expect(readPackageJson(PACKAGE_JSON_PATH)).toEqual({});
  });

  it("should retain an empty pi object when it contains only unsupported metadata", () => {
    spyOn(fs, "readFileSync").mockReturnValue(
      '{"pi":{"changelogPath":"CHANGELOG.md"}}',
    );
    expect(readPackageJson(PACKAGE_JSON_PATH)).toEqual({ pi: {} });
  });

  it("should retain all four resource declarations and omit unsupported metadata when arrays contain only strings", () => {
    spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        name: "tool",
        pi: {
          extensions: ["first.ts", "last.ts"],
          skills: [],
          prompts: ["prompts/*.md"],
          themes: ["dark.json"],
          changelogPath: "CHANGELOG.md",
        },
      }),
    );
    expect(readPackageJson(PACKAGE_JSON_PATH)).toEqual({
      pi: {
        extensions: ["first.ts", "last.ts"],
        skills: [],
        prompts: ["prompts/*.md"],
        themes: ["dark.json"],
      },
    });
  });

  it("should discard whole invalid fields while retaining valid declarations when resource fields are malformed", () => {
    spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({
        pi: {
          extensions: ["tool.ts", false],
          skills: ["skills"],
          prompts: "prompts",
          themes: [false],
        },
      }),
    );
    expect(readPackageJson(PACKAGE_JSON_PATH)).toEqual({
      pi: { skills: ["skills"] },
    });
  });
});

describe("mergeWithDefaultPackageJson", () => {
  const cases: [
    condition: string,
    metadata: PackageJson,
    mode: PackageCollectionMode,
    expected: { extensions: string[]; useConvention: boolean },
  ][] = [
    [
      "a string package omits pi",
      {},
      "package",
      { extensions: [], useConvention: true },
    ],
    [
      "a string package has metadata-only pi",
      { pi: {} },
      "package",
      { extensions: [], useConvention: true },
    ],
    [
      "a string package explicitly disables extensions",
      { pi: { extensions: [] } },
      "package",
      { extensions: [], useConvention: false },
    ],
    [
      "a string package declares extension files",
      { pi: { extensions: ["tool.ts"] } },
      "package",
      { extensions: ["tool.ts"], useConvention: false },
    ],
    [
      "a string package declares only skills",
      { pi: { skills: [] } },
      "package",
      { extensions: [], useConvention: false },
    ],
    [
      "a string package declares only prompts",
      { pi: { prompts: ["prompt.md"] } },
      "package",
      { extensions: [], useConvention: false },
    ],
    [
      "a string package declares only themes",
      { pi: { themes: [] } },
      "package",
      { extensions: [], useConvention: false },
    ],
    [
      "a default object omits pi",
      {},
      "default",
      { extensions: [], useConvention: true },
    ],
    [
      "a default object declares only skills",
      { pi: { skills: [] } },
      "default",
      { extensions: [], useConvention: true },
    ],
    [
      "a default object explicitly disables extensions",
      { pi: { extensions: [] } },
      "default",
      { extensions: [], useConvention: false },
    ],
    [
      "a filtered object omits extensions",
      { pi: { skills: ["skills"] } },
      "filter",
      { extensions: [], useConvention: true },
    ],
    [
      "a filtered object has an empty extensions list",
      { pi: { extensions: [] } },
      "filter",
      { extensions: [], useConvention: true },
    ],
    [
      "a filtered object declares extension files",
      { pi: { extensions: ["tool.ts"] } },
      "filter",
      { extensions: ["tool.ts"], useConvention: false },
    ],
  ];

  it.each(cases)(
    "should resolve extension discovery when %s",
    (_condition, metadata, mode, expected) => {
      const result = mergeWithDefaultPackageJson(metadata, mode);
      expect(result.pi.extensions).toEqual(expected.extensions);
      expect(result.useConvention).toBe(expected.useConvention);
    },
  );

  it("should preserve later object-mode discovery when the same metadata was merged in package mode", () => {
    const metadata = { pi: { skills: ["skills"] } };
    const fromPackage = mergeWithDefaultPackageJson(metadata, "package");
    const fromObject = mergeWithDefaultPackageJson(metadata, "default");
    expect(fromPackage.useConvention).toBe(false);
    expect(fromObject.useConvention).toBe(true);
    expect(fromObject.pi.extensions).toEqual([]);
  });
});
