import {
  type Dirent,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { globSync } from "glob";
import { minimatch } from "minimatch";
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

function normalizedExactPattern(pattern: string): string {
  const withoutDot =
    pattern.startsWith("./") || pattern.startsWith(".\\")
      ? pattern.slice(2)
      : pattern;
  return toPosixPath(withoutDot);
}

export function matchesExactPattern(
  filePath: string,
  pattern: string,
  baseDir: string,
): boolean {
  const normalized = normalizedExactPattern(pattern);
  const relativePath = toPosixPath(relative(baseDir, filePath));
  const absolutePath = toPosixPath(filePath);
  if (normalized === relativePath || normalized === absolutePath) {
    return true;
  }

  if (basename(filePath) !== "SKILL.md") {
    return false;
  }

  const parent = dirname(filePath);
  return (
    normalized === toPosixPath(relative(baseDir, parent)) ||
    normalized === toPosixPath(parent)
  );
}

export function matchesPattern(
  filePath: string,
  pattern: string,
  baseDir: string,
): boolean {
  const normalized = toPosixPath(pattern);
  const relativePath = toPosixPath(relative(baseDir, filePath));
  const name = basename(filePath);
  const absolutePath = toPosixPath(filePath);
  if (
    minimatch(relativePath, normalized) ||
    minimatch(name, normalized) ||
    minimatch(absolutePath, normalized)
  ) {
    return true;
  }

  if (name !== "SKILL.md") {
    return false;
  }

  const parent = dirname(filePath);
  return (
    minimatch(toPosixPath(relative(baseDir, parent)), normalized) ||
    minimatch(basename(parent), normalized) ||
    minimatch(toPosixPath(parent), normalized)
  );
}

function matchesAnyPattern(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
): boolean {
  return patterns.some((pattern) => matchesPattern(filePath, pattern, baseDir));
}

function matchesAnyExactPattern(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
): boolean {
  return patterns.some((pattern) =>
    matchesExactPattern(filePath, pattern, baseDir),
  );
}

export function applyPatterns(
  allPaths: readonly string[],
  patterns: readonly string[],
  baseDir: string,
): ReadonlySet<string> {
  const includes: string[] = [];
  const excludes: string[] = [];
  const forceIncludes: string[] = [];
  const forceExcludes: string[] = [];

  for (const pattern of patterns) {
    if (pattern.startsWith("+")) {
      forceIncludes.push(pattern.slice(1));
    } else if (pattern.startsWith("-")) {
      forceExcludes.push(pattern.slice(1));
    } else if (pattern.startsWith("!")) {
      excludes.push(pattern.slice(1));
    } else {
      includes.push(pattern);
    }
  }

  const enabled = new Set(
    includes.length === 0
      ? allPaths
      : allPaths.filter((path) => matchesAnyPattern(path, includes, baseDir)),
  );

  for (const path of allPaths) {
    if (enabled.has(path) && matchesAnyPattern(path, excludes, baseDir)) {
      enabled.delete(path);
    }
  }
  for (const path of allPaths) {
    if (matchesAnyExactPattern(path, forceIncludes, baseDir)) {
      enabled.add(path);
    }
  }
  for (const path of allPaths) {
    if (matchesAnyExactPattern(path, forceExcludes, baseDir)) {
      enabled.delete(path);
    }
  }

  return enabled;
}

export type FilterEvaluationMode =
  | "normal"
  | "overrides"
  | "top-level"
  | "autoload-disabled";

export interface FilterExplanation {
  readonly enabled: boolean;
  readonly reason: string;
}

function lastMatchingPattern(
  patterns: readonly string[],
  matches: (pattern: string) => boolean,
): string | undefined {
  for (let index = patterns.length - 1; index >= 0; index -= 1) {
    const pattern = patterns[index];
    if (pattern !== undefined && matches(pattern)) {
      return pattern;
    }
  }
  return undefined;
}

export function explainFilterState(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
  mode: FilterEvaluationMode,
): FilterExplanation {
  if (mode === "autoload-disabled") {
    const match = lastMatchingPattern(patterns, (pattern) => {
      const prefix = pattern[0];
      const target =
        prefix === "+" || prefix === "-" || prefix === "!"
          ? pattern.slice(1)
          : pattern;
      return prefix === "+" || prefix === "-"
        ? matchesExactPattern(filePath, target, baseDir)
        : matchesPattern(filePath, target, baseDir);
    });
    if (match === undefined) {
      return {
        enabled: false,
        reason: "Disabled: autoload is false and no filter matches",
      };
    }
    const enabled = !match.startsWith("-") && !match.startsWith("!");
    return {
      enabled,
      reason: `${enabled ? "Enabled" : "Disabled"} by last matching autoload:false filter \`${match}\``,
    };
  }

  const applicable =
    mode === "overrides"
      ? patterns.filter(
          (pattern) =>
            pattern.startsWith("!") ||
            pattern.startsWith("+") ||
            pattern.startsWith("-"),
        )
      : mode === "top-level"
        ? patterns.filter(
            (pattern) =>
              pattern.startsWith("!") ||
              pattern.startsWith("+") ||
              pattern.startsWith("-") ||
              pattern.includes("*") ||
              pattern.includes("?"),
          )
        : patterns;
  const forceExclude = lastMatchingPattern(
    applicable,
    (pattern) =>
      pattern.startsWith("-") &&
      matchesExactPattern(filePath, pattern.slice(1), baseDir),
  );
  if (forceExclude !== undefined) {
    return {
      enabled: false,
      reason: `Disabled by exact force-exclude \`${forceExclude}\``,
    };
  }
  const forceInclude = lastMatchingPattern(
    applicable,
    (pattern) =>
      pattern.startsWith("+") &&
      matchesExactPattern(filePath, pattern.slice(1), baseDir),
  );
  if (forceInclude !== undefined) {
    return {
      enabled: true,
      reason: `Enabled by exact force-include \`${forceInclude}\``,
    };
  }
  const exclude = lastMatchingPattern(
    applicable,
    (pattern) =>
      pattern.startsWith("!") &&
      matchesPattern(filePath, pattern.slice(1), baseDir),
  );
  if (exclude !== undefined) {
    return {
      enabled: false,
      reason: `Disabled by exclusion \`${exclude}\``,
    };
  }
  const includes = applicable.filter(
    (pattern) =>
      !pattern.startsWith("!") &&
      !pattern.startsWith("+") &&
      !pattern.startsWith("-"),
  );
  if (includes.length === 0) {
    return {
      enabled: true,
      reason: "Enabled by default: no include filter is configured",
    };
  }
  const include = lastMatchingPattern(includes, (pattern) =>
    matchesPattern(filePath, pattern, baseDir),
  );
  return include === undefined
    ? {
        enabled: false,
        reason: "Disabled: no include filter matches",
      }
    : {
        enabled: true,
        reason: `Enabled by include filter \`${include}\``,
      };
}

export function isEnabledByOverrides(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
): boolean {
  const overrides = patterns.filter(
    (pattern) =>
      pattern.startsWith("!") ||
      pattern.startsWith("+") ||
      pattern.startsWith("-"),
  );
  return applyPatterns([filePath], overrides, baseDir).has(filePath);
}

export function isEnabledByAutoloadDisabledPatterns(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
): boolean {
  let enabled = false;
  for (const pattern of patterns) {
    const prefix = pattern[0];
    const target =
      prefix === "+" || prefix === "-" || prefix === "!"
        ? pattern.slice(1)
        : pattern;
    const exact = prefix === "+" || prefix === "-";
    const matches = exact
      ? matchesExactPattern(filePath, target, baseDir)
      : matchesPattern(filePath, target, baseDir);
    if (matches) {
      enabled = prefix !== "-" && prefix !== "!";
    }
  }
  return enabled;
}

export function matchesAutoloadDisabledPattern(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
): boolean {
  return patterns.some((pattern) => {
    const prefix = pattern[0];
    const target =
      prefix === "+" || prefix === "-" || prefix === "!"
        ? pattern.slice(1)
        : pattern;
    return prefix === "+" || prefix === "-"
      ? matchesExactPattern(filePath, target, baseDir)
      : matchesPattern(filePath, target, baseDir);
  });
}

export interface PatternMutation {
  readonly baseDir: string;
  readonly desired: boolean;
  readonly filePath: string;
  readonly filterPath: string;
  readonly patterns: readonly string[];
}

export function mutateExactPattern(input: PatternMutation): string[] {
  const withoutExactToggle = input.patterns.filter((pattern) => {
    if (!pattern.startsWith("+") && !pattern.startsWith("-")) {
      return true;
    }
    return !matchesExactPattern(
      input.filePath,
      pattern.slice(1),
      input.baseDir,
    );
  });
  const enabledWithoutToggle = isEnabledByOverrides(
    input.filePath,
    withoutExactToggle,
    input.baseDir,
  );
  if (enabledWithoutToggle === input.desired) {
    return withoutExactToggle;
  }
  return [
    ...withoutExactToggle,
    `${input.desired ? "+" : "-"}${input.filterPath}`,
  ];
}

export interface PackagePatternMutation {
  readonly allPaths: readonly string[];
  readonly autoloadDisabled: boolean;
  readonly baseDir: string;
  readonly desired: boolean;
  readonly filePath: string;
  readonly filterPath: string;
  readonly hadField: boolean;
  readonly patterns: readonly string[];
}

export interface PackagePatternMutationResult {
  readonly keepField: boolean;
  readonly patterns: readonly string[];
}

export function mutatePackagePatterns(
  input: PackagePatternMutation,
): PackagePatternMutationResult {
  let removedPlainExact = false;
  let removedSignedExact = false;
  const remaining = input.patterns.filter((pattern) => {
    const prefix = pattern[0];
    if (prefix === "+" || prefix === "-") {
      const matches = matchesExactPattern(
        input.filePath,
        pattern.slice(1),
        input.baseDir,
      );
      removedSignedExact ||= matches;
      return !matches;
    }
    if (
      !input.desired &&
      prefix !== "!" &&
      matchesExactPattern(input.filePath, pattern, input.baseDir)
    ) {
      removedPlainExact = true;
      return false;
    }
    return true;
  });

  let keepField = input.hadField;
  if (
    input.hadField &&
    input.patterns.length > 0 &&
    remaining.length === 0 &&
    removedSignedExact &&
    !removedPlainExact
  ) {
    keepField = false;
  }
  if (removedPlainExact) {
    keepField = true;
  }

  const enabled = input.autoloadDisabled
    ? isEnabledByAutoloadDisabledPatterns(
        input.filePath,
        remaining,
        input.baseDir,
      )
    : keepField
      ? remaining.length > 0 &&
        applyPatterns(input.allPaths, remaining, input.baseDir).has(
          input.filePath,
        )
      : true;
  if (enabled === input.desired) {
    return { keepField, patterns: remaining };
  }

  if (!input.desired) {
    return {
      keepField: true,
      patterns: [...remaining, `-${input.filterPath}`],
    };
  }
  if (input.autoloadDisabled) {
    return {
      keepField: true,
      patterns: [...remaining, `+${input.filterPath}`],
    };
  }

  const withPlainInclude = [...remaining, input.filterPath];
  if (
    applyPatterns(input.allPaths, withPlainInclude, input.baseDir).has(
      input.filePath,
    )
  ) {
    return { keepField: true, patterns: withPlainInclude };
  }
  return {
    keepField: true,
    patterns: [...remaining, `+${input.filterPath}`],
  };
}
