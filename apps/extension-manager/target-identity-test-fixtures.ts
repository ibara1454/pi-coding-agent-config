import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackageToggleTarget } from "./types.ts";

// Inert package toggle targets, real temporary package layouts, and the package
// drift cases shared by the target identity and persistence integration suites.
// Top-level target fixtures and suite behavior stay in each suite.

export async function withTemporaryRoot(
  prefix: string,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  try {
    await run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

export function basePackageTarget(): PackageToggleTarget {
  return {
    id: "global-package",
    type: "package",
    scope: "global",
    kind: "extension",
    field: "extensions",
    canonicalPath: "/agent/pkg/extensions/alpha.ts",
    resolvedPath: "/agent/pkg/extensions/alpha.ts",
    filterPath: "extensions/alpha.ts",
    allPaths: ["/agent/pkg/extensions/alpha.ts"],
    packageRoot: "/agent/pkg",
    canonicalPackageRoot: "/agent/pkg",
    packageSourcePath: "/agent/pkg",
    package: { source: "npm:kit", occurrence: 0 },
    autoloadDelta: false,
    participates: true,
    participatesWhenEnabled: true,
    participatesWhenDisabled: true,
    packageIdentity: "npm:kit",
    hadFilterField: false,
  };
}

export function manifestPackage(root: string): PackageToggleTarget {
  const packageRoot = join(root, "package");
  const alpha = join(packageRoot, "alpha.ts");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(alpha, "export default () => 'alpha';\n");
  writeFileSync(join(packageRoot, "beta.ts"), "export default () => 'beta';\n");
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ pi: { extensions: ["./alpha.ts"] } }),
  );
  return {
    ...basePackageTarget(),
    canonicalPath: alpha,
    resolvedPath: alpha,
    filterPath: "alpha.ts",
    allPaths: [alpha],
    packageRoot,
    canonicalPackageRoot: packageRoot,
    packageSourcePath: packageRoot,
  };
}

export function symlinkedPackage(root: string): PackageToggleTarget {
  const packageRoot = join(root, "package");
  const extensions = join(packageRoot, "extensions");
  const first = join(extensions, "first.ts");
  const resolvedPath = join(extensions, "alpha.ts");
  mkdirSync(extensions, { recursive: true });
  writeFileSync(first, "export default () => 'first';\n");
  writeFileSync(
    join(extensions, "second.ts"),
    "export default () => 'second';\n",
  );
  symlinkSync(first, resolvedPath);
  return {
    ...basePackageTarget(),
    canonicalPath: first,
    resolvedPath,
    filterPath: "extensions/alpha.ts",
    allPaths: [resolvedPath],
    packageRoot,
    canonicalPackageRoot: packageRoot,
    packageSourcePath: packageRoot,
  };
}

export const packageDrifts: [
  string,
  (root: string) => PackageToggleTarget,
  (target: PackageToggleTarget) => void,
  string,
][] = [
  [
    "a deleted package child",
    manifestPackage,
    (target: PackageToggleTarget) => {
      unlinkSync(target.resolvedPath);
    },
    "Resource target disappeared",
  ],
  [
    "a package child retargeted to another file",
    symlinkedPackage,
    (target: PackageToggleTarget) => {
      unlinkSync(target.resolvedPath);
      symlinkSync(
        join(target.packageRoot, "extensions", "second.ts"),
        target.resolvedPath,
      );
    },
    "Resource target changed",
  ],
  [
    "a package child dropped from the manifest",
    manifestPackage,
    (target: PackageToggleTarget) => {
      writeFileSync(
        join(target.packageRoot, "package.json"),
        JSON.stringify({ pi: { extensions: ["./beta.ts"] } }),
      );
    },
    "Resource no longer resolves from its package",
  ],
];
