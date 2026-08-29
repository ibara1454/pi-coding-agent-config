import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { ExtensionCatalog } from "./catalog.ts";
import { ExtensionManagerPanel, type PanelResult } from "./panel.ts";
import {
  catalogRow,
  defaultPanelRows,
  panelCatalogSeed,
} from "./panel-test-fixtures.ts";
import type { CatalogDiagnostic, CatalogRow, CommitResult } from "./types.ts";

const openPanels: ExtensionManagerPanel[] = [];

afterEach(() => {
  for (const panel of openPanels.splice(0)) {
    panel.dispose();
  }
});

function panelCatalog(
  rows: readonly CatalogRow[],
  commit: () => Promise<CommitResult> = async () => ({
    scopes: [],
    committedScopes: [],
  }),
  diagnostics: readonly CatalogDiagnostic[] = [],
): ExtensionCatalog {
  return new ExtensionCatalog(panelCatalogSeed(rows, diagnostics), commit);
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
  readonly renders: { count: number };
  readonly results: PanelResult[];
  readonly writes: string[];
} {
  const rows = options.rows ?? defaultPanelRows();
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
  openPanels.push(panel);
  return {
    catalog,
    finished,
    panel,
    renders: terminal.renders,
    results,
    writes: terminal.writes,
  };
}

// Snapshots keep the padded frame shape but drop the trailing cell padding so
// the external snapshot stays reviewable; width budgets are asserted below.
function frame(panel: ExtensionManagerPanel, width: number): string {
  return panel
    .render(width)
    .map((line) => line.replace(/ +$/, ""))
    .join("\n");
}

describe("ExtensionManagerPanel.render", () => {
  test("should render the default narrow list", () => {
    const { panel } = makePanel();

    expect(frame(panel, 70)).toMatchSnapshot();
  });

  test("should render the default wide list beside the inspector", () => {
    const { panel } = makePanel();

    expect(frame(panel, 120)).toMatchSnapshot();
  });

  test("should render stable search results", () => {
    const { panel } = makePanel();
    panel.render(70);
    for (const character of "rev") {
      panel.handleInput(character);
    }

    expect(frame(panel, 70)).toMatchSnapshot();
  });

  test("should render the focused inspector", () => {
    const { panel } = makePanel();
    panel.render(120);
    panel.handleInput("\r");

    expect(frame(panel, 120)).toMatchSnapshot();
  });

  test("should render the close confirmation", () => {
    const { panel } = makePanel();
    panel.render(70);
    panel.handleInput(" ");
    panel.handleInput("\u001b");

    expect(frame(panel, 70)).toMatchSnapshot();
  });

  test("should render the self-disable warning", () => {
    const selfPath = "/repo/alpha.ts";
    const { panel } = makePanel({
      rows: [catalogRow("alpha", "extension", "Settings", selfPath)],
      selfPath,
    });
    panel.render(70);
    panel.handleInput(" ");

    expect(frame(panel, 70)).toMatchSnapshot();
  });

  test("should render discovery diagnostics", () => {
    const { panel } = makePanel({
      diagnostics: [
        {
          scope: "global",
          path: "/agent/settings.json",
          message: "extensions[1] must be a string",
        },
        {
          scope: "project",
          source: "npm:kit",
          message: "skills[0] must be a string",
        },
      ],
    });

    expect(frame(panel, 120)).toMatchSnapshot();
  });

  test("should render the partial commit error state", async () => {
    const { panel } = makePanel({
      commit: async () => ({
        scopes: [
          { scope: "global", status: "failed", message: "denied" },
          { scope: "project", status: "conflict", message: "changed" },
        ],
        committedScopes: [],
      }),
    });
    panel.render(70);
    panel.handleInput(" ");
    panel.handleInput("\u0013");
    await Bun.sleep(0);

    expect(frame(panel, 70)).toMatchSnapshot();
  });
  test.each([70, 100, 120])(
    "should fill exactly %i cells at the terminal width",
    (width: number) => {
      const { panel } = makePanel();
      const lines = panel.render(width);

      expect(lines).toHaveLength(18);
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
    },
  );

  test.each([70, 120])(
    "should keep dialog frames inside the %i-cell budget",
    (width: number) => {
      const { panel } = makePanel();
      panel.render(width);
      panel.handleInput(" ");
      panel.handleInput("\u001b");
      const lines = panel.render(width);

      expect(lines.join("\n")).toContain("Apply staged changes");
      expect(lines).toHaveLength(18);
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
    },
  );

  test("should leave fullscreen mouse modes unchanged and omit click support", () => {
    const { panel, writes } = makePanel({ mode: "fullscreen" });
    const lines = panel.render(80);

    expect(writes).toEqual([]);
    expect(lines.join("\n")).toContain("Wheel");
    expect(lines.join("\n")).not.toContain("Click/wheel");
  });

  test("should render the first malformed discovery item instead of only its count", () => {
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

  test("should mark rows affected by source diagnostics", () => {
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

  test("should sanitize row diagnostics before rendering the inspector", () => {
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

  test("should strip hyperlink escapes from row names instead of rendering them", () => {
    const hyperlink =
      "alpha\u001b]8;;https://example.com\u0007label\u001b]8;;\u0007";
    const { panel } = makePanel({
      rows: [
        {
          ...catalogRow("alpha", "extension", "Settings"),
          name: hyperlink,
        },
        catalogRow(
          "project-review",
          "skill",
          "npm:kit",
          "/repo/review/SKILL.md",
        ),
      ],
    });
    const lines = panel.render(120);

    expect(lines.join("\n")).toContain("alphalabel");
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.join("\n")).not.toContain("\u0007");
    expect(lines.every((line) => visibleWidth(line) === 120)).toBe(true);
  });
});

describe("ExtensionManagerPanel.dispose", () => {
  test("should release regular-mode mouse state exactly once", () => {
    const { panel, writes } = makePanel();
    panel.render(80);

    expect(writes[0]).toContain("?1000h");

    panel.dispose();
    panel.dispose();
    expect(writes.filter((write) => write.includes("?1000l"))).toHaveLength(1);
  });

  test("should release regular-mode mouse state when discard closes the panel", () => {
    const commit = mock(
      async (): Promise<CommitResult> => ({
        scopes: [],
        committedScopes: [],
      }),
    );
    const { panel, writes } = makePanel({ commit });
    panel.render(70);
    panel.handleInput(" ");
    panel.handleInput("\u001b");

    panel.handleInput("\u001b[D");
    panel.handleInput("\r");

    expect(writes.filter((write) => write.includes("?1000l"))).toHaveLength(1);
  });
});

describe("ExtensionManagerPanel.handleInput", () => {
  test("should open narrow details with Enter and return to the list with Escape", () => {
    const { panel } = makePanel();
    panel.render(70);
    panel.handleInput("\r");
    expect(panel.render(70).join("\n")).toContain("Resolved path:");

    panel.handleInput("\u001b");
    expect(panel.render(70).join("\n")).toContain("[x]");
  });

  test("should expand and focus the wide inspector until Escape", () => {
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

  test("should route printable input to search but keep j and k as navigation", () => {
    const { panel } = makePanel();
    panel.render(70);

    panel.handleInput("j");
    let rendered = panel.render(70).join("\n");
    expect(rendered).toContain("type to filter");
    expect(rendered).toContain("> [x] P project-review");

    for (const character of "rev") {
      panel.handleInput(character);
    }
    rendered = panel.render(70).join("\n");
    expect(rendered).toContain("Search: rev");
    expect(rendered).toContain("project-review");
    expect(rendered).not.toContain("alpha");

    panel.handleInput("\u007f");
    rendered = panel.render(70).join("\n");
    expect(rendered).toContain("Search: re");
    expect(rendered).not.toContain("Search: rev");
  });

  test("should ignore list keys while the inspector is focused", () => {
    const { catalog, panel } = makePanel();
    panel.render(70);
    panel.handleInput("\r");

    panel.handleInput("j");
    panel.handleInput(" ");
    const rendered = panel.render(70).join("\n");

    expect(rendered).toContain("Resolved path: /repo/alpha.ts");
    expect(rendered).not.toContain("Search: j");
    expect(catalog.hasChanges()).toBe(false);
  });

  test("should clear search with Escape before closing", () => {
    const { panel, results } = makePanel();
    panel.render(70);
    panel.handleInput("a");
    panel.handleInput("\u001b");
    expect(results).toEqual([]);
    expect(panel.render(70).join("\n")).toContain("type to filter");

    panel.handleInput("\u001b");
    expect(results).toEqual([{ type: "closed" }]);
  });

  test("should warn before staging self-disable and stage only on confirmation", () => {
    const selfPath = "/repo/alpha.ts";
    const { catalog, panel } = makePanel({
      rows: [catalogRow("alpha", "extension", "Settings", selfPath)],
      selfPath,
    });
    panel.render(70);
    panel.handleInput(" ");
    expect(panel.render(70).join("\n")).toContain("Disable Extension Manager?");
    expect(catalog.hasChanges()).toBe(false);

    panel.handleInput("\r");
    expect(panel.render(70).join("\n")).not.toContain(
      "Disable Extension Manager?",
    );
    expect(catalog.hasChanges()).toBe(false);

    panel.handleInput(" ");
    panel.handleInput("\u001b[D");
    panel.handleInput("\r");
    expect(catalog.view().rows[0]?.configured).toBe(false);
  });

  test("should cancel the close dialog and keep staged changes", () => {
    const commit = mock(
      async (): Promise<CommitResult> => ({
        scopes: [],
        committedScopes: [],
      }),
    );
    const { catalog, panel, results } = makePanel({ commit });
    panel.render(70);
    panel.handleInput(" ");
    panel.handleInput("\u001b");

    panel.handleInput("\r");

    expect(results).toEqual([]);
    expect(catalog.hasChanges()).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    expect(panel.render(70).join("\n")).toContain("> [ ] G alpha");
  });

  test("should discard staged changes and close when discard is confirmed", () => {
    const commit = mock(
      async (): Promise<CommitResult> => ({
        scopes: [],
        committedScopes: [],
      }),
    );
    const { catalog, panel, results } = makePanel({ commit });
    panel.render(70);
    panel.handleInput(" ");
    panel.handleInput("\u001b");

    panel.handleInput("\u001b[D");
    panel.handleInput("\r");

    expect(results).toEqual([{ type: "closed" }]);
    expect(catalog.hasChanges()).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });

  test("should report missing staged changes without calling the committer", () => {
    const commit = mock(
      async (): Promise<CommitResult> => ({
        scopes: [],
        committedScopes: [],
      }),
    );
    const { panel, results } = makePanel({ commit });
    panel.render(70);

    panel.handleInput("\u0013");

    expect(commit).not.toHaveBeenCalled();
    expect(results).toEqual([]);
    expect(panel.render(70).join("\n")).toContain("No staged changes");
  });
  const layouts: [string, number][] = [
    ["narrow", 70],
    ["wide", 120],
  ];

  test.each(layouts)(
    "should toggle a row on the second regular click in %s layout",
    (_layout: string, width: number) => {
      const { catalog, panel } = makePanel();
      panel.render(width);

      panel.handleInput("\u001b[<0;2;9M");
      expect(catalog.hasChanges()).toBe(false);
      panel.handleInput("\u001b[<0;2;9M");

      expect(
        catalog.view().rows.find((row) => row.id === "project-review")
          ?.configured,
      ).toBe(false);
    },
  );

  test("should toggle an unselected row on its checkbox click", () => {
    const { catalog, panel } = makePanel();
    panel.render(70);

    panel.handleInput("\u001b[<0;3;9M");

    expect(
      catalog.view().rows.find((row) => row.id === "project-review")
        ?.configured,
    ).toBe(false);
  });

  test("should switch tabs from a header click", () => {
    const { panel } = makePanel();
    panel.render(70);

    panel.handleInput("\u001b[<0;8;3M");

    const rendered = panel.render(70).join("\n");
    expect(rendered).toContain("alpha");
    expect(rendered).not.toContain("project-review");
  });

  test("should ignore fullscreen clicks but accept fullscreen wheel input", () => {
    const { catalog, panel } = makePanel({ mode: "fullscreen" });
    panel.render(70);
    panel.handleInput("\u001b[<0;3;9M");
    expect(catalog.hasChanges()).toBe(false);

    panel.handleInput("\u001b[<65;1;1M");
    expect(panel.render(70).join("\n")).toContain("project-review");
  });

  test("should request a render only for handled mouse events", () => {
    const { panel, renders } = makePanel();
    panel.render(70);
    const before = renders.count;

    panel.handleInput("\u001b[<0;40;17M");
    expect(renders.count).toBe(before);

    panel.handleInput("\u001b[<0;3;9M");
    expect(renders.count).toBe(before + 1);
  });
});
