import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
  token_in: true,
  token_out: true,
  token_total: true,
  token_rate: true,
  cost: true,
  context_pct: true,
  context_total: true,
  time_spent: true,
  time: true,
  session: true,
  hostname: true,
  cache_read: true,
  cache_write: true,
  cache_hit: true,
  session_name: true,
  usage: true,
  collab: true,
};
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
const GIT_TTL_MS = 1_000;

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function agentDir(): string {
  const { PI_CODING_AGENT_DIR } = process.env;
  const configured = PI_CODING_AGENT_DIR?.trim();
  return configured || path.join(os.homedir(), ".pi", "agent");
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
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (item): item is StatusLineSegmentId =>
      typeof item === "string" &&
      SEGMENT_IDS[item as StatusLineSegmentId] === true,
  );
}

type NonNullRecord<T extends Record<PropertyKey, unknown>> = {
  [K in keyof T]?: NonNullable<T[K]>;
};

function toNonNullRecord<T extends Record<PropertyKey, unknown>>(
  record: T,
): NonNullRecord<T> {
  const result: NonNullRecord<T> = {};
  for (const key of Reflect.ownKeys(record) as Array<keyof T>) {
    const value = record[key];
    if (value !== null && value !== undefined) result[key] = value;
  }
  return result;
}

function readSettings(
  cwd: string,
  projectTrusted: boolean,
): StatusLineSettings {
  const global = readJsonObject(path.join(agentDir(), "settings.json"));
  // Pi does not expose its merged SettingsManager to extensions. Because this
  // extension reads settings directly, mirror Pi's trust gate before loading
  // project-local configuration.
  const project = projectTrusted
    ? readJsonObject(path.join(cwd, ".pi", "settings.json"))
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
  if (!isObjectRecord(message)) return undefined;
  const { role, usage } = message;
  if (role !== "assistant" || !isObjectRecord(usage)) return undefined;
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
    if (entry.type !== "message") continue;
    const usage = messageUsage(entry.message);
    if (!usage) continue;
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

export default function ompStatusLine(pi: ExtensionAPI): void {
  let currentCtx: ExtensionContext | null = null;
  let settings: StatusLineSettings = readSettings(process.cwd(), false);
  let footerData: ReadonlyFooterDataProvider | null = null;
  let tui: { requestRender(): void } | null = null;
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
    if (!ctx || !branch || branch === "detached" || prInFlight) {
      if (!branch || branch === "detached") gitState.pr = null;
      return;
    }
    const key = `${ctx.cwd}\0${branch}`;
    if (!force && prBranchKey === key) return;
    prBranchKey = key;
    prInFlight = true;
    const controller = new AbortController();
    prController = controller;
    try {
      const result = await pi.exec(
        "gh",
        ["pr", "view", "--json", "number,url"],
        { cwd: ctx.cwd, timeout: 2_000, signal: controller.signal },
      );
      if (
        prController !== controller ||
        currentCtx !== ctx ||
        prBranchKey !== key
      )
        return;
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
      )
        gitState.pr = null;
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
    )
      return;
    gitInFlight = true;
    const controller = new AbortController();
    gitController = controller;
    try {
      const result = await pi.exec(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        { cwd: ctx.cwd, timeout: 2_000, signal: controller.signal },
      );
      if (gitController !== controller || currentCtx !== ctx) return;
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
          if (line.length < 2) continue;
          const x = line[0];
          const y = line[1];
          if (x === "?" && y === "?") {
            untracked++;
            continue;
          }
          if (x !== " " && x !== "?") staged++;
          if (y !== " " && y !== "?") unstaged++;
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
        if (branchChanged) prBranchKey = null;
        void refreshPr(branch);
      }
      gitLastFetch = Date.now();
    } catch {
      if (gitController === controller) gitLastFetch = Date.now();
    } finally {
      if (gitController === controller) {
        gitController = null;
        gitInFlight = false;
        requestRender();
      }
    }
  };

  const estimateTextTokens = (text: string): number =>
    (Buffer.byteLength(text, "utf8") + 3) >> 2;

  const estimateNonMessageTokens = (ctx: ExtensionContext): number => {
    let tokens = estimateTextTokens(ctx.getSystemPrompt());
    const activeTools = new Set(pi.getActiveTools());
    for (const tool of pi.getAllTools()) {
      if (!activeTools.has(tool.name)) continue;
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
      if (entry?.type !== "message" || entry.message.role !== "assistant")
        continue;
      if (
        entry.message.stopReason === "aborted" ||
        entry.message.stopReason === "error"
      )
        continue;
      const usage = messageUsage(entry.message);
      if (!usage) continue;
      const { totalTokens, input, output, cacheRead, cacheWrite } = usage;
      const contextTokens =
        numeric(totalTokens) ||
        numeric(input) +
          numeric(output) +
          numeric(cacheRead) +
          numeric(cacheWrite);
      if (contextTokens > 0) return true;
    }
    return false;
  };

  const buildSegmentContext = (
    theme: Theme,
    options: StatusLineSegmentOptions,
  ): SegmentContext | null => {
    if (!currentCtx) return null;
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
        contextWindow > 0 ? (contextTokens / contextWindow) * 100 : null,
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

  const buildStatusLine = (width: number, theme: Theme): string => {
    if (width <= 0) return "";
    void refreshGit();
    const preset = effectivePreset(settings);
    const segmentCtx = buildSegmentContext(theme, preset.segmentOptions);
    if (!segmentCtx) return "";
    const separator = getSeparator(
      preset.separator,
      settings.preset === "ascii",
    );
    const bg = settings.transparent ? TRANSPARENT_BG : DEFAULT_STATUS_BG;
    const transparent = settings.transparent;
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
      if (rendered.visible && rendered.content) right.push(rendered.content);
    }

    const leftSeparatorWidth = visibleWidth(separator.left);
    const rightSeparatorWidth = visibleWidth(separator.right);
    const leftCapWidth =
      separator.endCaps && !transparent
        ? visibleWidth(separator.endCaps.right)
        : 0;
    const rightCapWidth =
      separator.endCaps && !transparent
        ? visibleWidth(separator.endCaps.left)
        : 0;
    const groupWidth = (
      parts: string[],
      capWidth: number,
      separatorWidth: number,
    ): number => {
      if (parts.length === 0) return 0;
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
        const currentMaxLength = preset.segmentOptions.path?.maxLength ?? 40;
        let nextMaxLength = Math.max(
          4,
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
          for (let attempt = 0; attempt < 8; attempt++) {
            const saved = currentWidth - visibleWidth(adjusted.content);
            if (saved >= shrinkBy) break;
            const correctedMaxLength = Math.max(
              4,
              nextMaxLength - (shrinkBy - saved),
            );
            if (correctedMaxLength >= nextMaxLength) break;
            nextMaxLength = correctedMaxLength;
            const rerendered = renderSegment("path", pathCtx(nextMaxLength));
            if (!rerendered.visible || !rerendered.content) break;
            adjusted = rerendered;
          }
          left[pathIndex] = adjusted.content;
          leftWidth = groupWidth(left, leftCapWidth, leftSeparatorWidth);
        }
      }
    }

    while (totalWidth() > width && left.length > 0) {
      let dropIndex = leftIds.length - 1;
      while (dropIndex >= 0 && leftIds[dropIndex] === "path") dropIndex--;
      if (dropIndex < 0) dropIndex = left.length - 1;
      left.splice(dropIndex, 1);
      leftIds.splice(dropIndex, 1);
      leftWidth = groupWidth(left, leftCapWidth, leftSeparatorWidth);
    }

    const renderGroup = (
      parts: string[],
      direction: "left" | "right",
    ): string => {
      if (parts.length === 0) return "";
      const separatorText =
        direction === "left" ? separator.left : separator.right;
      const cap =
        separator.endCaps && !transparent
          ? direction === "left"
            ? separator.endCaps.right
            : separator.endCaps.left
          : "";
      const capText = cap ? `${STATUS_BG_AS_FG}${cap}${RESET}` : "";
      const content = `${bg}${foreground} ${parts.join(` ${STATUS_SEPARATOR_FG}${separatorText}${foreground} `)} ${RESET}`;
      return direction === "right"
        ? `${capText}${content}`
        : `${content}${capText}`;
    };

    const leftGroup = renderGroup(left, "left");
    const rightGroup = renderGroup(right, "right");
    if (!leftGroup && !rightGroup) return "";
    if (!leftGroup || !rightGroup) return `${leftGroup}${rightGroup}`;

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

  const installUi = (ctx: ExtensionContext): void => {
    const previousEditorFactory = ctx.ui.getEditorComponent();
    const installedEditorFactory: NonNullable<
      Parameters<ExtensionUIContext["setEditorComponent"]>[0]
    > = (editorTui, editorTheme, keybindings) => {
      const editor =
        previousEditorFactory?.(editorTui, editorTheme, keybindings) ??
        new CustomEditor(editorTui, editorTheme, keybindings);
      const originalRender = editor.render.bind(editor);
      editor.render = (width: number): string[] => {
        if (width < 10 || !currentCtx) return [...originalRender(width)];
        const chromeWidth = 3;
        const contentWidth = Math.max(1, width - chromeWidth * 2);
        const lines = [...originalRender(contentWidth)];
        if (lines.length < 3) return lines;

        let bottomBorderIndex = lines.length - 1;
        for (let index = lines.length - 1; index >= 1; index--) {
          if (/^─{3,}/.test(stripVTControlCharacters(lines[index] ?? ""))) {
            bottomBorderIndex = index;
            break;
          }
        }

        const theme = currentCtx.ui.theme;
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
      if (disposed) return;
      if (ownsFooterSlot) {
        ownsFooterSlot = false;
        ctx.ui.setFooter(undefined);
      }
      if (ctx.ui.getEditorComponent() === installedEditorFactory)
        ctx.ui.setEditorComponent(previousEditorFactory);
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
        void refreshGit(true);
      });
      footerUnsubscribe = unsubscribe;
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
          if (!settings.showHookStatus) return [];
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
    if (!footerFactoryInvoked) ownsFooterSlot = true;
  };

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    settings = readSettings(ctx.cwd, ctx.isProjectTrusted());
    activeMs = 0;
    activeStartedAt = null;
    streamStartedAt = null;
    tokensPerSecond = null;
    gitLastFetch = 0;
    prBranchKey = null;
    gitState = { branch: null, staged: 0, unstaged: 0, untracked: 0, pr: null };
    if (ctx.mode !== "tui") return;

    installUi(ctx);
    ticker = setInterval(() => {
      void refreshGit();
      requestRender();
    }, 1_000);
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    currentCtx = ctx;
    requestRender();
  });
  pi.on("model_select", async (_event, ctx) => {
    currentCtx = ctx;
    requestRender();
  });
  pi.on("thinking_level_select", async (_event, ctx) => {
    currentCtx = ctx;
    requestRender();
  });
  pi.on("session_tree", async (_event, ctx) => {
    currentCtx = ctx;
    requestRender();
  });
  pi.on("session_compact", async (_event, ctx) => {
    currentCtx = ctx;
    requestRender();
  });
  pi.on("agent_start", async (_event, ctx) => {
    currentCtx = ctx;
    if (activeStartedAt === null) activeStartedAt = Date.now();
    streamStartedAt = Date.now();
    requestRender();
  });
  pi.on("message_update", async (event, ctx) => {
    currentCtx = ctx;
    const usage = messageUsage(event.message);
    if (usage && streamStartedAt !== null) {
      const elapsed = (Date.now() - streamStartedAt) / 1000;
      const { output } = usage;
      const outputTokens = numeric(output);
      if (elapsed > 0 && outputTokens > 0)
        tokensPerSecond = outputTokens / elapsed;
    }
    requestRender();
  });
  pi.on("message_end", async (event, ctx) => {
    currentCtx = ctx;
    const usage = messageUsage(event.message);
    if (usage && streamStartedAt !== null) {
      const elapsed = (Date.now() - streamStartedAt) / 1000;
      const { output } = usage;
      const outputTokens = numeric(output);
      if (elapsed > 0 && outputTokens > 0)
        tokensPerSecond = outputTokens / elapsed;
    }
    requestRender();
  });
  pi.on("agent_end", async (_event, ctx) => {
    currentCtx = ctx;
    if (activeStartedAt !== null) {
      activeMs += Date.now() - activeStartedAt;
      activeStartedAt = null;
    }
    streamStartedAt = null;
    requestRender();
  });
  pi.on("tool_result", async (event, ctx) => {
    currentCtx = ctx;
    if (event.toolName === "write" || event.toolName === "edit") {
      gitLastFetch = 0;
      void refreshGit(true);
      return;
    }
    if (event.toolName !== "bash" || !isObjectRecord(event.input)) return;
    const { command } = event.input;
    if (
      typeof command === "string" &&
      /\bgit\s+(checkout|switch|branch|merge|rebase|pull|reset|worktree|stash)/.test(
        command,
      )
    ) {
      gitLastFetch = 0;
      prBranchKey = null;
      prController?.abort();
      prController = null;
      prInFlight = false;
      void refreshGit(true);
    }
  });
  pi.on("user_bash", async (event, ctx) => {
    currentCtx = ctx;
    if (
      /\bgit\s+(checkout|switch|branch|merge|rebase|pull|reset|worktree|stash)/.test(
        event.command,
      )
    ) {
      clearTimeout(delayedRefresh);
      delayedRefresh = setTimeout(() => {
        delayedRefresh = undefined;
        prController?.abort();
        prController = null;
        prInFlight = false;
        void refreshGit(true);
      }, 150);
    }
  });
  pi.on("session_shutdown", async () => {
    releaseSessionResources();
  });
}
