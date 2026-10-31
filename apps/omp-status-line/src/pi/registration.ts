import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
  estimateTokens,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  calculateContextUsage,
  estimateContextEntryTokens,
  estimateContextOverhead,
  hasProviderContextAnchor,
} from "../context/context-usage.ts";
import {
  activeRunMilliseconds,
  EMPTY_RUN_METRICS,
  updateRunMetrics,
} from "../context/run-metrics.ts";
import { createGitStatus } from "../git/git-status.ts";
import { isObjectRecord } from "../guards.ts";
import { getPreset } from "../rendering/presets.ts";
import { renderSegment, sanitizeInlineText } from "../rendering/segments.ts";
import {
  DEFAULT_STATUS_BG,
  EMPTY_END_CAPS,
  getSeparator,
  RESET,
  type SeparatorDef,
  STATUS_BG_AS_FG,
  STATUS_SEPARATOR_FG,
  sessionAccentAnsi,
  TRANSPARENT_BG,
} from "../rendering/theme.ts";
import type {
  PresetDef,
  SegmentContext,
  StatusLineSegmentId,
  StatusLineSegmentOptions,
  StatusLineSeparatorStyle,
  StatusLineSettings,
  UsageStats,
} from "../rendering/types.ts";

const SEGMENT_IDS: Record<StatusLineSegmentId, true> = {
  pi: true,
  model: true,
  mode: true,
  path: true,
  git: true,
  pr: true,
  subagents: true,
  // biome-ignore lint/style/useNamingConvention: public status segment identifier
  token_in: true,
  // biome-ignore lint/style/useNamingConvention: public status segment identifier
  token_out: true,
  // biome-ignore lint/style/useNamingConvention: public status segment identifier
  token_total: true,
  // biome-ignore lint/style/useNamingConvention: public status segment identifier
  token_rate: true,
  cost: true,
  // biome-ignore lint/style/useNamingConvention: public status segment identifier
  context_pct: true,
  // biome-ignore lint/style/useNamingConvention: public status segment identifier
  context_total: true,
  // biome-ignore lint/style/useNamingConvention: public status segment identifier
  time_spent: true,
  time: true,
  session: true,
  hostname: true,
  // biome-ignore lint/style/useNamingConvention: public status segment identifier
  cache_read: true,
  // biome-ignore lint/style/useNamingConvention: public status segment identifier
  cache_write: true,
  // biome-ignore lint/style/useNamingConvention: public status segment identifier
  cache_hit: true,
  // biome-ignore lint/style/useNamingConvention: public status segment identifier
  session_name: true,
  usage: true,
  collab: true,
};
// ponytail: validate STATUS_LINE_PRESETS keys instead of this duplicate list.
const PRESETS: Record<StatusLineSettings["preset"], true> = {
  default: true,
  minimal: true,
  compact: true,
  full: true,
  nerd: true,
  ascii: true,
  custom: true,
};
const SEPARATORS: Record<StatusLineSeparatorStyle, true> = {
  powerline: true,
  "powerline-thin": true,
  slash: true,
  pipe: true,
  block: true,
  none: true,
  ascii: true,
};
const STATUS_KEYS: Record<string, true> = {
  mode: true,
  collab: true,
  subagents: true,
  usage: true,
};
const MILLISECONDS_PER_SECOND = 1000;
const STATUS_REFRESH_INTERVAL_MS = MILLISECONDS_PER_SECOND;
const EDITOR_BORDER_RE = /^─{3,}/;
const GIT_BRANCH_COMMAND_RE =
  /\bgit\s+(checkout|switch|branch|merge|rebase|pull|reset|worktree|stash)/;
const DEFAULT_PATH_MAX_LENGTH = 40;
const MIN_PATH_MAX_LENGTH = 4;
const MAX_PATH_WIDTH_ADJUSTMENT_ATTEMPTS = 8;
const MIN_EDITOR_RENDER_LINES = 3;
const GIT_REFRESH_COALESCE_DELAY_MS = 150;

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function agentDir(): string {
  const { PI_CODING_AGENT_DIR } = process.env;
  const configured = PI_CODING_AGENT_DIR?.trim();
  return configured || join(homedir(), ".pi", "agent");
}

function mergeOptions(
  base: StatusLineSegmentOptions | undefined,
  override: StatusLineSegmentOptions | undefined,
): StatusLineSegmentOptions {
  return {
    model: { ...base?.model, ...override?.model },
    path: { ...base?.path, ...override?.path },
    git: { ...base?.git, ...override?.git },
    time: { ...base?.time, ...override?.time },
  };
}

function parseSegmentIds(value: unknown): StatusLineSegmentId[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter(
    (item): item is StatusLineSegmentId =>
      typeof item === "string" &&
      SEGMENT_IDS[item as StatusLineSegmentId] === true,
  );
}

// ponytail: replace toNonNullRecord with explicit optional spreads.
type NonNullRecord<T extends Record<string, unknown>> = {
  [K in keyof T as K extends string ? K : never]?: NonNullable<T[K]>;
};

function toNonNullRecord<T extends Record<string, unknown>>(
  record: T,
): NonNullRecord<T> {
  // entries/fromEntries lose the per-key value types. The assertion restores
  // them: retained values are unchanged, and the filter removes nullish values.
  return Object.fromEntries(
    Object.entries(record).filter(
      ([, value]) => value !== null && value !== undefined,
    ),
  ) as NonNullRecord<T>;
}

function readSettings(
  cwd: string,
  projectTrusted: boolean,
): StatusLineSettings {
  const global = readJsonObject(join(agentDir(), "settings.json"));
  // Pi does not expose its merged SettingsManager to extensions. Because this
  // extension reads settings directly, mirror Pi's trust gate before loading
  // project-local configuration.
  const project = projectTrusted
    ? readJsonObject(join(cwd, ".pi", "settings.json"))
    : {};
  const { statusLine: globalValue } = global;
  const { statusLine: projectValue } = project;
  const globalStatus = isObjectRecord(globalValue) ? globalValue : {};
  const projectStatus = isObjectRecord(projectValue) ? projectValue : {};
  const raw = { ...globalStatus, ...projectStatus };
  const {
    preset: presetValue,
    separator: separatorValue,
    leftSegments,
    rightSegments,
    showHookStatus,
    sessionAccent,
    transparent,
    compactThinkingLevel,
  } = raw;
  const preset =
    typeof presetValue === "string" &&
    PRESETS[presetValue as StatusLineSettings["preset"]] === true
      ? (presetValue as StatusLineSettings["preset"])
      : "default";
  const separator =
    typeof separatorValue === "string" &&
    SEPARATORS[separatorValue as StatusLineSeparatorStyle] === true
      ? (separatorValue as StatusLineSeparatorStyle)
      : undefined;
  const { segmentOptions: globalSegmentOptions } = globalStatus;
  const { segmentOptions: projectSegmentOptions } = projectStatus;
  const segmentOptions =
    isObjectRecord(globalSegmentOptions) ||
    isObjectRecord(projectSegmentOptions)
      ? mergeOptions(
          isObjectRecord(globalSegmentOptions)
            ? (globalSegmentOptions as StatusLineSegmentOptions)
            : undefined,
          isObjectRecord(projectSegmentOptions)
            ? (projectSegmentOptions as StatusLineSegmentOptions)
            : undefined,
        )
      : undefined;
  return {
    preset,
    ...toNonNullRecord({
      leftSegments: parseSegmentIds(leftSegments),
      rightSegments: parseSegmentIds(rightSegments),
      separator,
      segmentOptions,
    }),
    showHookStatus: showHookStatus !== false,
    sessionAccent: sessionAccent !== false,
    transparent: transparent === true,
    compactThinkingLevel: compactThinkingLevel === true,
  };
}

function effectivePreset(settings: StatusLineSettings): PresetDef {
  const preset = getPreset(settings.preset);
  return {
    leftSegments:
      settings.preset === "custom" && settings.leftSegments
        ? settings.leftSegments
        : preset.leftSegments,
    rightSegments:
      settings.preset === "custom" && settings.rightSegments
        ? settings.rightSegments
        : preset.rightSegments,
    separator: settings.separator ?? preset.separator,
    segmentOptions: mergeOptions(
      preset.segmentOptions,
      settings.segmentOptions,
    ),
  };
}

function messageUsage(message: unknown): Record<string, unknown> | undefined {
  if (!isObjectRecord(message)) {
    return undefined;
  }
  const { role, usage } = message;
  if (role !== "assistant" || !isObjectRecord(usage)) {
    return undefined;
  }
  return usage;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Reads usage totals from the current session branch without modifying entries.
 * @param ctx Host context whose session branch supplies usage records.
 * @param tokensPerSecond Current stream rate, or undefined before measurement.
 * @returns Totals with invalid numeric fields treated as zero; host read errors propagate.
 * @example aggregateUsage(ctx, undefined).tokensPerSecond === undefined
 */
function aggregateUsage(
  ctx: ExtensionContext,
  tokensPerSecond: number | undefined,
): UsageStats {
  const stats: UsageStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    premiumRequests: 0,
    cost: 0,
    tokensPerSecond,
  };
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") {
      continue;
    }
    const usage = messageUsage(entry.message);
    if (!usage) {
      continue;
    }
    const { input, output, cacheRead, cacheWrite, premiumRequests, cost } =
      usage;
    stats.input += numeric(input);
    stats.output += numeric(output);
    stats.cacheRead += numeric(cacheRead);
    stats.cacheWrite += numeric(cacheWrite);
    stats.premiumRequests += numeric(premiumRequests);
    if (isObjectRecord(cost)) {
      const { total } = cost;
      stats.cost += numeric(total);
    } else {
      stats.cost += numeric(cost);
    }
  }
  return stats;
}

/**
 * Shrinks rendered path text by up to the overflow in terminal cells without changing options.
 * @param content Current ANSI path, including its icon.
 * @param overflow Positive cell reduction requested by the layout.
 * @returns Last visible rendering, or the original when shrinking is unavailable.
 * Renderer errors propagate; at most eight corrections account for icon width.
 * @example shrinkStatusPath("short", 2, ctx); // "short" (below the eight-cell floor)
 */
function shrinkStatusPath(
  content: string,
  overflow: number,
  segmentCtx: SegmentContext,
): string {
  const currentWidth = visibleWidth(content);
  const minPathWidth = 8;
  const shrinkable = currentWidth - minPathWidth;
  if (shrinkable <= 0) {
    return content;
  }
  const shrinkBy = Math.min(shrinkable, overflow);
  const currentMaxLength =
    segmentCtx.options.path?.maxLength ?? DEFAULT_PATH_MAX_LENGTH;
  let nextMaxLength = Math.max(
    MIN_PATH_MAX_LENGTH,
    Math.min(currentMaxLength, currentWidth) - shrinkBy,
  );
  /**
   * Copies context options with a path-text cell budget, leaving the shared snapshot unchanged.
   * @example pathCtx(4).options.path?.maxLength; // 4
   */
  const pathCtx = (maxLength: number): SegmentContext => ({
    ...segmentCtx,
    options: {
      ...segmentCtx.options,
      path: { ...segmentCtx.options.path, maxLength },
    },
  });
  let adjusted = renderSegment("path", pathCtx(nextMaxLength));
  if (!(adjusted.visible && adjusted.content)) {
    return content;
  }
  // maxLength governs path text rather than the icon prefix; converge on the requested reduction.
  for (
    let attempt = 0;
    attempt < MAX_PATH_WIDTH_ADJUSTMENT_ATTEMPTS;
    attempt++
  ) {
    const saved = currentWidth - visibleWidth(adjusted.content);
    if (saved >= shrinkBy) {
      break;
    }
    const correctedMaxLength = Math.max(
      MIN_PATH_MAX_LENGTH,
      nextMaxLength - (shrinkBy - saved),
    );
    if (correctedMaxLength >= nextMaxLength) {
      break;
    }
    nextMaxLength = correctedMaxLength;
    const rerendered = renderSegment("path", pathCtx(nextMaxLength));
    if (!(rerendered.visible && rerendered.content)) {
      break;
    }
    adjusted = rerendered;
  }
  return adjusted.content;
}

/**
 * Renders visible segments and fits them in terminal cells, including padding and caps.
 * Drops right segments first, shrinks the path, then drops non-path left segments first.
 * @param width Available terminal cells.
 * @returns Owned segment arrays, fitted cell widths, and caps; inputs remain unchanged.
 * Segment rendering errors propagate; this operation owns no session resources.
 * @example An empty preset produces empty left/right arrays with zero widths.
 */
function fitStatusSegments(
  width: number,
  preset: PresetDef,
  segmentCtx: SegmentContext,
  separator: SeparatorDef,
): {
  left: string[];
  right: string[];
  leftWidth: number;
  rightWidth: number;
  endCaps: SeparatorDef["endCaps"];
} {
  const endCaps = segmentCtx.settings.transparent
    ? EMPTY_END_CAPS
    : separator.endCaps;
  const left: string[] = [];
  const leftIds: StatusLineSegmentId[] = [];
  for (const id of preset.leftSegments) {
    const rendered = renderSegment(id, segmentCtx);
    if (rendered.visible && rendered.content) {
      left.push(rendered.content);
      leftIds.push(id);
    }
  }
  const right: string[] = [];
  for (const id of preset.rightSegments) {
    const rendered = renderSegment(id, segmentCtx);
    if (rendered.visible && rendered.content) {
      right.push(rendered.content);
    }
  }

  const leftSeparatorWidth = visibleWidth(separator.left);
  const rightSeparatorWidth = visibleWidth(separator.right);
  const leftCapWidth = visibleWidth(endCaps.right);
  const rightCapWidth = visibleWidth(endCaps.left);
  /**
   * Counts ANSI content, inter-segment spaces, outer padding and a nonempty group's cap.
   * @returns Terminal cells without changing parts.
   * @example groupWidth([], 1, 1); // 0
   */
  const groupWidth = (
    parts: string[],
    capWidth: number,
    separatorWidth: number,
  ): number => {
    if (parts.length === 0) {
      return 0;
    }
    return (
      parts.reduce((sum, part) => sum + visibleWidth(part), 0) +
      Math.max(0, parts.length - 1) * (separatorWidth + 2) +
      2 +
      capWidth
    );
  };

  let leftWidth = groupWidth(left, leftCapWidth, leftSeparatorWidth);
  let rightWidth = groupWidth(right, rightCapWidth, rightSeparatorWidth);
  /** Returns occupied cells, reserving one gap cell only when both groups remain.
   * @example Empty left/right arrays produce zero cells.
   */
  const totalWidth = (): number =>
    leftWidth + rightWidth + (left.length > 0 && right.length > 0 ? 1 : 0);

  while (totalWidth() > width && right.length > 0) {
    right.pop();
    rightWidth = groupWidth(right, rightCapWidth, rightSeparatorWidth);
  }

  const pathIndex = leftIds.indexOf("path");
  if (pathIndex >= 0 && totalWidth() > width) {
    left[pathIndex] = shrinkStatusPath(
      left[pathIndex] ?? "",
      totalWidth() - width,
      segmentCtx,
    );
    leftWidth = groupWidth(left, leftCapWidth, leftSeparatorWidth);
  }

  while (totalWidth() > width && left.length > 0) {
    let dropIndex = leftIds.length - 1;
    while (dropIndex >= 0 && leftIds[dropIndex] === "path") {
      dropIndex--;
    }
    if (dropIndex < 0) {
      dropIndex = left.length - 1;
    }
    left.splice(dropIndex, 1);
    leftIds.splice(dropIndex, 1);
    leftWidth = groupWidth(left, leftCapWidth, leftSeparatorWidth);
  }
  return { left, right, leftWidth, rightWidth, endCaps };
}

/**
 * Registers the status-line renderer and session-owned refresh resources.
 * Async lifecycle handlers own refresh startup/stop; synchronous callbacks only signal work.
 * Shutdown cancels timers, joins commands, and releases only UI slots still owned here.
 * @param pi Host extension API used for events, UI state, and command execution.
 * @example registerStatusLine(pi); // Installs UI on session_start in TUI mode.
 */
export function registerStatusLine(pi: ExtensionAPI): void {
  let currentCtx: ExtensionContext | undefined;
  let settings: StatusLineSettings = readSettings(process.cwd(), false);
  let footerData: ReadonlyFooterDataProvider | undefined;
  let tui: { requestRender: () => void } | undefined;
  let footerUnsubscribe: (() => void) | undefined;
  let ticker: NodeJS.Timeout | undefined;
  let delayedRefresh: NodeJS.Timeout | undefined;
  let disposeUi: (() => void) | undefined;
  let runMetrics = EMPTY_RUN_METRICS;

  const requestRender = (): void => {
    tui?.requestRender();
  };

  const gitStatus = createGitStatus({
    exec: (command, args, options) => pi.exec(command, args, options),
    /** Returns host identity separately from cwd so replaced contexts reject stale work. */
    readContext: () =>
      currentCtx ? { owner: currentCtx, cwd: currentCtx.cwd } : undefined,
    readBranch: () => footerData?.getGitBranch() ?? undefined,
    changed: requestRender,
  });

  /**
   * Releases owned timers and subscriptions, joins refresh work, then releases owned UI slots.
   * Lifecycle calls are serial; startup awaits this cleanup before acquiring another session.
   * @returns Completion after all owned resources and host references have been released.
   * @example A repeated session_shutdown leaves no owned handles or subscriptions.
   */
  const releaseSessionResources = async (): Promise<void> => {
    clearInterval(ticker);
    ticker = undefined;
    clearTimeout(delayedRefresh);
    delayedRefresh = undefined;
    footerUnsubscribe?.();
    footerUnsubscribe = undefined;
    await gitStatus.stop();
    disposeUi?.();
    disposeUi = undefined;
    currentCtx = undefined;
    footerData = undefined;
    tui = undefined;
    runMetrics = EMPTY_RUN_METRICS;
  };

  /**
   * Snapshots host usage and wall-clock active milliseconds without starting timers.
   * Only absent reported tokens acquire entries; anchored totals skip prompt/tool acquisition.
   * @param theme Styling callbacks retained for segment rendering; host errors propagate.
   * @param options Per-segment display options, retained without mutation.
   * @returns Context with 0–100 percentage units, or undefined before a session is available.
   * @example With no currentCtx, buildSegmentContext(theme, {}) returns undefined.
   */
  const buildSegmentContext = (
    theme: Theme,
    options: StatusLineSegmentOptions,
  ): SegmentContext | undefined => {
    if (!currentCtx) {
      return undefined;
    }
    const context = currentCtx.getContextUsage();
    const contextWindow = context?.contextWindow;
    const modelContextWindow =
      contextWindow === null || contextWindow === undefined
        ? currentCtx.model?.contextWindow
        : undefined;
    const providerAnchored = hasProviderContextAnchor(
      currentCtx.sessionManager.getBranch(),
    );
    const reportedTokens = context?.tokens;
    const estimatedMessageTokens =
      reportedTokens === null || reportedTokens === undefined
        ? estimateContextEntryTokens(
            currentCtx.sessionManager.buildContextEntries().map((entry) =>
              entry.type === "message"
                ? {
                    type: "message" as const,
                    tokens: estimateTokens(entry.message),
                  }
                : entry,
            ),
          )
        : 0;
    const estimatedOverheadTokens =
      providerAnchored &&
      reportedTokens !== null &&
      reportedTokens !== undefined
        ? 0
        : estimateContextOverhead({
            systemPrompt: currentCtx.getSystemPrompt(),
            activeToolNames: pi.getActiveTools(),
            tools: pi.getAllTools(),
          });
    const contextUsage = calculateContextUsage({
      reportedTokens,
      providerAnchored,
      estimatedMessageTokens,
      estimatedOverheadTokens,
      contextWindow,
      modelContextWindow,
    });
    const now = Date.now();
    return {
      extensionContext: currentCtx,
      footerData,
      theme,
      settings,
      options,
      usage: aggregateUsage(currentCtx, runMetrics.tokensPerSecond),
      ...contextUsage,
      autoCompactEnabled: true,
      activeMs: activeRunMilliseconds(runMetrics, now),
      git: gitStatus.snapshot,
    };
  };

  /**
   * Fits cached ANSI segments to width in terminal cells without starting Git/PR work.
   * @param width Available cells, including separators and caps.
   * Drops right segments, then shortens the path before dropping other left segments.
   * @returns Styled row or empty text without a session/positive width; host errors propagate.
   * @example buildStatusLine(0, theme); // ""
   */
  const buildStatusLine = (width: number, theme: Theme): string => {
    if (width <= 0) {
      return "";
    }
    const preset = effectivePreset(settings);
    const segmentCtx = buildSegmentContext(theme, preset.segmentOptions);
    if (!segmentCtx) {
      return "";
    }
    const separator = getSeparator(
      preset.separator,
      settings.preset === "ascii",
    );
    const { transparent } = settings;
    const bg = transparent ? TRANSPARENT_BG : DEFAULT_STATUS_BG;
    const foreground = theme.getFgAnsi("text");

    const { left, right, leftWidth, rightWidth, endCaps } = fitStatusSegments(
      width,
      preset,
      segmentCtx,
      separator,
    );

    /**
     * Styles a segment group with its outward-facing cap, omitted when transparent.
     * @param parts Visible ANSI segments, left unmodified.
     * @param direction Selects separators and the cap's side.
     * @returns Styled text, or empty text for an empty group; performs no I/O.
     * @example renderGroup([], "left"); // ""
     */
    const renderGroup = (
      parts: string[],
      direction: "left" | "right",
    ): string => {
      if (parts.length === 0) {
        return "";
      }
      const separatorText =
        direction === "left" ? separator.left : separator.right;
      const cap = direction === "left" ? endCaps.right : endCaps.left;
      const capText = cap ? `${STATUS_BG_AS_FG}${cap}${RESET}` : "";
      const content = `${bg}${foreground} ${parts.join(` ${STATUS_SEPARATOR_FG}${separatorText}${foreground} `)} ${RESET}`;
      return direction === "right"
        ? `${capText}${content}`
        : `${content}${capText}`;
    };

    const leftGroup = renderGroup(left, "left");
    const rightGroup = renderGroup(right, "right");
    if (!(leftGroup && rightGroup)) {
      return `${leftGroup}${rightGroup}`;
    }

    const gapWidth = Math.max(1, width - leftWidth - rightWidth);
    const sessionName = sanitizeInlineText(
      currentCtx?.sessionManager.getSessionName() ?? "",
    ).trim();
    const gapColor =
      settings.sessionAccent && sessionName
        ? sessionAccentAnsi(sessionName)
        : theme.getFgAnsi("border");
    return `${leftGroup}${gapColor}${"─".repeat(gapWidth)}\x1b[39m${rightGroup}`;
  };

  /**
   * Frames editor content and trailing completion rows with this owner's status chrome.
   * @param lines Original editor rows; the last detected border separates completion rows.
   * @param contentWidth Inner cell budget, used for padding without truncating editor text.
   * @param chromeWidth Trailing completion-row left indent in cells.
   * @param ctx Host supplies the border theme without transferring lifecycle ownership.
   * @returns Fresh framed rows using the current session's status; inputs remain unchanged
   * and host/render errors propagate. No resources are acquired.
   * @example Three editor rows at contentWidth 14 produce a top status and bottom content frame.
   */
  function renderStatusEditorFrame(
    lines: readonly string[],
    contentWidth: number,
    chromeWidth: number,
    ctx: ExtensionContext,
  ): string[] {
    let bottomBorderIndex = lines.length - 1;
    for (let index = lines.length - 1; index >= 1; index--) {
      if (EDITOR_BORDER_RE.test(stripVTControlCharacters(lines[index] ?? ""))) {
        bottomBorderIndex = index;
        break;
      }
    }

    const { theme } = ctx.ui;
    const border = theme.getFgAnsi("border");
    const paintBorder = (text: string): string => `${border}${text}\x1b[39m`;
    const status = buildStatusLine(contentWidth, theme);
    const statusFill = Math.max(0, contentWidth - visibleWidth(status));
    const result: string[] = [
      `${paintBorder("╭──")}${status}${paintBorder(`${"─".repeat(statusFill)}──╮`)}`,
    ];
    const contentLines = lines.slice(1, bottomBorderIndex);
    for (let index = 0; index < contentLines.length; index++) {
      const line = contentLines[index] ?? "";
      const lineFill = " ".repeat(
        Math.max(0, contentWidth - visibleWidth(line)),
      );
      if (index === contentLines.length - 1) {
        result.push(
          `${paintBorder("╰─ ")}${line}${lineFill}${paintBorder(" ─╯")}`,
        );
      } else {
        result.push(
          `${paintBorder("│ ")}${line}${lineFill}${paintBorder(" │")}`,
        );
      }
    }
    for (const line of lines.slice(bottomBorderIndex + 1)) {
      result.push(`${" ".repeat(chromeWidth)}${line}`);
    }
    return result;
  }

  /**
   * Wraps the host editor and replaces the footer; teardown restores only still-owned slots.
   * @param ctx TUI host; UI callback errors propagate and teardown owns branch unsubscription.
   * @example installUi(ctx) installs status chrome; releaseSessionResources() removes it.
   */
  const installUi = (ctx: ExtensionContext): void => {
    const previousEditorFactory = ctx.ui.getEditorComponent();
    /**
     * Creates the prior/custom editor and decorates its render method without taking disposal ownership.
     * @example When a prior factory exists, its editor instance is returned with status chrome.
     */
    const installedEditorFactory: NonNullable<
      Parameters<ExtensionUIContext["setEditorComponent"]>[0]
    > = (editorTui, editorTheme, keybindings) => {
      const editor =
        previousEditorFactory?.(editorTui, editorTheme, keybindings) ??
        new CustomEditor(editorTui, editorTheme, keybindings);
      const originalRender = editor.render.bind(editor);
      /**
       * Renders cell-sized status chrome around the original editor; host errors propagate.
       * @example render(5) delegates at width 5; fewer than three base rows remain unchanged.
       */
      editor.render = (width: number): string[] => {
        if (width < 10 || !currentCtx) {
          return [...originalRender(width)];
        }
        const chromeWidth = 3;
        const contentWidth = Math.max(1, width - chromeWidth * 2);
        const lines = [...originalRender(contentWidth)];
        if (lines.length < MIN_EDITOR_RENDER_LINES) {
          return lines;
        }

        return renderStatusEditorFrame(
          lines,
          contentWidth,
          chromeWidth,
          currentCtx,
        );
      };
      return editor;
    };

    let disposed = false;
    let ownsFooterSlot = false;
    let footerFactoryInvoked = false;
    const releaseInstalledUi = (): void => {
      if (disposed) {
        return;
      }
      if (ownsFooterSlot) {
        ownsFooterSlot = false;
        ctx.ui.setFooter(undefined);
      }
      if (ctx.ui.getEditorComponent() === installedEditorFactory) {
        ctx.ui.setEditorComponent(previousEditorFactory);
      }
      footerData = undefined;
      tui = undefined;
      disposed = true;
    };
    disposeUi = releaseInstalledUi;

    ctx.ui.setEditorComponent(installedEditorFactory);
    ctx.ui.setFooter((footerTui, _theme, data) => {
      footerFactoryInvoked = true;
      ownsFooterSlot = true;
      footerData = data;
      tui = footerTui;
      footerUnsubscribe?.();
      const unsubscribe = data.onBranchChange(() => {
        gitStatus.invalidate("branch");
      });
      footerUnsubscribe = unsubscribe;
      gitStatus.requestRefresh();
      return {
        dispose(): void {
          ownsFooterSlot = false;
          if (footerUnsubscribe === unsubscribe) {
            unsubscribe();
            footerUnsubscribe = undefined;
          }
          if (footerData === data) {
            footerData = undefined;
            tui = undefined;
          }
        },
        invalidate(): void {
          requestRender();
        },
        render(width: number): string[] {
          if (!settings.showHookStatus) {
            return [];
          }
          const preset = effectivePreset(settings);
          const usedSegments = new Set([
            ...preset.leftSegments,
            ...preset.rightSegments,
          ]);
          return Array.from(data.getExtensionStatuses().entries())
            .filter(
              ([key]) =>
                !(
                  STATUS_KEYS[key] === true &&
                  usedSegments.has(key as StatusLineSegmentId)
                ),
            )
            .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
            .map(([, text]) =>
              truncateToWidth(sanitizeInlineText(text).trim(), width),
            );
        },
      };
    });
    if (!footerFactoryInvoked) {
      ownsFooterSlot = true;
    }
  };

  /**
   * Releases the previous session before acquiring TUI chrome and owned refresh scheduling.
   * Setup failures release newly acquired resources before rejecting with the original error.
   * @returns Setup completion without waiting for optional Git/PR commands.
   * @example A non-TUI session_start resets counters without installing UI or a ticker.
   */
  pi.on("session_start", async (_event, ctx) => {
    await releaseSessionResources();
    currentCtx = ctx;
    settings = readSettings(ctx.cwd, ctx.isProjectTrusted());
    runMetrics = EMPTY_RUN_METRICS;
    if (ctx.mode !== "tui") {
      return;
    }

    try {
      await gitStatus.start();
      installUi(ctx);
      ticker = setInterval(() => {
        gitStatus.requestRefresh();
        requestRender();
      }, STATUS_REFRESH_INTERVAL_MS);
    } catch (error) {
      await releaseSessionResources();
      throw error;
    }
  });

  // ponytail: share one context-refresh callback across these five hooks.
  pi.on("session_info_changed", (_event, ctx) => {
    currentCtx = ctx;
    requestRender();
    return Promise.resolve();
  });
  pi.on("model_select", (_event, ctx) => {
    currentCtx = ctx;
    requestRender();
    return Promise.resolve();
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    currentCtx = ctx;
    requestRender();
    return Promise.resolve();
  });
  pi.on("session_tree", (_event, ctx) => {
    currentCtx = ctx;
    requestRender();
    return Promise.resolve();
  });
  pi.on("session_compact", (_event, ctx) => {
    currentCtx = ctx;
    requestRender();
    return Promise.resolve();
  });
  /**
   * Opens run metrics using one event timestamp and requests a render.
   * @example A repeated agent_start restarts stream timing without restarting active time.
   */
  pi.on("agent_start", (_event, ctx) => {
    currentCtx = ctx;
    runMetrics = updateRunMetrics(runMetrics, { kind: "start" }, Date.now());
    requestRender();
    return Promise.resolve();
  });
  /**
   * Applies assistant output to run metrics at the event timestamp and requests a render.
   * @example Missing output retains the previous rate and still requests a render.
   */
  pi.on("message_update", (event, ctx) => {
    currentCtx = ctx;
    runMetrics = updateRunMetrics(
      runMetrics,
      { kind: "output", output: messageUsage(event.message)?.["output"] },
      Date.now(),
    );
    requestRender();
    return Promise.resolve();
  });
  /**
   * Applies final assistant output to run metrics and requests a render.
   * @example After agent_end, final output retains the previous rate.
   */
  pi.on("message_end", (event, ctx) => {
    currentCtx = ctx;
    runMetrics = updateRunMetrics(
      runMetrics,
      { kind: "output", output: messageUsage(event.message)?.["output"] },
      Date.now(),
    );
    requestRender();
    return Promise.resolve();
  });
  /**
   * Closes run metrics at the event timestamp and requests a render.
   * @example A repeated agent_end retains the accumulated duration and throughput.
   */
  pi.on("agent_end", (_event, ctx) => {
    currentCtx = ctx;
    runMetrics = updateRunMetrics(runMetrics, { kind: "end" }, Date.now());
    requestRender();
    return Promise.resolve();
  });
  pi.on("tool_result", (event, ctx) => {
    currentCtx = ctx;
    if (event.toolName === "write" || event.toolName === "edit") {
      gitStatus.invalidate("working-tree");
      return;
    }
    if (event.toolName !== "bash" || !isObjectRecord(event.input)) {
      return;
    }
    const { command } = event.input;
    if (typeof command === "string" && GIT_BRANCH_COMMAND_RE.test(command)) {
      gitStatus.invalidate("branch");
    }
  });
  /**
   * Coalesces Git-changing shell commands into one owned 150 ms refresh timeout.
   * @example Two immediate "git switch" events replace the pending timeout, not duplicate it.
   */
  pi.on("user_bash", (event, ctx) => {
    currentCtx = ctx;
    if (ticker && GIT_BRANCH_COMMAND_RE.test(event.command)) {
      clearTimeout(delayedRefresh);
      delayedRefresh = setTimeout(() => {
        delayedRefresh = undefined;
        gitStatus.invalidate("pending-pr");
      }, GIT_REFRESH_COALESCE_DELAY_MS);
    }
    return Promise.resolve();
  });
  /**
   * Stops queued/running refresh jobs and releases the session's timers, subscriptions, and UI.
   * @returns Completion after owned commands are aborted/joined without waiting for late exec results.
   * @example await session_shutdown(); // A later ticker signal cannot execute optional commands.
   */
  pi.on("session_shutdown", async () => {
    await releaseSessionResources();
  });
}
