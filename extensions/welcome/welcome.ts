import { stripTerminalSequences, truncateToWidth as truncateTerminalWidth, visibleWidth, wrapTextWithAnsi } from "./terminal.ts";
import { IntroAnimation, introFrame, RESTING_FRAMES, type ColorMode } from "./gradient.ts";
import { STARTUP_TIPS, type WelcomeExtension, type WelcomeSession } from "./data.ts";

const BOX = { horizontal: "─", vertical: "│", topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", teeUp: "┴" } as const;
const MAX_BOX_WIDTH = 100;
const FIXED_TIP_ROWS = ["/ for commands", "! to run bash", "!! to run bash (no context)", "drop files to attach"] as const;

export interface WelcomeTheme {
  fg(color: "accent" | "customMessageLabel" | "dim" | "muted", text: string): string;
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

export { visibleWidth };

export function stripAnsi(value: string): string {
  return stripTerminalSequences(value);
}

/** Pi TUI's ANSI- and terminal-cell-safe truncation with the welcome ellipsis. */
export function truncateToWidth(value: string, width: number): string {
  return truncateTerminalWidth(value, width, "…");
}

function pad(value: string, width: number): string {
  const available = width - visibleWidth(value);
  return available > 0 ? `${value}${" ".repeat(available)}` : truncateToWidth(value, width);
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

/**
 * Display-only startup header. Its rows are normal TUI header output, so the
 * main-screen transcript owns scrolling and the editor/footer stay docked.
 */
export class WelcomeHeader {
  private readonly animation: IntroAnimation;
  private cache: { width: number; rows: number; lines: string[] } | undefined;
  private disposed = false;

  constructor(private readonly options: WelcomeHeaderOptions) {
    this.animation = new IntroAnimation(() => {
      if (this.disposed) return;
      this.invalidate();
      options.requestRender();
    });
    if (options.playIntro) this.animation.start();
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

  render(terminalWidth: number): string[] {
    const terminalRows = this.options.terminalRows();
    if (!this.animation.isActive() && this.cache?.width === terminalWidth && this.cache.rows === terminalRows) return this.cache.lines;
    const lines = this.renderLines(terminalWidth, terminalRows);
    if (!this.animation.isActive()) this.cache = { width: terminalWidth, rows: terminalRows, lines };
    return lines;
  }

  private renderLines(terminalWidth: number, terminalRows: number): string[] {
    const boxWidth = Math.min(MAX_BOX_WIDTH, Math.max(0, terminalWidth - 2));
    if (boxWidth < 4) return [];

    const contentWidth = boxWidth - 3;
    const preferredLeft = 26;
    const minimumLeft = 12;
    const minimumRight = 20;
    const minimumLeftContent = Math.max(minimumLeft, visibleWidth("Welcome back!"));
    const desiredLeft = Math.min(preferredLeft, Math.max(minimumLeft, Math.floor(contentWidth * 0.35)));
    const dualLeft = contentWidth >= minimumRight + 1 ? Math.min(desiredLeft, contentWidth - minimumRight) : Math.max(1, contentWidth - 1);
    const dualRight = Math.max(1, contentWidth - dualLeft);
    const isWide = dualLeft >= minimumLeftContent && dualRight >= minimumRight;
    const leftWidth = isWide ? dualLeft : boxWidth - 2;
    const rightWidth = isWide ? dualRight : 0;
    const logo = this.logoFrame();
    const left = [
      "",
      center(this.options.theme.bold("Welcome back!"), leftWidth),
      "",
      ...logo.map(line => center(line, leftWidth)),
      "",
    ];
    const tipLines = this.tipLines(boxWidth);
    const sections = this.sections(isWide ? rightWidth : leftWidth, isWide, terminalRows, tipLines.length);
    const content = isWide ? this.wideRows(left, sections, leftWidth, rightWidth) : this.narrowRows(left, sections, leftWidth);
    return this.box(boxWidth, content, tipLines, isWide ? leftWidth : undefined, isWide ? rightWidth : undefined);
  }

  private logoFrame(): readonly string[] {
    const mode = colorMode(this.options.theme);
    const progress = this.animation.progress();
    return progress === undefined ? RESTING_FRAMES[mode] : introFrame(progress, mode);
  }

  private sections(width: number, isWide: boolean, terminalRows: number, tipRows: number): { tips: string[]; extensions: string[]; sessions: string[]; separator: string } {
    const separator = ` ${this.options.theme.fg("dim", BOX.horizontal.repeat(Math.max(0, width - 2)))}`;
    const tips = FIXED_TIP_ROWS.map(row => ` ${this.options.theme.fg("muted", row)}`);
    const sessions = this.sessionRows(width);
    const extensions = this.extensionRows(width, this.extensionCapacity(isWide, terminalRows, tipRows, sessions.length));
    return { tips, extensions, sessions, separator };
  }

  private extensionCapacity(isWide: boolean, terminalRows: number, tipRows: number, sessionRows: number): number {
    // Fixed rows include borders, one-row top/bottom padding, headings,
    // separators, tips, and the rendered session rows.
    const fixedRows = (isWide ? 13 : 22) + sessionRows;
    return Math.max(4, terminalRows - fixedRows - tipRows);
  }

  private extensionRows(width: number, capacity: number): string[] {
    if (this.options.extensions.length === 0) return [` ${this.options.theme.fg("dim", "No extensions")}`];
    const shownCount = this.options.extensions.length > capacity ? Math.max(0, capacity - 1) : this.options.extensions.length;
    const displayed = this.options.extensions.slice(0, shownCount);
    const rows = displayed.map(extension => this.extensionRow(extension, width));
    if (displayed.length < this.options.extensions.length) {
      rows.push(` ${this.options.theme.fg("dim", `… +${this.options.extensions.length - displayed.length} more`)}`);
    }
    return rows;
  }

  private extensionRow(extension: WelcomeExtension, width: number): string {
    const prefix = " • ";
    const suffix = ` ${extension.scope}`;
    const nameWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
    const name = truncateToWidth(extension.name, nameWidth);
    return `${this.options.theme.fg("dim", prefix)}${this.options.theme.fg("muted", name)}${this.options.theme.fg("dim", suffix)}`;
  }

  private sessionRows(width: number): string[] {
    const rows: string[] = [];
    for (const session of this.options.recentSessions.slice(0, 4)) {
      const prefix = " • ";
      const suffix = ` (${session.timeAgo})`;
      const name = truncateToWidth(session.name, Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix)));
      rows.push(`${this.options.theme.fg("dim", prefix)}${this.options.theme.fg("muted", name)}${this.options.theme.fg("dim", suffix)}`);
    }
    if (rows.length === 0) rows.push(` ${this.options.theme.fg("dim", "No recent sessions")}`);
    return rows;
  }

  private wideRows(left: readonly string[], sections: { tips: string[]; extensions: string[]; sessions: string[]; separator: string }, leftWidth: number, rightWidth: number): string[] {
    const right = [
      "",
      ` ${this.options.theme.bold(this.options.theme.fg("accent", "Tips"))}`,
      ...sections.tips,
      sections.separator,
      ` ${this.options.theme.bold(this.options.theme.fg("accent", "Extensions"))}`,
      ...sections.extensions,
      sections.separator,
      ` ${this.options.theme.bold(this.options.theme.fg("accent", "Recent sessions"))}`,
      ...sections.sessions,
      "",
    ];
    const rows: string[] = [];
    const count = Math.max(left.length, right.length);
    for (let index = 0; index < count; index++) rows.push(`${BOX.vertical}${pad(left[index] ?? "", leftWidth)}${BOX.vertical}${pad(right[index] ?? "", rightWidth)}${BOX.vertical}`);
    return rows;
  }

  private narrowRows(left: readonly string[], sections: { tips: string[]; extensions: string[]; sessions: string[]; separator: string }, width: number): string[] {
    const content = [
      ...left,
      sections.separator,
      ` ${this.options.theme.bold(this.options.theme.fg("accent", "Tips"))}`,
      ...sections.tips,
      sections.separator,
      ` ${this.options.theme.bold(this.options.theme.fg("accent", "Extensions"))}`,
      ...sections.extensions,
      sections.separator,
      ` ${this.options.theme.bold(this.options.theme.fg("accent", "Recent sessions"))}`,
      ...sections.sessions,
      "",
    ];
    return content.map(line => `${BOX.vertical}${pad(line, width)}${BOX.vertical}`);
  }

  private box(boxWidth: number, content: readonly string[], tipLines: readonly string[], leftWidth?: number, rightWidth?: number): string[] {
    const dim = (value: string) => this.options.theme.fg("dim", value);
    const title = ` pi v${this.options.version} `;
    const prefix = BOX.horizontal.repeat(3);
    const innerWidth = boxWidth - 2;
    const titleWidth = visibleWidth(prefix) + visibleWidth(title);
    const topInner = titleWidth >= innerWidth
      ? truncateToWidth(`${dim(prefix)}${this.options.theme.fg("muted", title)}`, innerWidth)
      : `${dim(prefix)}${this.options.theme.fg("muted", title)}${dim(BOX.horizontal.repeat(innerWidth - titleWidth))}`;
    const bottom = leftWidth === undefined || rightWidth === undefined
      ? `${dim(BOX.bottomLeft)}${dim(BOX.horizontal.repeat(boxWidth - 2))}${dim(BOX.bottomRight)}`
      : `${dim(BOX.bottomLeft)}${dim(BOX.horizontal.repeat(leftWidth))}${dim(BOX.teeUp)}${dim(BOX.horizontal.repeat(rightWidth))}${dim(BOX.bottomRight)}`;
    return [
      `${dim(BOX.topLeft)}${topInner}${dim(BOX.topRight)}`,
      ...content.map(line => dim(BOX.vertical) + line.slice(1, -1).replaceAll(BOX.vertical, dim(BOX.vertical)) + dim(BOX.vertical)),
      bottom,
      ...tipLines,
    ];
  }

  private tipLines(boxWidth: number): string[] {
    const label = "Tip: ";
    const bodyWidth = boxWidth - 1 - visibleWidth(label);
    if (bodyWidth < 8) return [];
    const body = wrapText(this.options.selectedTip, bodyWidth);
    const continuation = " ".repeat(visibleWidth(label));
    return body.map((line, index) => {
      const content = index === 0
        ? `${this.options.theme.fg("customMessageLabel", label)}${this.options.theme.fg("muted", line)}`
        : `${continuation}${this.options.theme.fg("muted", line)}`;
      return ` ${this.options.theme.italic(content)}`;
    });
  }
}

export function pickStartupTip(random = Math.random): string {
  const index = Math.min(STARTUP_TIPS.length - 1, Math.floor(random() * STARTUP_TIPS.length));
  return STARTUP_TIPS[index] ?? STARTUP_TIPS[0];
}


