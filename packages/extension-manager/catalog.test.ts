import { describe, expect, test } from "bun:test";
import { ExtensionCatalog } from "./catalog.ts";
import type {
  CatalogRow,
  CatalogSeed,
  CommitRequest,
  CommitResult,
  PackageToggleTarget,
  ResourceScope,
  ToggleTarget,
} from "./types.ts";

const path = "/repo/extensions/shared.ts";

function target(id: string, scope: ResourceScope): ToggleTarget {
  return {
    id,
    type: "top-level",
    scope,
    kind: "extension",
    field: "extensions",
    canonicalPath: path,
    resolvedPath: path,
    filterPath: "extensions/shared.ts",
    allPaths: [path],
    baseDir: scope === "global" ? "/agent" : "/repo/.pi",
    occurrencePaths: [path],
  };
}

function packageTarget(
  id: string,
  scope: ResourceScope,
  options: {
    readonly canonicalPath?: string;
    readonly autoloadDelta?: boolean;
    readonly participates?: boolean;
    readonly participatesWhenEnabled?: boolean;
    readonly participatesWhenDisabled?: boolean;
  } = {},
): PackageToggleTarget {
  const canonicalPath = options.canonicalPath ?? path;
  const packageRoot = scope === "global" ? "/global/pkg" : "/project/pkg";
  return {
    id,
    type: "package",
    scope,
    kind: "extension",
    field: "extensions",
    canonicalPath,
    resolvedPath: canonicalPath,
    filterPath: "extensions/shared.ts",
    allPaths: [canonicalPath],
    packageRoot,
    canonicalPackageRoot: packageRoot,
    packageSourcePath: packageRoot,
    package: { source: "npm:kit", occurrence: 0 },
    autoloadDelta: options.autoloadDelta ?? false,
    hadFilterField: false,
    participates: options.participates ?? true,
    participatesWhenEnabled: options.participatesWhenEnabled ?? true,
    participatesWhenDisabled: options.participatesWhenDisabled ?? true,
    packageIdentity: "npm:kit",
  };
}

function row(
  id: string,
  scope: ResourceScope,
  configured: boolean,
  shadowedBy?: string,
): CatalogRow {
  return {
    id,
    kind: "extension",
    scope,
    name: id,
    path,
    canonicalPath: path,
    source: id === "winner" ? "Settings" : "npm:kit",
    origins: [{ label: id, source: id === "winner" ? "settings" : "package" }],
    filters: ["extensions/**"],
    configurationReason: configured
      ? "Enabled by include filter"
      : "Disabled by exclusion",
    configured,
    resolvedAfterReload: true,
    resolutionParticipant: shadowedBy === undefined,
    resolutionOrder: scope === "project" ? 0 : 1,
    resolutionCandidate: shadowedBy === undefined,
    ...(shadowedBy === undefined ? {} : { shadowedBy }),
  };
}

function seed(
  rows: readonly CatalogRow[],
  targets: ReadonlyMap<string, ToggleTarget> = new Map(
    rows.map((candidate) => [
      candidate.id,
      target(candidate.id, candidate.scope),
    ]),
  ),
): CatalogSeed {
  return {
    rows,
    targets,
    settings: new Map(),
    diagnostics: [],
    projectTrusted: true,
    tuiMode: "regular",
    reloadPending: false,
  };
}

describe("catalog staging", () => {
  test("projects staged state and removes a stage when restored", () => {
    const catalog = new ExtensionCatalog(
      seed([row("winner", "project", true)]),
      async () => ({ scopes: [], committedScopes: [] }),
    );

    catalog.stage("winner", false);
    expect(catalog.view().rows[0]?.configured).toBe(false);
    expect(catalog.view().stagedCount).toBe(1);

    catalog.stage("winner", true);
    expect(catalog.view().rows[0]?.configured).toBe(true);
    expect(catalog.hasChanges()).toBe(false);
  });

  test("does not let a staged shadowed row change the resolved projection", () => {
    const catalog = new ExtensionCatalog(
      seed([
        row("winner", "project", true),
        row("loser", "global", true, "Project settings"),
      ]),
      async () => ({ scopes: [], committedScopes: [] }),
    );

    catalog.stage("loser", false);
    expect(
      catalog.view().rows.every((candidate) => candidate.resolvedAfterReload),
    ).toBe(true);

    catalog.stage("winner", false);
    expect(
      catalog.view().rows.every((candidate) => !candidate.resolvedAfterReload),
    ).toBe(true);
  });

  test("returns inspector provenance and configured versus resolved labels", () => {
    const catalog = new ExtensionCatalog(
      seed([row("winner", "project", true)]),
      async () => ({ scopes: [], committedScopes: [] }),
    );

    const inspection = catalog.inspect("winner");
    expect(inspection?.fields).toContainEqual({
      label: "Filters",
      value: '"extensions/**"',
    });
    expect(inspection?.fields).toContainEqual({
      label: "Reason",
      value: "Enabled by include filter",
    });
    expect(inspection?.fields).toContainEqual({
      label: "Resolution",
      value: "Enabled after reload",
    });
    expect(inspection?.fields).toContainEqual({
      label: "Origins",
      value: "winner",
    });
  });
});

test("commit emits opaque mutations and retains only failed-scope stages", async () => {
  const requests: CommitRequest[] = [];
  const result: CommitResult = {
    scopes: [
      { scope: "global", status: "committed" },
      { scope: "project", status: "failed", message: "disk full" },
    ],
    committedScopes: ["global"],
  };
  const catalog = new ExtensionCatalog(
    seed([row("global", "global", true), row("project", "project", true)]),
    async (request) => {
      requests.push(request);
      return result;
    },
  );
  catalog.stage("global", false);
  catalog.stage("project", false);

  expect(await catalog.commit()).toEqual(result);
  expect(
    requests[0]?.mutations.map((mutation) => [
      mutation.scope,
      mutation.enabled,
    ]),
  ).toEqual([
    ["global", false],
    ["project", false],
  ]);
  expect(catalog.view().stagedCount).toBe(1);
  expect(
    catalog.view().rows.find((candidate) => candidate.id === "global")
      ?.configured,
  ).toBe(false);
});

test("self projection canonicalizes equivalent paths", () => {
  const catalog = new ExtensionCatalog(
    seed([row("winner", "project", true)]),
    async () => ({ scopes: [], committedScopes: [] }),
  );
  expect(
    catalog.wouldDisableSelf(
      "/repo/extensions/../extensions/shared.ts",
      "winner",
      false,
    ),
  ).toBe(true);
});

test("self-disable projection follows the effective row across duplicate origins", () => {
  const catalog = new ExtensionCatalog(
    seed([
      row("loser", "global", true, "Project settings"),
      row("winner", "project", true),
    ]),
    async () => ({ scopes: [], committedScopes: [] }),
  );

  expect(catalog.wouldDisableSelf(path, "loser", false)).toBe(false);
  expect(catalog.wouldDisableSelf(path, "winner", false)).toBe(true);

  catalog.stage("loser", false);
  expect(catalog.selfResolved(path, true)).toBe(true);
  catalog.stage("winner", false);
  expect(catalog.selfResolved(path, true)).toBe(false);
});

test("keeps a lower canonical occurrence shadowed when its winner is disabled", () => {
  const lower: CatalogRow = {
    ...row("first", "global", true, "Project settings"),
    resolutionCandidate: true,
  };
  const rows = [lower, row("second", "project", true)];
  const targets = new Map<string, ToggleTarget>([
    ["first", packageTarget("first", "global")],
    ["second", target("second", "project")],
  ]);
  const catalog = new ExtensionCatalog(seed(rows, targets), async () => ({
    scopes: [],
    committedScopes: [],
  }));

  expect(catalog.wouldDisableSelf(path, "first", false)).toBe(false);
  catalog.stage("first", false);
  expect(catalog.selfResolved(path, true)).toBe(true);
  expect(catalog.wouldDisableSelf(path, "second", false)).toBe(true);
  catalog.stage("second", false);
  expect(catalog.selfResolved(path, true)).toBe(false);
});

test("projects autoload delta removal to its enabled Global fallback", () => {
  const globalRow: CatalogRow = {
    ...row("global", "global", true, "Project package npm:kit"),
    source: "npm:kit",
    resolutionParticipant: false,
    resolutionCandidate: true,
  };
  const projectRow: CatalogRow = {
    ...row("project", "project", true),
    source: "npm:kit",
  };
  const targets = new Map<string, ToggleTarget>([
    ["global", packageTarget("global", "global")],
    [
      "project",
      packageTarget("project", "project", {
        autoloadDelta: true,
        participates: true,
        participatesWhenEnabled: true,
        participatesWhenDisabled: false,
      }),
    ],
  ]);
  const catalog = new ExtensionCatalog(
    seed([globalRow, projectRow], targets),
    async () => ({ scopes: [], committedScopes: [] }),
  );

  expect(catalog.wouldDisableSelf(path, "project", false)).toBe(false);
  catalog.stage("project", false);
  expect(catalog.selfResolved(path, true)).toBe(true);
});

test("projects an absent autoload delta when it is enabled", () => {
  const globalRow: CatalogRow = {
    ...row("global", "global", false),
    source: "npm:kit",
    resolvedAfterReload: false,
  };
  const projectRow: CatalogRow = {
    ...row("project", "project", false, "Global package npm:kit"),
    source: "npm:kit",
    resolvedAfterReload: false,
    resolutionParticipant: false,
    resolutionCandidate: true,
  };
  const targets = new Map<string, ToggleTarget>([
    ["global", packageTarget("global", "global")],
    [
      "project",
      packageTarget("project", "project", {
        autoloadDelta: true,
        participates: false,
        participatesWhenEnabled: true,
        participatesWhenDisabled: false,
      }),
    ],
  ]);
  const catalog = new ExtensionCatalog(
    seed([globalRow, projectRow], targets),
    async () => ({ scopes: [], committedScopes: [] }),
  );

  catalog.stage("project", true);
  expect(catalog.selfResolved(path, true)).toBe(true);
});

test("keeps a regular Global package shadowed by the same Project identity", () => {
  const globalPath = "/global/pkg/extensions/shared.ts";
  const globalRow: CatalogRow = {
    ...row("global", "global", false, "Project package npm:kit"),
    path: globalPath,
    canonicalPath: globalPath,
    source: "npm:kit",
    resolvedAfterReload: false,
    resolutionParticipant: false,
    resolutionCandidate: false,
  };
  const target = packageTarget("global", "global", {
    canonicalPath: globalPath,
  });
  const catalog = new ExtensionCatalog(
    seed([globalRow], new Map([["global", target]])),
    async () => ({ scopes: [], committedScopes: [] }),
  );

  catalog.stage("global", true);
  expect(
    catalog.view().rows.find((candidate) => candidate.id === "global")
      ?.resolvedAfterReload,
  ).toBe(false);
});

test("associates source diagnostics only with matching rows", () => {
  const first: CatalogRow = {
    ...row("first", "global", true),
    source: "npm:first",
  };
  const second: CatalogRow = {
    ...row("second", "global", true),
    source: "npm:second",
  };
  const catalog = new ExtensionCatalog(
    {
      ...seed([first, second]),
      diagnostics: [
        {
          scope: "global",
          source: "npm:first",
          message: "invalid extensions filter",
        },
      ],
    },
    async () => ({ scopes: [], committedScopes: [] }),
  );

  expect(catalog.inspect("first")?.diagnostics).toEqual([
    "invalid extensions filter",
  ]);
  expect(catalog.inspect("second")?.diagnostics).toEqual([]);
});

test("falls through an absent delta to the next package candidate", () => {
  const deltaRow: CatalogRow = {
    ...row("delta", "project", true),
    source: "npm:first",
    resolutionOrder: 0,
  };
  const fallbackRow: CatalogRow = {
    ...row("fallback", "global", true, "Project package npm:first"),
    source: "npm:second",
    resolutionParticipant: false,
    resolutionCandidate: true,
    resolutionOrder: 1,
  };
  const deltaTarget: PackageToggleTarget = {
    ...packageTarget("delta", "project", {
      autoloadDelta: true,
      participates: true,
      participatesWhenEnabled: true,
      participatesWhenDisabled: false,
    }),
    package: { source: "npm:first", occurrence: 0 },
    packageIdentity: "npm:first",
  };
  const fallbackTarget: PackageToggleTarget = {
    ...packageTarget("fallback", "global"),
    package: { source: "npm:second", occurrence: 0 },
    packageIdentity: "npm:second",
  };
  const catalog = new ExtensionCatalog(
    seed(
      [deltaRow, fallbackRow],
      new Map([
        ["delta", deltaTarget],
        ["fallback", fallbackTarget],
      ]),
    ),
    async () => ({ scopes: [], committedScopes: [] }),
  );

  catalog.stage("delta", false);
  expect(catalog.selfResolved(path, true)).toBe(true);
});

test("keeps a disabled top-level winner ahead of an enabled package delta", () => {
  const topRow: CatalogRow = {
    ...row("top", "project", false),
    resolvedAfterReload: false,
    resolutionOrder: 0,
  };
  const deltaRow: CatalogRow = {
    ...row("delta", "global", false, "Project settings"),
    source: "npm:kit",
    resolvedAfterReload: false,
    resolutionParticipant: false,
    resolutionCandidate: true,
    resolutionOrder: 1,
  };
  const deltaTarget = packageTarget("delta", "global", {
    autoloadDelta: true,
    participates: false,
    participatesWhenEnabled: true,
    participatesWhenDisabled: false,
  });
  const catalog = new ExtensionCatalog(
    seed(
      [topRow, deltaRow],
      new Map([
        ["top", target("top", "project")],
        ["delta", deltaTarget],
      ]),
    ),
    async () => ({ scopes: [], committedScopes: [] }),
  );

  catalog.stage("delta", true);
  expect(catalog.selfResolved(path, true)).toBe(false);
});

test("projects staged top-level filters and precedence reason in inspection", () => {
  const projectedTarget = {
    ...target("winner", "project"),
    baseDir: "/repo",
  };
  const catalog = new ExtensionCatalog(
    seed(
      [row("winner", "project", true)],
      new Map([["winner", projectedTarget]]),
    ),
    async () => ({ scopes: [], committedScopes: [] }),
  );

  catalog.stage("winner", false);
  const fields = catalog.inspect("winner")?.fields;

  expect(fields).toContainEqual({ label: "Configured", value: "Disabled" });
  expect(fields).toContainEqual({
    label: "Filters",
    value: '"extensions/**", "-extensions/shared.ts"',
  });
  expect(fields).toContainEqual({
    label: "Reason",
    value: "Disabled by exact force-exclude `-extensions/shared.ts`",
  });
});

test("projects explicit-empty package filters in inspection", () => {
  const packagePath = "/global/pkg/extensions/shared.ts";
  const packageRow: CatalogRow = {
    ...row("package", "global", false),
    path: packagePath,
    canonicalPath: packagePath,
    source: "npm:kit",
    filters: [],
    configurationReason: "Disabled by explicit empty package filter",
    resolvedAfterReload: false,
  };
  const packageToggle: PackageToggleTarget = {
    ...packageTarget("package", "global", {
      canonicalPath: packagePath,
    }),
    hadFilterField: true,
  };
  const catalog = new ExtensionCatalog(
    seed([packageRow], new Map([["package", packageToggle]])),
    async () => ({ scopes: [], committedScopes: [] }),
  );

  catalog.stage("package", true);
  const fields = catalog.inspect("package")?.fields;

  expect(fields).toContainEqual({ label: "Configured", value: "Enabled" });
  expect(fields).toContainEqual({
    label: "Filters",
    value: '"extensions/shared.ts"',
  });
  expect(fields).toContainEqual({
    label: "Reason",
    value: "Enabled by include filter `extensions/shared.ts`",
  });
});

test("exposes every settings-file diagnostic to rows in that scope", () => {
  const settingsPath = "/agent/settings.json";
  const scopedSeed: CatalogSeed = {
    ...seed([row("winner", "global", true)]),
    settings: new Map([
      [
        "global",
        {
          scope: "global",
          path: settingsPath,
          content: "{}",
          value: {},
        },
      ],
    ]),
    diagnostics: [
      { scope: "global", path: settingsPath, message: "first parse problem" },
      { scope: "global", path: settingsPath, message: "second parse problem" },
    ],
  };
  const catalog = new ExtensionCatalog(scopedSeed, async () => ({
    scopes: [],
    committedScopes: [],
  }));

  expect(catalog.inspect("winner")?.diagnostics).toEqual([
    "first parse problem",
    "second parse problem",
  ]);
  expect(catalog.view().rows[0]?.diagnosticCount).toBe(2);
});
