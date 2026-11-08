import { describe, expect, it, spyOn } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: Bun spies must intercept the live named filesystem import used by the package reader.
import * as fs from "node:fs";
import {
  hasPackageResourceDeclaration,
  mergeWithDefaultPackageJson,
  type PackageJson,
  type ResolvedPackageJson,
  readPackageJson,
} from "./package-json.ts";

const PACKAGE_JSON_PATH = "/unit/package/package.json";
const DEFAULT_EXTENSION_PATH = "extensions/";

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

describe("hasPackageResourceDeclaration", () => {
  const cases: [condition: string, metadata: PackageJson, expected: boolean][] =
    [
      ["pi is absent", {}, false],
      ["pi is empty", { pi: {} }, false],
      ["only another resource is declared", { pi: { skills: [] } }, false],
      ["extensions is explicitly empty", { pi: { extensions: [] } }, true],
      [
        "extensions contains resource paths",
        { pi: { extensions: ["tool.ts"] } },
        true,
      ],
    ];

  it.each(cases)(
    "should report extension declaration presence when %s",
    (_condition, metadata, expected) => {
      expect(hasPackageResourceDeclaration(metadata, "extensions")).toBe(
        expected,
      );
    },
  );

  it.each(["skills", "prompts", "themes"] as const)(
    "should recognize explicitly empty %s declarations",
    (resource) => {
      const metadata: PackageJson = { pi: { [resource]: [] } };
      expect(hasPackageResourceDeclaration(metadata, resource)).toBe(true);
    },
  );
});

describe("mergeWithDefaultPackageJson", () => {
  const cases: [
    condition: string,
    metadata: PackageJson,
    expected: ResolvedPackageJson,
  ][] = [
    ["pi is absent", {}, { pi: { extensions: [DEFAULT_EXTENSION_PATH] } }],
    [
      "pi is empty",
      { pi: {} },
      { pi: { extensions: [DEFAULT_EXTENSION_PATH] } },
    ],
    [
      "other resource declarations omit extensions",
      {
        pi: {
          skills: [],
          prompts: ["prompts/*.md"],
          themes: ["dark.json"],
        },
      },
      {
        pi: {
          extensions: [DEFAULT_EXTENSION_PATH],
          skills: [],
          prompts: ["prompts/*.md"],
          themes: ["dark.json"],
        },
      },
    ],
    [
      "extension files are declared",
      { pi: { extensions: ["first.ts", "last.ts"] } },
      { pi: { extensions: ["first.ts", "last.ts"] } },
    ],
    [
      "extensions is explicitly empty",
      { pi: { extensions: [] } },
      { pi: { extensions: [] } },
    ],
  ];

  it.each(cases)(
    "should merge package defaults when %s",
    (_condition, metadata, expected) => {
      expect(mergeWithDefaultPackageJson(metadata)).toEqual(expected);
    },
  );

  it("should preserve supplied declarations when returned arrays are changed", () => {
    const metadata: PackageJson = {
      pi: { extensions: ["custom.ts"], skills: ["skills"] },
    };
    const merged = mergeWithDefaultPackageJson(metadata);
    merged.pi.extensions.push("other.ts");
    expect(metadata).toEqual({
      pi: { extensions: ["custom.ts"], skills: ["skills"] },
    });
  });

  it("should preserve later defaults when a previous result is modified", () => {
    const earlier = mergeWithDefaultPackageJson({});
    earlier.pi.extensions.push("custom.ts");
    expect(mergeWithDefaultPackageJson({})).toEqual({
      pi: { extensions: [DEFAULT_EXTENSION_PATH] },
    });
  });
});
