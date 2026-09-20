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
import { isObjectRecord } from "./guards.ts";
import { getPreset } from "./presets.ts";
import { renderSegment, sanitizeInlineText } from "./segments.ts";
import {
  DEFAULT_STATUS_BG,
  EMPTY_END_CAPS,
  getSeparator,
  RESET,
  STATUS_BG_AS_FG,
  STATUS_SEPARATOR_FG,
  sessionAccentAnsi,
  TRANSPARENT_BG,
} from "./theme.ts";
import type {
  GitState,
  PresetDef,
  SegmentContext,
  StatusLineSegmentId,
  StatusLineSegmentOptions,
  StatusLineSeparatorStyle,
  StatusLineSettings,
  UsageStats,
} from "./types.ts";

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
const GIT_TTL_MS = MILLISECONDS_PER_SECOND;
const STATUS_REFRESH_INTERVAL_MS = MILLISECONDS_PER_SECOND;
const EDITOR_BORDER_RE = /^─{3,}/;
const GIT_BRANCH_COMMAND_RE =
  /\bgit\s+(checkout|switch|branch|merge|rebase|pull|reset|worktree|stash)/;
const TOKEN_ESTIMATE_ROUNDING_OFFSET = 3;
const PERCENT_SCALE = 100;
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

function aggregateUsage(
  ctx: ExtensionContext,
  tokensPerSecond: number | null,
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
 * Registers the status-line renderer and session-owned refresh resources.
 * Event effects run synchronously; handlers return promises and reject on failure.
 * Shutdown cancels timers and commands and releases only UI slots still owned here.
 * @param pi Host extension API used for events, UI state, and command execution.
 * @example ompStatusLine(pi); // Installs UI on session_start in TUI mode.
 */
export default function ompStatusLine(pi: ExtensionAPI): void {
  let currentCtx: ExtensionContext | null = null;
  let settings: StatusLineSettings = readSettings(process.cwd(), false);
  let footerData: ReadonlyFooterDataProvider | null = null;
  let tui: { requestRender: () => void } | null = null;
  let footerUnsubscribe: (() => void) | null = null;
  let ticker: NodeJS.Timeout | undefined;
  let delayedRefresh: NodeJS.Timeout | undefined;
  let disposeUi: (() => void) | null = null;
  let activeMs = 0;
  let activeStartedAt: number | null = null;
  let streamStartedAt: number | null = null;
  let tokensPerSecond: number | null = null;
  let gitLastFetch = 0;
  let gitController: AbortController | null = null;
  let gitInFlight = false;
  let prBranchKey: string | null = null;
  let prController: AbortController | null = null;
  let prInFlight = false;
  let gitState: GitState = {
    branch: null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    pr: null,
  };

  const requestRender = (): void => {
    tui?.requestRender();
  };

  const releaseSessionResources = (): void => {
    clearInterval(ticker);
    ticker = undefined;
    clearTimeout(delayedRefresh);
    delayedRefresh = undefined;
    footerUnsubscribe?.();
    footerUnsubscribe = null;
    gitController?.abort();
    gitController = null;
    gitInFlight = false;
    prController?.abort();
    prController = null;
    prInFlight = false;
    disposeUi?.();
    disposeUi = null;
    currentCtx = null;
    footerData = null;
    tui = null;
    activeMs = 0;
    activeStartedAt = null;
    streamStartedAt = null;
    tokensPerSecond = null;
  };

  const refreshPr = async (
    branch: string | null,
    force = false,
  ): Promise<void> => {
    const ctx = currentCtx;
    if (!(ctx && branch) || branch === "detached" || prInFlight) {
      if (!branch || branch === "detached") {
        gitState.pr = null;
      }
      return;
    }
    const key = `${ctx.cwd}\0${branch}`;
    if (!force && prBranchKey === key) {
      return;
    }
    prBranchKey = key;
    prInFlight = true;
    const controller = new AbortController();
    prController = controller;
    try {
      const result = await pi.exec(
        "gh",
        ["pr", "view", "--json", "number,url"],
        { cwd: ctx.cwd, timeout: 2000, signal: controller.signal },
      );
      if (
        prController !== controller ||
        currentCtx !== ctx ||
        prBranchKey !== key
      ) {
        return;
      }
      if (result.code !== 0) {
        gitState.pr = null;
      } else {
        const parsed: unknown = JSON.parse(result.stdout);
        if (isObjectRecord(parsed)) {
          const { number, url } = parsed;
          gitState.pr =
            typeof number === "number" && typeof url === "string"
              ? { number, url }
              : null;
        } else {
          gitState.pr = null;
        }
      }
    } catch {
      if (
        prController === controller &&
        currentCtx === ctx &&
        prBranchKey === key
      ) {
        gitState.pr = null;
      }
    } finally {
      if (prController === controller) {
        prController = null;
        prInFlight = false;
        requestRender();
      }
    }
  };

  const refreshGit = async (force = false): Promise<void> => {
    const ctx = currentCtx;
    if (
      !ctx ||
      gitInFlight ||
      (!force && Date.now() - gitLastFetch < GIT_TTL_MS)
    ) {
      return;
    }
    gitInFlight = true;
    const controller = new AbortController();
    gitController = controller;
    try {
      const result = await pi.exec(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        { cwd: ctx.cwd, timeout: 2000, signal: controller.signal },
      );
      if (gitController !== controller || currentCtx !== ctx) {
        return;
      }
      if (result.code !== 0) {
        gitState = {
          branch: null,
          staged: 0,
          unstaged: 0,
          untracked: 0,
          pr: null,
        };
        prBranchKey = null;
      } else {
        let staged = 0;
        let unstaged = 0;
        let untracked = 0;
        for (const line of result.stdout.split("\n")) {
          if (line.length < 2) {
            continue;
          }
          const [x, y] = line;
          if (x === "?" && y === "?") {
            untracked++;
            continue;
          }
          if (x !== " " && x !== "?") {
            staged++;
          }
          if (y !== " " && y !== "?") {
            unstaged++;
          }
        }
        const branch = footerData?.getGitBranch() ?? gitState.branch;
        const branchChanged = branch !== gitState.branch;
        gitState = {
          ...gitState,
          branch,
          staged,
          unstaged,
          untracked,
          pr: branchChanged ? null : gitState.pr,
        };
        if (branchChanged) {
          prBranchKey = null;
        }
        // biome-ignore lint/complexity/noVoid: PR refresh handles command errors and must not delay Git completion.
        void refreshPr(branch);
      }
      gitLastFetch = Date.now();
    } catch {
      if (gitController === controller) {
        gitLastFetch = Date.now();
      }
    } finally {
      if (gitController === controller) {
        gitController = null;
        gitInFlight = false;
        requestRender();
      }
    }
  };

  /**
   * Estimates text tokens as UTF-8 bytes rounded up to groups of four.
   * @param text Text measured in bytes, not characters or terminal cells.
   * @example estimateTextTokens("hello"); // 2, not an exact tokenizer count.
   */
  const estimateTextTokens = (text: string): number =>
    (Buffer.byteLength(text, "utf8") + TOKEN_ESTIMATE_ROUNDING_OFFSET) >> 2;

  const estimateNonMessageTokens = (ctx: ExtensionContext): number => {
    let tokens = estimateTextTokens(ctx.getSystemPrompt());
    const activeTools = new Set(pi.getActiveTools());
    for (const tool of pi.getAllTools()) {
      if (!activeTools.has(tool.name)) {
        continue;
      }
      tokens += estimateTextTokens(tool.name);
      tokens += estimateTextTokens(tool.description);
      try {
        tokens += estimateTextTokens(JSON.stringify(tool.parameters));
      } catch {
        // A cyclic extension schema cannot be sent verbatim either; omit only that schema.
      }
    }
    return tokens;
  };

  const estimateContextEntryTokens = (ctx: ExtensionContext): number => {
    let tokens = 0;
    for (const entry of ctx.sessionManager.buildContextEntries()) {
      if (entry.type === "message") {
        tokens += estimateTokens(entry.message);
      } else if (
        entry.type === "compaction" ||
        entry.type === "branch_summary"
      ) {
        tokens += estimateTextTokens(entry.summary);
      } else if (entry.type === "custom_message") {
        tokens += estimateTextTokens(
          typeof entry.content === "string"
            ? entry.content
            : JSON.stringify(entry.content),
        );
      }
    }
    return tokens;
  };

  const hasProviderContextAnchor = (ctx: ExtensionContext): boolean => {
    const branch = ctx.sessionManager.getBranch();
    let boundary = -1;
    for (let index = branch.length - 1; index >= 0; index--) {
      if (branch[index]?.type === "compaction") {
        boundary = index;
        break;
      }
    }
    for (let index = branch.length - 1; index > boundary; index--) {
      const entry = branch[index];
      if (entry?.type !== "message" || entry.message.role !== "assistant") {
        continue;
      }
      if (
        entry.message.stopReason === "aborted" ||
        entry.message.stopReason === "error"
      ) {
        continue;
      }
      const usage = messageUsage(entry.message);
      if (!usage) {
        continue;
      }
      const { totalTokens, input, output, cacheRead, cacheWrite } = usage;
      const contextTokens =
        numeric(totalTokens) ||
        numeric(input) +
          numeric(output) +
          numeric(cacheRead) +
          numeric(cacheWrite);
      if (contextTokens > 0) {
        return true;
      }
    }
    return false;
  };

  /**
   * Snapshots host usage and wall-clock active milliseconds without starting timers.
   * @param theme Styling callbacks retained for segment rendering; host errors propagate.
   * @param options Per-segment display options, retained without mutation.
   * @returns Context with 0–100 percentage units, or null before a session is available.
   * @example With no currentCtx, buildSegmentContext(theme, {}) returns null.
   */
  const buildSegmentContext = (
    theme: Theme,
    options: StatusLineSegmentOptions,
  ): SegmentContext | null => {
    if (!currentCtx) {
      return null;
    }
    const context = currentCtx.getContextUsage();
    const contextWindow =
      context?.contextWindow ?? currentCtx.model?.contextWindow ?? 0;
    const providerAnchored = hasProviderContextAnchor(currentCtx);
    const estimatedMessages =
      context?.tokens ?? estimateContextEntryTokens(currentCtx);
    const contextTokens =
      providerAnchored &&
      context?.tokens !== null &&
      context?.tokens !== undefined
        ? context.tokens
        : estimateNonMessageTokens(currentCtx) + estimatedMessages;
    const now = Date.now();
    return {
      extensionContext: currentCtx,
      footerData,
      theme,
      settings,
      options,
      usage: aggregateUsage(currentCtx, tokensPerSecond),
      contextTokens,
      contextPercent:
        contextWindow > 0
          ? (contextTokens / contextWindow) * PERCENT_SCALE
          : null,
      contextWindow,
      autoCompactEnabled: true,
      activeMs:
        activeMs + (activeStartedAt === null ? 0 : now - activeStartedAt),
      git: {
        ...gitState,
        branch: footerData?.getGitBranch() ?? gitState.branch,
      },
    };
  };

  /**
   * Fits ANSI segments to width in terminal cells, not string length; refreshes Git nonblocking.
   * @param width Available cells, including separators and caps.
   * Drops right segments, then shortens the path before dropping other left segments.
   * @returns Styled row or empty text without a session/positive width; host errors propagate.
   * @example buildStatusLine(0, theme); // ""
   */
  const buildStatusLine = (width: number, theme: Theme): string => {
    if (width <= 0) {
      return "";
    }
    // biome-ignore lint/complexity/noVoid: Git refresh handles command errors and must not block rendering.
    void refreshGit();
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
    const endCaps = transparent ? EMPTY_END_CAPS : separator.endCaps;
    const leftCapWidth = visibleWidth(endCaps.right);
    const rightCapWidth = visibleWidth(endCaps.left);
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
    const totalWidth = (): number =>
      leftWidth + rightWidth + (left.length > 0 && right.length > 0 ? 1 : 0);

    while (totalWidth() > width && right.length > 0) {
      right.pop();
      rightWidth = groupWidth(right, rightCapWidth, rightSeparatorWidth);
    }

    const pathIndex = leftIds.indexOf("path");
    if (pathIndex >= 0 && totalWidth() > width) {
      const overflow = totalWidth() - width;
      const currentWidth = visibleWidth(left[pathIndex] ?? "");
      const minPathWidth = 8;
      const shrinkable = currentWidth - minPathWidth;
      if (shrinkable > 0) {
        const shrinkBy = Math.min(shrinkable, overflow);
        const currentMaxLength =
          preset.segmentOptions.path?.maxLength ?? DEFAULT_PATH_MAX_LENGTH;
        let nextMaxLength = Math.max(
          MIN_PATH_MAX_LENGTH,
          Math.min(currentMaxLength, currentWidth) - shrinkBy,
        );
        const pathCtx = (maxLength: number): SegmentContext => ({
          ...segmentCtx,
          options: {
            ...segmentCtx.options,
            path: { ...segmentCtx.options.path, maxLength },
          },
        });
        let adjusted = renderSegment("path", pathCtx(nextMaxLength));
        if (adjusted.visible && adjusted.content) {
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
          left[pathIndex] = adjusted.content;
          leftWidth = groupWidth(left, leftCapWidth, leftSeparatorWidth);
        }
      }
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

        let bottomBorderIndex = lines.length - 1;
        for (let index = lines.length - 1; index >= 1; index--) {
          if (
            EDITOR_BORDER_RE.test(stripVTControlCharacters(lines[index] ?? ""))
          ) {
            bottomBorderIndex = index;
            break;
          }
        }

        const { theme } = currentCtx.ui;
        const border = theme.getFgAnsi("border");
        const paintBorder = (text: string): string =>
          `${border}${text}\x1b[39m`;
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
      footerData = null;
      tui = null;
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
        gitLastFetch = 0;
        prBranchKey = null;
        prController?.abort();
        prController = null;
        prInFlight = false;
        // biome-ignore lint/complexity/noVoid: Git refresh handles command errors and branch notifications stay nonblocking.
        void refreshGit(true);
      });
      footerUnsubscribe = unsubscribe;
      // biome-ignore lint/complexity/noVoid: Git refresh handles command errors and footer installation stays synchronous.
      void refreshGit(true);
      return {
        dispose(): void {
          ownsFooterSlot = false;
          if (footerUnsubscribe === unsubscribe) {
            unsubscribe();
            footerUnsubscribe = null;
          }
          if (footerData === data) {
            footerData = null;
            tui = null;
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

  // Executors retain synchronous event effects and turn thrown failures into rejections.
  /**
   * Resets session state and installs TUI chrome plus an owned one-second refresh timer.
   * @example A non-TUI session_start resets counters without installing UI or a ticker.
   */
  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx;
    settings = readSettings(ctx.cwd, ctx.isProjectTrusted());
    activeMs = 0;
    activeStartedAt = null;
    streamStartedAt = null;
    tokensPerSecond = null;
    gitLastFetch = 0;
    prBranchKey = null;
    gitState = {
      branch: null,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      pr: null,
    };
    if (ctx.mode !== "tui") {
      return Promise.resolve();
    }

    installUi(ctx);
    ticker = setInterval(() => {
      // biome-ignore lint/complexity/noVoid: Git refresh handles command errors and must not delay this render tick.
      void refreshGit();
      requestRender();
    }, STATUS_REFRESH_INTERVAL_MS);
    return Promise.resolve();
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
  pi.on("agent_start", (_event, ctx) => {
    currentCtx = ctx;
    if (activeStartedAt === null) {
      activeStartedAt = Date.now();
    }
    streamStartedAt = Date.now();
    requestRender();
    return Promise.resolve();
  });
  // ponytail: share the identical message_update/message_end usage callback.
  /**
   * Updates output tokens/second from wall-clock stream duration and requests a render.
   * @example 20 output tokens over two seconds sets tokensPerSecond to 10.
   */
  pi.on("message_update", (event, ctx) => {
    currentCtx = ctx;
    const usage = messageUsage(event.message);
    if (usage && streamStartedAt !== null) {
      const elapsed = (Date.now() - streamStartedAt) / MILLISECONDS_PER_SECOND;
      const { output } = usage;
      const outputTokens = numeric(output);
      if (elapsed > 0 && outputTokens > 0) {
        tokensPerSecond = outputTokens / elapsed;
      }
    }
    requestRender();
    return Promise.resolve();
  });
  /**
   * Records final output tokens/second when positive usage and elapsed time are available.
   * @example A final message with zero output retains the last rate and requests a render.
   */
  pi.on("message_end", (event, ctx) => {
    currentCtx = ctx;
    const usage = messageUsage(event.message);
    if (usage && streamStartedAt !== null) {
      const elapsed = (Date.now() - streamStartedAt) / MILLISECONDS_PER_SECOND;
      const { output } = usage;
      const outputTokens = numeric(output);
      if (elapsed > 0 && outputTokens > 0) {
        tokensPerSecond = outputTokens / elapsed;
      }
    }
    requestRender();
    return Promise.resolve();
  });
  pi.on("agent_end", (_event, ctx) => {
    currentCtx = ctx;
    if (activeStartedAt !== null) {
      activeMs += Date.now() - activeStartedAt;
      activeStartedAt = null;
    }
    streamStartedAt = null;
    requestRender();
    return Promise.resolve();
  });
  pi.on("tool_result", (event, ctx) => {
    currentCtx = ctx;
    if (event.toolName === "write" || event.toolName === "edit") {
      gitLastFetch = 0;
      // biome-ignore lint/complexity/noVoid: Git refresh handles command errors and must not delay tool-result completion.
      void refreshGit(true);
      return Promise.resolve();
    }
    if (event.toolName !== "bash" || !isObjectRecord(event.input)) {
      return Promise.resolve();
    }
    const { command } = event.input;
    if (typeof command === "string" && GIT_BRANCH_COMMAND_RE.test(command)) {
      gitLastFetch = 0;
      prBranchKey = null;
      prController?.abort();
      prController = null;
      prInFlight = false;
      // biome-ignore lint/complexity/noVoid: Git refresh handles command errors and must not delay tool-result completion.
      void refreshGit(true);
    }
    return Promise.resolve();
  });
  /**
   * Coalesces Git-changing shell commands into one owned 150 ms refresh timeout.
   * @example Two immediate "git switch" events replace the pending timeout, not duplicate it.
   */
  pi.on("user_bash", (event, ctx) => {
    currentCtx = ctx;
    if (GIT_BRANCH_COMMAND_RE.test(event.command)) {
      clearTimeout(delayedRefresh);
      delayedRefresh = setTimeout(() => {
        delayedRefresh = undefined;
        prController?.abort();
        prController = null;
        prInFlight = false;
        // biome-ignore lint/complexity/noVoid: Git refresh handles command errors and the coalescing timer stays nonblocking.
        void refreshGit(true);
      }, GIT_REFRESH_COALESCE_DELAY_MS);
    }
    return Promise.resolve();
  });
  pi.on("session_shutdown", () => {
    releaseSessionResources();
    return Promise.resolve();
  });
}
