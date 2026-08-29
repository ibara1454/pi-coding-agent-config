import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  stripTerminalSequences,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionCatalog } from "./catalog.ts";
import { ExtensionManagerPanelState, TABS } from "./panel-state.ts";
import type { CommitResult } from "./types.ts";

const ENABLE_MOUSE = "\u001b[?1000h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1000l";

export type PanelResult =
  | { readonly type: "closed" }
  | {
      readonly type: "commit";
      readonly result: CommitResult;
      readonly selfDisableCommitted: boolean;
    };

interface PanelOptions {
  readonly catalog: ExtensionCatalog;
  readonly done: (result: PanelResult) => void;
  readonly selfPath: string;
  readonly theme: Theme;
  readonly tui: TUI;
}

type DialogState =
  | { readonly type: "close"; choice: number }
  | { readonly type: "self-disable"; choice: number; readonly id: string }
  | undefined;

interface ColumnHit {
  readonly row: number;
  readonly firstColumn: number;
  readonly lastColumn: number;
}

interface TabHit extends ColumnHit {
  readonly index: number;
}

interface RowHit extends ColumnHit {
  readonly id: string;
  readonly toggleFirstColumn: number;
  readonly toggleLastColumn: number;
}

function safeInline(value: string): string {
  let safe = "";
  for (const character of stripTerminalSequences(value)
    .replaceAll("\n", " ")
    .replaceAll("\r", " ")) {
    const code = character.charCodeAt(0);
    if (code >= 32 && code !== 127) {
      safe += character;
    }
  }
  return safe;
}

function fitLine(value: string, width: number): string {
  const truncated = truncateToWidth(value, Math.max(0, width));
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function parseMouse(data: string):
  | {
      readonly button: number;
      readonly column: number;
      readonly row: number;
      readonly pressed: boolean;
    }
  | undefined {
  const prefix = "\u001b[<";
  if (!data.startsWith(prefix)) {
    return undefined;
  }
  const match = data.slice(prefix.length).match(/^(\d+);(\d+);(\d+)([Mm])$/);
  if (match === null) {
    return undefined;
  }
  const button = Number(match[1]);
  const column = Number(match[2]);
  const row = Number(match[3]);
  const pressed = match[4] === "M";
  if (![button, column, row].every(Number.isFinite)) {
    return undefined;
  }
  return { button, column, row, pressed };
}

function isPrintableInput(data: string): boolean {
  if (data === "" || data.startsWith("\u001b")) {
    return false;
  }
  for (const character of data) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) {
      return false;
    }
  }
  return true;
}

export class ExtensionManagerPanel implements Component {
  readonly #catalog: ExtensionCatalog;
  readonly #done: (result: PanelResult) => void;
  readonly #selfPath: string;
  readonly #state: ExtensionManagerPanelState;
  readonly #theme: Theme;
  readonly #tui: TUI;
  readonly #rowHits: RowHit[] = [];
  readonly #tabHits: TabHit[] = [];
  #dialog: DialogState;
  #busy = false;
  #disposed = false;
  #finished = false;
  #listOffset = 0;
  #message: string | undefined;
  #mouseOwned = false;
  #narrow = false;

  constructor(options: PanelOptions) {
    this.#catalog = options.catalog;
    this.#done = options.done;
    this.#selfPath = options.selfPath;
    this.#state = new ExtensionManagerPanelState(options.catalog);
    this.#theme = options.theme;
    this.#tui = options.tui;
    if (this.#tui.mode === "regular") {
      this.#tui.terminal.write(ENABLE_MOUSE);
      this.#mouseOwned = true;
    }
  }

  invalidate(): void {
    this.#tui.requestRender();
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    if (this.#mouseOwned) {
      this.#tui.terminal.write(DISABLE_MOUSE);
      this.#mouseOwned = false;
    }
  }

  render(width: number): string[] {
    const height = Math.max(1, this.#tui.terminal.rows);
    this.#narrow = width < 100;
    this.#rowHits.length = 0;
    this.#tabHits.length = 0;

    const lines =
      this.#dialog === undefined
        ? this.renderMain(width, height)
        : this.renderDialog(width, height);
    while (lines.length < height) {
      lines.push("");
    }
    return lines.slice(0, height).map((line) => fitLine(line, width));
  }

  handleInput(data: string): void {
    if (this.#busy || this.#finished) {
      return;
    }

    const mouse = parseMouse(data);
    if (mouse !== undefined) {
      this.handleMouse(mouse);
      return;
    }

    if (this.#dialog !== undefined) {
      this.handleDialogInput(data);
      return;
    }
    if (
      this.#state.detailsOpen &&
      !matchesKey(data, "escape") &&
      !matchesKey(data, "ctrl+s")
    ) {
      return;
    }

    if (matchesKey(data, "escape")) {
      this.handleEscape();
    } else if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      this.#state.moveTab(1);
    } else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
      this.#state.moveTab(-1);
    } else if (matchesKey(data, "up") || data === "k") {
      this.#state.moveSelection(-1);
    } else if (matchesKey(data, "down") || data === "j") {
      this.#state.moveSelection(1);
    } else if (matchesKey(data, "space")) {
      this.requestToggle();
    } else if (
      matchesKey(data, "enter") &&
      this.#state.selectedRow() !== undefined
    ) {
      this.#state.detailsOpen = true;
    } else if (matchesKey(data, "ctrl+s")) {
      void this.apply();
    } else if (matchesKey(data, "backspace")) {
      this.#state.backspaceSearch();
    } else if (isPrintableInput(data) && data !== "j" && data !== "k") {
      this.#state.appendSearch(data);
    }
    this.invalidate();
  }

  private handleEscape(): void {
    if (this.#state.detailsOpen) {
      this.#state.detailsOpen = false;
      return;
    }
    if (this.#state.query !== "") {
      this.#state.clearSearch();
      return;
    }
    if (this.#catalog.hasChanges()) {
      this.#dialog = { type: "close", choice: 2 };
      return;
    }
    this.finish({ type: "closed" });
  }

  private handleDialogInput(data: string): void {
    const dialog = this.#dialog;
    if (dialog === undefined) {
      return;
    }
    const optionCount = dialog.type === "close" ? 3 : 2;
    if (matchesKey(data, "escape")) {
      this.#dialog = undefined;
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) {
      dialog.choice = (dialog.choice - 1 + optionCount) % optionCount;
      return;
    }
    if (matchesKey(data, "right") || matchesKey(data, "tab")) {
      dialog.choice = (dialog.choice + 1) % optionCount;
      return;
    }
    if (!matchesKey(data, "enter")) {
      return;
    }

    if (dialog.type === "self-disable") {
      this.#dialog = undefined;
      if (dialog.choice === 0) {
        this.#catalog.stage(dialog.id, false);
      }
      return;
    }

    if (dialog.choice === 0) {
      this.#dialog = undefined;
      void this.apply();
    } else if (dialog.choice === 1) {
      this.#catalog.discard();
      this.finish({ type: "closed" });
    } else {
      this.#dialog = undefined;
    }
  }

  private requestToggle(): void {
    const row = this.#state.selectedRow();
    if (row === undefined) {
      return;
    }
    const enabled = !row.configured;
    if (
      !enabled &&
      this.#catalog.wouldDisableSelf(this.#selfPath, row.id, enabled)
    ) {
      this.#dialog = { type: "self-disable", choice: 1, id: row.id };
      return;
    }
    this.#catalog.stage(row.id, enabled);
  }

  private handleMouse(mouse: {
    readonly button: number;
    readonly column: number;
    readonly row: number;
    readonly pressed: boolean;
  }): void {
    if (mouse.button === 64 || mouse.button === 65) {
      this.#state.moveSelection(mouse.button === 64 ? -3 : 3);
      this.invalidate();
      return;
    }
    if (
      this.#tui.mode === "fullscreen" ||
      !mouse.pressed ||
      mouse.button !== 0
    ) {
      return;
    }

    const tab = this.#tabHits.find(
      (hit) =>
        hit.row === mouse.row &&
        mouse.column >= hit.firstColumn &&
        mouse.column <= hit.lastColumn,
    );
    if (tab !== undefined) {
      while (this.#state.tabIndex !== tab.index) {
        this.#state.moveTab(1);
      }
      this.invalidate();
      return;
    }

    const row = this.#rowHits.find(
      (hit) =>
        hit.row === mouse.row &&
        mouse.column >= hit.firstColumn &&
        mouse.column <= hit.lastColumn,
    );
    if (row === undefined) {
      return;
    }
    const wasSelected = this.#state.selectedId === row.id;
    this.#state.select(row.id);
    const checkboxClicked =
      mouse.column >= row.toggleFirstColumn &&
      mouse.column <= row.toggleLastColumn;
    if (wasSelected || checkboxClicked) {
      this.requestToggle();
    }
    this.invalidate();
  }

  private async apply(): Promise<void> {
    if (!this.#catalog.hasChanges()) {
      this.#message = "No staged changes";
      this.invalidate();
      return;
    }
    this.#busy = true;
    this.#message = undefined;
    this.invalidate();
    const selfWasResolved = this.#catalog.selfResolved(this.#selfPath, false);
    try {
      const result = await this.#catalog.commit();
      if (result.committedScopes.length > 0) {
        this.finish({
          type: "commit",
          result,
          selfDisableCommitted:
            selfWasResolved &&
            !this.#catalog.selfResolved(this.#selfPath, false),
        });
        return;
      }
      this.#message = result.scopes
        .map((scope) => `${scope.scope}: ${scope.message ?? scope.status}`)
        .join(" | ");
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    } finally {
      this.#busy = false;
      if (!this.#finished) {
        this.invalidate();
      }
    }
  }

  private finish(result: PanelResult): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    this.dispose();
    this.#done(result);
  }

  private renderMain(width: number, height: number): string[] {
    const view = this.#catalog.view();
    const lines: string[] = [];
    lines.push(this.#theme.bold(this.#theme.fg("accent", "Extension Manager")));

    const banners: string[] = [];
    if (!view.projectTrusted) {
      banners.push(
        "Project is untrusted: project settings are hidden and read-only",
      );
    }
    if (view.reloadPending) {
      banners.push("Saved settings are pending /reload");
    }
    if (view.diagnostics.length > 0) {
      const diagnostic = view.diagnostics[0];
      const marker = [
        diagnostic?.scope === undefined
          ? undefined
          : diagnostic.scope === "global"
            ? "Global"
            : "Project",
        diagnostic?.source,
        diagnostic?.path,
      ]
        .filter((part): part is string => part !== undefined)
        .join(" · ");
      banners.push(
        `Diagnostic${marker === "" ? "" : ` [${marker}]`}: ${diagnostic?.message ?? "Unknown discovery error"}${
          view.diagnostics.length === 1
            ? ""
            : ` (+${view.diagnostics.length - 1} more)`
        }`,
      );
    }
    if (this.#message !== undefined) {
      banners.push(this.#message);
    }
    lines.push(
      this.#theme.fg(
        banners.length === 0 ? "dim" : "warning",
        safeInline(banners.join(" | ") || "Persistent Extensions and Skills"),
      ),
    );

    const tabs = TABS.map((tab, index) => {
      const label = ` ${tab} `;
      return index === this.#state.tabIndex
        ? this.#theme.inverse(label)
        : this.#theme.fg("muted", label);
    });
    lines.push(tabs.join(" "));
    if (this.#tui.mode === "regular") {
      let column = 1;
      for (const [index, tab] of tabs.entries()) {
        const tabWidth = visibleWidth(tab);
        this.#tabHits.push({
          row: 3,
          firstColumn: column,
          lastColumn: column + tabWidth - 1,
          index,
        });
        column += tabWidth + 1;
      }
    }
    lines.push(
      `Search: ${this.#state.query === "" ? this.#theme.fg("dim", "type to filter") : safeInline(this.#state.query)}`,
    );
    lines.push(this.#theme.fg("borderMuted", "─".repeat(Math.max(0, width))));

    const bodyHeight = Math.max(0, height - 7);
    if (this.#state.detailsOpen) {
      lines.push(...this.renderInspector(width, bodyHeight));
    } else if (this.#narrow) {
      lines.push(...this.renderList(width, bodyHeight, 6));
    } else {
      const listWidth = Math.max(36, Math.floor(width * 0.45));
      const inspectorWidth = Math.max(1, width - listWidth - 3);
      const list = this.renderList(listWidth, bodyHeight, 6);
      const inspector = this.renderInspector(inspectorWidth, bodyHeight);
      for (let index = 0; index < bodyHeight; index += 1) {
        lines.push(
          `${fitLine(list[index] ?? "", listWidth)} ${this.#theme.fg("borderMuted", "│")} ${fitLine(inspector[index] ?? "", inspectorWidth)}`,
        );
      }
    }

    lines.push(this.#theme.fg("borderMuted", "─".repeat(Math.max(0, width))));
    const mouseHint =
      this.#tui.mode === "regular" ? "  Click/wheel" : "  Wheel";
    lines.push(
      this.#theme.fg(
        "dim",
        `Tab kind  ↑↓ select  Space toggle  Enter inspect  Ctrl-S apply  Esc back${mouseHint}`,
      ),
    );
    return lines;
  }

  private renderList(
    width: number,
    height: number,
    firstScreenRow: number,
  ): string[] {
    const entries = this.#state.listEntries();
    const selectedEntry = entries.findIndex(
      (entry) =>
        entry.type === "row" && entry.row.id === this.#state.selectedId,
    );
    if (selectedEntry < this.#listOffset) {
      this.#listOffset = selectedEntry;
    } else if (selectedEntry >= this.#listOffset + height) {
      this.#listOffset = selectedEntry - height + 1;
    }
    this.#listOffset = Math.max(
      0,
      Math.min(this.#listOffset, Math.max(0, entries.length - height)),
    );

    const visible = entries.slice(this.#listOffset, this.#listOffset + height);
    return visible.map((entry, index) => {
      if (entry.type === "header") {
        return this.#theme.bold(
          this.#theme.fg("accent", safeInline(entry.label)),
        );
      }
      const selected = entry.row.id === this.#state.selectedId;
      const marker = selected ? ">" : " ";
      const checkbox = entry.row.configured ? "[x]" : "[ ]";
      const scope = entry.row.scope === "global" ? "G" : "P";
      const originCount =
        entry.row.origins.length > 1
          ? ` (${entry.row.origins.length} origins)`
          : "";
      const diagnostic = (entry.row.diagnosticCount ?? 0) > 0 ? " [!]" : "";
      const value = `${marker} ${checkbox} ${scope} ${safeInline(entry.row.name)}${originCount}${diagnostic}`;
      this.#rowHits.push({
        row: firstScreenRow + index,
        firstColumn: 1,
        lastColumn: width,
        id: entry.row.id,
        toggleFirstColumn: 3,
        toggleLastColumn: 5,
      });
      return selected ? this.#theme.inverse(fitLine(value, width)) : value;
    });
  }

  private renderInspector(width: number, height: number): string[] {
    const row = this.#state.selectedRow();
    if (row === undefined) {
      return [this.#theme.fg("dim", "No matching resources")];
    }
    const inspection = this.#catalog.inspect(row.id);
    if (inspection === undefined) {
      return [this.#theme.fg("dim", "Inspection unavailable")];
    }
    const lines = [this.#theme.bold(safeInline(inspection.row.name))];
    if (inspection.row.description !== undefined) {
      lines.push(this.#theme.fg("dim", safeInline(inspection.row.description)));
    }
    for (const field of inspection.fields) {
      lines.push(
        `${this.#theme.fg("muted", `${field.label}:`)} ${safeInline(field.value)}`,
      );
    }
    if (inspection.preview !== undefined) {
      lines.push("", this.#theme.fg("muted", "Preview:"));
      for (const paragraph of inspection.preview.split("\n")) {
        lines.push(...wrapTextWithAnsi(paragraph, Math.max(1, width)));
      }
    }
    if (inspection.diagnostics.length > 0) {
      lines.push("", this.#theme.fg("warning", "Diagnostics:"));
      for (const diagnostic of inspection.diagnostics) {
        lines.push(
          ...wrapTextWithAnsi(safeInline(diagnostic), Math.max(1, width)),
        );
      }
    }
    return lines.slice(0, height);
  }

  private renderDialog(width: number, height: number): string[] {
    const dialog = this.#dialog;
    if (dialog === undefined) {
      return [];
    }
    const lines = Array.from(
      { length: Math.max(0, Math.floor(height / 3)) },
      () => "",
    );
    if (dialog.type === "self-disable") {
      lines.push(
        this.#theme.bold(
          this.#theme.fg("warning", "Disable Extension Manager?"),
        ),
        "The command remains available until you run /reload.",
        "Recovery after reload: run `pi config` or edit settings.json.",
        "",
      );
      const options = ["Disable", "Cancel"];
      lines.push(
        options
          .map((option, index) =>
            index === dialog.choice
              ? this.#theme.inverse(` ${option} `)
              : ` ${option} `,
          )
          .join(" "),
      );
    } else {
      lines.push(this.#theme.bold("Apply staged changes before closing?"), "");
      const options = ["Apply", "Discard", "Cancel"];
      lines.push(
        options
          .map((option, index) =>
            index === dialog.choice
              ? this.#theme.inverse(` ${option} `)
              : ` ${option} `,
          )
          .join(" "),
      );
    }
    return lines.slice(0, height).map((line) => truncateToWidth(line, width));
  }
}
