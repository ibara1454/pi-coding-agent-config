import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  DefaultPackageManager,
  loadSkills,
  type ResolvedPaths,
  type ResolvedResource,
  SettingsManager,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { globSync } from "glob";
import {
  applyPatterns,
  canonicalizeResourcePath,
  explainFilterState,
  isEnabledByAutoloadDisabledPatterns,
  matchesAutoloadDisabledPattern,
  mutatePackagePatterns,
  packageResourcePaths,
  resourceFilterPath,
} from "./resource-paths.ts";
import {
  isJsonObject,
  packageSource,
  readSettingsDocument,
} from "./settings.ts";
import type {
  CatalogDiagnostic,
  CatalogRow,
  CatalogSeed,
  JsonObject,
  PackageLocator,
  ResourceField,
  ResourceKind,
  ResourceOrigin,
  ResourceScope,
  SettingsDocument,
  ToggleTarget,
} from "./types.ts";

const RESOURCE_FIELDS = ["extensions", "skills"] as const;

class SnapshotSettingsStorage {
  readonly #global: string;
  readonly #project: string;

  constructor(global: JsonObject, project: JsonObject) {
    this.#global = JSON.stringify(global);
    this.#project = JSON.stringify(project);
  }

  withLock(
    scope: "global" | "project",
    callback: (current: string | undefined) => string | undefined,
  ): void {
    callback(scope === "global" ? this.#global : this.#project);
  }
}

export class PackageResolutionFailure extends Error {
  override readonly name = "PackageResolutionFailure";
}

interface DiscoveryOptions {
  readonly agentDir: string;
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly reloadPending: boolean;
}

interface ResourceDraft {
  readonly configured: boolean;
  readonly kind: ResourceKind;
  readonly scope: ResourceScope;
  readonly canonicalPath: string;
  readonly resolvedPath: string;
  readonly baseDir: string;
  readonly source: string;
  readonly sourceType: "auto" | "local" | "package";
  readonly origins: readonly ResourceOrigin[];
  readonly filters: readonly string[];
  readonly configurationReason: string;
  readonly target:
    | {
        readonly type: "top-level";
        readonly occurrencePaths: readonly string[];
      }
    | {
        readonly type: "package";
        readonly packageRoot: string;
        readonly packageSourcePath: string;
        readonly locator: PackageLocator;
        readonly autoloadDelta: boolean;
        readonly participates: boolean;
        readonly participatesWhenEnabled: boolean;
        readonly participatesWhenDisabled: boolean;
        readonly settingsIndex: number;
        readonly hadFilterField: boolean;
        readonly packageIdentity: string;
        readonly precedenceWinner: boolean;
        readonly precedenceSlot: number;
      };
}

function fieldForKind(kind: ResourceKind): ResourceField {
  return kind === "extension" ? "extensions" : "skills";
}

function kindForField(field: ResourceField): ResourceKind {
  return field === "extensions" ? "extension" : "skill";
}

function scopeForMetadata(scope: string): ResourceScope | undefined {
  if (scope === "user") {
    return "global";
  }
  if (scope === "project") {
    return "project";
  }
  return undefined;
}

function npmPackageName(spec: string): string {
  if (spec.startsWith("@")) {
    const separator = spec.indexOf("@", spec.indexOf("/") + 1);
    return separator === -1 ? spec : spec.slice(0, separator);
  }
  const separator = spec.indexOf("@");
  return separator === -1 ? spec : spec.slice(0, separator);
}

function gitPackageIdentity(source: string): string | undefined {
  const trimmed = source.trim();
  const hasGitPrefix = trimmed.startsWith("git:");
  let candidate = hasGitPrefix ? trimmed.slice("git:".length).trim() : trimmed;
  if (!hasGitPrefix && !/^(?:https?|ssh|git):\/\//i.test(candidate)) {
    return undefined;
  }
  if (/^(?:github|gitlab|bitbucket):/i.test(candidate)) {
    const [provider, path] = candidate.split(/:(.+)/, 2);
    const host =
      provider?.toLowerCase() === "github"
        ? "github.com"
        : provider?.toLowerCase() === "gitlab"
          ? "gitlab.com"
          : "bitbucket.org";
    candidate = `${host}/${path ?? ""}`;
  }

  const scp = candidate.match(/^git@([^:]+):(.+)$/);
  let host: string;
  let path: string;
  if (scp !== null) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else if (candidate.includes("://")) {
    try {
      const parsed = new URL(candidate);
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\/+/, "");
    } catch {
      return undefined;
    }
  } else {
    const slash = candidate.indexOf("/");
    if (slash < 0) {
      return undefined;
    }
    host = candidate.slice(0, slash);
    path = candidate.slice(slash + 1);
  }
  path = path.split("@", 1)[0]?.replace(/\.git$/, "") ?? "";
  return host === "" || path === ""
    ? undefined
    : `git:${host.toLowerCase()}/${path.toLowerCase()}`;
}

export function packageIdentity(
  source: string,
  scope: ResourceScope,
  cwd: string,
  agentDir: string,
): string {
  if (source.startsWith("npm:")) {
    return `npm:${npmPackageName(source.slice("npm:".length).trim())}`;
  }
  const gitIdentity = gitPackageIdentity(source);
  if (gitIdentity !== undefined) {
    return gitIdentity;
  }
  const baseDir = scope === "global" ? agentDir : join(cwd, ".pi");
  const localSource = source.startsWith("~/")
    ? join(homedir(), source.slice(2))
    : source;
  return `local:${resolve(baseDir, localSource)}`;
}

function regularProjectPackageWinners(
  document: SettingsDocument | undefined,
  cwd: string,
  agentDir: string,
): ReadonlyMap<string, string> {
  const winners = new Map<
    string,
    { readonly source: string; readonly autoloadDelta: boolean }
  >();
  const entries = document?.value.packages;
  if (!Array.isArray(entries)) {
    return new Map();
  }
  for (const entry of entries) {
    const source = packageSource(entry);
    if (source === undefined) {
      continue;
    }
    winners.set(packageIdentity(source, "project", cwd, agentDir), {
      source,
      autoloadDelta: isJsonObject(entry) && entry.autoload === false,
    });
  }
  return new Map(
    Array.from(winners)
      .filter(([, winner]) => !winner.autoloadDelta)
      .map(([identity, winner]) => [identity, winner.source]),
  );
}

function scopedSettings(
  value: JsonObject,
  diagnostics: CatalogDiagnostic[],
  scope: ResourceScope,
): JsonObject {
  const result: JsonObject = { packages: [] };
  for (const field of RESOURCE_FIELDS) {
    const candidate = value[field];
    if (candidate === undefined) {
      continue;
    }
    if (
      !Array.isArray(candidate) ||
      !candidate.every((item) => typeof item === "string")
    ) {
      diagnostics.push({
        scope,
        message: `${field} must be an array of strings`,
      });
      continue;
    }
    result[field] = candidate;
  }
  return result;
}

function settingsManagerForScope(
  scope: ResourceScope,
  settings: JsonObject,
): SettingsManager {
  const storage =
    scope === "global"
      ? new SnapshotSettingsStorage(settings, {})
      : new SnapshotSettingsStorage({}, settings);
  return SettingsManager.fromStorage(storage, {
    projectTrusted: scope === "project",
  });
}

function scopeResources(
  resolved: ResolvedPaths,
  scope: ResourceScope,
  field: ResourceField,
): ResolvedResource[] {
  const resources =
    field === "extensions" ? resolved.extensions : resolved.skills;
  return resources.filter(
    (resource) => scopeForMetadata(resource.metadata.scope) === scope,
  );
}

function expandTopLevelGlobs(
  scope: ResourceScope,
  settings: JsonObject,
  cwd: string,
  agentDir: string,
): JsonObject {
  const baseDir = scope === "global" ? agentDir : join(cwd, ".pi");
  const expanded: JsonObject = { packages: [] };
  for (const field of RESOURCE_FIELDS) {
    const entries = settings[field];
    if (!Array.isArray(entries)) {
      continue;
    }
    expanded[field] = entries.flatMap((entry) => {
      if (
        typeof entry !== "string" ||
        entry.startsWith("!") ||
        entry.startsWith("+") ||
        entry.startsWith("-") ||
        (!entry.includes("*") && !entry.includes("?"))
      ) {
        return [entry];
      }
      return globSync(entry, {
        cwd: baseDir,
        absolute: true,
        dot: false,
        nodir: false,
      });
    });
  }
  return expanded;
}

async function resolveTopLevelSettings(
  scope: ResourceScope,
  settings: JsonObject,
  cwd: string,
  agentDir: string,
): Promise<ResolvedPaths> {
  const expanded = expandTopLevelGlobs(scope, settings, cwd, agentDir);
  const settingsManager = settingsManagerForScope(scope, expanded);
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  });
  return packageManager.resolve(async () => "skip");
}

function appendOrigin(
  origins: Map<string, ResourceOrigin[]>,
  key: string,
  origin: ResourceOrigin,
): void {
  const existing = origins.get(key) ?? [];
  if (!existing.some((candidate) => candidate.label === origin.label)) {
    existing.push(origin);
    origins.set(key, existing);
  }
}

function appendOccurrencePath(
  paths: Map<string, string[]>,
  key: string,
  path: string,
): void {
  const existing = paths.get(key) ?? [];
  if (!existing.includes(path)) {
    existing.push(path);
    paths.set(key, existing);
  }
}

function setPreferredResource(
  resources: Map<string, ResolvedResource>,
  key: string,
  resource: ResolvedResource,
): void {
  if (!resources.has(key)) {
    resources.set(key, resource);
  }
}

function resourceKey(
  scope: ResourceScope,
  kind: ResourceKind,
  path: string,
): string {
  return `${scope}:${kind}:${canonicalizeResourcePath(path)}`;
}

async function discoverTopLevelScope(
  scope: ResourceScope,
  document: SettingsDocument,
  cwd: string,
  agentDir: string,
  diagnostics: CatalogDiagnostic[],
): Promise<ResourceDraft[]> {
  const settings = scopedSettings(document.value, diagnostics, scope);
  const candidates = new Map<string, ResolvedResource>();
  const origins = new Map<string, ResourceOrigin[]>();
  const occurrencePaths = new Map<string, string[]>();

  try {
    const resolved = await resolveTopLevelSettings(
      scope,
      settings,
      cwd,
      agentDir,
    );
    for (const field of RESOURCE_FIELDS) {
      const kind = kindForField(field);
      for (const resource of scopeResources(resolved, scope, field)) {
        const key = resourceKey(scope, kind, resource.path);
        setPreferredResource(candidates, key, resource);
        appendOccurrencePath(occurrencePaths, key, resource.path);
      }
    }
  } catch (error) {
    diagnostics.push({
      scope,
      message: `Top-level discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  for (const field of RESOURCE_FIELDS) {
    const entries = Array.isArray(settings[field])
      ? (settings[field] as string[])
      : [];
    const overrides = entries.filter(
      (entry) =>
        entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-"),
    );
    for (const [index, entry] of entries.entries()) {
      if (
        entry.startsWith("!") ||
        entry.startsWith("+") ||
        entry.startsWith("-")
      ) {
        continue;
      }
      const isolated: JsonObject = {
        packages: [],
        [field]: [entry, ...overrides],
      };
      try {
        const resolved = await resolveTopLevelSettings(
          scope,
          isolated,
          cwd,
          agentDir,
        );
        const kind = kindForField(field);
        for (const resource of scopeResources(resolved, scope, field)) {
          if (resource.metadata.source !== "local") {
            continue;
          }
          const key = resourceKey(scope, kind, resource.path);
          setPreferredResource(candidates, key, resource);
          appendOccurrencePath(occurrencePaths, key, resource.path);
          appendOrigin(origins, key, {
            label: `${document.path}#${field}[${index}]`,
            source: "settings",
          });
        }
      } catch (error) {
        diagnostics.push({
          scope,
          message: `Could not inspect ${field}[${index}]: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    const autoOnly: JsonObject = { packages: [], [field]: overrides };
    try {
      const resolved = await resolveTopLevelSettings(
        scope,
        autoOnly,
        cwd,
        agentDir,
      );
      const kind = kindForField(field);
      for (const resource of scopeResources(resolved, scope, field)) {
        if (resource.metadata.source !== "auto") {
          continue;
        }
        const key = resourceKey(scope, kind, resource.path);
        setPreferredResource(candidates, key, resource);
        appendOccurrencePath(occurrencePaths, key, resource.path);
        appendOrigin(origins, key, {
          label: `${resource.metadata.baseDir ?? document.path}/${field} (auto)`,
          source: "auto",
        });
      }
    } catch (error) {
      diagnostics.push({
        scope,
        message: `Could not inspect auto-discovered ${field}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return Array.from(candidates.entries(), ([key, resource]) => {
    const kind = key.includes(":extension:") ? "extension" : "skill";
    const field = fieldForKind(kind);
    const filters = Array.isArray(settings[field])
      ? (settings[field] as string[])
      : [];
    const baseDir =
      resource.metadata.baseDir ??
      (scope === "global" ? agentDir : join(cwd, ".pi"));
    const explanation = explainFilterState(
      resource.path,
      filters,
      baseDir,
      resource.metadata.source === "auto" ? "overrides" : "top-level",
    );
    return {
      configured: resource.enabled,
      kind,
      scope,
      canonicalPath: canonicalizeResourcePath(resource.path),
      resolvedPath: resource.path,
      baseDir,
      source:
        resource.metadata.source === "auto" ? "Auto-discovered" : "Settings",
      sourceType: resource.metadata.source === "auto" ? "auto" : "local",
      filters,
      configurationReason: explanation.reason,
      origins: origins.get(key) ?? [
        {
          label:
            resource.metadata.source === "auto"
              ? "Conventional directory"
              : document.path,
          source: resource.metadata.source === "auto" ? "auto" : "settings",
        },
      ],
      target: {
        type: "top-level",
        occurrencePaths: occurrencePaths.get(key) ?? [resource.path],
      },
    };
  });
}

function packagePatterns(
  entry: unknown,
  field: ResourceField,
  diagnostics: CatalogDiagnostic[],
  scope: ResourceScope,
  source: string,
): {
  readonly autoloadDisabled: boolean;
  readonly patterns?: readonly string[];
} {
  if (typeof entry === "string") {
    return { autoloadDisabled: false };
  }
  if (!isJsonObject(entry)) {
    return { autoloadDisabled: false, patterns: [] };
  }
  const value = entry[field];
  if (value === undefined) {
    return { autoloadDisabled: entry.autoload === false };
  }
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    diagnostics.push({
      scope,
      source,
      message: `${source}.${field} must be an array of strings`,
    });
    return { autoloadDisabled: entry.autoload === false, patterns: [] };
  }
  return {
    autoloadDisabled: entry.autoload === false,
    patterns: value,
  };
}

function packageResourceEnabled(
  resource: ResolvedResource,
  allPaths: readonly string[],
  packageRoot: string,
  filter: {
    readonly autoloadDisabled: boolean;
    readonly patterns?: readonly string[];
  },
): boolean {
  if (filter.autoloadDisabled) {
    return filter.patterns === undefined
      ? false
      : isEnabledByAutoloadDisabledPatterns(
          resource.path,
          filter.patterns,
          packageRoot,
        );
  }
  if (filter.patterns === undefined) {
    return true;
  }
  if (filter.patterns.length === 0) {
    return false;
  }
  return applyPatterns(allPaths, filter.patterns, packageRoot).has(
    resource.path,
  );
}

function packageConfigurationReason(
  resource: ResolvedResource,
  packageRoot: string,
  filter: {
    readonly autoloadDisabled: boolean;
    readonly patterns?: readonly string[];
  },
): string {
  if (filter.autoloadDisabled) {
    return explainFilterState(
      resource.path,
      filter.patterns ?? [],
      packageRoot,
      "autoload-disabled",
    ).reason;
  }
  if (filter.patterns === undefined) {
    return "Enabled by package autoload: no kind filter is configured";
  }
  if (filter.patterns.length === 0) {
    return "Disabled by explicit empty package filter";
  }
  return explainFilterState(
    resource.path,
    filter.patterns,
    packageRoot,
    "normal",
  ).reason;
}

function packageResourceParticipation(
  resource: ResolvedResource,
  allPaths: readonly string[],
  packageRoot: string,
  kind: ResourceKind,
  filter: {
    readonly autoloadDisabled: boolean;
    readonly patterns?: readonly string[];
  },
  desired?: boolean,
): boolean {
  if (!filter.autoloadDisabled) {
    return true;
  }
  let patterns = filter.patterns ?? [];
  if (desired !== undefined) {
    const projected = mutatePackagePatterns({
      allPaths,
      autoloadDisabled: true,
      baseDir: packageRoot,
      desired,
      filePath: resource.path,
      filterPath: resourceFilterPath(resource.path, kind, packageRoot),
      hadField: filter.patterns !== undefined,
      patterns,
    });
    patterns = projected.keepField ? [...projected.patterns] : [];
  }
  return matchesAutoloadDisabledPattern(resource.path, patterns, packageRoot);
}
async function discoverPackageScope(
  scope: ResourceScope,
  document: SettingsDocument,
  cwd: string,
  agentDir: string,
  diagnostics: CatalogDiagnostic[],
  globalDocument?: SettingsDocument,
): Promise<ResourceDraft[]> {
  const packageEntries = document.value.packages;
  if (packageEntries === undefined) {
    return [];
  }
  if (!Array.isArray(packageEntries)) {
    diagnostics.push({ scope, message: "packages must be an array" });
    return [];
  }

  const scopeSettings = scopedSettings(document.value, diagnostics, scope);
  scopeSettings.packages = packageEntries;
  const settingsManager = settingsManagerForScope(scope, scopeSettings);
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  });
  const occurrenceBySource = new Map<string, number>();
  const drafts: ResourceDraft[] = [];
  const globalPackages = Array.isArray(globalDocument?.value.packages)
    ? globalDocument.value.packages
    : [];
  const winningIndexByIdentity = new Map<string, number>();
  const precedenceSlotByIdentity = new Map<string, number>();
  for (const [index, entry] of packageEntries.entries()) {
    const source = packageSource(entry);
    if (source === undefined) {
      continue;
    }
    const identity = packageIdentity(source, scope, cwd, agentDir);
    if (!precedenceSlotByIdentity.has(identity)) {
      precedenceSlotByIdentity.set(identity, index);
    }
    if (scope === "project" || !winningIndexByIdentity.has(identity)) {
      winningIndexByIdentity.set(identity, index);
    }
  }

  for (const [index, entry] of packageEntries.entries()) {
    const source = packageSource(entry);
    if (source === undefined) {
      diagnostics.push({
        scope,
        message: `packages[${index}] must be a source string or object`,
      });
      continue;
    }
    const occurrence = occurrenceBySource.get(source) ?? 0;
    occurrenceBySource.set(source, occurrence + 1);
    const locator = { source, occurrence };
    const identity = packageIdentity(source, scope, cwd, agentDir);
    const precedenceWinner = winningIndexByIdentity.get(identity) === index;
    const precedenceSlot = precedenceSlotByIdentity.get(identity) ?? index;
    const autoloadDelta = isJsonObject(entry) && entry.autoload === false;
    const globalBaseEntry =
      scope === "project" && autoloadDelta
        ? globalPackages.find((candidate) => {
            const candidateSource = packageSource(candidate);
            return (
              candidateSource !== undefined &&
              packageIdentity(candidateSource, "global", cwd, agentDir) ===
                identity
            );
          })
        : undefined;
    const installedSource = packageSource(globalBaseEntry) ?? source;
    const installedScope = globalBaseEntry === undefined ? scope : "global";

    let installedPath: string | undefined;
    try {
      installedPath = packageManager.getInstalledPath(
        installedSource,
        installedScope === "global" ? "user" : "project",
      );
    } catch (error) {
      diagnostics.push({
        scope,
        source,
        message: `Could not locate ${source}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (installedPath === undefined) {
      continue;
    }

    try {
      const resolved = await packageManager.resolveExtensionSources(
        [installedPath],
        { local: scope === "project" },
      );
      const packageRoot = statSync(installedPath).isFile()
        ? dirname(installedPath)
        : installedPath;
      for (const field of RESOURCE_FIELDS) {
        const resolvedResources =
          field === "extensions" ? resolved.extensions : resolved.skills;
        const allPaths = packageResourcePaths(
          packageRoot,
          field,
          resolvedResources.map((resource) => resource.path),
        );
        const fallbackMetadata: ResolvedResource["metadata"] = {
          source,
          scope: scope === "global" ? "user" : "project",
          origin: "package",
          baseDir: packageRoot,
        };
        const resources = allPaths.map(
          (path): ResolvedResource =>
            resolvedResources.find((resource) => resource.path === path) ?? {
              path,
              enabled: true,
              metadata: fallbackMetadata,
            },
        );
        const filter = packagePatterns(
          entry,
          field,
          diagnostics,
          scope,
          source,
        );
        const kind = kindForField(field);
        for (const resource of resources) {
          const configured = packageResourceEnabled(
            resource,
            allPaths,
            packageRoot,
            filter,
          );
          const participates = packageResourceParticipation(
            resource,
            allPaths,
            packageRoot,
            kind,
            filter,
          );
          drafts.push({
            configured,
            kind,
            scope,
            canonicalPath: canonicalizeResourcePath(resource.path),
            resolvedPath: resource.path,
            baseDir: packageRoot,
            source,
            sourceType: "package",
            filters: filter.patterns ?? [],
            configurationReason: packageConfigurationReason(
              resource,
              packageRoot,
              filter,
            ),
            origins: [
              {
                label: `${document.path}#packages[${index}]`,
                source: "package",
              },
            ],
            target: {
              type: "package",
              packageRoot,
              packageSourcePath: installedPath,
              locator,
              settingsIndex: index,
              autoloadDelta,
              participates,
              participatesWhenEnabled: packageResourceParticipation(
                resource,
                allPaths,
                packageRoot,
                kind,
                filter,
                true,
              ),
              participatesWhenDisabled: packageResourceParticipation(
                resource,
                allPaths,
                packageRoot,
                kind,
                filter,
                false,
              ),
              hadFilterField: filter.patterns !== undefined,
              packageIdentity: identity,
              precedenceWinner,
              precedenceSlot,
            },
          });
        }
      }
    } catch (error) {
      diagnostics.push({
        scope,
        source,
        message: `Could not inspect ${source}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return drafts;
}

function stripUnsafeControlCharacters(value: string): string {
  let safe = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 9 || code === 10 || (code >= 32 && code !== 127)) {
      safe += character;
    }
  }
  return safe;
}

function readBoundedSkillPreview(path: string): string | undefined {
  const buffer = Buffer.allocUnsafe(4096);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const body = stripFrontmatter(buffer.subarray(0, length).toString("utf8"));
    const safe = stripUnsafeControlCharacters(
      stripTerminalSequences(body).replaceAll("\r", ""),
    ).trim();
    return safe === "" ? undefined : safe.slice(0, 2000);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function skillMetadata(
  drafts: readonly ResourceDraft[],
  cwd: string,
  agentDir: string,
  diagnostics: CatalogDiagnostic[],
): ReadonlyMap<
  string,
  { readonly name: string; readonly description: string }
> {
  const paths = Array.from(
    new Set(
      drafts
        .filter((draft) => draft.kind === "skill")
        .map((draft) => draft.canonicalPath),
    ),
  );
  if (paths.length === 0) {
    return new Map();
  }

  const loaded = loadSkills({
    cwd,
    agentDir,
    skillPaths: paths,
    includeDefaults: false,
  });
  diagnostics.push(
    ...loaded.diagnostics.map((diagnostic) => ({
      message: diagnostic.message,
      ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
    })),
  );
  return new Map(
    loaded.skills.map((skill) => [
      canonicalizeResourcePath(skill.filePath),
      { name: skill.name, description: skill.description },
    ]),
  );
}

export function aggregateResources(
  resolved: ResolvedPaths,
): ReadonlyMap<string, ResolvedResource> {
  const aggregate = new Map<string, ResolvedResource>();
  for (const [kind, resources] of [
    ["extension", resolved.extensions],
    ["skill", resolved.skills],
  ] as const) {
    for (const resource of resources) {
      const key = `${kind}:${canonicalizeResourcePath(resource.path)}`;
      const current = aggregate.get(key);
      if (current === undefined || (!current.enabled && resource.enabled)) {
        aggregate.set(key, resource);
      }
    }
  }
  return aggregate;
}

function winnerLabel(resource: ResolvedResource): string {
  const scope = resource.metadata.scope === "project" ? "Project" : "Global";
  if (resource.metadata.origin === "package") {
    return `${scope} package ${resource.metadata.source}`;
  }
  return `${scope} ${resource.metadata.source === "auto" ? "auto-discovery" : "settings"}`;
}

function draftMatchesWinner(
  draft: ResourceDraft,
  winner: ResolvedResource,
): boolean {
  if (scopeForMetadata(winner.metadata.scope) !== draft.scope) {
    return false;
  }
  if (draft.sourceType === "package") {
    return (
      draft.target.type === "package" &&
      winner.metadata.origin === "package" &&
      winner.metadata.source === draft.source
    );
  }
  return (
    winner.metadata.origin === "top-level" &&
    winner.metadata.source === draft.sourceType
  );
}

function rowName(path: string, kind: ResourceKind): string {
  if (kind === "skill" && basename(path) === "SKILL.md") {
    return basename(dirname(path));
  }
  const stem = basename(path).replace(/\.(?:[cm]?[jt]s)$/i, "");
  return kind === "extension" && stem === "index"
    ? basename(dirname(path))
    : stem;
}

function resolutionOrder(draft: ResourceDraft, draftIndex: number): number {
  if (draft.target.type === "package") {
    const scopeOffset = draft.scope === "project" ? 0 : 500_000_000_000;
    return (
      4_000_000_000_000 +
      scopeOffset +
      draft.target.precedenceSlot * 1_000_000 +
      draftIndex
    );
  }
  const rank =
    draft.scope === "project"
      ? draft.sourceType === "local"
        ? 0
        : 1
      : draft.sourceType === "local"
        ? 2
        : 3;
  return rank * 1_000_000_000_000 + draftIndex;
}

function materializeCatalog(
  drafts: readonly ResourceDraft[],
  resolved: ResolvedPaths,
  cwd: string,
  agentDir: string,
  diagnostics: CatalogDiagnostic[],
  projectRegularPackages: ReadonlyMap<string, string>,
): {
  readonly rows: CatalogRow[];
  readonly targets: Map<string, ToggleTarget>;
} {
  const resolvedByCanonical = aggregateResources(resolved);
  const skills = skillMetadata(drafts, cwd, agentDir, diagnostics);
  const allPathsByTargetGroup = new Map<string, string[]>();
  for (const draft of drafts) {
    const group =
      draft.target.type === "top-level"
        ? `top:${draft.scope}:${draft.kind}`
        : `package:${draft.scope}:${draft.target.locator.source}:${draft.target.locator.occurrence}:${draft.kind}`;
    const paths = allPathsByTargetGroup.get(group) ?? [];
    paths.push(draft.resolvedPath);
    allPathsByTargetGroup.set(group, paths);
  }

  const rows: CatalogRow[] = [];
  const targets = new Map<string, ToggleTarget>();
  for (const [draftIndex, draft] of drafts.entries()) {
    const field = fieldForKind(draft.kind);
    const filterPath = resourceFilterPath(
      draft.resolvedPath,
      draft.kind,
      draft.target.type === "top-level"
        ? draft.baseDir
        : draft.target.packageRoot,
    );
    const id =
      draft.target.type === "top-level"
        ? `top:${draft.scope}:${draft.kind}:${draft.canonicalPath}`
        : `package:${draft.scope}:${draft.target.locator.source}:${draft.target.locator.occurrence}:${draft.kind}:${filterPath}`;
    const group =
      draft.target.type === "top-level"
        ? `top:${draft.scope}:${draft.kind}`
        : `package:${draft.scope}:${draft.target.locator.source}:${draft.target.locator.occurrence}:${draft.kind}`;
    const allPaths =
      draft.target.type === "top-level"
        ? draft.target.occurrencePaths
        : (allPathsByTargetGroup.get(group) ?? [draft.resolvedPath]);
    const target: ToggleTarget =
      draft.target.type === "top-level"
        ? {
            id,
            type: "top-level",
            scope: draft.scope,
            kind: draft.kind,
            field,
            canonicalPath: draft.canonicalPath,
            resolvedPath: draft.resolvedPath,
            filterPath,
            allPaths,
            baseDir: draft.baseDir,
            occurrencePaths: draft.target.occurrencePaths,
          }
        : {
            id,
            type: "package",
            scope: draft.scope,
            kind: draft.kind,
            field,
            canonicalPath: draft.canonicalPath,
            resolvedPath: draft.resolvedPath,
            filterPath,
            allPaths,
            packageRoot: draft.target.packageRoot,
            canonicalPackageRoot: canonicalizeResourcePath(
              draft.target.packageRoot,
            ),
            packageSourcePath: draft.target.packageSourcePath,
            package: draft.target.locator,
            hadFilterField: draft.target.hadFilterField,
            autoloadDelta: draft.target.autoloadDelta,
            participates: draft.target.participates,
            participatesWhenEnabled: draft.target.participatesWhenEnabled,
            participatesWhenDisabled: draft.target.participatesWhenDisabled,
            packageIdentity: draft.target.packageIdentity,
          };
    targets.set(id, target);

    const skill = skills.get(draft.canonicalPath);
    const canonicalWinner = resolvedByCanonical.get(
      `${draft.kind}:${draft.canonicalPath}`,
    );
    const ownedPaths =
      draft.target.type === "top-level"
        ? draft.target.occurrencePaths
        : [draft.resolvedPath];
    const duplicatePackageOccurrence =
      draft.target.type === "package" && !draft.target.precedenceWinner;
    const projectPackageWinner =
      draft.scope === "global" && draft.target.type === "package"
        ? projectRegularPackages.get(draft.target.packageIdentity)
        : undefined;
    const resolutionParticipant =
      !duplicatePackageOccurrence &&
      projectPackageWinner === undefined &&
      canonicalWinner !== undefined &&
      ownedPaths.some(
        (path) => resolve(path) === resolve(canonicalWinner.path),
      ) &&
      draftMatchesWinner(draft, canonicalWinner);
    const resolutionCandidate =
      !duplicatePackageOccurrence && projectPackageWinner === undefined;
    const name = skill?.name ?? rowName(draft.resolvedPath, draft.kind);
    const preview =
      draft.kind === "skill"
        ? readBoundedSkillPreview(draft.canonicalPath)
        : undefined;
    const shadowedBy = duplicatePackageOccurrence
      ? `${draft.scope === "project" ? "Project" : "Global"} package ${draft.source} occurrence 1`
      : projectPackageWinner !== undefined
        ? `Project package ${projectPackageWinner}`
        : !resolutionParticipant && canonicalWinner !== undefined
          ? winnerLabel(canonicalWinner)
          : !resolutionParticipant && draft.target.type === "package"
            ? "Package precedence"
            : undefined;
    rows.push({
      id,
      kind: draft.kind,
      scope: draft.scope,
      name,
      ...(skill?.description === undefined
        ? {}
        : { description: skill.description }),
      path: draft.resolvedPath,
      canonicalPath: draft.canonicalPath,
      source: draft.source,
      filters: draft.filters,
      configurationReason: draft.configurationReason,
      origins: draft.origins,
      configured: draft.configured,
      resolvedAfterReload: canonicalWinner?.enabled ?? false,
      resolutionParticipant,
      resolutionCandidate,
      resolutionOrder: resolutionOrder(draft, draftIndex),
      ...(shadowedBy === undefined ? {} : { shadowedBy }),
      ...(preview === undefined ? {} : { preview }),
    });
  }

  rows.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.name.localeCompare(right.name) ||
      left.scope.localeCompare(right.scope) ||
      left.source.localeCompare(right.source),
  );
  return { rows, targets };
}

export async function discoverCatalog(
  options: DiscoveryOptions,
): Promise<CatalogSeed> {
  const diagnostics: CatalogDiagnostic[] = [];
  const globalDocument = readSettingsDocument(
    "global",
    options.cwd,
    options.agentDir,
  );
  const documents = new Map<ResourceScope, SettingsDocument>([
    ["global", globalDocument],
  ]);
  if (globalDocument.error !== undefined) {
    diagnostics.push({
      scope: "global",
      path: globalDocument.path,
      message: globalDocument.error,
    });
  }

  if (options.projectTrusted) {
    const projectDocument = readSettingsDocument(
      "project",
      options.cwd,
      options.agentDir,
    );
    documents.set("project", projectDocument);
    if (projectDocument.error !== undefined) {
      diagnostics.push({
        scope: "project",
        path: projectDocument.path,
        message: projectDocument.error,
      });
    }
  }

  const drafts: ResourceDraft[] = [];
  for (const [scope, document] of documents) {
    drafts.push(
      ...(await discoverTopLevelScope(
        scope,
        document,
        options.cwd,
        options.agentDir,
        diagnostics,
      )),
      ...(await discoverPackageScope(
        scope,
        document,
        options.cwd,
        options.agentDir,
        diagnostics,
        globalDocument,
      )),
    );
  }

  const storage = new SnapshotSettingsStorage(
    globalDocument.value,
    documents.get("project")?.value ?? {},
  );
  const settingsManager = SettingsManager.fromStorage(storage, {
    projectTrusted: options.projectTrusted,
  });
  const packageManager = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
  });

  let resolved: ResolvedPaths;
  try {
    resolved = await packageManager.resolve(async () => "skip");
  } catch (error) {
    throw new PackageResolutionFailure(
      `Package resolution failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const materialized = materializeCatalog(
    drafts,
    resolved,
    options.cwd,
    options.agentDir,
    diagnostics,
    regularProjectPackageWinners(
      documents.get("project"),
      options.cwd,
      options.agentDir,
    ),
  );
  return {
    rows: materialized.rows,
    targets: materialized.targets,
    settings: documents,
    diagnostics,
    projectTrusted: options.projectTrusted,
    tuiMode: settingsManager.getTuiMode(),
    reloadPending: options.reloadPending,
  };
}
