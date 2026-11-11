import { afterEach, describe, expect, it } from "bun:test";
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
import { canonicalizeResourcePath, packageResourcePaths } from "./index.ts";

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

describe("packageResourcePaths", () => {
  it("should enumerate raw aliases when a manifest glob matches a canonical resource", () => {
    const fixture = aliasedPackage(
      manifest({ pi: { extensions: ["./extensions/*.ts"] } }),
    );

    expect(
      packageResourcePaths(fixture.root, "extensions", [
        fixture.actual,
      ]).toSorted(),
    ).toEqual([fixture.actual, fixture.linked]);
  });

  it("should enumerate extension entrypoints below a resource directory", () => {
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

    expect(paths.toSorted((a, b) => a.localeCompare(b))).toEqual(
      [actual, nested, plain, legacy].toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("should enumerate skill documents below a skill directory", () => {
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

    expect(paths.toSorted((a, b) => a.localeCompare(b))).toEqual(
      [actual, linked, deep, notes].toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("should terminate when a directory symlink is self-referential", () => {
    const root = temporaryRoot();
    const index = join(root, "index.ts");
    const nested = join(root, "nest", "index.ts");
    const content = manifest({ pi: { extensions: ["./nest"] } });
    put(index, MODULE);
    put(join(root, "package.json"), content);
    symlinkSync(root, join(root, "nest"), "dir");

    const paths = packageResourcePaths(root, "extensions", [index]);

    expect(paths.toSorted((a, b) => a.localeCompare(b))).toEqual(
      [index, nested].toSorted((a, b) => a.localeCompare(b)),
    );
  });
});

describe("canonicalizeResourcePath", () => {
  it("should resolve aliases and traversal without failing when files are absent", () => {
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
