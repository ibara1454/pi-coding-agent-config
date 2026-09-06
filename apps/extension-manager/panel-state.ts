import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { ExtensionCatalog } from "./catalog.ts";
import type { CatalogRow } from "./types.ts";

export const TABS = ["All", "Extensions", "Skills"] as const;

export type PanelListEntry =
  | { readonly type: "header"; readonly label: string }
  | { readonly type: "row"; readonly row: CatalogRow };

export class ExtensionManagerPanelState {
  readonly #catalog: ExtensionCatalog;
  #tabIndex = 0;
  #query = "";
  #selectedId: string | undefined;
  #detailsOpen = false;

  constructor(catalog: ExtensionCatalog) {
    this.#catalog = catalog;
    this.ensureSelection();
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
    const rows = this.visibleRows();
    if (rows.length === 0) {
      this.#selectedId = undefined;
      return;
    }
    const current = rows.findIndex((row) => row.id === this.#selectedId);
    const next =
      current === -1
        ? 0
        : Math.max(0, Math.min(rows.length - 1, current + delta));
    this.#selectedId = rows[next]?.id;
  }

  moveTab(delta: number): void {
    this.#tabIndex = (this.#tabIndex + delta + TABS.length) % TABS.length;
    this.#detailsOpen = false;
    this.ensureSelection();
  }

  appendSearch(text: string): void {
    this.#query += text;
    this.#detailsOpen = false;
    this.ensureSelection();
  }

  backspaceSearch(): void {
    this.#query = Array.from(this.#query).slice(0, -1).join("");
    this.ensureSelection();
  }

  clearSearch(): void {
    this.#query = "";
    this.ensureSelection();
  }

  selectedRow(): CatalogRow | undefined {
    return this.visibleRows().find((row) => row.id === this.#selectedId);
  }

  private ensureSelection(): void {
    const rows = this.visibleRows();
    if (!rows.some((row) => row.id === this.#selectedId)) {
      this.#selectedId = rows[0]?.id;
    }
  }
}
