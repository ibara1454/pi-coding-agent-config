import {
  STARTUP_TIPS,
  type WelcomeExtension,
  type WelcomeSession,
} from "./data.ts";
import {
  type ColorMode,
  IntroAnimation,
  introFrame,
  RESTING_FRAMES,
} from "./gradient.ts";
import {
  sanitizeInline,
  truncateToWidth as truncateTerminalWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "./terminal.ts";

const BOX = {
  horizontal: "─",
  vertical: "│",
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  teeUp: "┴",
} as const;
const MAX_BOX_WIDTH = 100;
const FIXED_TIP_ROWS = [
  "/ for commands",
  "! to run bash",
  "!! to run bash (no context)",
  "drop files to attach",
] as const;

export interface WelcomeTheme {
  fg(
    color: "accent" | "customMessageLabel" | "dim" | "muted",
    text: string,
  ): string;
  bold(text: string): string;
  italic(text: string): string;
  getColorMode(): "truecolor" | "256color";
}

export interface WelcomeHeaderOptions {
  version: string;
  extensions: readonly WelcomeExtension[];
  recentSessions: readonly WelcomeSession[];
  selectedTip: string;
  theme: WelcomeTheme;
  requestRender: () => void;
  terminalRows: () => number;
  playIntro?: boolean;
}

/** Pi TUI's ANSI- and terminal-cell-safe truncation with the welcome ellipsis. */
function truncateToWidth(value: string, width: number): string {
  return truncateTerminalWidth(value, width, "…");
}

function pad(value: string, width: number): string {
  const available = width - visibleWidth(value);
  return available > 0
    ? `${value}${" ".repeat(available)}`
    : truncateToWidth(value, width);
}

function center(value: string, width: number): string {
  if (visibleWidth(value) >= width) return truncateToWidth(value, width);
  const remaining = width - visibleWidth(value);
  const left = Math.floor(remaining / 2);
  return `${" ".repeat(left)}${value}${" ".repeat(remaining - left)}`;
}

function wrapText(value: string, width: number): string[] {
  if (width < 1) return [];
  return wrapTextWithAnsi(value.replace(/\s+/g, " ").trim(), width);
}

function colorMode(theme: WelcomeTheme): ColorMode {
  return theme.getColorMode() === "truecolor" ? "truecolor" : "256color";
}

function sanitizeOptions(options: WelcomeHeaderOptions): WelcomeHeaderOptions {
  return {
    ...options,
    version: sanitizeInline(options.version),
    selectedTip: sanitizeInline(options.selectedTip),
    extensions: options.extensions.map((extension) => ({
      ...extension,
      name: sanitizeInline(extension.name),
    })),
    recentSessions: options.recentSessions.map((session) => ({
      name: sanitizeInline(session.name),
      timeAgo: sanitizeInline(session.timeAgo),
    })),
  };
}

/**
 * Builds the responsive box and tip from sanitized display data without caching.
 * Theme callback errors propagate to the caller.
 * @param options - Sanitized labels, entries, and the rendering theme.
 * @param boxWidth - Box width in terminal cells, at least four.
 * @param terminalRows - Terminal height used to budget extension rows.
 * @param logo - Current ANSI-colored logo rows.
 * @returns Box and tip rows, choosing columns only when both fit.
 * @example With boxWidth 100 and terminalRows 40, the logo and sections use two columns.
 */
function renderLines(
  options: Omit<
    WelcomeHeaderOptions,
    "requestRender" | "terminalRows" | "playIntro"
  >,
  boxWidth: number,
  terminalRows: number,
  logo: readonly string[],
): string[] {
  const contentWidth = boxWidth - 3;
  const preferredLeft = 26;
  const minimumLeft = 12;
  const minimumRight = 20;
  const minimumLeftContent = Math.max(
    minimumLeft,
    visibleWidth("Welcome back!"),
  );
  const desiredLeft = Math.min(
    preferredLeft,
    Math.max(minimumLeft, Math.floor(contentWidth * 0.35)),
  );
  const dualLeft =
    contentWidth >= minimumRight + 1
      ? Math.min(desiredLeft, contentWidth - minimumRight)
      : Math.max(1, contentWidth - 1);
  const dualRight = Math.max(1, contentWidth - dualLeft);
  const isWide = dualLeft >= minimumLeftContent && dualRight >= minimumRight;
  const leftWidth = isWide ? dualLeft : boxWidth - 2;
  const rightWidth = isWide ? dualRight : 0;
  const left = [
    "",
    center(options.theme.bold("Welcome back!"), leftWidth),
    "",
    ...logo.map((line) => center(line, leftWidth)),
    "",
  ];
  const tipLines = renderTipLines(options.theme, options.selectedTip, boxWidth);
  const sections = renderSections(
    options.theme,
    options.extensions,
    options.recentSessions,
    isWide ? rightWidth : leftWidth,
    isWide,
    terminalRows,
    tipLines.length,
  );
  const content = isWide
    ? renderWideRows(options.theme, left, sections, leftWidth, rightWidth)
    : renderNarrowRows(options.theme, left, sections, leftWidth);
  return renderBox(
    options.theme,
    options.version,
    boxWidth,
    content,
    tipLines,
    isWide ? leftWidth : undefined,
    isWide ? rightWidth : undefined,
  );
}

/**
 * Selects the shared resting logo or renders the current intro frame.
 * @param mode - Terminal color capability.
 * @param progress - Intro progress from zero to one, or undefined when inactive.
 * @returns Read-only logo rows; resting rows are shared and must not be mutated.
 * @example logoFrame("256color", undefined) returns RESTING_FRAMES["256color"].
 */
function logoFrame(
  mode: ColorMode,
  progress: number | undefined,
): readonly string[] {
  return progress === undefined
    ? RESTING_FRAMES[mode]
    : introFrame(progress, mode);
}

/**
 * Renders tips, capacity-limited extensions, sessions, and their separator.
 * Theme callback errors propagate to the caller.
 * @param theme - Text styling callbacks.
 * @param extensions - Sanitized extensions in display order.
 * @param recentSessions - Sanitized sessions in display order.
 * @param width - Section width in terminal cells.
 * @param isWide - Whether the sections share rows with the logo.
 * @param terminalRows - Terminal height used for the extension budget.
 * @param tipRows - Rows already reserved for the startup tip below the box.
 * @returns Styled section rows and a separator sized for the section width.
 * @example
 * In a 20-row wide terminal with 40-cell sections, one tip row, and one
 * recent session, six extensions named "a" through "f" get five slots:
 * rows for "a" through "d", then " … +2 more". The session stays visible.
 */
function renderSections(
  theme: WelcomeTheme,
  extensions: readonly WelcomeExtension[],
  recentSessions: readonly WelcomeSession[],
  width: number,
  isWide: boolean,
  terminalRows: number,
  tipRows: number,
): {
  tips: string[];
  extensions: string[];
  sessions: string[];
  separator: string;
} {
  const separator = ` ${theme.fg("dim", BOX.horizontal.repeat(Math.max(0, width - 2)))}`;
  const tips = FIXED_TIP_ROWS.map((row) => ` ${theme.fg("muted", row)}`);
  const sessions = renderSessions(theme, recentSessions, width);
  const extensionLines = renderExtensions(
    theme,
    extensions,
    width,
    extensionCapacity(isWide, terminalRows, tipRows, sessions.length),
  );
  return { tips, extensions: extensionLines, sessions, separator };
}

/**
 * Reserves layout rows while retaining at least four extension slots.
 * @param isWide - Whether the logo and sections occupy separate columns.
 * @param terminalRows - Available terminal height.
 * @param tipRows - Wrapped startup-tip row count.
 * @param sessionRows - Rendered recent-session row count.
 * @returns Extension slots, including any overflow row.
 * @example
 * ```ts
 * extensionCapacity(true, 24, 1, 1); // 9 slots with side-by-side columns.
 * extensionCapacity(false, 24, 1, 1); // 4 slots: the minimum, even if the header scrolls.
 * ```
 */
function extensionCapacity(
  isWide: boolean,
  terminalRows: number,
  tipRows: number,
  sessionRows: number,
): number {
  // Fixed rows include borders, one-row top/bottom padding, headings,
  // separators, tips, and the rendered session rows.
  const fixedRows = (isWide ? 13 : 22) + sessionRows;
  return Math.max(4, terminalRows - fixedRows - tipRows);
}

/**
 * Renders extensions, reserving the last slot for overflow when needed.
 * Theme callback errors propagate to the caller.
 * @param theme - Text styling callbacks.
 * @param extensions - Sanitized extensions in display order.
 * @param width - Row width in terminal cells.
 * @param capacity - Maximum slots, including the overflow row.
 * @returns Extension rows or a single empty-list placeholder.
 * @example
 * Five user-scoped extensions named "a" through "e", an unstyled theme,
 * width 20, and capacity 4 produce:
 * [" • a user", " • b user", " • c user", " … +2 more"].
 * The overflow row occupies the fourth slot rather than adding a fifth.
 */
function renderExtensions(
  theme: WelcomeTheme,
  extensions: readonly WelcomeExtension[],
  width: number,
  capacity: number,
): string[] {
  if (extensions.length === 0) return [` ${theme.fg("dim", "No extensions")}`];
  const shownCount =
    extensions.length > capacity
      ? Math.max(0, capacity - 1)
      : extensions.length;
  const displayed = extensions.slice(0, shownCount);
  const rows = displayed.map((extension) =>
    renderExtension(theme, extension, width),
  );
  if (displayed.length < extensions.length) {
    rows.push(
      ` ${theme.fg("dim", `… +${extensions.length - displayed.length} more`)}`,
    );
  }
  return rows;
}

/**
 * Truncates an extension name while reserving cells for its scope suffix.
 * Theme callback errors propagate to the caller.
 * @param theme - Text styling callbacks.
 * @param extension - Sanitized extension name and scope.
 * @param width - Row width in terminal cells.
 * @returns Styled bullet, truncated name, and scope.
 * @example
 * With an unstyled theme:
 * ```ts
 * renderExtension(theme, { name: "extension-manager", scope: "user" }, 16);
 * // " • extensi… user": only the name is shortened; the scope stays visible.
 * ```
 */
function renderExtension(
  theme: WelcomeTheme,
  extension: WelcomeExtension,
  width: number,
): string {
  const prefix = " • ";
  const suffix = ` ${extension.scope}`;
  const nameWidth = Math.max(
    1,
    width - visibleWidth(prefix) - visibleWidth(suffix),
  );
  const name = truncateToWidth(extension.name, nameWidth);
  return `${theme.fg("dim", prefix)}${theme.fg("muted", name)}${theme.fg("dim", suffix)}`;
}

/**
 * Renders up to four sessions, reserving cells for each relative-age suffix.
 * Theme callback errors propagate to the caller.
 * @param theme - Text styling callbacks.
 * @param recentSessions - Sanitized sessions in display order.
 * @param width - Row width in terminal cells.
 * @returns Session rows or a single empty-list placeholder.
 * @example
 * With an unstyled theme:
 * ```ts
 * renderSessions(theme, [{ name: "Investigate login", timeAgo: "2h" }], 16);
 * // [" • Investi… (2h)"]: the age suffix keeps its cells when the name is long.
 * ```
 */
function renderSessions(
  theme: WelcomeTheme,
  recentSessions: readonly WelcomeSession[],
  width: number,
): string[] {
  const rows: string[] = [];
  for (const session of recentSessions.slice(0, 4)) {
    const prefix = " • ";
    const suffix = ` (${session.timeAgo})`;
    const name = truncateToWidth(
      session.name,
      Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix)),
    );
    rows.push(
      `${theme.fg("dim", prefix)}${theme.fg("muted", name)}${theme.fg("dim", suffix)}`,
    );
  }
  if (rows.length === 0) rows.push(` ${theme.fg("dim", "No recent sessions")}`);
  return rows;
}

/**
 * Joins the logo column and headed sections with cell-padded vertical borders.
 * Theme callback errors propagate to the caller.
 * @param theme - Heading styling callbacks.
 * @param left - Centered logo-column rows.
 * @param sections - Styled section contents and separator.
 * @param leftWidth - Left-column width in terminal cells.
 * @param rightWidth - Right-column width in terminal cells.
 * @returns Bordered rows padded to the taller column, preserving bottom spacing.
 * @example Left width 26 and right width 71 produce rows measuring 100 terminal cells.
 */
function renderWideRows(
  theme: WelcomeTheme,
  left: readonly string[],
  sections: {
    tips: string[];
    extensions: string[];
    sessions: string[];
    separator: string;
  },
  leftWidth: number,
  rightWidth: number,
): string[] {
  const right = [
    "",
    ` ${theme.bold(theme.fg("accent", "Tips"))}`,
    ...sections.tips,
    sections.separator,
    ` ${theme.bold(theme.fg("accent", "Extensions"))}`,
    ...sections.extensions,
    sections.separator,
    ` ${theme.bold(theme.fg("accent", "Recent sessions"))}`,
    ...sections.sessions,
    "",
  ];
  const rows: string[] = [];
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index++)
    rows.push(
      `${BOX.vertical}${pad(left[index] ?? "", leftWidth)}${BOX.vertical}${pad(right[index] ?? "", rightWidth)}${BOX.vertical}`,
    );
  return rows;
}

/**
 * Stacks the logo and headed sections inside one cell-padded column.
 * Theme callback errors propagate to the caller.
 * @param theme - Heading styling callbacks.
 * @param left - Centered logo rows placed above the sections.
 * @param sections - Styled section contents and separator.
 * @param width - Content width in terminal cells, excluding borders.
 * @returns Bordered stacked rows with a trailing blank content row.
 * @example A content width of 28 produces rows measuring 30 terminal cells.
 */
function renderNarrowRows(
  theme: WelcomeTheme,
  left: readonly string[],
  sections: {
    tips: string[];
    extensions: string[];
    sessions: string[];
    separator: string;
  },
  width: number,
): string[] {
  const content = [
    ...left,
    sections.separator,
    ` ${theme.bold(theme.fg("accent", "Tips"))}`,
    ...sections.tips,
    sections.separator,
    ` ${theme.bold(theme.fg("accent", "Extensions"))}`,
    ...sections.extensions,
    sections.separator,
    ` ${theme.bold(theme.fg("accent", "Recent sessions"))}`,
    ...sections.sessions,
    "",
  ];
  return content.map(
    (line) => `${BOX.vertical}${pad(line, width)}${BOX.vertical}`,
  );
}

/**
 * Adds the version border, optional column junction, and external startup tip.
 * Theme callback errors propagate to the caller.
 * @param theme - Border and title styling callbacks.
 * @param version - Sanitized version label.
 * @param boxWidth - Total box width in terminal cells.
 * @param content - Rows already enclosed in vertical borders.
 * @param tipLines - Styled tip rows appended below the bottom border.
 * @param leftWidth - Left-column width, or undefined for a stacked box.
 * @param rightWidth - Right-column width, or undefined for a stacked box.
 * @returns Completed box and tip rows with themed vertical borders.
 * @example Width 30 with both column widths omitted produces a 30-cell bottom border without a junction.
 */
function renderBox(
  theme: WelcomeTheme,
  version: string,
  boxWidth: number,
  content: readonly string[],
  tipLines: readonly string[],
  leftWidth?: number,
  rightWidth?: number,
): string[] {
  const dim = (value: string) => theme.fg("dim", value);
  const title = ` pi v${version} `;
  const prefix = BOX.horizontal.repeat(3);
  const innerWidth = boxWidth - 2;
  const titleWidth = visibleWidth(prefix) + visibleWidth(title);
  const topInner =
    titleWidth >= innerWidth
      ? truncateToWidth(`${dim(prefix)}${theme.fg("muted", title)}`, innerWidth)
      : `${dim(prefix)}${theme.fg("muted", title)}${dim(BOX.horizontal.repeat(innerWidth - titleWidth))}`;
  const bottom =
    leftWidth === undefined || rightWidth === undefined
      ? `${dim(BOX.bottomLeft)}${dim(BOX.horizontal.repeat(boxWidth - 2))}${dim(BOX.bottomRight)}`
      : `${dim(BOX.bottomLeft)}${dim(BOX.horizontal.repeat(leftWidth))}${dim(BOX.teeUp)}${dim(BOX.horizontal.repeat(rightWidth))}${dim(BOX.bottomRight)}`;
  return [
    `${dim(BOX.topLeft)}${topInner}${dim(BOX.topRight)}`,
    ...content.map(
      (line) =>
        dim(BOX.vertical) +
        line.slice(1, -1).replaceAll(BOX.vertical, dim(BOX.vertical)) +
        dim(BOX.vertical),
    ),
    bottom,
    ...tipLines,
  ];
}

/**
 * Wraps a startup tip with an italic label and aligned continuation rows.
 * Theme callback errors propagate to the caller.
 * @param theme - Label, body, and italic styling callbacks.
 * @param selectedTip - Sanitized startup-tip text.
 * @param boxWidth - Available width in terminal cells.
 * @returns Styled tip rows, or none when fewer than eight body cells fit.
 * @example
 * With an unstyled theme:
 * ```ts
 * renderTipLines(theme, "one two three", 14);
 * // [" Tip: one two", "      three"]: continuation text aligns after "Tip: ".
 * renderTipLines(theme, "one two three", 13); // []: fewer than eight body cells.
 * ```
 */
function renderTipLines(
  theme: WelcomeTheme,
  selectedTip: string,
  boxWidth: number,
): string[] {
  const label = "Tip: ";
  const bodyWidth = boxWidth - 1 - visibleWidth(label);
  if (bodyWidth < 8) return [];
  const body = wrapText(selectedTip, bodyWidth);
  const continuation = " ".repeat(visibleWidth(label));
  return body.map((line, index) => {
    const content =
      index === 0
        ? `${theme.fg("customMessageLabel", label)}${theme.fg("muted", line)}`
        : `${continuation}${theme.fg("muted", line)}`;
    return ` ${theme.italic(content)}`;
  });
}

/**
 * Display-only startup header. Its rows are normal TUI header output, so the
 * main-screen transcript owns scrolling and the editor/footer stay docked.
 */
export class WelcomeHeader {
  private readonly animation: IntroAnimation;
  private readonly options: WelcomeHeaderOptions;
  private cache: { width: number; rows: number; lines: string[] } | undefined;
  private disposed = false;

  constructor(options: WelcomeHeaderOptions) {
    this.options = sanitizeOptions(options);
    this.animation = new IntroAnimation(() => {
      if (this.disposed) return;
      this.invalidate();
      this.options.requestRender();
    });
    if (this.options.playIntro) this.animation.start();
  }

  invalidate(): void {
    this.cache = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cache = undefined;
    this.animation.dispose();
  }

  /**
   * Renders the header, reusing cached rows only while the intro is inactive.
   * @param terminalWidth - Current terminal width in cells.
   * @returns Header rows; a resting cache hit returns the same array.
   * @throws If terminal-height or theme callbacks throw.
   * @example render(5) returns []; repeated render(102) calls at a fixed height reuse resting rows.
   */
  render(terminalWidth: number): string[] {
    const terminalRows = this.options.terminalRows();
    if (
      !this.animation.isActive() &&
      this.cache?.width === terminalWidth &&
      this.cache.rows === terminalRows
    )
      return this.cache.lines;
    const boxWidth = Math.min(MAX_BOX_WIDTH, Math.max(0, terminalWidth - 2));
    const lines =
      boxWidth < 4
        ? []
        : renderLines(
            this.options,
            boxWidth,
            terminalRows,
            logoFrame(colorMode(this.options.theme), this.animation.progress()),
          );
    if (!this.animation.isActive())
      this.cache = { width: terminalWidth, rows: terminalRows, lines };
    return lines;
  }
}

export function pickStartupTip(random = Math.random): string {
  const index = Math.min(
    STARTUP_TIPS.length - 1,
    Math.floor(random() * STARTUP_TIPS.length),
  );
  return STARTUP_TIPS[index] ?? STARTUP_TIPS[0];
}
