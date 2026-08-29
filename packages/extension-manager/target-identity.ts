import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import {
  DefaultPackageManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  packageResourcePaths,
  resourceFilterPath,
} from "./package-resource-paths.ts";
import type { ToggleTarget } from "./types.ts";

function existingCanonical(path: string, label: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    throw new Error(`${label} disappeared: ${path}`, { cause: error });
  }
}

export async function validateTargetIdentity(
  target: ToggleTarget,
): Promise<void> {
  const occurrencePaths =
    target.type === "top-level"
      ? target.occurrencePaths
      : [target.resolvedPath];
  for (const occurrencePath of occurrencePaths) {
    const canonicalPath = existingCanonical(occurrencePath, "Resource target");
    if (canonicalPath !== target.canonicalPath) {
      throw new Error(`Resource target changed: ${occurrencePath}`);
    }
    if (!target.allPaths.includes(occurrencePath)) {
      throw new Error(
        `Resource target left its discovered package: ${occurrencePath}`,
      );
    }
  }
  if (target.type !== "package") {
    return;
  }

  const canonicalRoot = existingCanonical(target.packageRoot, "Package root");
  if (canonicalRoot !== target.canonicalPackageRoot) {
    throw new Error(`Package root changed: ${target.packageRoot}`);
  }
  const childPath = relative(target.packageRoot, target.resolvedPath);
  if (
    childPath === ".." ||
    childPath.startsWith(`..${sep}`) ||
    isAbsolute(childPath)
  ) {
    throw new Error(`Resource left its package root: ${target.resolvedPath}`);
  }
  if (
    resourceFilterPath(target.resolvedPath, target.kind, target.packageRoot) !==
    target.filterPath
  ) {
    throw new Error(`Resource filter identity changed: ${target.resolvedPath}`);
  }

  const packageManager = new DefaultPackageManager({
    cwd: target.packageRoot,
    agentDir: target.packageRoot,
    settingsManager: SettingsManager.inMemory(),
  });
  const resolved = await packageManager.resolveExtensionSources(
    [target.packageSourcePath],
    { local: target.scope === "project" },
  );
  const resources =
    target.kind === "extension" ? resolved.extensions : resolved.skills;
  const resourcePaths = packageResourcePaths(
    target.packageRoot,
    target.field,
    resources.map((resource) => resource.path),
  );
  const stillResolves = resourcePaths.some((path) => {
    try {
      return (
        realpathSync.native(path) === target.canonicalPath &&
        resourceFilterPath(path, target.kind, target.packageRoot) ===
          target.filterPath
      );
    } catch {
      return false;
    }
  });
  if (!stillResolves) {
    throw new Error(
      `Resource no longer resolves from its package: ${target.resolvedPath}`,
    );
  }
}
