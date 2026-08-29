import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { mutateExactPattern, mutatePackagePatterns } from "./resource-paths.ts";
import type {
  JsonObject,
  PackageLocator,
  ResourceField,
  ResourceScope,
  SettingsDocument,
  SettingsMutation,
  ToggleTarget,
} from "./types.ts";

const MISSING = Symbol("missing-settings-owner");

export type SettingsOwnerSnapshot =
  | {
      readonly type: "field";
      readonly field: ResourceField;
      readonly value: unknown;
    }
  | {
      readonly type: "package";
      readonly locator: PackageLocator;
      readonly value: unknown;
    };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function settingsPathForScope(
  scope: ResourceScope,
  cwd: string,
  agentDir: string,
): string {
  return scope === "global"
    ? join(agentDir, "settings.json")
    : join(cwd, CONFIG_DIR_NAME, "settings.json");
}

export function parseSettingsDocument(
  scope: ResourceScope,
  path: string,
  content: string | undefined,
): SettingsDocument {
  if (content === undefined || content.trim() === "") {
    return { path, scope, content, value: {} };
  }

  try {
    const parsed: unknown = JSON.parse(content);
    if (!isJsonObject(parsed)) {
      return {
        path,
        scope,
        content,
        value: {},
        error: "Settings root must be a JSON object",
      };
    }
    return { path, scope, content, value: parsed };
  } catch (error) {
    return {
      path,
      scope,
      content,
      value: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function readSettingsDocument(
  scope: ResourceScope,
  cwd: string,
  agentDir: string,
): SettingsDocument {
  const path = settingsPathForScope(scope, cwd, agentDir);
  const content = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  return parseSettingsDocument(scope, path, content);
}

export function packageSource(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return entry;
  }
  if (!isJsonObject(entry) || typeof entry.source !== "string") {
    return undefined;
  }
  return entry.source;
}

export function findPackageOccurrence(
  packages: readonly unknown[],
  locator: PackageLocator,
): number {
  let occurrence = 0;
  for (const [index, entry] of packages.entries()) {
    if (packageSource(entry) !== locator.source) {
      continue;
    }
    if (occurrence === locator.occurrence) {
      return index;
    }
    occurrence += 1;
  }
  return -1;
}

function stringArray(
  value: unknown,
  label: string,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function mutateTopLevel(
  settings: JsonObject,
  mutation: SettingsMutation,
): void {
  const target = mutation.target;
  if (target.type !== "top-level") {
    throw new Error("Expected a top-level toggle target");
  }

  const existing = stringArray(settings[target.field], target.field) ?? [];
  const next = mutateExactPattern({
    baseDir: target.baseDir,
    desired: mutation.enabled,
    filePath: target.resolvedPath,
    filterPath: target.filterPath,
    patterns: existing,
  });
  if (arraysEqual(existing, next)) {
    return;
  }
  if (next.length === 0 && settings[target.field] === undefined) {
    return;
  }
  settings[target.field] = next;
}

function packageObject(entry: unknown): JsonObject {
  if (typeof entry === "string") {
    return { source: entry };
  }
  if (!isJsonObject(entry) || typeof entry.source !== "string") {
    throw new Error(
      "Package entry must be a source string or object with a source",
    );
  }
  return { ...entry };
}

function mutatePackage(settings: JsonObject, mutation: SettingsMutation): void {
  const target = mutation.target;
  if (target.type !== "package") {
    throw new Error("Expected a package toggle target");
  }

  if (!Array.isArray(settings.packages)) {
    throw new Error("packages must be an array");
  }
  const packageIndex = findPackageOccurrence(settings.packages, target.package);
  if (packageIndex === -1) {
    throw new Error(`Package occurrence disappeared: ${target.package.source}`);
  }

  const currentEntry = settings.packages[packageIndex];
  const nextEntry = packageObject(currentEntry);
  const hadField = Object.hasOwn(nextEntry, target.field);
  const existing = stringArray(nextEntry[target.field], target.field) ?? [];
  const { keepField, patterns } = mutatePackagePatterns({
    allPaths: target.allPaths,
    autoloadDisabled: nextEntry.autoload === false,
    baseDir: target.packageRoot,
    desired: mutation.enabled,
    filePath: target.resolvedPath,
    filterPath: target.filterPath,
    hadField,
    patterns: existing,
  });

  if (keepField) {
    nextEntry[target.field] = patterns;
  } else {
    delete nextEntry[target.field];
  }

  settings.packages[packageIndex] =
    Object.keys(nextEntry).length === 1 ? target.package.source : nextEntry;
}

export function applySettingsMutations(
  current: JsonObject,
  mutations: readonly SettingsMutation[],
): JsonObject {
  const next = structuredClone(current);
  for (const mutation of mutations) {
    if (mutation.target.type === "top-level") {
      mutateTopLevel(next, mutation);
    } else {
      mutatePackage(next, mutation);
    }
  }
  return next;
}

export function captureOwner(
  settings: JsonObject,
  target: ToggleTarget,
): SettingsOwnerSnapshot {
  if (target.type === "top-level") {
    return {
      type: "field",
      field: target.field,
      value: Object.hasOwn(settings, target.field)
        ? structuredClone(settings[target.field])
        : MISSING,
    };
  }
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const sameSource = packages.filter(
    (entry) => packageSource(entry) === target.package.source,
  );
  return {
    type: "package",
    locator: target.package,
    value: sameSource.length === 0 ? MISSING : structuredClone(sameSource),
  };
}

export function captureMutationOwners(
  settings: JsonObject,
  mutations: readonly SettingsMutation[],
): readonly SettingsOwnerSnapshot[] {
  const seen = new Set<string>();
  const owners: SettingsOwnerSnapshot[] = [];
  for (const mutation of mutations) {
    const target = mutation.target;
    const key =
      target.type === "top-level"
        ? `field:${target.field}`
        : `package:${target.package.source}:${target.package.occurrence}`;
    if (!seen.has(key)) {
      seen.add(key);
      owners.push(captureOwner(settings, target));
    }
  }
  return owners;
}

export function currentOwner(
  settings: JsonObject,
  snapshot: SettingsOwnerSnapshot,
): unknown {
  if (snapshot.type === "field") {
    return Object.hasOwn(settings, snapshot.field)
      ? settings[snapshot.field]
      : MISSING;
  }
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const sameSource = packages.filter(
    (entry) => packageSource(entry) === snapshot.locator.source,
  );
  return sameSource.length === 0 ? MISSING : sameSource;
}
