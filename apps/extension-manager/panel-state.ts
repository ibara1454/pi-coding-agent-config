import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { ExtensionCatalog } from "./catalog.ts";
import type { CatalogRow } from "./types.ts";

export const TABS = ["All", "Extensions", "Skills"] as const;

export type PanelListEntry =
  | { readonly type: "header"; readonly label: string }
  | { readonly type: "row"; readonly row: CatalogRow };

/**
 * Keeps the current visible selection, falling back to the first visible row.
 * @param rows - Filtered rows in catalog order.
 * @param selectedId - Previously selected row ID, if any.
 * @returns A visible row ID, or `undefined` when no rows remain.
 * @example
 * Given visible rows with IDs "alpha" then "beta":
 * ```ts
 * selectedVisibleId(rows, "beta"); // "beta": retain a selection still visible
 * selectedVisibleId(rows, "hidden"); // "alpha": fall back to the first visible row
 * ```
 */
function selectedVisibleId(
  rows: readonly CatalogRow[],
  selectedId: string | undefined,
): string | undefined {
  return rows.some((row) => row.id === selectedId) ? selectedId : rows[0]?.id;
}

export class ExtensionManagerPanelState {
  readonly #catalog: ExtensionCatalog;
  #tabIndex = 0;
  #query = "";
  #selectedId: string | undefined;
  #detailsOpen = false;

  /**
   * Opens the All tab with the first visible row selected.
   * @param catalog - Catalog supplying live rows and staged configuration.
   * @example
   * With catalog rows "alpha" (extension) then "review" (skill),
   * `new ExtensionManagerPanelState(catalog)` opens All with "alpha" selected;
   * both rows are visible without a search filter.
   */
  constructor(catalog: ExtensionCatalog) {
    this.#catalog = catalog;
    this.#selectedId = selectedVisibleId(this.visibleRows(), this.#selectedId);
  }

  get tabIndex(): number {
    return this.#tabIndex;
  }

  get query(): string {
    return this.#query;
  }

  get selectedId(): string | undefined {
    return this.#selectedId;
  }

  get detailsOpen(): boolean {
    return this.#detailsOpen;
  }

  set detailsOpen(open: boolean) {
    this.#detailsOpen = open;
  }

  visibleRows(): CatalogRow[] {
    const rows = this.#catalog.view().rows.filter((row) => {
      if (this.#tabIndex === 1) {
        return row.kind === "extension";
      }
      if (this.#tabIndex === 2) {
        return row.kind === "skill";
      }
      return true;
    });
    if (this.#query.trim() === "") {
      return rows;
    }
    return fuzzyFilter(rows, this.#query, (row) =>
      [
        row.name,
        row.description ?? "",
        row.path,
        row.source,
        row.kind,
        row.scope,
        ...row.origins.map((origin) => origin.label),
      ].join(" "),
    );
  }

  listEntries(): PanelListEntry[] {
    const rows = this.visibleRows();
    const entries: PanelListEntry[] = [];
    if (this.#tabIndex === 0) {
      for (const kind of ["extension", "skill"] as const) {
        const kindRows = rows.filter((row) => row.kind === kind);
        if (kindRows.length === 0) {
          continue;
        }
        entries.push({
          type: "header",
          label: kind === "extension" ? "Extensions" : "Skills",
        });
        entries.push(...kindRows.map((row) => ({ type: "row" as const, row })));
      }
      return entries;
    }

    const sources = Array.from(new Set(rows.map((row) => row.source))).sort(
      (left, right) => left.localeCompare(right),
    );
    for (const source of sources) {
      entries.push({ type: "header", label: source });
      entries.push(
        ...rows
          .filter((row) => row.source === source)
          .map((row) => ({ type: "row" as const, row })),
      );
    }
    return entries;
  }

  select(id: string): void {
    if (this.visibleRows().some((row) => row.id === id)) {
      this.#selectedId = id;
    }
  }

  moveSelection(delta: number): void {
    const rows = this.listEntries().filter((entry) => entry.type === "row");
    if (rows.length === 0) {
      this.#selectedId = undefined;
      return;
    }
    const current = rows.findIndex(
      (entry) => entry.row.id === this.#selectedId,
    );
    const next =
      current === -1
        ? 0
        : Math.max(0, Math.min(rows.length - 1, current + delta));
    this.#selectedId = rows[next]?.row.id;
  }

  /**
   * Changes tabs with wrapping, closes details, and keeps selection visible.
   * @param delta - Signed number of tabs to move.
   * @example state.moveTab(-1); // From All, selects the Skills tab.
   */
  moveTab(delta: number): void {
    this.#tabIndex = (this.#tabIndex + delta + TABS.length) % TABS.length;
    this.#detailsOpen = false;
    this.#selectedId = selectedVisibleId(this.visibleRows(), this.#selectedId);
  }

  /**
   * Extends the search query, closes details, and selects a matching row.
   * @param text - Search text to append without normalization.
   * @example
   * With empty search, details open on "alpha", and only row "beta" matching "beta",
   * `state.appendSearch("beta")` closes details and selects "beta".
   */
  appendSearch(text: string): void {
    this.#query += text;
    this.#detailsOpen = false;
    this.#selectedId = selectedVisibleId(this.visibleRows(), this.#selectedId);
  }

  /**
   * Removes the final Unicode code point and keeps selection in the results.
   * @example
   * ```ts
   * state.clearSearch();
   * state.appendSearch("na\u{1f600}");
   * state.backspaceSearch();
   * state.query; // "na": removes the whole astral code point, not half a surrogate pair
   * ```
   */
  backspaceSearch(): void {
    this.#query = Array.from(this.#query).slice(0, -1).join("");
    this.#selectedId = selectedVisibleId(this.visibleRows(), this.#selectedId);
  }

  /**
   * Clears the query while preserving the selected row when it remains visible.
   * @example
   * With the Extensions tab filtered to selected row "beta" by query "beta",
   * `state.clearSearch()` shows all extensions again and keeps "beta" selected.
   */
  clearSearch(): void {
    this.#query = "";
    this.#selectedId = selectedVisibleId(this.visibleRows(), this.#selectedId);
  }

  selectedRow(): CatalogRow | undefined {
    return this.visibleRows().find((row) => row.id === this.#selectedId);
  }
}
