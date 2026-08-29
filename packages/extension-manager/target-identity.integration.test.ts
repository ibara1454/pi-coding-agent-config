import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateTargetIdentity } from "./target-identity.ts";
import {
  basePackageTarget,
  manifestPackage,
  packageDrifts,
  symlinkedPackage,
  withTemporaryRoot,
} from "./target-identity-test-fixtures.ts";
import type { PackageToggleTarget, TopLevelToggleTarget } from "./types.ts";

const linkName = "alpha-link.ts";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  await withTemporaryRoot("extension-manager-identity-", run);
}

function topLevelTarget(root: string): TopLevelToggleTarget {
  const baseDir = join(root, ".pi");
  const extensions = join(baseDir, "extensions");
  const actual = join(extensions, "alpha.ts");
  const linked = join(extensions, linkName);
  mkdirSync(extensions, { recursive: true });
  writeFileSync(actual, "export default () => 'alpha';\n");
  writeFileSync(join(extensions, "other.ts"), "export default () => 'o';\n");
  symlinkSync(actual, linked);
  return {
    id: "project-top",
    type: "top-level",
    scope: "project",
    kind: "extension",
    field: "extensions",
    canonicalPath: actual,
    resolvedPath: actual,
    filterPath: "extensions/alpha.ts",
    allPaths: [actual, linked],
    baseDir,
    occurrencePaths: [actual, linked],
  };
}

function linkedOccurrence(target: TopLevelToggleTarget): string {
  return join(target.baseDir, "extensions", linkName);
}

const topLevelDrifts: [
  string,
  (target: TopLevelToggleTarget) => void,
  string,
][] = [
  [
    "a deleted secondary occurrence",
    (target: TopLevelToggleTarget) => {
      unlinkSync(linkedOccurrence(target));
    },
    "Resource target disappeared",
  ],
  [
    "a secondary occurrence retargeted to another file",
    (target: TopLevelToggleTarget) => {
      unlinkSync(linkedOccurrence(target));
      symlinkSync(
        join(target.baseDir, "extensions", "other.ts"),
        linkedOccurrence(target),
      );
    },
    "Resource target changed",
  ],
];

describe("validateTargetIdentity", () => {
  test("should accept a package child that still resolves from its manifest", async () => {
    await withRoot(async (root) => {
      await expect(
        validateTargetIdentity(manifestPackage(root)),
      ).resolves.toBeUndefined();
    });
  });

  test("should accept a symlinked child under a raw package directory", async () => {
    await withRoot(async (root) => {
      await expect(
        validateTargetIdentity(symlinkedPackage(root)),
      ).resolves.toBeUndefined();
    });
  });

  test("should accept a shadowed raw child under a manifest directory", async () => {
    await withRoot(async (root) => {
      const packageRoot = join(root, "package");
      const extensions = join(packageRoot, "extensions");
      const actual = join(extensions, "actual.ts");
      const linked = join(extensions, "linked.ts");
      mkdirSync(extensions, { recursive: true });
      writeFileSync(actual, "export default () => {};\n");
      symlinkSync(actual, linked);
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ pi: { extensions: ["./extensions"] } }),
      );
      const target: PackageToggleTarget = {
        ...basePackageTarget(),
        canonicalPath: actual,
        resolvedPath: linked,
        filterPath: "extensions/linked.ts",
        allPaths: [actual, linked],
        packageRoot,
        canonicalPackageRoot: packageRoot,
        packageSourcePath: packageRoot,
      };

      await expect(validateTargetIdentity(target)).resolves.toBeUndefined();
    });
  });

  test("should accept every occurrence path of a collapsed canonical target", async () => {
    await withRoot(async (root) => {
      await expect(
        validateTargetIdentity(topLevelTarget(root)),
      ).resolves.toBeUndefined();
    });
  });
  test.each(packageDrifts)(
    "should reject the target when %s",
    async (_label: string, prepare: (
      root: string,
    ) => PackageToggleTarget, drift: (
      target: PackageToggleTarget,
    ) => void, message: string) => {
      await withRoot(async (root) => {
        const target = prepare(root);
        await expect(validateTargetIdentity(target)).resolves.toBeUndefined();

        drift(target);

        await expect(validateTargetIdentity(target)).rejects.toThrow(message);
      });
    },
  );
  test.each(topLevelDrifts)(
    "should reject the target when %s",
    async (_label: string, drift: (
      target: TopLevelToggleTarget,
    ) => void, message: string) => {
      await withRoot(async (root) => {
        const target = topLevelTarget(root);
        await expect(validateTargetIdentity(target)).resolves.toBeUndefined();

        drift(target);

        await expect(validateTargetIdentity(target)).rejects.toThrow(
          `${message}: ${linkedOccurrence(target)}`,
        );
      });
    },
  );

  test("should reject an occurrence when it left its discovered package", async () => {
    await withRoot(async (root) => {
      const target = topLevelTarget(root);
      const narrowed: TopLevelToggleTarget = {
        ...target,
        allPaths: [target.resolvedPath],
      };

      await expect(validateTargetIdentity(narrowed)).rejects.toThrow(
        `Resource target left its discovered package: ${linkedOccurrence(target)}`,
      );
    });
  });
});
