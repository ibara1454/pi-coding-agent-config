import {
  type Dirent,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { globSync } from "glob";
import type { ResourceField, ResourceKind } from "./types.ts";

export function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function canonicalizeResourcePath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function resourceFilterPath(
  path: string,
  kind: ResourceKind,
  baseDir: string,
): string {
  const target =
    kind === "skill" && basename(path) === "SKILL.md" ? dirname(path) : path;
  return toPosixPath(relative(baseDir, target));
}

interface PackageManifestResources {
  readonly hasPiManifest: boolean;
  readonly entries?: readonly string[];
}

function packageManifestResources(
  packageRoot: string,
  field: ResourceField,
): PackageManifestResources {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    );
    const pi =
      typeof manifest === "object" &&
      manifest !== null &&
      !Array.isArray(manifest) &&
      "pi" in manifest &&
      typeof manifest.pi === "object" &&
      manifest.pi !== null &&
      !Array.isArray(manifest.pi)
        ? (manifest.pi as Record<string, unknown>)
        : undefined;
    if (pi === undefined) {
      return { hasPiManifest: false };
    }
    const entries = pi[field];
    return {
      hasPiManifest: true,
      ...(Array.isArray(entries) &&
      entries.every((entry) => typeof entry === "string")
        ? { entries }
        : {}),
    };
  } catch {
    return { hasPiManifest: false };
  }
}

function expandResourceEntries(
  root: string,
  entries: readonly string[],
): readonly string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    if (
      entry.startsWith("!") ||
      entry.startsWith("+") ||
      entry.startsWith("-")
    ) {
      continue;
    }
    const matches = /[*?[\]{}]/.test(entry)
      ? globSync(entry, {
          cwd: root,
          absolute: true,
          dot: false,
          nodir: false,
        })
      : [resolve(root, entry)];
    paths.push(...matches.map((match) => resolve(match)));
  }
  return paths;
}

function fileSystemKind(path: string): "file" | "directory" | undefined {
  try {
    const stats = statSync(path);
    return stats.isFile()
      ? "file"
      : stats.isDirectory()
        ? "directory"
        : undefined;
  } catch {
    return undefined;
  }
}

function extensionDirectoryEntrypoints(
  directory: string,
  ancestors: ReadonlySet<string>,
): readonly string[] | undefined {
  const manifest = packageManifestResources(directory, "extensions");
  if (manifest.entries !== undefined && manifest.entries.length > 0) {
    const entries: string[] = [];
    for (const path of expandResourceEntries(directory, manifest.entries)) {
      const kind = fileSystemKind(path);
      if (kind === "file") {
        entries.push(path);
      } else if (kind === "directory") {
        entries.push(...collectExtensionDirectory(path, ancestors));
      }
    }
    if (entries.length > 0) {
      return entries;
    }
  }
  for (const name of ["index.ts", "index.js"]) {
    const path = join(directory, name);
    if (fileSystemKind(path) === "file") {
      return [path];
    }
  }
  return undefined;
}

function collectExtensionDirectory(
  directory: string,
  ancestors: ReadonlySet<string> = new Set(),
): readonly string[] {
  let canonical: string;
  try {
    canonical = realpathSync.native(directory);
  } catch {
    return [];
  }
  if (ancestors.has(canonical)) {
    return [];
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(canonical);
  const rootEntries = extensionDirectoryEntrypoints(directory, nextAncestors);
  if (rootEntries !== undefined) {
    return rootEntries;
  }
  const entries: string[] = [];
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const path = join(directory, entry.name);
      const kind = fileSystemKind(path);
      if (
        kind === "file" &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))
      ) {
        entries.push(path);
      } else if (kind === "directory") {
        entries.push(
          ...(extensionDirectoryEntrypoints(path, nextAncestors) ?? []),
        );
      }
    }
  } catch {
    return entries;
  }
  return entries;
}

function collectSkillDirectory(
  directory: string,
  root: string = directory,
  ancestors: ReadonlySet<string> = new Set(),
): readonly string[] {
  let canonical: string;
  try {
    canonical = realpathSync.native(directory);
  } catch {
    return [];
  }
  if (ancestors.has(canonical)) {
    return [];
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(canonical);
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const skill = entries.find((entry) => entry.name === "SKILL.md");
  if (
    skill !== undefined &&
    fileSystemKind(join(directory, skill.name)) === "file"
  ) {
    return [join(directory, skill.name)];
  }

  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const path = join(directory, entry.name);
    const kind = fileSystemKind(path);
    if (directory === root && kind === "file" && entry.name.endsWith(".md")) {
      paths.push(path);
    } else if (kind === "directory") {
      paths.push(...collectSkillDirectory(path, root, nextAncestors));
    }
  }
  return paths;
}

export function packageResourcePaths(
  packageRoot: string,
  field: ResourceField,
  resolvedPaths: readonly string[],
): readonly string[] {
  const allowedCanonicalPaths = new Set(
    resolvedPaths.map(canonicalizeResourcePath),
  );
  const paths: string[] = [];
  const addFile = (path: string): void => {
    const kind = fileSystemKind(path);
    if (kind === "directory") {
      const children =
        field === "extensions"
          ? collectExtensionDirectory(path)
          : collectSkillDirectory(path);
      for (const child of children) {
        addFile(child);
      }
      return;
    }
    if (
      kind === "file" &&
      allowedCanonicalPaths.has(canonicalizeResourcePath(path)) &&
      !paths.includes(path)
    ) {
      paths.push(path);
    }
  };

  const manifest = packageManifestResources(packageRoot, field);
  if (manifest.entries !== undefined) {
    for (const path of expandResourceEntries(packageRoot, manifest.entries)) {
      addFile(path);
    }
  } else if (!manifest.hasPiManifest) {
    addFile(join(packageRoot, field));
  }
  for (const path of resolvedPaths) {
    addFile(path);
  }
  return paths;
}
