import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalizeResourcePath,
  packageResourcePaths,
  resourceFilterPath,
} from "./package-resource-paths.ts";

const MODULE = "export default () => {};\n";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "package-resource-paths-"));
  roots.push(root);
  return realpathSync.native(root);
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function manifest(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

interface AliasedPackage {
  readonly root: string;
  readonly actual: string;
  readonly linked: string;
}

function aliasedPackage(content: string | undefined): AliasedPackage {
  const root = temporaryRoot();
  const actual = join(root, "extensions", "actual.ts");
  const linked = join(root, "extensions", "linked.ts");
  put(actual, MODULE);
  symlinkSync(actual, linked);
  if (content !== undefined) {
    put(join(root, "package.json"), content);
  }
  return { root, actual, linked };
}

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
    content: manifest({ name: "fixture-package" }),
    enumeratesAlias: true,
  },
  {
    label: "an unparseable package.json falls back to the directory",
    content: "{ not json",
    enumeratesAlias: true,
  },
  {
    label: "a pi section without the field suppresses directory scanning",
    content: manifest({ name: "fixture-package", pi: {} }),
    enumeratesAlias: false,
  },
  {
    label: "a directory entry expands to the files it contains",
    content: manifest({ pi: { extensions: ["./extensions"] } }),
    enumeratesAlias: true,
  },
  {
    label: "a glob entry expands to each matching file",
    content: manifest({ pi: { extensions: ["./extensions/*.ts"] } }),
    enumeratesAlias: true,
  },
  {
    label: "a file entry lists exactly that declared file",
    content: manifest({ pi: { extensions: ["./extensions/linked.ts"] } }),
    enumeratesAlias: true,
  },
  {
    label: "filter prefixes in a manifest are not resource entries",
    content: manifest({
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
    content: manifest({ pi: { extensions: [1] } }),
    enumeratesAlias: false,
  },
  {
    label: "an empty entry list yields only the resolved paths",
    content: manifest({ pi: { extensions: [] } }),
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
  test.each(manifestCases.map((entry) => [entry.label, entry] as const))(
    "should return the expected paths for: %s",
    (_label, scenario) => {
      const fixture = aliasedPackage(scenario.content);
      const paths = packageResourcePaths(fixture.root, "extensions", [
        fixture.actual,
      ]);
      const expected = scenario.enumeratesAlias
        ? [fixture.actual, fixture.linked]
        : [fixture.actual];

      expect([...paths].toSorted()).toEqual(expected.toSorted());
    },
  );

  test("should enumerate extension entrypoints below a resource directory", () => {
    const root = temporaryRoot();
    const actual = join(root, "extensions", "actual.ts");
    const nested = join(root, "extensions", "nested", "entry.ts");
    const plain = join(root, "extensions", "plain", "index.ts");
    const legacy = join(root, "extensions", "legacy", "index.js");
    const vendored = join(root, "extensions", "node_modules", "d", "index.ts");
    const hidden = join(root, "extensions", ".hidden", "index.ts");
    const content = manifest({ pi: { extensions: ["./extensions"] } });
    put(join(root, "package.json"), content);
    put(actual, MODULE);
    put(
      join(root, "extensions", "nested", "package.json"),
      manifest({ pi: { extensions: ["./entry.ts"] } }),
    );
    for (const alias of [nested, plain, legacy, vendored, hidden]) {
      mkdirSync(dirname(alias), { recursive: true });
      symlinkSync(actual, alias);
    }

    const paths = packageResourcePaths(root, "extensions", [actual]);

    expect([...paths].toSorted()).toEqual(
      [actual, nested, plain, legacy].toSorted(),
    );
  });

  test("should enumerate skill documents below a skill directory", () => {
    const root = temporaryRoot();
    const skills = join(root, "skills");
    const actual = join(skills, "actual", "SKILL.md");
    const linked = join(skills, "linked", "SKILL.md");
    const deep = join(skills, "nested", "deep", "SKILL.md");
    const notes = join(skills, "notes.md");
    const content = manifest({ pi: { skills: ["./skills"] } });
    put(join(root, "package.json"), content);
    put(actual, "# Actual\n");
    put(deep, "# Deep\n");
    put(notes, "# Notes\n");
    put(join(skills, "nested", "loose.md"), "# Loose\n");
    symlinkSync(join(skills, "actual"), join(skills, "linked"), "dir");

    const paths = packageResourcePaths(root, "skills", [actual, deep, notes]);

    expect([...paths].toSorted()).toEqual(
      [actual, linked, deep, notes].toSorted(),
    );
  });

  test("should terminate when a directory symlink is self-referential", () => {
    const root = temporaryRoot();
    const index = join(root, "index.ts");
    const nested = join(root, "nest", "index.ts");
    const content = manifest({ pi: { extensions: ["./nest"] } });
    put(index, MODULE);
    put(join(root, "package.json"), content);
    symlinkSync(root, join(root, "nest"), "dir");

    const paths = packageResourcePaths(root, "extensions", [index]);

    expect([...paths].toSorted()).toEqual([index, nested].toSorted());
  });
});

describe("canonicalizeResourcePath", () => {
  test("should resolve aliases and traversal without failing when files are absent", () => {
    const root = temporaryRoot();
    const actual = join(root, "extensions", "actual.ts");
    const linked = join(root, "extensions", "linked.ts");
    put(actual, MODULE);
    symlinkSync(actual, linked);
    const traversed = join(root, "extensions", "..", "extensions", "actual.ts");
    const absent = join(root, "extensions", "gone", "..", "absent.ts");

    expect(canonicalizeResourcePath(linked)).toBe(actual);
    expect(canonicalizeResourcePath(traversed)).toBe(actual);
    expect(canonicalizeResourcePath(absent)).toBe(
      join(root, "extensions", "absent.ts"),
    );
  });
});

describe("resourceFilterPath", () => {
  test.each(filterPathCases.map((entry) => [entry.label, entry] as const))(
    "should return the expected filter path for: %s",
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
