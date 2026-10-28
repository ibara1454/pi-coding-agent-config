import { describe, expect, it, spyOn } from "bun:test";
import type { PathLike } from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: Bun spies must intercept live filesystem imports while resource traversal remains real.
import * as fs from "node:fs";
import { packageResourcePaths } from "./package-resource-paths.ts";

describe("packageResourcePaths", () => {
  it("should retain resolved files when skill enumeration fails and another resolver path is not a file", () => {
    const root = "/unit/pkg";
    const skill = `${root}/skills/review/SKILL.md`;
    const nonFile = `${root}/non-file`;
    spyOn(fs, "readFileSync").mockReturnValue("{}");
    spyOn(fs.realpathSync, "native").mockImplementation(((path: PathLike) =>
      String(path)) as typeof fs.realpathSync.native);
    spyOn(fs, "statSync").mockImplementation(((path: PathLike) => ({
      isFile: () => String(path) === skill,
      isDirectory: () => String(path) === `${root}/skills`,
    })) as typeof fs.statSync);
    spyOn(fs, "readdirSync").mockImplementation(() => {
      throw new Error("skill directory is unreadable");
    });

    expect(packageResourcePaths(root, "skills", [nonFile, skill])).toEqual([
      skill,
    ]);
  });
});
