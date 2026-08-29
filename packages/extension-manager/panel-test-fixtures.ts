import type {
  CatalogDiagnostic,
  CatalogRow,
  CatalogSeed,
  ResourceKind,
  ToggleTarget,
} from "./types.ts";

// Inert catalog data shared by the panel state, rendering, and integration
// suites. TUI, theme, committer, and lifecycle fixtures stay in each suite.

export function catalogRow(
  id: string,
  kind: ResourceKind,
  source: string,
  path = `/repo/${id}.ts`,
): CatalogRow {
  return {
    id,
    kind,
    scope: id.includes("project") ? "project" : "global",
    name: id,
    description: `${id} description`,
    path,
    canonicalPath: path,
    source,
    origins: [
      {
        label: `${source}:${id}`,
        source: source === "Settings" ? "settings" : "package",
      },
    ],
    filters: ["extensions/**"],
    configurationReason: "Enabled by include filter",
    configured: true,
    resolvedAfterReload: true,
    resolutionParticipant: true,
    resolutionCandidate: true,
    resolutionOrder: id.includes("project") ? 0 : 1,
    ...(kind === "skill" ? { preview: "Preview body" } : {}),
  };
}

function toggleTarget(row: CatalogRow): ToggleTarget {
  return {
    id: row.id,
    type: "top-level",
    scope: row.scope,
    kind: row.kind,
    field: row.kind === "extension" ? "extensions" : "skills",
    canonicalPath: row.canonicalPath,
    resolvedPath: row.path,
    filterPath: row.path.split("/").at(-1) ?? row.path,
    allPaths: [row.path],
    baseDir: "/repo",
    occurrencePaths: [row.path],
  };
}

export function panelCatalogSeed(
  rows: readonly CatalogRow[],
  diagnostics: readonly CatalogDiagnostic[] = [],
): CatalogSeed {
  return {
    rows,
    targets: new Map(rows.map((row) => [row.id, toggleTarget(row)])),
    settings: new Map(),
    diagnostics,
    projectTrusted: true,
    tuiMode: "regular",
    reloadPending: false,
  };
}

export function defaultPanelRows(): CatalogRow[] {
  return [
    catalogRow("alpha", "extension", "Settings"),
    catalogRow("project-review", "skill", "npm:kit", "/repo/review/SKILL.md"),
  ];
}
