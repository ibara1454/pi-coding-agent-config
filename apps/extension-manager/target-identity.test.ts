import { describe, expect, spyOn, test } from "bun:test";
import type { PathLike } from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: Spy on filesystem effects while leaving identity policy real.
import * as fs from "node:fs";
import { validateTargetIdentity } from "./target-identity.ts";
import { basePackageTarget } from "./target-identity-test-fixtures.ts";

describe("validateTargetIdentity", () => {
  test("should reject the target when its package root resolves to a different directory", async () => {
    const target = basePackageTarget();
    spyOn(fs.realpathSync, "native").mockImplementation(((path: PathLike) =>
      String(path) === target.packageRoot
        ? "/agent/replacement-package"
        : String(path)) as typeof fs.realpathSync.native);

    await expect(validateTargetIdentity(target)).rejects.toThrow(
      `Package root changed: ${target.packageRoot}`,
    );
  });

  test.each([
    ["a sibling directory", "/agent/other/alpha.ts"],
    ["the parent directory", "/agent"],
  ])(
    "should reject the target when its resource path leaves the package root for %s",
    async (_label, resolvedPath) => {
      const target = {
        ...basePackageTarget(),
        resolvedPath,
        canonicalPath: resolvedPath,
        allPaths: [resolvedPath],
      };
      spyOn(fs.realpathSync, "native").mockImplementation(((path: PathLike) =>
        String(path)) as typeof fs.realpathSync.native);

      await expect(validateTargetIdentity(target)).rejects.toThrow(
        `Resource left its package root: ${resolvedPath}`,
      );
    },
  );

  test("should reject the target when its saved filter identifies a different resource", async () => {
    const target = {
      ...basePackageTarget(),
      filterPath: "extensions/beta.ts",
    };
    spyOn(fs.realpathSync, "native").mockImplementation(((path: PathLike) =>
      String(path)) as typeof fs.realpathSync.native);

    await expect(validateTargetIdentity(target)).rejects.toThrow(
      `Resource filter identity changed: ${target.resolvedPath}`,
    );
  });
});
