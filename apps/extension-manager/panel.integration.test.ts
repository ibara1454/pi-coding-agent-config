import { afterEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { ExtensionCatalog } from "./catalog.ts";
import { ExtensionManagerPanel, type PanelResult } from "./panel.ts";
import {
  catalogRow,
  defaultPanelRows,
  panelCatalogSeed,
} from "./panel-test-fixtures.ts";
import type { CatalogRow, CommitRequest, CommitResult } from "./types.ts";

const ESCAPE = "\u001b";
const LEFT = "\u001b[D";
const ENTER = "\r";
const CTRL_S = "\u0013";
const SPACE = " ";

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
      requestRender() {},
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
  readonly results: PanelResult[];
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
  return { catalog, finished, panel, results, writes: terminal.writes };
}

describe("ExtensionManagerPanel.handleInput", () => {
  test("should apply staged changes and forward catalog mutations when the close dialog applies", async () => {
    const requests: CommitRequest[] = [];
    const commitResult: CommitResult = {
      scopes: [{ scope: "global", status: "committed" }],
      committedScopes: ["global"],
    };
    const { finished, panel, writes } = makePanel({
      commit: async (request) => {
        requests.push(request);
        return commitResult;
      },
    });
    panel.render(70);
    panel.handleInput(SPACE);
    panel.handleInput(ESCAPE);
    expect(panel.render(70).join("\n")).toContain("Apply staged changes");

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

  test("should commit an effective self-disable and show recovery instructions", async () => {
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
    panel.render(70);
    panel.handleInput(SPACE);

    const warning = panel.render(70).join("\n");
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

  test("should keep self-disable unreported when an uncommitted scope still resolves self", async () => {
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

  test("should skip the self-disable warning when another scope still resolves self", () => {
    const selfPath = "/repo/self.ts";
    const { catalog, panel } = makePanel({
      rows: [
        catalogRow("global-self", "extension", "Settings", selfPath),
        catalogRow("project-self", "extension", "Settings", selfPath),
      ],
      selfPath,
    });
    panel.render(70);

    panel.handleInput(SPACE);

    expect(panel.render(70).join("\n")).not.toContain(
      "Disable Extension Manager?",
    );
    expect(
      catalog.view().rows.find((row) => row.id === "global-self")?.configured,
    ).toBe(false);
  });

  test("should emit the exact partial commit result consumed by command notifications", async () => {
    const commitResult: CommitResult = {
      scopes: [
        { scope: "global", status: "committed" },
        { scope: "project", status: "failed", message: "disk full" },
      ],
      committedScopes: ["global"],
    };
    const { finished, panel, results, writes } = makePanel({
      commit: async () => commitResult,
    });
    panel.render(70);
    panel.handleInput(SPACE);

    panel.handleInput(CTRL_S);

    expect(await finished).toEqual({
      type: "commit",
      result: commitResult,
      selfDisableCommitted: false,
    });
    expect(results).toHaveLength(1);
    expect(writes.filter((write) => write.includes("?1000l"))).toHaveLength(1);
  });

  interface NoCommitOutcome {
    readonly label: string;
    readonly commit: () => Promise<CommitResult>;
    readonly expectedMessage: string;
  }

  interface NoCommitEntryPoint {
    readonly label: string;
    readonly trigger: (panel: ExtensionManagerPanel) => void;
  }

  type NoCommitCase = [
    entryPoint: string,
    outcome: string,
    trigger: (panel: ExtensionManagerPanel) => void,
    commit: () => Promise<CommitResult>,
    expectedMessage: string,
  ];

  const noCommitOutcomes: NoCommitOutcome[] = [
    {
      label: "all-failed",
      commit: async () => ({
        scopes: [{ scope: "global", status: "failed", message: "denied" }],
        committedScopes: [],
      }),
      expectedMessage: "global: denied",
    },
    {
      label: "conflict",
      commit: async () => ({
        scopes: [{ scope: "global", status: "conflict", message: "changed" }],
        committedScopes: [],
      }),
      expectedMessage: "global: changed",
    },
    {
      label: "unchanged",
      commit: async () => ({
        scopes: [{ scope: "global", status: "unchanged" }],
        committedScopes: [],
      }),
      expectedMessage: "global: unchanged",
    },
    {
      label: "thrown",
      commit: async () => {
        throw new Error("commit exploded");
      },
      expectedMessage: "commit exploded",
    },
  ];

  const noCommitEntryPoints: NoCommitEntryPoint[] = [
    {
      label: "Ctrl-S",
      trigger: (panel) => {
        panel.handleInput(CTRL_S);
      },
    },
    {
      label: "close-dialog Apply",
      trigger: (panel) => {
        panel.handleInput(ESCAPE);
        panel.handleInput(LEFT);
        panel.handleInput(LEFT);
        panel.handleInput(ENTER);
      },
    },
  ];

  const noCommitCases: NoCommitCase[] = noCommitEntryPoints.flatMap(
    (entryPoint) =>
      noCommitOutcomes.map(
        (outcome): NoCommitCase => [
          entryPoint.label,
          outcome.label,
          entryPoint.trigger,
          outcome.commit,
          outcome.expectedMessage,
        ],
      ),
  );

  test.each(noCommitCases)(
    "should keep the panel open and staged when using %s with %s",
    async (_entryPoint: string, _outcome: string, trigger: (
      panel: ExtensionManagerPanel,
    ) => void, commit: () => Promise<CommitResult>, expectedMessage: string) => {
      const { catalog, panel, results, writes } = makePanel({ commit });
      panel.render(70);
      panel.handleInput(SPACE);
      trigger(panel);
      await Bun.sleep(0);

      expect(results).toEqual([]);
      expect(catalog.hasChanges()).toBe(true);
      expect(panel.render(70).join("\n")).toContain(expectedMessage);
      expect(writes.some((write) => write.includes("?1000l"))).toBe(false);

      panel.dispose();
      expect(writes.filter((write) => write.includes("?1000l"))).toHaveLength(
        1,
      );
    },
  );
});
