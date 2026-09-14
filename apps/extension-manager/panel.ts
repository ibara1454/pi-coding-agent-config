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

interface PanelState extends PanelOptions {
  readonly model: ExtensionManagerPanelState;
  readonly rowHits: RowHit[];
  readonly tabHits: TabHit[];
  dialog: DialogState;
  busy: boolean;
  disposed: boolean;
  finished: boolean;
  listOffset: number;
  message: string | undefined;
  mouseOwned: boolean;
  narrow: boolean;
}

export class ExtensionManagerPanel implements Component {
  readonly #state: PanelState;

  /**
   * Opens a panel, acquiring mouse reporting only in regular terminal mode.
   * @param options - Catalog, host hooks, theme, and manager path retained by the panel.
   * @throws If enabling terminal mouse reporting fails.
   * @example
   * new ExtensionManagerPanel(options); // In regular mode, enables SGR mouse reporting.
   */
  constructor(options: PanelOptions) {
    this.#state = {
      catalog: options.catalog,
      done: options.done,
      selfPath: options.selfPath,
      model: new ExtensionManagerPanelState(options.catalog),
      theme: options.theme,
      tui: options.tui,
      rowHits: [],
      tabHits: [],
      dialog: undefined,
      busy: false,
      disposed: false,
      finished: false,
      listOffset: 0,
      message: undefined,
      mouseOwned: false,
      narrow: false,
    };
    if (this.#state.tui.mode === "regular") {
      this.#state.tui.terminal.write(ENABLE_MOUSE);
      this.#state.mouseOwned = true;
    }
  }

  /**
   * Requests a host render without changing panel state.
   * @example
   * panel.invalidate(); // Queues a redraw through the owning TUI.
   */
  invalidate(): void {
    this.#state.tui.requestRender();
  }

  /**
   * Releases this panel's mouse reporting once; fullscreen mouse modes are untouched.
   * @throws If the terminal write restoring mouse reporting fails.
   * @example
   * panel.dispose(); panel.dispose(); // Sends at most one mouse-disable sequence.
   */
  dispose(): void {
    const state = this.#state;
    if (state.disposed) {
      return;
    }
    state.disposed = true;
    if (state.mouseOwned) {
      state.tui.terminal.write(DISABLE_MOUSE);
      state.mouseOwned = false;
    }
  }

  /**
   * Renders a terminal-height frame and refreshes its row and tab mouse hit regions.
   * @param width - Available terminal cells per line; widths below 100 use one pane.
   * @returns Lines padded and clipped to the requested cell width and terminal height.
   * @example
   * panel.render(70); // An 18-row terminal receives 18 lines of 70 visible cells.
   */
  render(width: number): string[] {
    const state = this.#state;
    const height = Math.max(1, state.tui.terminal.rows);
    state.narrow = width < 100;
    state.rowHits.length = 0;
    state.tabHits.length = 0;

    const lines =
      state.dialog === undefined
        ? renderMain(state, width, height)
        : renderDialog(state.dialog, state.theme, width, height);
    while (lines.length < height) {
      lines.push("");
    }
    return lines.slice(0, height).map((line) => fitLine(line, width));
  }

  /**
   * Routes keyboard or SGR mouse input, ignoring events while committing or finished.
   * @param data - Raw terminal input; focused dialogs and inspectors constrain key actions.
   * @example
   * panel.handleInput(" "); // Stages the selected row, or asks before disabling this manager.
   */
  handleInput(data: string): void {
    const state = this.#state;
    if (state.busy || state.finished) {
      return;
    }

    const mouse = parseMouse(data);
    if (mouse !== undefined) {
      handleMouse(state, this, mouse);
      return;
    }

    if (state.dialog !== undefined) {
      handleDialogInput(state, this, data);
      return;
    }
    if (
      state.model.detailsOpen &&
      !matchesKey(data, "escape") &&
      !matchesKey(data, "ctrl+s")
    ) {
      return;
    }

    if (matchesKey(data, "escape")) {
      handleEscape(state, this);
    } else if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      state.model.moveTab(1);
    } else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
      state.model.moveTab(-1);
    } else if (matchesKey(data, "up") || data === "k") {
      state.model.moveSelection(-1);
    } else if (matchesKey(data, "down") || data === "j") {
      state.model.moveSelection(1);
    } else if (matchesKey(data, "space")) {
      requestToggle(state);
    } else if (
      matchesKey(data, "enter") &&
      state.model.selectedRow() !== undefined
    ) {
      state.model.detailsOpen = true;
    } else if (matchesKey(data, "ctrl+s")) {
      void apply(state, this);
    } else if (matchesKey(data, "backspace")) {
      state.model.backspaceSearch();
    } else if (isPrintableInput(data) && data !== "j" && data !== "k") {
      state.model.appendSearch(data);
    }
    this.invalidate();
  }
}

/**
 * Backs out of details, then search, then closes or asks how to resolve staged changes.
 * @param state - Owned panel state whose navigation or close dialog may change.
 * @param panel - Lifecycle owner used when closing without staged changes.
 * @example
 * handleEscape(state, panel); // With query "rev", clears search without closing.
 */
function handleEscape(state: PanelState, panel: ExtensionManagerPanel): void {
  if (state.model.detailsOpen) {
    state.model.detailsOpen = false;
    return;
  }
  if (state.model.query !== "") {
    state.model.clearSearch();
    return;
  }
  if (state.catalog.hasChanges()) {
    state.dialog = { type: "close", choice: 2 };
    return;
  }
  finish(state, panel, { type: "closed" });
}

/**
 * Cycles confirmation choices and applies the chosen stage, commit, discard, or cancel action.
 * @param state - Owned state containing the active dialog and staged catalog.
 * @param panel - Lifecycle owner used for commits and closure.
 * @param data - Raw terminal key input; unrelated keys leave the dialog unchanged.
 * @example
 * handleDialogInput(state, panel, "\r"); // A close dialog on Cancel keeps staged changes.
 */
function handleDialogInput(
  state: PanelState,
  panel: ExtensionManagerPanel,
  data: string,
): void {
  const dialog = state.dialog;
  if (dialog === undefined) {
    return;
  }
  const optionCount = dialog.type === "close" ? 3 : 2;
  if (matchesKey(data, "escape")) {
    state.dialog = undefined;
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
    state.dialog = undefined;
    if (dialog.choice === 0) {
      state.catalog.stage(dialog.id, false);
    }
    return;
  }

  if (dialog.choice === 0) {
    state.dialog = undefined;
    void apply(state, panel);
  } else if (dialog.choice === 1) {
    state.catalog.discard();
    finish(state, panel, { type: "closed" });
  } else {
    state.dialog = undefined;
  }
}

/**
 * Stages the selected resource's opposite setting, asking before disabling the manager.
 * @param state - Selection and catalog to update; an empty selection is a no-op.
 * @example
 * requestToggle(state); // An enabled non-manager row "alpha" becomes staged off.
 */
function requestToggle(state: PanelState): void {
  const row = state.model.selectedRow();
  if (row === undefined) {
    return;
  }
  const enabled = !row.configured;
  if (
    !enabled &&
    state.catalog.wouldDisableSelf(state.selfPath, row.id, enabled)
  ) {
    state.dialog = { type: "self-disable", choice: 1, id: row.id };
    return;
  }
  state.catalog.stage(row.id, enabled);
}

/**
 * Navigates wheel input in either mode and uses regular-mode tab, row, and checkbox hits.
 * @param state - Selection and hit regions from the most recent frame.
 * @param panel - Lifecycle owner notified only when a mouse event is handled.
 * @param mouse - Decoded SGR event with one-based screen coordinates.
 * @example
 * handleMouse(state, panel, { button: 65, column: 1, row: 1, pressed: true });
 * // Moves down three selectable rows and requests a redraw, even in fullscreen mode.
 */
function handleMouse(
  state: PanelState,
  panel: ExtensionManagerPanel,
  mouse: {
    readonly button: number;
    readonly column: number;
    readonly row: number;
    readonly pressed: boolean;
  },
): void {
  if (mouse.button === 64 || mouse.button === 65) {
    state.model.moveSelection(mouse.button === 64 ? -3 : 3);
    panel.invalidate();
    return;
  }
  if (state.tui.mode === "fullscreen" || !mouse.pressed || mouse.button !== 0) {
    return;
  }

  const tab = state.tabHits.find(
    (hit) =>
      hit.row === mouse.row &&
      mouse.column >= hit.firstColumn &&
      mouse.column <= hit.lastColumn,
  );
  if (tab !== undefined) {
    while (state.model.tabIndex !== tab.index) {
      state.model.moveTab(1);
    }
    panel.invalidate();
    return;
  }

  const row = state.rowHits.find(
    (hit) =>
      hit.row === mouse.row &&
      mouse.column >= hit.firstColumn &&
      mouse.column <= hit.lastColumn,
  );
  if (row === undefined) {
    return;
  }
  const wasSelected = state.model.selectedId === row.id;
  state.model.select(row.id);
  const checkboxClicked =
    mouse.column >= row.toggleFirstColumn &&
    mouse.column <= row.toggleLastColumn;
  if (wasSelected || checkboxClicked) {
    requestToggle(state);
  }
  panel.invalidate();
}

/**
 * Commits staged settings, closing after any saved scope and keeping failed attempts editable.
 * @param state - Catalog and busy/message state; self-disable is measured against saved settings.
 * @param panel - Lifecycle owner used for redraws and commit completion.
 * @returns Completion after commit feedback or closure; commit errors become panel messages.
 * @example
 * await apply(state, panel); // With no staged changes, shows "No staged changes" without saving.
 */
async function apply(
  state: PanelState,
  panel: ExtensionManagerPanel,
): Promise<void> {
  if (!state.catalog.hasChanges()) {
    state.message = "No staged changes";
    panel.invalidate();
    return;
  }
  state.busy = true;
  state.message = undefined;
  panel.invalidate();
  const selfWasResolved = state.catalog.selfResolved(state.selfPath, false);
  try {
    const result = await state.catalog.commit();
    if (result.committedScopes.length > 0) {
      finish(state, panel, {
        type: "commit",
        result,
        selfDisableCommitted:
          selfWasResolved && !state.catalog.selfResolved(state.selfPath, false),
      });
      return;
    }
    state.message = result.scopes
      .map((scope) => `${scope.scope}: ${scope.message ?? scope.status}`)
      .join(" | ");
  } catch (error) {
    state.message = error instanceof Error ? error.message : String(error);
  } finally {
    state.busy = false;
    if (!state.finished) {
      panel.invalidate();
    }
  }
}

/**
 * Completes the panel once, disposing terminal ownership before notifying its caller.
 * @param state - Completion guard and result callback owned by the panel.
 * @param panel - Lifecycle owner whose disposal hook runs before the callback.
 * @param result - Closure reason and, for a commit, saved-scope and self-disable details.
 * @throws If disposal or the completion callback throws; completion stays marked finished.
 * @example
 * finish(state, panel, { type: "closed" }); // Disposes, then reports closure once.
 */
function finish(
  state: PanelState,
  panel: ExtensionManagerPanel,
  result: PanelResult,
): void {
  if (state.finished) {
    return;
  }
  state.finished = true;
  panel.dispose();
  state.done(result);
}

/**
 * Builds banners, tabs, search, content panes, and footer while recording regular-mode tab hits.
 * @param state - Catalog, layout, theme, and persistent hit/scroll state for this frame.
 * @param width - Available terminal cells across the panel.
 * @param height - Terminal row budget, including seven rows of panel chrome.
 * @returns Content lines for the outer renderer to clip and pad to a full frame.
 * @example
 * renderMain(state, 120, 18); // With details closed, shows a list beside an inspector.
 */
function renderMain(
  state: PanelState,
  width: number,
  height: number,
): string[] {
  const view = state.catalog.view();
  const lines: string[] = [];
  lines.push(state.theme.bold(state.theme.fg("accent", "Extension Manager")));

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
  if (state.message !== undefined) {
    banners.push(state.message);
  }
  lines.push(
    state.theme.fg(
      banners.length === 0 ? "dim" : "warning",
      safeInline(banners.join(" | ") || "Persistent Extensions and Skills"),
    ),
  );

  const tabs = TABS.map((tab, index) => {
    const label = ` ${tab} `;
    return index === state.model.tabIndex
      ? state.theme.inverse(label)
      : state.theme.fg("muted", label);
  });
  lines.push(tabs.join(" "));
  if (state.tui.mode === "regular") {
    let column = 1;
    for (const [index, tab] of tabs.entries()) {
      const tabWidth = visibleWidth(tab);
      state.tabHits.push({
        row: 3,
        firstColumn: column,
        lastColumn: column + tabWidth - 1,
        index,
      });
      column += tabWidth + 1;
    }
  }
  lines.push(
    `Search: ${state.model.query === "" ? state.theme.fg("dim", "type to filter") : safeInline(state.model.query)}`,
  );
  lines.push(state.theme.fg("borderMuted", "─".repeat(Math.max(0, width))));

  const bodyHeight = Math.max(0, height - 7);
  if (state.model.detailsOpen) {
    lines.push(
      ...renderInspector(
        state.catalog,
        state.model.selectedRow()?.id,
        state.theme,
        width,
        bodyHeight,
      ),
    );
  } else if (state.narrow) {
    lines.push(...renderList(state, width, bodyHeight, 6));
  } else {
    const listWidth = Math.max(36, Math.floor(width * 0.45));
    const inspectorWidth = Math.max(1, width - listWidth - 3);
    const list = renderList(state, listWidth, bodyHeight, 6);
    const inspector = renderInspector(
      state.catalog,
      state.model.selectedRow()?.id,
      state.theme,
      inspectorWidth,
      bodyHeight,
    );
    for (let index = 0; index < bodyHeight; index += 1) {
      lines.push(
        `${fitLine(list[index] ?? "", listWidth)} ${state.theme.fg("borderMuted", "│")} ${fitLine(inspector[index] ?? "", inspectorWidth)}`,
      );
    }
  }

  lines.push(state.theme.fg("borderMuted", "─".repeat(Math.max(0, width))));
  const mouseHint = state.tui.mode === "regular" ? "  Click/wheel" : "  Wheel";
  lines.push(
    state.theme.fg(
      "dim",
      `Tab kind  ↑↓ select  Space toggle  Enter inspect  Ctrl-S apply  Esc back${mouseHint}`,
    ),
  );
  return lines;
}

/**
 * Keeps the selected row in view and records mouse hits for the visible resource rows.
 * @param state - Grouped selection, theme, retained scroll offset, and row-hit accumulator.
 * @param width - List cell budget, also used to bound row hit regions.
 * @param height - Maximum number of list lines, including group headers.
 * @param firstScreenRow - One-based terminal row where the first list line appears.
 * @returns Visible headers and resource rows, with the selected row padded and highlighted.
 * @example
 * renderList(state, 54, 11, 6); // Emits at most 11 lines with hits starting at screen row 6.
 */
function renderList(
  state: PanelState,
  width: number,
  height: number,
  firstScreenRow: number,
): string[] {
  const entries = state.model.listEntries();
  const selectedEntry = entries.findIndex(
    (entry) => entry.type === "row" && entry.row.id === state.model.selectedId,
  );
  if (selectedEntry < state.listOffset) {
    state.listOffset = selectedEntry;
  } else if (selectedEntry >= state.listOffset + height) {
    state.listOffset = selectedEntry - height + 1;
  }
  state.listOffset = Math.max(
    0,
    Math.min(state.listOffset, Math.max(0, entries.length - height)),
  );

  const visible = entries.slice(state.listOffset, state.listOffset + height);
  return visible.map((entry, index) => {
    if (entry.type === "header") {
      return state.theme.bold(
        state.theme.fg("accent", safeInline(entry.label)),
      );
    }
    const selected = entry.row.id === state.model.selectedId;
    const marker = selected ? ">" : " ";
    const checkbox = entry.row.configured ? "[x]" : "[ ]";
    const scope = entry.row.scope === "global" ? "G" : "P";
    const originCount =
      entry.row.origins.length > 1
        ? ` (${entry.row.origins.length} origins)`
        : "";
    const diagnostic = (entry.row.diagnosticCount ?? 0) > 0 ? " [!]" : "";
    const value = `${marker} ${checkbox} ${scope} ${safeInline(entry.row.name)}${originCount}${diagnostic}`;
    state.rowHits.push({
      row: firstScreenRow + index,
      firstColumn: 1,
      lastColumn: width,
      id: entry.row.id,
      toggleFirstColumn: 3,
      toggleLastColumn: 5,
    });
    return selected ? state.theme.inverse(fitLine(value, width)) : value;
  });
}

/**
 * Renders a selected resource's sanitized metadata, wrapped preview, and diagnostics.
 * @param catalog - Source of the selected resource's inspection data.
 * @param selectedId - Selected resource ID, or undefined when there is no matching row.
 * @param theme - Styling for inspector text and diagnostics.
 * @param width - Cell budget for wrapped preview and diagnostic lines.
 * @param height - Maximum inspection lines when inspection data is available.
 * @returns Inspection lines, or a message when selection or inspection is unavailable.
 * @example
 * renderInspector(catalog, undefined, theme, 60, 11); // Shows "No matching resources".
 */
function renderInspector(
  catalog: ExtensionCatalog,
  selectedId: string | undefined,
  theme: Theme,
  width: number,
  height: number,
): string[] {
  if (selectedId === undefined) {
    return [theme.fg("dim", "No matching resources")];
  }
  const inspection = catalog.inspect(selectedId);
  if (inspection === undefined) {
    return [theme.fg("dim", "Inspection unavailable")];
  }
  const lines = [theme.bold(safeInline(inspection.row.name))];
  if (inspection.row.description !== undefined) {
    lines.push(theme.fg("dim", safeInline(inspection.row.description)));
  }
  for (const field of inspection.fields) {
    lines.push(
      `${theme.fg("muted", `${field.label}:`)} ${safeInline(field.value)}`,
    );
  }
  if (inspection.preview !== undefined) {
    lines.push("", theme.fg("muted", "Preview:"));
    for (const paragraph of inspection.preview.split("\n")) {
      lines.push(...wrapTextWithAnsi(paragraph, Math.max(1, width)));
    }
  }
  if (inspection.diagnostics.length > 0) {
    lines.push("", theme.fg("warning", "Diagnostics:"));
    for (const diagnostic of inspection.diagnostics) {
      lines.push(
        ...wrapTextWithAnsi(safeInline(diagnostic), Math.max(1, width)),
      );
    }
  }
  return lines.slice(0, height);
}

/**
 * Draws the active close or self-disable confirmation without changing its selected choice.
 * @param dialog - Current confirmation, or undefined to render no dialog lines.
 * @param theme - Styling for the warning, heading, and selected choice.
 * @param width - Cell budget used to truncate each dialog line.
 * @param height - Row budget used to position and clip the dialog.
 * @returns Dialog lines within the row and cell budgets; the outer renderer pads the frame.
 * @example
 * renderDialog({ type: "close", choice: 2 }, theme, 70, 18); // Highlights Cancel.
 */
function renderDialog(
  dialog: DialogState,
  theme: Theme,
  width: number,
  height: number,
): string[] {
  if (dialog === undefined) {
    return [];
  }
  const lines = Array.from(
    { length: Math.max(0, Math.floor(height / 3)) },
    () => "",
  );
  if (dialog.type === "self-disable") {
    lines.push(
      theme.bold(theme.fg("warning", "Disable Extension Manager?")),
      "The command remains available until you run /reload.",
      "Recovery after reload: run `pi config` or edit settings.json.",
      "",
    );
    const options = ["Disable", "Cancel"];
    lines.push(
      options
        .map((option, index) =>
          index === dialog.choice
            ? theme.inverse(` ${option} `)
            : ` ${option} `,
        )
        .join(" "),
    );
  } else {
    lines.push(theme.bold("Apply staged changes before closing?"), "");
    const options = ["Apply", "Discard", "Cancel"];
    lines.push(
      options
        .map((option, index) =>
          index === dialog.choice
            ? theme.inverse(` ${option} `)
            : ` ${option} `,
        )
        .join(" "),
    );
  }
  return lines.slice(0, height).map((line) => truncateToWidth(line, width));
}
