import {
  canonicalizeResourcePath,
  explainFilterState,
  mutateExactPattern,
  mutatePackagePatterns,
} from "./resource-paths.ts";
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

export class ExtensionCatalog {
  readonly #seed: CatalogSeed;
  readonly #committer: CatalogCommitter;
  readonly #baseRows = new Map<string, CatalogRow>();
  readonly #rowKeys = new Map<string, string>();
  readonly #staged = new Map<string, boolean>();
  readonly #baseParticipation = new Map<string, boolean>();

  constructor(seed: CatalogSeed, committer: CatalogCommitter) {
    this.#seed = seed;
    this.#committer = committer;
    for (const row of seed.rows) {
      this.#baseRows.set(row.id, row);
      this.#rowKeys.set(row.id, `${row.kind}:${row.canonicalPath}`);
      const target = seed.targets.get(row.id);
      if (target?.type === "package" && target.autoloadDelta) {
        this.#baseParticipation.set(row.id, target.participates);
      }
    }
  }

  #rowConfigured(
    row: CatalogRow,
    staged: ReadonlyMap<string, boolean>,
  ): boolean {
    return staged.get(row.id) ?? row.configured;
  }

  #rowParticipates(
    row: CatalogRow,
    staged: ReadonlyMap<string, boolean>,
  ): boolean {
    const target = this.#seed.targets.get(row.id);
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
    return this.#baseParticipation.get(row.id) ?? target.participates;
  }

  #resolveRows(
    rows: readonly CatalogRow[],
    staged: ReadonlyMap<string, boolean>,
  ): boolean {
    const winner = [...rows]
      .filter(
        (row) => row.resolutionCandidate && this.#rowParticipates(row, staged),
      )
      .sort((left, right) => left.resolutionOrder - right.resolutionOrder)[0];
    return winner === undefined ? false : this.#rowConfigured(winner, staged);
  }

  #projectResolved(
    staged: ReadonlyMap<string, boolean> = this.#staged,
  ): ReadonlyMap<string, boolean> {
    const rowsByPath = new Map<string, CatalogRow[]>();
    for (const row of this.#baseRows.values()) {
      const key = this.#rowKeys.get(row.id);
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
          ? this.#resolveRows(rows, staged)
          : (rows[0]?.resolvedAfterReload ?? false),
      );
    }
    return resolvedByPath;
  }

  #projectRow(row: CatalogRow): CatalogRow {
    const desired = this.#staged.get(row.id);
    if (desired === undefined) {
      return row;
    }
    const target = this.#seed.targets.get(row.id);
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
    const configurationReason = target.autoloadDelta
      ? explainFilterState(
          target.resolvedPath,
          filters,
          target.packageRoot,
          "autoload-disabled",
        ).reason
      : !projected.keepField
        ? "Enabled by package autoload: no kind filter is configured"
        : filters.length === 0
          ? "Disabled by explicit empty package filter"
          : explainFilterState(
              target.resolvedPath,
              filters,
              target.packageRoot,
              "normal",
            ).reason;
    return {
      ...row,
      configured: desired,
      filters,
      configurationReason,
    };
  }

  #diagnosticMessages(row: CatalogRow): readonly string[] {
    const settingsPath = this.#seed.settings.get(row.scope)?.path;
    return this.#seed.diagnostics
      .filter((diagnostic) => {
        const samePath =
          diagnostic.path !== undefined &&
          (diagnostic.path === row.path ||
            diagnostic.path === row.canonicalPath);
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

  view(): CatalogView {
    const resolvedByPath = this.#projectResolved();
    const rows = Array.from(this.#baseRows.values(), (row) => {
      const projected = this.#projectRow(row);
      return {
        ...projected,
        resolvedAfterReload:
          resolvedByPath.get(this.#rowKeys.get(row.id) ?? "") ?? false,
        diagnosticCount: this.#diagnosticMessages(projected).length,
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
    const row = this.#baseRows.get(id);
    if (row === undefined) {
      throw new Error(`Unknown catalog row: ${id}`);
    }
    if (row.configured === enabled) {
      this.#staged.delete(id);
      return;
    }
    this.#staged.set(id, enabled);
  }

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

  inspect(id: string): RowInspection | undefined {
    const row = this.view().rows.find((candidate) => candidate.id === id);
    if (row === undefined) {
      return undefined;
    }
    const target = this.#seed.targets.get(id);
    const diagnostics = this.#diagnosticMessages(row);
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

  wouldDisableSelf(path: string, id: string, enabled: boolean): boolean {
    const canonical = canonicalizeResourcePath(path);
    const row = this.#baseRows.get(id);
    if (
      row === undefined ||
      row.kind !== "extension" ||
      row.canonicalPath !== canonical
    ) {
      return false;
    }
    const key = `extension:${canonical}`;
    if (this.#projectResolved().get(key) !== true) {
      return false;
    }
    const staged = new Map(this.#staged);
    staged.set(id, enabled);
    return this.#projectResolved(staged).get(key) === false;
  }

  selfResolved(path: string, includeStaged: boolean): boolean {
    const canonical = canonicalizeResourcePath(path);
    const staged = includeStaged ? this.#staged : new Map<string, boolean>();
    return this.#projectResolved(staged).get(`extension:${canonical}`) === true;
  }

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
      const row = this.#baseRows.get(id);
      if (row === undefined || !completedScopes.has(row.scope)) {
        continue;
      }
      this.#baseRows.set(id, this.#projectRow(row));
      const target = this.#seed.targets.get(id);
      if (target?.type === "package" && target.autoloadDelta) {
        this.#baseParticipation.set(
          id,
          enabled
            ? target.participatesWhenEnabled
            : target.participatesWhenDisabled,
        );
      }
      const key = this.#rowKeys.get(id);
      if (key !== undefined) {
        affectedKeys.add(key);
      }
      this.#staged.delete(id);
    }
    for (const key of affectedKeys) {
      const rows = Array.from(this.#baseRows.values()).filter(
        (row) => this.#rowKeys.get(row.id) === key,
      );
      const resolved = this.#resolveRows(rows, new Map());
      for (const row of rows) {
        this.#baseRows.set(row.id, { ...row, resolvedAfterReload: resolved });
      }
    }
    return result;
  }
}
