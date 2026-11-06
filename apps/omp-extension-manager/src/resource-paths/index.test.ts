import { describe, expect, it, spyOn } from "bun:test";
import type { Dirent, PathLike } from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: Bun spies must intercept live filesystem imports while resource traversal remains real.
import * as fs from "node:fs";
import { packageResourcePaths, resourceFilterPath } from "./index.ts";

const directoryIo: {
  readdirSync: (
    path: PathLike,
    options: { withFileTypes: true },
  ) => Pick<Dirent, "name">[];
} = fs;

interface ManifestCase {
  readonly label: string;
  readonly content: string | undefined;
  readonly enumeratesAlias: boolean;
}

const manifestCases: readonly ManifestCase[] = [
  {
    label: "a package without a package.json scans its resource directory",
    content: undefined,
    enumeratesAlias: true,
  },
  {
    label: "a package.json without a pi section scans the directory",
    content: JSON.stringify({ name: "fixture-package" }),
    enumeratesAlias: true,
  },
  {
    label: "an unparseable package.json falls back to the directory",
    content: "{ not json",
    enumeratesAlias: true,
  },
  {
    label: "a pi section without the field suppresses directory scanning",
    content: JSON.stringify({ name: "fixture-package", pi: {} }),
    enumeratesAlias: false,
  },
  {
    label: "a directory entry expands to the files it contains",
    content: JSON.stringify({ pi: { extensions: ["./extensions"] } }),
    enumeratesAlias: true,
  },
  {
    label: "a file entry lists exactly that declared file",
    content: JSON.stringify({ pi: { extensions: ["./extensions/linked.ts"] } }),
    enumeratesAlias: true,
  },
  {
    label: "filter prefixes in a manifest are not resource entries",
    content: JSON.stringify({
      pi: {
        extensions: [
          "!extensions/**",
          "+extensions/linked.ts",
          "-extensions/actual.ts",
        ],
      },
    }),
    enumeratesAlias: false,
  },
  {
    label: "a non-string entry list suppresses directory scanning",
    content: JSON.stringify({ pi: { extensions: [1] } }),
    enumeratesAlias: false,
  },
  {
    label: "an empty entry list yields only the resolved paths",
    content: JSON.stringify({ pi: { extensions: [] } }),
    enumeratesAlias: false,
  },
];

interface FilterPathCase {
  readonly label: string;
  readonly path: string;
  readonly kind: "extension" | "skill";
  readonly expected: string;
}

const filterPathCases: readonly FilterPathCase[] = [
  {
    label: "an extension file keeps its relative path",
    path: "/package/root/extensions/alpha.ts",
    kind: "extension",
    expected: "extensions/alpha.ts",
  },
  {
    label: "a skill document collapses to its skill directory",
    path: "/package/root/skills/review/SKILL.md",
    kind: "skill",
    expected: "skills/review",
  },
  {
    label: "a loose skill markdown file keeps its own path",
    path: "/package/root/skills/notes.md",
    kind: "skill",
    expected: "skills/notes.md",
  },
  {
    label: "an extension named SKILL.md is never collapsed",
    path: "/package/root/extensions/SKILL.md",
    kind: "extension",
    expected: "extensions/SKILL.md",
  },
  {
    label: "a path outside the base directory stays relative to it",
    path: "/elsewhere/alpha.ts",
    kind: "extension",
    expected: "../../elsewhere/alpha.ts",
  },
];

describe("packageResourcePaths", () => {
  it.each(manifestCases.map((entry) => [entry.label, entry] as const))(
    "should enumerate only permitted raw aliases when %s",
    (_label, scenario) => {
      const root = "/unit/pkg";
      const actual = `${root}/extensions/actual.ts`;
      const linked = `${root}/extensions/linked.ts`;
      const effects = [
        spyOn(fs, "readFileSync").mockImplementation(((path: PathLike) => {
          if (
            String(path) !== `${root}/package.json` ||
            scenario.content === undefined
          ) {
            throw new Error("No package manifest");
          }
          return scenario.content;
        }) as typeof fs.readFileSync),
        spyOn(fs.realpathSync, "native").mockImplementation(((
          path: PathLike,
        ) =>
          String(path) === linked
            ? actual
            : String(path)) as typeof fs.realpathSync.native),
        spyOn(fs, "statSync").mockImplementation(((path: PathLike) => ({
          isFile: () => String(path) === actual || String(path) === linked,
          isDirectory: () => String(path) === `${root}/extensions`,
        })) as typeof fs.statSync),
        spyOn(directoryIo, "readdirSync").mockReturnValue([
          { name: "actual.ts" },
          { name: "linked.ts" },
        ]),
      ];
      try {
        const paths = packageResourcePaths(root, "extensions", [actual]);
        expect(paths.toSorted()).toEqual(
          scenario.enumeratesAlias ? [actual, linked] : [actual],
        );
      } finally {
        for (const effect of effects) {
          effect.mockRestore();
        }
      }
    },
  );

  it("should retain resolved files when skill enumeration fails and another resolver path is not a file", () => {
    const root = "/unit/pkg";
    const skill = `${root}/skills/review/SKILL.md`;
    const nonFile = `${root}/non-file`;
    const effects = [
      spyOn(fs, "readFileSync").mockReturnValue("{}"),
      spyOn(fs.realpathSync, "native").mockImplementation(((path: PathLike) =>
        String(path)) as typeof fs.realpathSync.native),
      spyOn(fs, "statSync").mockImplementation(((path: PathLike) => ({
        isFile: () => String(path) === skill,
        isDirectory: () => String(path) === `${root}/skills`,
      })) as typeof fs.statSync),
      spyOn(fs, "readdirSync").mockImplementation(() => {
        throw new Error("skill directory is unreadable");
      }),
    ];
    try {
      expect(packageResourcePaths(root, "skills", [nonFile, skill])).toEqual([
        skill,
      ]);
    } finally {
      for (const effect of effects) {
        effect.mockRestore();
      }
    }
  });
});

describe("resourceFilterPath", () => {
  it.each(filterPathCases.map((entry) => [entry.label, entry] as const))(
    "should return the resource filter when %s",
    (_label, scenario) => {
      const filterPath = resourceFilterPath(
        scenario.path,
        scenario.kind,
        "/package/root",
      );
      expect(filterPath).toBe(scenario.expected);
    },
  );
});
