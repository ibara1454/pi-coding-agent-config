import { canonicalizeResourcePath } from "./package-resource-paths.ts";
import {
  explainFilterState,
  mutateExactPattern,
  mutatePackagePatterns,
} from "./resource-filters.ts";
import type {
  CatalogRow,
  CatalogSeed,
  CatalogView,
  CommitRequest,
  CommitResult,
  ResourceScope,
  RowInspection,
  SettingsMutation,
} from "./types.ts";

export type CatalogCommitter = (
  request: CommitRequest,
) => Promise<CommitResult>;

/**
 * Resolves competing rows using staged participation and discovery precedence.
 * @param rows - Candidates for the same resource kind and canonical path.
 * @param targets - Toggle policies for discovered rows.
 * @param baseParticipation - Participation retained after successful commits.
 * @param staged - Desired states overriding committed configuration.
 * @returns The winning row's enabled state, or `false` without a candidate.
 * @example
 * For two enabled candidates at the same path, a project autoload delta has order 0
 * and a global package has order 1. If the delta's `participatesWhenDisabled` is
 * false, `resolveRows(rows, targets, baseParticipation, new Map([["project", false]]))`
 * returns true: disabling the delta yields to the enabled global package.
 */
function resolveRows(
  rows: readonly CatalogRow[],
  targets: CatalogSeed["targets"],
  baseParticipation: ReadonlyMap<string, boolean>,
  staged: ReadonlyMap<string, boolean>,
): boolean {
  const [winner] = rows
    .filter((row) => {
      if (!row.resolutionCandidate) {
        return false;
      }
      const target = targets.get(row.id);
      if (target?.type !== "package" || !target.autoloadDelta) {
        return true;
      }
      const desired = staged.get(row.id);
      if (desired === true) {
        return target.participatesWhenEnabled;
      }
      if (desired === false) {
        return target.participatesWhenDisabled;
      }
      return baseParticipation.get(row.id) ?? target.participates;
    })
    .sort((left, right) => left.resolutionOrder - right.resolutionOrder);
  return winner === undefined
    ? false
    : (staged.get(winner.id) ?? winner.configured);
}

interface CatalogBase {
  readonly rows: Map<string, CatalogRow>;
  readonly rowKeys: Map<string, string>;
  readonly participation: Map<string, boolean>;
}

/**
 * Projects reload resolution without modifying committed rows or staged edits.
 * @param base - Committed rows, cached resource keys, and package participation.
 * @param targets - Discovery-time toggle policies.
 * @param staged - Proposed configuration; untouched groups keep resolution.
 * @returns Enabled states keyed by resource kind and canonical path.
 * @example With independently enabled "alpha" and "beta" rows,
 * `projectResolved(base, targets, new Map([["alpha", false]]))` disables alpha's
 * path while preserving beta's discovery-time resolution.
 */
function projectResolved(
  base: CatalogBase,
  targets: CatalogSeed["targets"],
  staged: ReadonlyMap<string, boolean>,
): ReadonlyMap<string, boolean> {
  const rowsByPath = new Map<string, CatalogRow[]>();
  for (const row of base.rows.values()) {
    const key = base.rowKeys.get(row.id);
    if (key === undefined) {
      continue;
    }
    const rows = rowsByPath.get(key) ?? [];
    rows.push(row);
    rowsByPath.set(key, rows);
  }

  const resolvedByPath = new Map<string, boolean>();
  for (const [key, rows] of rowsByPath) {
    resolvedByPath.set(
      key,
      rows.some((row) => staged.has(row.id))
        ? resolveRows(rows, targets, base.participation, staged)
        : (rows[0]?.resolvedAfterReload ?? false),
    );
  }
  return resolvedByPath;
}

/**
 * Projects a staged toggle into the row's filters and explanation without mutating it.
 * @param row - Committed row to project.
 * @param targets - Discovery-time serialization policy for each row.
 * @param desired - Staged enabled state; `undefined` leaves the row unchanged.
 * @returns A projected row, or the original row when no change or target exists.
 * @example
 * For an enabled top-level row at /repo/extensions/shared.ts with filters
 * ["extensions/**"] and a target based at /repo with filterPath "extensions/shared.ts",
 * `projectRow(row, targets, false)`
 * returns configured false with filters ["extensions/**", "-extensions/shared.ts"].
 * The original row keeps its enabled state and include-only filters.
 */
function projectRow(
  row: CatalogRow,
  targets: CatalogSeed["targets"],
  desired: boolean | undefined,
): CatalogRow {
  if (desired === undefined) {
    return row;
  }
  const target = targets.get(row.id);
  if (target === undefined) {
    return row;
  }

  if (target.type === "top-level") {
    const filters = mutateExactPattern({
      baseDir: target.baseDir,
      desired,
      filePath: target.resolvedPath,
      filterPath: target.filterPath,
      patterns: row.filters,
    });
    return {
      ...row,
      configured: desired,
      filters,
      configurationReason: explainFilterState(
        target.resolvedPath,
        filters,
        target.baseDir,
        row.source === "Auto-discovered" ? "overrides" : "top-level",
      ).reason,
    };
  }

  const projected = mutatePackagePatterns({
    allPaths: target.allPaths,
    autoloadDisabled: target.autoloadDelta,
    baseDir: target.packageRoot,
    desired,
    filePath: target.resolvedPath,
    filterPath: target.filterPath,
    hadField: target.hadFilterField,
    patterns: row.filters,
  });
  const filters = projected.keepField ? [...projected.patterns] : [];
  let configurationReason: string;
  if (target.autoloadDelta) {
    configurationReason = explainFilterState(
      target.resolvedPath,
      filters,
      target.packageRoot,
      "autoload-disabled",
    ).reason;
  } else if (!projected.keepField) {
    configurationReason =
      "Enabled by package autoload: no kind filter is configured";
  } else if (filters.length === 0) {
    configurationReason = "Disabled by explicit empty package filter";
  } else {
    configurationReason = explainFilterState(
      target.resolvedPath,
      filters,
      target.packageRoot,
      "normal",
    ).reason;
  }
  return { ...row, configured: desired, filters, configurationReason };
}

/**
 * Collects diagnostics matching a row's paths, source, or scope-wide settings.
 * @param row - Resource whose inspector or diagnostic count is being rendered.
 * @param seed - Discovered diagnostics and settings-document paths.
 * @returns Matching messages in discovery order; an empty array if none match.
 * @example
 * For a global row from "npm:first", let seed diagnostics in order be
 * { scope: "global", source: "npm:second", message: "Package unavailable" } and
 * { scope: "global", message: "Invalid settings" }.
 * `diagnosticMessages(row, seed)` returns ["Invalid settings"]: scope-wide
 * settings errors apply, but another package's source-specific error does not.
 */
function diagnosticMessages(
  row: CatalogRow,
  seed: CatalogSeed,
): readonly string[] {
  const settingsPath = seed.settings.get(row.scope)?.path;
  return seed.diagnostics
    .filter((diagnostic) => {
      const samePath =
        diagnostic.path !== undefined &&
        (diagnostic.path === row.path || diagnostic.path === row.canonicalPath);
      const sameSource =
        diagnostic.source !== undefined &&
        diagnostic.source === row.source &&
        diagnostic.scope === row.scope;
      const scopeWide =
        diagnostic.source === undefined &&
        diagnostic.scope === row.scope &&
        (diagnostic.path === undefined || diagnostic.path === settingsPath);
      return samePath || sameSource || scopeWide;
    })
    .map((diagnostic) => diagnostic.message);
}

export class ExtensionCatalog {
  readonly #seed: CatalogSeed;
  readonly #committer: CatalogCommitter;
  readonly #base: CatalogBase = {
    rows: new Map<string, CatalogRow>(),
    rowKeys: new Map<string, string>(),
    participation: new Map<string, boolean>(),
  };
  readonly #staged = new Map<string, boolean>();

  constructor(seed: CatalogSeed, committer: CatalogCommitter) {
    this.#seed = seed;
    this.#committer = committer;
    for (const row of seed.rows) {
      this.#base.rows.set(row.id, row);
      this.#base.rowKeys.set(row.id, `${row.kind}:${row.canonicalPath}`);
      const target = seed.targets.get(row.id);
      if (target?.type === "package" && target.autoloadDelta) {
        this.#base.participation.set(row.id, target.participates);
      }
    }
  }

  /**
   * Builds the current catalog view with staged filters, resolution, and diagnostics.
   * @returns A fresh view; committed rows and staged changes remain unchanged.
   * @example
   * With no pending edits and a sole enabled top-level row "alpha":
   * ```ts
   * catalog.stage("alpha", false);
   * const view = catalog.view();
   * // view.stagedCount === 1; alpha is configured and resolvedAfterReload false.
   * catalog.discard();
   * // catalog.view() shows alpha enabled again; viewing did not save the edit.
   * ```
   */
  view(): CatalogView {
    const resolvedByPath = projectResolved(
      this.#base,
      this.#seed.targets,
      this.#staged,
    );
    const rows = Array.from(this.#base.rows.values(), (row) => {
      const projected = projectRow(
        row,
        this.#seed.targets,
        this.#staged.get(row.id),
      );
      return {
        ...projected,
        resolvedAfterReload:
          resolvedByPath.get(this.#base.rowKeys.get(row.id) ?? "") ?? false,
        diagnosticCount: diagnosticMessages(projected, this.#seed).length,
      };
    });
    return {
      rows,
      diagnostics: this.#seed.diagnostics,
      projectTrusted: this.#seed.projectTrusted,
      reloadPending: this.#seed.reloadPending,
      tuiMode: this.#seed.tuiMode,
      stagedCount: this.#staged.size,
    };
  }

  stage(id: string, enabled: boolean): void {
    const row = this.#base.rows.get(id);
    if (row === undefined) {
      throw new Error(`Unknown catalog row: ${id}`);
    }
    if (row.configured === enabled) {
      this.#staged.delete(id);
      return;
    }
    this.#staged.set(id, enabled);
  }

  // ponytail: delete this test-only wrapper; callers already use stage().
  toggle(id: string): void {
    const row = this.view().rows.find((candidate) => candidate.id === id);
    if (row === undefined) {
      throw new Error(`Unknown catalog row: ${id}`);
    }
    this.stage(id, !row.configured);
  }

  discard(): void {
    this.#staged.clear();
  }

  hasChanges(): boolean {
    return this.#staged.size > 0;
  }

  /**
   * Describes one row using its staged state and matching discovery diagnostics.
   * @param id - Catalog row ID, not a resource path.
   * @returns Inspector content, or `undefined` for an unknown ID.
   * @example
   * Given enabled top-level row "shared" at /repo/extensions/shared.ts, with
   * filters ["extensions/**"] and a target based at /repo with filterPath "extensions/shared.ts":
   * ```ts
   * catalog.stage("shared", false);
   * const inspection = catalog.inspect("shared");
   * // Configured: Disabled; Filters: "extensions/**", "-extensions/shared.ts".
   * // Reason identifies the exact force-exclude, before settings are saved.
   * ```
   */
  inspect(id: string): RowInspection | undefined {
    const row = this.view().rows.find((candidate) => candidate.id === id);
    if (row === undefined) {
      return undefined;
    }
    const target = this.#seed.targets.get(id);
    const diagnostics = diagnosticMessages(row, this.#seed);
    return {
      row,
      fields: [
        {
          label: "Kind",
          value: row.kind === "extension" ? "Extension" : "Skill",
        },
        {
          label: "Scope",
          value: row.scope === "global" ? "Global" : "Project",
        },
        { label: "Source", value: row.source },
        { label: "Resolved path", value: row.path },
        { label: "Canonical path", value: row.canonicalPath },
        {
          label: "Filters",
          value:
            row.filters.length === 0
              ? "(none)"
              : row.filters.map((filter) => JSON.stringify(filter)).join(", "),
        },
        {
          label: "Toggle serialization",
          value: target?.filterPath ?? "Unavailable",
        },
        {
          label: "Configured",
          value: row.configured ? "Enabled" : "Disabled",
        },
        { label: "Reason", value: row.configurationReason },
        {
          label: "Resolution",
          value: row.resolvedAfterReload
            ? "Enabled after reload"
            : "Disabled after reload",
        },
        {
          label: "Shadowing",
          value: row.shadowedBy ?? "None",
        },
        {
          label: "Origins",
          value: row.origins.map((origin) => origin.label).join(", "),
        },
      ],
      diagnostics,
      ...(row.preview === undefined ? {} : { preview: row.preview }),
    };
  }

  /**
   * Checks whether a proposed toggle would disable this extension after reload.
   * @param path - Extension-manager entry path to canonicalize.
   * @param id - Row receiving the proposed toggle.
   * @param enabled - Proposed configured state.
   * @returns `true` only for a currently resolved self-extension that becomes disabled.
   * @example
   * With enabled project and global top-level rows for /repo/manager.ts,
   * where project has higher precedence and the path resolves enabled:
   * ```ts
   * catalog.wouldDisableSelf("/repo/manager.ts", "global", false); // false
   * catalog.wouldDisableSelf("/repo/manager.ts", "project", false); // true
   * // These checks do not stage either toggle.
   * ```
   */
  wouldDisableSelf(path: string, id: string, enabled: boolean): boolean {
    const canonical = canonicalizeResourcePath(path);
    const row = this.#base.rows.get(id);
    if (
      row === undefined ||
      row.kind !== "extension" ||
      row.canonicalPath !== canonical
    ) {
      return false;
    }
    const key = `extension:${canonical}`;
    if (
      projectResolved(this.#base, this.#seed.targets, this.#staged).get(key) !==
      true
    ) {
      return false;
    }
    const staged = new Map(this.#staged);
    staged.set(id, enabled);
    return (
      projectResolved(this.#base, this.#seed.targets, staged).get(key) === false
    );
  }

  /**
   * Reads the extension manager's committed or staged reload-resolution state.
   * @param path - Extension entry path to canonicalize.
   * @param includeStaged - Whether pending toggles participate in resolution.
   * @returns Whether that extension resolves to enabled.
   * @example
   * With no pending edits and sole enabled top-level row "manager" at /repo/manager.ts:
   * ```ts
   * catalog.stage("manager", false);
   * catalog.selfResolved("/repo/manager.ts", true); // false: includes pending disable
   * catalog.selfResolved("/repo/manager.ts", false); // true: ignores pending disable
   * ```
   */
  selfResolved(path: string, includeStaged: boolean): boolean {
    const canonical = canonicalizeResourcePath(path);
    const staged = includeStaged ? this.#staged : new Map<string, boolean>();
    return (
      projectResolved(this.#base, this.#seed.targets, staged).get(
        `extension:${canonical}`,
      ) === true
    );
  }

  /**
   * Persists staged toggles and advances only successfully committed scopes.
   * Failed scopes retain their pending changes for another attempt.
   * @returns Per-scope persistence outcomes from the configured committer.
   * @throws If a staged row lacks a target or the committer rejects.
   * @example
   * Start with enabled rows "global" and "project" in their respective scopes.
   * If the committer saves global but reports project as failed:
   * ```ts
   * catalog.stage("global", false);
   * catalog.stage("project", false);
   * await catalog.commit();
   * catalog.view().stagedCount; // 1: only project's disable remains pending
   * catalog.discard();
   * // Global stays configured false; project returns to configured true.
   * ```
   */
  async commit(): Promise<CommitResult> {
    const mutations: SettingsMutation[] = [];
    for (const [id, enabled] of this.#staged) {
      const target = this.#seed.targets.get(id);
      if (target === undefined) {
        throw new Error(`Missing toggle target for ${id}`);
      }
      mutations.push({ scope: target.scope, target, enabled });
    }

    const result = await this.#committer({
      documents: this.#seed.settings,
      mutations,
    });
    const completedScopes = new Set<ResourceScope>(
      result.scopes
        .filter((scope) => scope.status === "committed")
        .map((scope) => scope.scope),
    );
    const affectedKeys = new Set<string>();
    for (const [id, enabled] of this.#staged) {
      const row = this.#base.rows.get(id);
      if (row === undefined || !completedScopes.has(row.scope)) {
        continue;
      }
      this.#base.rows.set(id, projectRow(row, this.#seed.targets, enabled));
      const target = this.#seed.targets.get(id);
      if (target?.type === "package" && target.autoloadDelta) {
        this.#base.participation.set(
          id,
          enabled
            ? target.participatesWhenEnabled
            : target.participatesWhenDisabled,
        );
      }
      const key = this.#base.rowKeys.get(id);
      if (key !== undefined) {
        affectedKeys.add(key);
      }
      this.#staged.delete(id);
    }
    for (const key of affectedKeys) {
      const rows = Array.from(this.#base.rows.values()).filter(
        (row) => this.#base.rowKeys.get(row.id) === key,
      );
      const resolved = resolveRows(
        rows,
        this.#seed.targets,
        this.#base.participation,
        new Map(),
      );
      for (const row of rows) {
        this.#base.rows.set(row.id, { ...row, resolvedAfterReload: resolved });
      }
    }
    return result;
  }
}
