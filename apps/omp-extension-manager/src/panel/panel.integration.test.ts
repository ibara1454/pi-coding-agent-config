import { afterEach, describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type {
  CatalogRow,
  CommitRequest,
  CommitResult,
} from "../catalog/index.ts";
import { ExtensionCatalog } from "../catalog/index.ts";
import { ExtensionManagerPanel, type PanelResult } from "./panel.ts";
import {
  catalogRow,
  defaultPanelRows,
  panelCatalogSeed,
} from "./test/panel.helper.ts";

const ESCAPE = "\u001b";
const LEFT = "\u001b[D";
const ENTER = "\r";
const CTRL_S = "\u0013";
const SPACE = " ";
const DISPLAYED_ROW = /^[ >] \[x\] [GP] (\S+)/;
const NARROW_PANEL_WIDTH = 70;

const openPanels: ExtensionManagerPanel[] = [];

afterEach(() => {
  for (const panel of openPanels.splice(0)) {
    panel.dispose();
  }
});

function plainTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
  } as Theme;
}

function fakeTui(): { readonly tui: TUI; readonly writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    tui: {
      mode: "regular",
      terminal: {
        rows: 18,
        columns: 120,
        write(data: string) {
          writes.push(data);
        },
      },
      requestRender() {
        // Tests render frames explicitly; no host render loop is running.
      },
    } as TUI,
  };
}

function makePanel(
  options: {
    readonly commit?: (request: CommitRequest) => Promise<CommitResult>;
    readonly rows?: readonly CatalogRow[];
    readonly selfPath?: string;
  } = {},
): {
  readonly catalog: ExtensionCatalog;
  readonly finished: Promise<PanelResult>;
  readonly panel: ExtensionManagerPanel;
  readonly writes: string[];
} {
  const rows = options.rows ?? defaultPanelRows();
  const catalog = new ExtensionCatalog(
    panelCatalogSeed(rows),
    options.commit ??
      (async () => ({
        scopes: [],
        committedScopes: [],
      })),
  );
  const terminal = fakeTui();
  const { promise: finished, resolve: resolveFinished } =
    Promise.withResolvers<PanelResult>();
  const panel = new ExtensionManagerPanel({
    catalog,
    done: (result) => {
      resolveFinished(result);
    },
    selfPath: options.selfPath ?? "/missing/index.ts",
    theme: plainTheme(),
    tui: terminal.tui,
  });
  openPanels.push(panel);
  return { catalog, finished, panel, writes: terminal.writes };
}

describe("ExtensionManagerPanel.handleInput", () => {
  it.each([
    ["Extensions", "\t", "extension", ""],
    ["Skills", LEFT, "skill", ""],
    ["filtered Skills", LEFT, "skill", "ill"],
  ] as const)(
    "should visit adjacent rendered rows in both directions when navigating %s source groups",
    (_label, tabKey, kind, query) => {
      const { panel } = makePanel({
        rows: [
          catalogRow("alpha-skill", kind, "Settings"),
          catalogRow("beta-skill", kind, "npm:kit"),
          catalogRow("charlie-skill", kind, "Settings"),
          catalogRow("delta-skill", kind, "npm:kit"),
        ],
      });
      panel.render(NARROW_PANEL_WIDTH);
      panel.handleInput(tabKey);
      for (const character of query) {
        panel.handleInput(character);
      }

      const displayedRows = panel.render(NARROW_PANEL_WIDTH).flatMap((line) => {
        const match = line.match(DISPLAYED_ROW);
        return match === null ? [] : [match[1]];
      });
      expect(displayedRows).toEqual([
        "beta-skill",
        "delta-skill",
        "alpha-skill",
        "charlie-skill",
      ]);

      for (const _row of displayedRows) {
        panel.handleInput("\u001b[A");
      }
      for (const name of displayedRows) {
        expect(
          panel
            .render(NARROW_PANEL_WIDTH)
            .find((line) => line.startsWith("> ")),
        ).toContain(name);
        panel.handleInput("\u001b[B");
      }
      for (const name of displayedRows.toReversed()) {
        expect(
          panel
            .render(NARROW_PANEL_WIDTH)
            .find((line) => line.startsWith("> ")),
        ).toContain(name);
        panel.handleInput("\u001b[A");
      }
      expect(
        panel.render(NARROW_PANEL_WIDTH).find((line) => line.startsWith("> ")),
      ).toContain(displayedRows[0]);
    },
  );

  it("should apply staged changes and forward catalog mutations when the close dialog applies", async () => {
    const requests: CommitRequest[] = [];
    const commitResult: CommitResult = {
      scopes: [{ scope: "global", status: "committed" }],
      committedScopes: ["global"],
    };
    const { finished, panel, writes } = makePanel({
      commit: (request) => {
        requests.push(request);
        return Promise.resolve(commitResult);
      },
    });
    panel.render(NARROW_PANEL_WIDTH);
    panel.handleInput(SPACE);
    panel.handleInput(ESCAPE);
    expect(panel.render(NARROW_PANEL_WIDTH).join("\n")).toContain(
      "Apply staged changes",
    );

    panel.handleInput(LEFT);
    panel.handleInput(LEFT);
    panel.handleInput(ENTER);

    expect(await finished).toEqual({
      type: "commit",
      result: commitResult,
      selfDisableCommitted: false,
    });
    expect(
      requests[0]?.mutations.map((mutation) => ({
        enabled: mutation.enabled,
        id: mutation.target.id,
        scope: mutation.scope,
      })),
    ).toEqual([{ enabled: false, id: "alpha", scope: "global" }]);
    expect(writes.filter((write) => write.includes("?1000l"))).toHaveLength(1);
  });

  it("should commit an effective self-disable and show recovery instructions", async () => {
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
    panel.render(NARROW_PANEL_WIDTH);
    panel.handleInput(SPACE);

    const warning = panel.render(NARROW_PANEL_WIDTH).join("\n");
    expect(warning).toContain("Disable Extension Manager?");
    expect(warning).toContain(
      "The command remains available until you run /reload.",
    );
    expect(warning).toContain(
      "Recovery after reload: run `pi config` or edit settings.json.",
    );
    expect(catalog.hasChanges()).toBe(false);

    panel.handleInput(LEFT);
    panel.handleInput(ENTER);
    expect(catalog.hasChanges()).toBe(true);

    panel.handleInput(CTRL_S);

    expect(await finished).toEqual({
      type: "commit",
      result: commitResult,
      selfDisableCommitted: true,
    });
    expect(catalog.selfResolved(selfPath, false)).toBe(false);
  });

  it("should keep self-disable unreported when an uncommitted scope still resolves self", async () => {
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

    panel.handleInput(CTRL_S);

    expect(await finished).toEqual({
      type: "commit",
      result: commitResult,
      selfDisableCommitted: false,
    });
    expect(catalog.selfResolved(selfPath, false)).toBe(true);
  });

  it("should skip the self-disable warning when another scope still resolves self", () => {
    const selfPath = "/repo/self.ts";
    const { catalog, panel } = makePanel({
      rows: [
        catalogRow("global-self", "extension", "Settings", selfPath),
        catalogRow("project-self", "extension", "Settings", selfPath),
      ],
      selfPath,
    });
    panel.render(NARROW_PANEL_WIDTH);

    panel.handleInput(SPACE);

    expect(panel.render(NARROW_PANEL_WIDTH).join("\n")).not.toContain(
      "Disable Extension Manager?",
    );
    expect(
      catalog.view().rows.find((row) => row.id === "global-self")?.configured,
    ).toBe(false);
  });
});
