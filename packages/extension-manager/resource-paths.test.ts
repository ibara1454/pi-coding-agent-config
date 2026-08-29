import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPatterns,
  explainFilterState,
  isEnabledByAutoloadDisabledPatterns,
  isEnabledByOverrides,
  matchesExactPattern,
  mutateExactPattern,
  packageResourcePaths,
  resourceFilterPath,
} from "./resource-paths.ts";

const base = "/repo/.pi";
const extension = "/repo/.pi/extensions/alpha.ts";
const otherExtension = "/repo/.pi/extensions/beta.ts";
const skill = "/repo/.pi/skills/review/SKILL.md";

describe("resource filtering", () => {
  test("applies include, exclude, force-include, and force-exclude in Pi order", () => {
    const enabled = applyPatterns(
      [extension, otherExtension],
      [
        "extensions/**",
        "!**/alpha.ts",
        "+extensions/alpha.ts",
        "-extensions/beta.ts",
      ],
      base,
    );

    expect([...enabled]).toEqual([extension]);
  });

  test("matches skill exact filters by the skill directory", () => {
    expect(matchesExactPattern(skill, "skills/review", base)).toBe(true);
    expect(matchesExactPattern(skill, "/repo/.pi/skills/review", base)).toBe(
      true,
    );
    expect(resourceFilterPath(skill, "skill", base)).toBe("skills/review");
  });

  test("applies top-level overrides without treating source roots as includes", () => {
    expect(
      isEnabledByOverrides(extension, ["extensions", "!extensions/**"], base),
    ).toBe(false);
    expect(
      isEnabledByOverrides(
        extension,
        ["extensions", "!extensions/**", "+extensions/alpha.ts"],
        base,
      ),
    ).toBe(true);
  });

  test("explains plain top-level directories as source roots", () => {
    expect(
      explainFilterState(
        "/repo/packages/extension-manager/index.ts",
        ["../../packages"],
        "/repo/apps/agent",
        "top-level",
      ),
    ).toEqual({
      enabled: true,
      reason: "Enabled by default: no include filter is configured",
    });
  });

  test("applies autoload-disabled package patterns in declaration order", () => {
    expect(
      isEnabledByAutoloadDisabledPatterns(
        extension,
        ["extensions/**", "!extensions/alpha.ts"],
        base,
      ),
    ).toBe(false);
    expect(
      isEnabledByAutoloadDisabledPatterns(
        extension,
        ["!extensions/**", "+extensions/alpha.ts"],
        base,
      ),
    ).toBe(true);
  });
});

test("enumerates raw canonical duplicates under manifest directories", () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "resource-paths-"));
  try {
    const extensionDirectory = join(packageRoot, "extensions");
    const actualExtension = join(extensionDirectory, "actual.ts");
    const linkedExtension = join(extensionDirectory, "linked.ts");
    const skillDirectory = join(packageRoot, "skills");
    const actualSkillDirectory = join(skillDirectory, "actual");
    const linkedSkillDirectory = join(skillDirectory, "linked");
    const actualSkill = join(actualSkillDirectory, "SKILL.md");
    mkdirSync(extensionDirectory, { recursive: true });
    writeFileSync(actualExtension, "export default () => {};\n");
    symlinkSync(actualExtension, linkedExtension);
    mkdirSync(actualSkillDirectory, { recursive: true });
    writeFileSync(actualSkill, "# Actual\n");
    symlinkSync(actualSkillDirectory, linkedSkillDirectory, "dir");
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        pi: {
          extensions: ["./extensions"],
          skills: ["./skills"],
        },
      }),
    );

    expect(
      packageResourcePaths(packageRoot, "extensions", [
        actualExtension,
      ]).toSorted(),
    ).toEqual([actualExtension, linkedExtension].toSorted());
    expect(
      packageResourcePaths(packageRoot, "skills", [actualSkill]).toSorted(),
    ).toEqual([actualSkill, join(linkedSkillDirectory, "SKILL.md")].toSorted());
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

describe("exact toggle mutation", () => {
  test("adds one exclusion when disabling a default-enabled top-level resource", () => {
    expect(
      mutateExactPattern({
        baseDir: base,
        desired: false,
        filePath: extension,
        filterPath: "extensions/alpha.ts",
        patterns: ["extensions"],
      }),
    ).toEqual(["extensions", "-extensions/alpha.ts"]);
  });

  test("removes the exact exclusion when default state restores enabled", () => {
    expect(
      mutateExactPattern({
        baseDir: base,
        desired: true,
        filePath: extension,
        filterPath: "extensions/alpha.ts",
        patterns: ["extensions", "-extensions/alpha.ts"],
      }),
    ).toEqual(["extensions"]);
  });

  test("uses a force-include only while a broad exclusion remains", () => {
    const enabled = mutateExactPattern({
      baseDir: base,
      desired: true,
      filePath: extension,
      filterPath: "extensions/alpha.ts",
      patterns: ["!extensions/**", "-extensions/alpha.ts"],
    });
    expect(enabled).toEqual(["!extensions/**", "+extensions/alpha.ts"]);

    expect(
      mutateExactPattern({
        baseDir: base,
        desired: false,
        filePath: extension,
        filterPath: "extensions/alpha.ts",
        patterns: enabled,
      }),
    ).toEqual(["!extensions/**"]);
  });
});
