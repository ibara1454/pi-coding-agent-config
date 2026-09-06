import { describe, expect, test } from "bun:test";
import { ExtensionCatalog } from "./catalog.ts";
import { ExtensionManagerPanelState } from "./panel-state.ts";
import { catalogRow, panelCatalogSeed } from "./panel-test-fixtures.ts";
import type { CatalogRow, ResourceKind } from "./types.ts";

function panelCatalog(rows: readonly CatalogRow[]): ExtensionCatalog {
  return new ExtensionCatalog(panelCatalogSeed(rows), async () => ({
    scopes: [],
    committedScopes: [],
  }));
}

const rows = [
  catalogRow("alpha", "extension", "Settings"),
  catalogRow("beta", "extension", "npm:kit"),
  catalogRow("project-review", "skill", "Settings", "/repo/review/SKILL.md"),
];

function panelState(): ExtensionManagerPanelState {
  return new ExtensionManagerPanelState(panelCatalog(rows));
}

function entryLabels(state: ExtensionManagerPanelState): string[] {
  return state
    .listEntries()
    .map((entry) =>
      entry.type === "header" ? `# ${entry.label}` : entry.row.id,
    );
}

const tabCases: [number, string[], string[], ResourceKind[]][] = [
  [
    0,
    ["Extensions", "Skills"],
    ["# Extensions", "alpha", "beta", "# Skills", "project-review"],
    ["extension", "extension", "skill"],
  ],
  [
    1,
    ["npm:kit", "Settings"],
    ["# npm:kit", "beta", "# Settings", "alpha"],
    ["extension", "extension"],
  ],
  [2, ["Settings"], ["# Settings", "project-review"], ["skill"]],
];

const moveTabCases: [number, number, string][] = [
  [1, 1, "alpha"],
  [-1, 2, "project-review"],
];

describe("ExtensionManagerPanelState.listEntries", () => {
  test.each(tabCases)(
    "should group and filter entries for tab %i",
    (tabIndex: number, headers: string[], labels: string[], _kinds: ResourceKind[]) => {
      const state = panelState();
      state.moveTab(tabIndex);

      expect(
        state
          .listEntries()
          .filter((entry) => entry.type === "header")
          .map((entry) => entry.label),
      ).toEqual(headers);
      expect(entryLabels(state)).toEqual(labels);
    },
  );
});

describe("ExtensionManagerPanelState.moveTab", () => {
  test.each(tabCases)(
    "should select tab %i and expose only its resource kinds",
    (tabIndex: number, _headers: string[], _labels: string[], kinds: ResourceKind[]) => {
      const state = panelState();

      state.moveTab(tabIndex);

      expect(state.tabIndex).toBe(tabIndex);
      expect(state.visibleRows().map((row) => row.kind)).toEqual(kinds);
    },
  );

  test.each(moveTabCases)(
    "should wrap by %i to tab %i, close details, and keep selection %s",
    (delta: number, expectedIndex: number, expectedSelection: string) => {
      const state = panelState();
      state.detailsOpen = true;

      state.moveTab(delta);

      expect(state.tabIndex).toBe(expectedIndex);
      expect(state.detailsOpen).toBe(false);
      expect(state.selectedId).toBe(expectedSelection);
    },
  );
});

describe("ExtensionManagerPanelState.moveSelection", () => {
  test("should select the first row and clamp movement at both ends", () => {
    const state = panelState();
    expect(state.selectedId).toBe("alpha");

    state.moveSelection(-1);
    expect(state.selectedId).toBe("alpha");

    state.moveSelection(10);
    expect(state.selectedId).toBe("project-review");
    expect(state.selectedRow()?.id).toBe("project-review");

    state.moveSelection(-1);
    expect(state.selectedId).toBe("beta");
  });

  test("should keep selection empty when no rows match", () => {
    const state = panelState();
    state.appendSearch("zzzzq");

    state.moveSelection(1);

    expect(state.selectedId).toBeUndefined();
  });
});

describe("ExtensionManagerPanelState.select", () => {
  test("should select only rows that are visible", () => {
    const state = panelState();
    state.appendSearch("npmkit beta");

    state.select("alpha");
    expect(state.selectedId).toBe("beta");

    state.clearSearch();
    state.select("alpha");
    expect(state.selectedId).toBe("alpha");
  });
});

describe("ExtensionManagerPanelState.appendSearch", () => {
  test("should move selection to the sole visible row when the query changes", () => {
    const state = panelState();

    state.appendSearch("npmkit beta");

    expect(state.selectedId).toBe("beta");
  });

  test("should close details when the query changes", () => {
    const state = panelState();
    state.detailsOpen = true;

    state.appendSearch("beta");

    expect(state.detailsOpen).toBe(false);
  });

  test("should fuzzy-search metadata and move selection into the results", () => {
    const state = panelState();
    state.appendSearch("npmkit beta");

    expect(state.query).toBe("npmkit beta");
    expect(state.visibleRows().map((row) => row.id)).toEqual(["beta"]);
    expect(state.selectedId).toBe("beta");
    expect(state.selectedRow()?.id).toBe("beta");
  });

  test("should append astral characters to the query", () => {
    const state = panelState();

    state.appendSearch("na");
    state.appendSearch("\u{1f600}");

    expect(state.query).toBe("na\u{1f600}");
  });

  test("should clear selection when no rows match", () => {
    const state = panelState();

    state.appendSearch("zzzzq");

    expect(state.visibleRows()).toEqual([]);
    expect(state.selectedId).toBeUndefined();
    expect(state.selectedRow()).toBeUndefined();
  });
});

describe("ExtensionManagerPanelState.backspaceSearch", () => {
  test("should drop one code point per backspace, including astral characters", () => {
    const state = panelState();
    state.appendSearch("na");
    state.appendSearch("\u{1f600}");

    state.backspaceSearch();
    expect(state.query).toBe("na");

    state.backspaceSearch();
    expect(state.query).toBe("n");
  });
});

describe("ExtensionManagerPanelState.clearSearch", () => {
  test("should restore the first selection when clearing a query with no matches", () => {
    const state = panelState();
    state.appendSearch("zzzzq");

    state.clearSearch();

    expect(state.query).toBe("");
    expect(state.selectedId).toBe("alpha");
  });
});
