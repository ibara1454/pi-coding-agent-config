import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { ExtensionCatalog } from "./catalog.ts";
import {
  ExtensionManagerPanel,
  ExtensionManagerPanelState,
  type PanelResult,
} from "./panel.ts";
import type {
  CatalogDiagnostic,
  CatalogRow,
  CatalogSeed,
  CommitResult,
  ResourceKind,
  ToggleTarget,
} from "./types.ts";

function catalogRow(
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

function target(row: CatalogRow): ToggleTarget {
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

function panelCatalog(
  rows: readonly CatalogRow[],
  commit: () => Promise<CommitResult> = async () => ({
    scopes: [],
    committedScopes: [],
  }),
  diagnostics: readonly CatalogDiagnostic[] = [],
): ExtensionCatalog {
  const seed: CatalogSeed = {
    rows,
    targets: new Map(rows.map((row) => [row.id, target(row)])),
    settings: new Map(),
    diagnostics,
    projectTrusted: true,
    tuiMode: "regular",
    reloadPending: false,
  };
  return new ExtensionCatalog(seed, commit);
}

function plainTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme;
}

function fakeTui(
  mode: "regular" | "fullscreen",
  rows = 18,
): {
  readonly tui: TUI;
  readonly writes: string[];
  readonly renders: { count: number };
} {
  const writes: string[] = [];
  const renders = { count: 0 };
  return {
    writes,
    renders,
    tui: {
      mode,
      terminal: {
        rows,
        columns: 120,
        write(data: string) {
          writes.push(data);
        },
      },
      requestRender() {
        renders.count += 1;
      },
    } as unknown as TUI,
  };
}

function makePanel(
  options: {
    readonly diagnostics?: readonly CatalogDiagnostic[];
    readonly mode?: "regular" | "fullscreen";
    readonly rows?: readonly CatalogRow[];
    readonly selfPath?: string;
    readonly commit?: () => Promise<CommitResult>;
  } = {},
): {
  readonly catalog: ExtensionCatalog;
  readonly finished: Promise<PanelResult>;
  readonly panel: ExtensionManagerPanel;
  readonly results: PanelResult[];
  readonly writes: string[];
} {
  const rows = options.rows ?? [
    catalogRow("alpha", "extension", "Settings"),
    catalogRow("project-review", "skill", "npm:kit", "/repo/review/SKILL.md"),
  ];
  const catalog = panelCatalog(rows, options.commit, options.diagnostics);
  const terminal = fakeTui(options.mode ?? "regular");
  const results: PanelResult[] = [];
  const { promise: finished, resolve: resolveFinished } =
    Promise.withResolvers<PanelResult>();
  const panel = new ExtensionManagerPanel({
    catalog,
    done: (result) => {
      results.push(result);
      resolveFinished(result);
    },
    selfPath: options.selfPath ?? "/missing/index.ts",
    theme: plainTheme(),
    tui: terminal.tui,
  });
  return { catalog, finished, panel, results, writes: terminal.writes };
}

describe("panel state", () => {
  const rows = [
    catalogRow("alpha", "extension", "Settings"),
    catalogRow("beta", "extension", "npm:kit"),
    catalogRow("project-review", "skill", "Settings", "/repo/review/SKILL.md"),
  ];

  test("groups All by kind and type tabs by configured source", () => {
    const state = new ExtensionManagerPanelState(panelCatalog(rows));
    expect(
      state
        .listEntries()
        .filter((entry) => entry.type === "header")
        .map((entry) => entry.label),
    ).toEqual(["Extensions", "Skills"]);

    state.moveTab(1);
    expect(
      state
        .listEntries()
        .filter((entry) => entry.type === "header")
        .map((entry) => entry.label),
    ).toEqual(["npm:kit", "Settings"]);
    expect(state.visibleRows().every((row) => row.kind === "extension")).toBe(
      true,
    );
  });

  test("fuzzy-searches metadata and keeps selection within results", () => {
    const state = new ExtensionManagerPanelState(panelCatalog(rows));
    state.appendSearch("npmkit beta");
    expect(state.visibleRows().map((row) => row.id)).toEqual(["beta"]);
    expect(state.selectedId).toBe("beta");

    state.clearSearch();
    state.moveSelection(1);
    expect(state.selectedId).toBe("project-review");
  });
});

describe("panel rendering and input", () => {
  test("owns regular-mode mouse state and renders exactly terminal rows and cells", () => {
    const { panel, writes } = makePanel();
    const lines = panel.render(80);

    expect(writes[0]).toContain("?1000h");
    expect(lines).toHaveLength(18);
    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);

    panel.dispose();
    panel.dispose();
    expect(writes.filter((write) => write.includes("?1000l"))).toHaveLength(1);
  });

  test("does not alter fullscreen mouse modes or claim click support", () => {
    const { panel, writes } = makePanel({ mode: "fullscreen" });
    const lines = panel.render(80);

    expect(writes).toEqual([]);
    expect(lines.join("\n")).toContain("Wheel");
    expect(lines.join("\n")).not.toContain("Click/wheel");
  });

  test("opens narrow details with Enter and Escape returns to the list", () => {
    const { panel } = makePanel();
    panel.render(70);
    panel.handleInput("\r");
    expect(panel.render(70).join("\n")).toContain("Resolved path:");

    panel.handleInput("\u001b");
    expect(panel.render(70).join("\n")).toContain("[x]");
  });

  test("Escape clears search before closing", () => {
    const { panel, results } = makePanel();
    panel.render(70);
    panel.handleInput("a");
    panel.handleInput("\u001b");
    expect(results).toEqual([]);
    expect(panel.render(70).join("\n")).toContain("type to filter");

    panel.handleInput("\u001b");
    expect(results).toEqual([{ type: "closed" }]);
  });

  test("warns before staging self-disable", () => {
    const selfPath = "/repo/alpha.ts";
    const { catalog, panel } = makePanel({
      rows: [catalogRow("alpha", "extension", "Settings", selfPath)],
      selfPath,
    });
    panel.render(70);
    panel.handleInput(" ");
    expect(panel.render(70).join("\n")).toContain("Disable Extension Manager?");
    expect(catalog.hasChanges()).toBe(false);

    panel.handleInput("\u001b[D");
    panel.handleInput("\r");
    expect(catalog.view().rows[0]?.configured).toBe(false);
  });

  test("applies staged changes from the close dialog", async () => {
    const commitResult: CommitResult = {
      scopes: [{ scope: "global", status: "committed" }],
      committedScopes: ["global"],
    };
    const { finished, panel } = makePanel({ commit: async () => commitResult });
    panel.handleInput(" ");
    panel.handleInput("\u001b");
    expect(panel.render(70).join("\n")).toContain("Apply staged changes");

    panel.handleInput("\u001b[D");
    panel.handleInput("\u001b[D");
    panel.handleInput("\r");
    expect(await finished).toEqual({
      type: "commit",
      result: commitResult,
      selfDisableCommitted: false,
    });
  });

  test("reports self-disable only when committed scopes make self unresolved", async () => {
    const selfPath = "/repo/self.ts";
    const commitResult: CommitResult = {
      scopes: [
        { scope: "global", status: "committed" },
        { scope: "project", status: "failed", message: "conflict" },
      ],
      committedScopes: ["global"],
    };
    const { catalog, finished, panel } = makePanel({
      rows: [
        catalogRow("global-self", "extension", "Settings", selfPath),
        catalogRow("project-self", "extension", "Settings", selfPath),
      ],
      selfPath,
      commit: async () => commitResult,
    });
    catalog.stage("global-self", false);
    catalog.stage("project-self", false);

    panel.handleInput("\u0013");

    expect(await finished).toEqual({
      type: "commit",
      result: commitResult,
      selfDisableCommitted: false,
    });
  });

  test("reports self-disable when the committed winner becomes unresolved", async () => {
    const selfPath = "/repo/self.ts";
    const commitResult: CommitResult = {
      scopes: [{ scope: "global", status: "committed" }],
      committedScopes: ["global"],
    };
    const { catalog, finished, panel } = makePanel({
      rows: [catalogRow("global-self", "extension", "Settings", selfPath)],
      selfPath,
      commit: async () => commitResult,
    });
    catalog.stage("global-self", false);

    panel.handleInput("\u0013");

    expect(await finished).toEqual({
      type: "commit",
      result: commitResult,
      selfDisableCommitted: true,
    });
  });

  test("toggles a row on the second regular click in narrow layout", () => {
    const { catalog, panel } = makePanel();
    panel.render(70);

    panel.handleInput("\u001b[<0;2;9M");
    expect(catalog.hasChanges()).toBe(false);
    panel.handleInput("\u001b[<0;2;9M");

    expect(
      catalog.view().rows.find((row) => row.id === "project-review")
        ?.configured,
    ).toBe(false);
  });

  test("toggles a row on the second regular click in wide layout", () => {
    const { catalog, panel } = makePanel();
    panel.render(120);

    panel.handleInput("\u001b[<0;2;9M");
    expect(catalog.hasChanges()).toBe(false);
    panel.handleInput("\u001b[<0;2;9M");

    expect(
      catalog.view().rows.find((row) => row.id === "project-review")
        ?.configured,
    ).toBe(false);
  });

  test("toggles an unselected row on its checkbox click", () => {
    const { catalog, panel } = makePanel();
    panel.render(70);

    panel.handleInput("\u001b[<0;3;9M");

    expect(
      catalog.view().rows.find((row) => row.id === "project-review")
        ?.configured,
    ).toBe(false);
  });

  test("ignores fullscreen clicks but accepts fullscreen wheel input", () => {
    const { catalog, panel } = makePanel({ mode: "fullscreen" });
    panel.render(70);
    panel.handleInput("\u001b[<0;3;9M");
    expect(catalog.hasChanges()).toBe(false);

    panel.handleInput("\u001b[<65;1;1M");
    expect(panel.render(70).join("\n")).toContain("project-review");
  });

  test("expands and focuses the wide inspector until Escape", () => {
    const { panel } = makePanel();
    expect(panel.render(120).join("\n")).toContain("│");

    panel.handleInput("\r");
    const focused = panel.render(120).join("\n");
    expect(focused).toContain("Resolved path:");
    expect(focused).not.toContain("│");

    panel.handleInput("\t");
    expect(panel.render(120).join("\n")).not.toContain("│");

    panel.handleInput("\u001b");
    expect(panel.render(120).join("\n")).toContain("│");
  });
  test("renders the first malformed discovery item instead of only its count", () => {
    const { panel } = makePanel({
      diagnostics: [
        {
          scope: "global",
          path: "/agent/settings.json",
          message: "extensions[1] must be a string",
        },
      ],
    });

    expect(panel.render(120).join("\n")).toContain(
      "Diagnostic [Global · /agent/settings.json]: extensions[1] must be a string",
    );
  });

  test("marks rows affected by source diagnostics", () => {
    const { panel } = makePanel({
      diagnostics: [
        {
          scope: "global",
          source: "Settings",
          message: "invalid extension filter",
        },
      ],
    });

    expect(panel.render(70).join("\n")).toContain("alpha [!]");
  });

  test("sanitizes row diagnostics before rendering the inspector", () => {
    const { panel } = makePanel({
      diagnostics: [
        {
          scope: "global",
          message: "bad\u001b[31m\ninjected",
        },
      ],
    });

    const rendered = panel.render(120).join("\n");
    expect(rendered).toContain("bad injected");
    expect(rendered).not.toContain("\u001b[31m");
  });
});

const noCommitOutcomes: readonly {
  readonly commit: () => Promise<CommitResult>;
  readonly expectedMessage: string;
  readonly label: string;
  readonly retainsStaging: boolean;
}[] = [
  {
    label: "all-failed",
    commit: async () => ({
      scopes: [{ scope: "global", status: "failed", message: "denied" }],
      committedScopes: [],
    }),
    expectedMessage: "global: denied",
    retainsStaging: true,
  },
  {
    label: "conflict",
    commit: async () => ({
      scopes: [{ scope: "global", status: "conflict", message: "changed" }],
      committedScopes: [],
    }),
    expectedMessage: "global: changed",
    retainsStaging: true,
  },
  {
    label: "unchanged",
    commit: async () => ({
      scopes: [{ scope: "global", status: "unchanged" }],
      committedScopes: [],
    }),
    expectedMessage: "global: unchanged",
    retainsStaging: true,
  },
  {
    label: "thrown",
    commit: async () => {
      throw new Error("commit exploded");
    },
    expectedMessage: "commit exploded",
    retainsStaging: true,
  },
];

describe("no-commit outcomes", () => {
  for (const entryPoint of ["Ctrl-S", "close-dialog Apply"] as const) {
    for (const outcome of noCommitOutcomes) {
      test(`${entryPoint} keeps the panel open for ${outcome.label}`, async () => {
        const { catalog, panel, results, writes } = makePanel({
          commit: outcome.commit,
        });
        panel.render(70);
        panel.handleInput(" ");
        if (entryPoint === "Ctrl-S") {
          panel.handleInput("\u0013");
        } else {
          panel.handleInput("\u001b");
          panel.handleInput("\u001b[D");
          panel.handleInput("\u001b[D");
          panel.handleInput("\r");
        }
        await Bun.sleep(0);

        expect(results).toEqual([]);
        expect(catalog.hasChanges()).toBe(outcome.retainsStaging);
        expect(panel.render(70).join("\n")).toContain(outcome.expectedMessage);
        expect(writes.some((write) => write.includes("?1000l"))).toBe(false);

        panel.dispose();
        expect(writes.filter((write) => write.includes("?1000l"))).toHaveLength(
          1,
        );
      });
    }
  }
});
