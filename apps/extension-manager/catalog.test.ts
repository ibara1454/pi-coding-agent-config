import { describe, expect, test } from "bun:test";
import { ExtensionCatalog } from "./catalog.ts";
import type {
  CatalogDiagnostic,
  CatalogRow,
  CatalogSeed,
  CommitRequest,
  CommitResult,
  PackageToggleTarget,
  ResourceScope,
  ScopeCommitResult,
  SettingsDocument,
  ToggleTarget,
} from "./types.ts";

const path = "/repo/extensions/shared.ts";
const settingsPath = "/agent/settings.json";

async function noCommit(): Promise<CommitResult> {
  return { scopes: [], committedScopes: [] };
}

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

function catalogFor(
  rows: readonly CatalogRow[],
  targets?: ReadonlyMap<string, ToggleTarget>,
): ExtensionCatalog {
  const staged = targets === undefined ? seed(rows) : seed(rows, targets);
  return new ExtensionCatalog(staged, noCommit);
}

interface ResolutionCandidate {
  readonly id: string;
  readonly scope: ResourceScope;
  readonly kind: "delta" | "package" | "top-level";
  readonly order: number;
  readonly configured?: boolean;
  readonly participates?: boolean;
  readonly participatesWhenDisabled?: boolean;
  readonly participatesWhenEnabled?: boolean;
  readonly resolutionCandidate?: boolean;
}

interface ResolutionCase {
  readonly label: string;
  readonly candidates: readonly ResolutionCandidate[];
  readonly stageId: string;
  readonly stageEnabled: boolean;
  readonly resolved: boolean;
}

function resolutionCatalog(
  candidates: readonly ResolutionCandidate[],
): ExtensionCatalog {
  const rows = candidates.map((c) => ({
    ...row(c.id, c.scope, c.configured ?? true),
    resolutionCandidate: c.resolutionCandidate ?? true,
    resolutionOrder: c.order,
    resolutionParticipant: c.resolutionCandidate ?? true,
  }));
  const targets = new Map<string, ToggleTarget>(
    candidates.map((c) => [
      c.id,
      c.kind === "top-level"
        ? target(c.id, c.scope)
        : packageTarget(c.id, c.scope, {
            autoloadDelta: c.kind === "delta",
            participates: c.participates ?? true,
            participatesWhenDisabled: c.participatesWhenDisabled ?? true,
            participatesWhenEnabled: c.participatesWhenEnabled ?? true,
          }),
    ]),
  );
  return catalogFor(rows, targets);
}

const resolutionCases: readonly ResolutionCase[] = [
  {
    label: "an autoload delta that stops participating yields to its package",
    candidates: [
      { id: "global", scope: "global", kind: "package", order: 1 },
      {
        id: "project",
        scope: "project",
        kind: "delta",
        order: 0,
        participatesWhenDisabled: false,
      },
    ],
    stageId: "project",
    stageEnabled: false,
    resolved: true,
  },
  {
    label: "an enabled autoload delta outranks a disabled package",
    candidates: [
      {
        id: "global",
        scope: "global",
        kind: "package",
        order: 1,
        configured: false,
      },
      {
        id: "project",
        scope: "project",
        kind: "delta",
        order: 0,
        configured: false,
        participates: false,
      },
    ],
    stageId: "project",
    stageEnabled: true,
    resolved: true,
  },
  {
    label: "a disabled top-level winner outranks an enabled package delta",
    candidates: [
      {
        id: "top",
        scope: "project",
        kind: "top-level",
        order: 0,
        configured: false,
      },
      {
        id: "delta",
        scope: "global",
        kind: "delta",
        order: 1,
        configured: false,
        participates: false,
      },
    ],
    stageId: "delta",
    stageEnabled: true,
    resolved: false,
  },
  {
    label: "a row that is not a resolution candidate never resolves",
    candidates: [
      {
        id: "global",
        scope: "global",
        kind: "package",
        order: 0,
        configured: false,
        resolutionCandidate: false,
      },
    ],
    stageId: "global",
    stageEnabled: true,
    resolved: false,
  },
  {
    label: "the lowest ordered candidate decides while it stays enabled",
    candidates: [
      { id: "global", scope: "global", kind: "package", order: 1 },
      { id: "project", scope: "project", kind: "top-level", order: 0 },
    ],
    stageId: "global",
    stageEnabled: false,
    resolved: true,
  },
  {
    label: "disabling the lowest ordered candidate disables resolution",
    candidates: [
      { id: "global", scope: "global", kind: "package", order: 1 },
      { id: "project", scope: "project", kind: "top-level", order: 0 },
    ],
    stageId: "project",
    stageEnabled: false,
    resolved: false,
  },
];

interface CommitCase {
  readonly label: string;
  readonly status: ScopeCommitResult["status"];
  readonly stagedCount: number;
}

const commitCases: readonly CommitCase[] = [
  {
    label: "clears the stage for a committed scope",
    status: "committed",
    stagedCount: 0,
  },
  {
    label: "retains the stage for a conflicting scope",
    status: "conflict",
    stagedCount: 1,
  },
  {
    label: "retains the stage for a failed scope",
    status: "failed",
    stagedCount: 1,
  },
  {
    label: "retains the stage for an unchanged scope",
    status: "unchanged",
    stagedCount: 1,
  },
];

interface DiagnosticCase {
  readonly label: string;
  readonly diagnostic: CatalogDiagnostic;
  readonly first: readonly string[];
  readonly second: readonly string[];
}

const diagnosticCases: readonly DiagnosticCase[] = [
  {
    label: "a source diagnostic reaches only its own package row",
    diagnostic: { scope: "global", source: "npm:first", message: "boom" },
    first: ["boom"],
    second: [],
  },
  {
    label: "a resource path diagnostic reaches every row on that path",
    diagnostic: { scope: "global", path, message: "boom" },
    first: ["boom"],
    second: ["boom"],
  },
  {
    label: "a settings file diagnostic reaches every row in its scope",
    diagnostic: { scope: "global", path: settingsPath, message: "boom" },
    first: ["boom"],
    second: ["boom"],
  },
  {
    label: "a scope wide diagnostic reaches every row in that scope",
    diagnostic: { scope: "global", message: "boom" },
    first: ["boom"],
    second: ["boom"],
  },
  {
    label: "a diagnostic from another scope reaches no row",
    diagnostic: { scope: "project", message: "boom" },
    first: [],
    second: [],
  },
];

function diagnosticCatalog(diagnostic: CatalogDiagnostic): ExtensionCatalog {
  const first: CatalogRow = {
    ...row("first", "global", true),
    source: "npm:first",
  };
  const second: CatalogRow = {
    ...row("second", "global", true),
    source: "npm:second",
  };
  const document: SettingsDocument = {
    scope: "global",
    path: settingsPath,
    content: "{}",
    value: {},
  };
  return new ExtensionCatalog(
    {
      ...seed([first, second]),
      settings: new Map<ResourceScope, SettingsDocument>([
        ["global", document],
      ]),
      diagnostics: [diagnostic],
    },
    noCommit,
  );
}

describe("ExtensionCatalog.stage", () => {
  test("should project a staged toggle and clear it when restored", () => {
    const catalog = catalogFor([row("winner", "project", true)]);

    catalog.stage("winner", false);
    expect(catalog.view().rows[0]?.configured).toBe(false);
    expect(catalog.view().stagedCount).toBe(1);

    catalog.stage("winner", true);
    expect(catalog.view().rows[0]?.configured).toBe(true);
    expect(catalog.hasChanges()).toBe(false);
  });

  test("should throw when staging an unknown catalog row", () => {
    const catalog = catalogFor([row("winner", "project", true)]);
    const message = "Unknown catalog row: missing";

    expect(() => catalog.stage("missing", true)).toThrow(message);
  });

  test("should preserve resolution when staging a shadowed row", () => {
    const catalog = catalogFor([
      row("winner", "project", true),
      row("loser", "global", true, "Project settings"),
    ]);

    catalog.stage("loser", false);
    const shadowed = catalog.view().rows;
    expect(shadowed.every((candidate) => candidate.resolvedAfterReload)).toBe(
      true,
    );

    catalog.stage("winner", false);
    const disabled = catalog.view().rows;
    expect(disabled.every((candidate) => !candidate.resolvedAfterReload)).toBe(
      true,
    );
  });
});

describe("ExtensionCatalog.toggle", () => {
  test("should toggle from the projected state", () => {
    const catalog = catalogFor([row("winner", "project", true)]);

    catalog.toggle("winner");

    expect(catalog.view().rows[0]?.configured).toBe(false);
    expect(catalog.hasChanges()).toBe(true);
  });

  test("should throw when toggling an unknown catalog row", () => {
    const catalog = catalogFor([row("winner", "project", true)]);
    const message = "Unknown catalog row: missing";

    expect(() => catalog.toggle("missing")).toThrow(message);
  });
});

describe("ExtensionCatalog.discard", () => {
  test("should discard every staged toggle", () => {
    const catalog = catalogFor([row("winner", "project", true)]);

    catalog.toggle("winner");
    catalog.discard();

    expect(catalog.view().rows[0]?.configured).toBe(true);
    expect(catalog.hasChanges()).toBe(false);
  });
});

describe("ExtensionCatalog.inspect", () => {
  test("should return configured and resolved provenance", () => {
    const catalog = catalogFor([row("winner", "project", true)]);

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

  test("should project staged top-level filters and their reason", () => {
    const projected = { ...target("winner", "project"), baseDir: "/repo" };
    const catalog = catalogFor(
      [row("winner", "project", true)],
      new Map([["winner", projected]]),
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

  test("should project an explicit-empty package filter and its reason", () => {
    const packagePath = "/global/pkg/extensions/shared.ts";
    const packageRow: CatalogRow = {
      ...row("package", "global", false),
      path: packagePath,
      canonicalPath: packagePath,
      filters: [],
      configurationReason: "Disabled by explicit empty package filter",
      resolvedAfterReload: false,
    };
    const packageToggle: PackageToggleTarget = {
      ...packageTarget("package", "global", { canonicalPath: packagePath }),
      hadFilterField: true,
    };
    const catalog = catalogFor(
      [packageRow],
      new Map([["package", packageToggle]]),
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

  test.each(diagnosticCases.map((entry) => [entry.label, entry] as const))(
    "should project diagnostics for: %s",
    (_label, scenario) => {
      const catalog = diagnosticCatalog(scenario.diagnostic);
      const first = catalog.inspect("first")?.diagnostics;
      const second = catalog.inspect("second")?.diagnostics;
      const rows = catalog.view().rows;
      const firstRow = rows.find((candidate) => candidate.id === "first");

      expect(first).toEqual([...scenario.first]);
      expect(second).toEqual([...scenario.second]);
      expect(firstRow?.diagnosticCount).toBe(scenario.first.length);
    },
  );
});

describe("ExtensionCatalog.selfResolved", () => {
  test.each(resolutionCases.map((entry) => [entry.label, entry] as const))(
    "should match projected resolution for: %s",
    (_label, scenario) => {
      const catalog = resolutionCatalog(scenario.candidates);

      catalog.stage(scenario.stageId, scenario.stageEnabled);

      expect(catalog.selfResolved(path, true)).toBe(scenario.resolved);
    },
  );

  test("should follow the effective row across staged duplicate origins", () => {
    const catalog = catalogFor([
      row("loser", "global", true, "Project settings"),
      row("winner", "project", true),
    ]);

    catalog.stage("loser", false);
    expect(catalog.selfResolved(path, true)).toBe(true);

    catalog.stage("winner", false);
    expect(catalog.selfResolved(path, true)).toBe(false);
  });
});

describe("ExtensionCatalog.wouldDisableSelf", () => {
  test("should canonicalize an equivalent path before projecting itself", () => {
    const catalog = catalogFor([row("winner", "project", true)]);
    const equivalent = "/repo/extensions/../extensions/shared.ts";

    expect(catalog.wouldDisableSelf(equivalent, "winner", false)).toBe(true);
  });

  test("should follow the effective row across duplicate origins", () => {
    const catalog = catalogFor([
      row("loser", "global", true, "Project settings"),
      row("winner", "project", true),
    ]);

    expect(catalog.wouldDisableSelf(path, "loser", false)).toBe(false);
    expect(catalog.wouldDisableSelf(path, "winner", false)).toBe(true);
  });
});

describe("ExtensionCatalog.commit", () => {
  test("should hand the committer opaque documents and mutations", async () => {
    const requests: CommitRequest[] = [];
    const result: CommitResult = {
      scopes: [
        { scope: "global", status: "committed" },
        { scope: "project", status: "failed", message: "disk full" },
      ],
      committedScopes: ["global"],
    };
    const rows = [
      row("global", "global", true),
      row("project", "project", true),
    ];
    const catalog = new ExtensionCatalog(seed(rows), async (request) => {
      requests.push(request);
      return result;
    });
    catalog.stage("global", false);
    catalog.stage("project", false);

    expect(await catalog.commit()).toEqual(result);
    const mutations = requests[0]?.mutations ?? [];
    expect(mutations.map((one) => [one.scope, one.enabled])).toEqual([
      ["global", false],
      ["project", false],
    ]);
    const ids = mutations.map((one) => one.target.id);
    expect(ids).toEqual(["global", "project"]);
    expect(catalog.view().stagedCount).toBe(1);
  });

  test.each(commitCases.map((entry) => [entry.label, entry] as const))(
    "should apply the commit outcome for: %s",
    async (_label, scenario) => {
      const committed = scenario.status === "committed";
      const catalog = new ExtensionCatalog(
        seed([row("global", "global", true)]),
        async () => ({
          scopes: [{ scope: "global", status: scenario.status }],
          committedScopes: committed ? ["global"] : [],
        }),
      );
      catalog.stage("global", false);

      await catalog.commit();

      expect(catalog.view().stagedCount).toBe(scenario.stagedCount);
      expect(catalog.view().rows[0]?.configured).toBe(false);
    },
  );
});
