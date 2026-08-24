import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  estimateTokens,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isObjectRecord } from "./guards.ts";
import { getPreset } from "./presets.ts";
import { renderSegment } from "./segments.ts";
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
  const configured = process.env["PI_CODING_AGENT_DIR"]?.trim();
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

function readSettings(cwd: string): StatusLineSettings {
  const global = readJsonObject(path.join(agentDir(), "settings.json"));
  const project = readJsonObject(path.join(cwd, ".pi", "settings.json"));
  const globalStatus = isObjectRecord(global["statusLine"])
    ? global["statusLine"]
    : {};
  const projectStatus = isObjectRecord(project["statusLine"])
    ? project["statusLine"]
    : {};
  const raw = { ...globalStatus, ...projectStatus };
  const preset =
    typeof raw["preset"] === "string" &&
    PRESETS[raw["preset"] as StatusLineSettings["preset"]] === true
      ? (raw["preset"] as StatusLineSettings["preset"])
      : "default";
  const separator =
    typeof raw["separator"] === "string" &&
    SEPARATORS[raw["separator"] as StatusLineSeparatorStyle] === true
      ? (raw["separator"] as StatusLineSeparatorStyle)
      : undefined;
  const segmentOptions =
    isObjectRecord(globalStatus["segmentOptions"]) ||
    isObjectRecord(projectStatus["segmentOptions"])
      ? mergeOptions(
          isObjectRecord(globalStatus["segmentOptions"])
            ? (globalStatus["segmentOptions"] as StatusLineSegmentOptions)
            : undefined,
          isObjectRecord(projectStatus["segmentOptions"])
            ? (projectStatus["segmentOptions"] as StatusLineSegmentOptions)
            : undefined,
        )
      : undefined;
  return {
    preset,
    ...toNonNullRecord({
      leftSegments: parseSegmentIds(raw["leftSegments"]),
      rightSegments: parseSegmentIds(raw["rightSegments"]),
      separator,
      segmentOptions,
    }),
    showHookStatus: raw["showHookStatus"] !== false,
    sessionAccent: raw["sessionAccent"] !== false,
    transparent: raw["transparent"] === true,
    compactThinkingLevel: raw["compactThinkingLevel"] === true,
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
  if (
    !isObjectRecord(message) ||
    message["role"] !== "assistant" ||
    !isObjectRecord(message["usage"])
  )
    return undefined;
  return message["usage"];
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
    stats.input += numeric(usage["input"]);
    stats.output += numeric(usage["output"]);
    stats.cacheRead += numeric(usage["cacheRead"]);
    stats.cacheWrite += numeric(usage["cacheWrite"]);
    stats.premiumRequests += numeric(usage["premiumRequests"]);
    const cost = usage["cost"];
    stats.cost += isObjectRecord(cost) ? numeric(cost["total"]) : numeric(cost);
  }
  return stats;
}

function sanitizeStatus(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").trim();
}

export default function ompStatusLine(pi: ExtensionAPI): void {
  let currentCtx: ExtensionContext | null = null;
  let settings: StatusLineSettings = readSettings(process.cwd());
  let footerData: ReadonlyFooterDataProvider | null = null;
  let tui: { requestRender(): void } | null = null;
  let footerUnsubscribe: (() => void) | null = null;
  let ticker: NodeJS.Timeout | undefined;
  let editorInstalled = false;
  let activeMs = 0;
  let activeStartedAt: number | null = null;
  let streamStartedAt: number | null = null;
  let tokensPerSecond: number | null = null;
  let gitLastFetch = 0;
  let gitInFlight = false;
  let prBranchKey: string | null = null;
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

  const refreshPr = async (
    branch: string | null,
    force = false,
  ): Promise<void> => {
    if (!currentCtx || !branch || branch === "detached" || prInFlight) {
      if (!branch || branch === "detached") gitState.pr = null;
      return;
    }
    const key = `${currentCtx.cwd}\0${branch}`;
    if (!force && prBranchKey === key) return;
    prBranchKey = key;
    prInFlight = true;
    try {
      const result = await pi.exec(
        "gh",
        ["pr", "view", "--json", "number,url"],
        { cwd: currentCtx.cwd, timeout: 2_000 },
      );
      if (result.code !== 0) {
        gitState.pr = null;
      } else {
        const parsed: unknown = JSON.parse(result.stdout);
        gitState.pr =
          isObjectRecord(parsed) &&
          typeof parsed["number"] === "number" &&
          typeof parsed["url"] === "string"
            ? { number: parsed["number"], url: parsed["url"] }
            : null;
      }
    } catch {
      gitState.pr = null;
    } finally {
      prInFlight = false;
      requestRender();
    }
  };

  const refreshGit = async (force = false): Promise<void> => {
    if (
      !currentCtx ||
      gitInFlight ||
      (!force && Date.now() - gitLastFetch < GIT_TTL_MS)
    )
      return;
    gitInFlight = true;
    const cwd = currentCtx.cwd;
    try {
      const result = await pi.exec(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        { cwd, timeout: 2_000 },
      );
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
      gitLastFetch = Date.now();
    } finally {
      gitInFlight = false;
      requestRender();
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
      const contextTokens =
        numeric(usage["totalTokens"]) ||
        numeric(usage["input"]) +
          numeric(usage["output"]) +
          numeric(usage["cacheRead"]) +
          numeric(usage["cacheWrite"]);
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
    const sessionName = currentCtx?.sessionManager.getSessionName();
    const gapColor =
      settings.sessionAccent && sessionName
        ? sessionAccentAnsi(sessionName)
        : theme.getFgAnsi("border");
    return `${leftGroup}${gapColor}${"─".repeat(gapWidth)}\x1b[39m${rightGroup}`;
  };

  const installUi = (ctx: ExtensionContext): void => {
    if (!editorInstalled) {
      const previousEditorFactory = ctx.ui.getEditorComponent();
      ctx.ui.setEditorComponent((editorTui, editorTheme, keybindings) => {
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
                `${paintBorder("│  ")}${line}${lineFill}${paintBorder("  │")}`,
              );
            }
          }
          for (const line of lines.slice(bottomBorderIndex + 1)) {
            result.push(`${" ".repeat(chromeWidth)}${line}`);
          }
          return result;
        };
        return editor;
      });
      editorInstalled = true;
    }

    ctx.ui.setFooter((footerTui, _theme, data) => {
      footerData = data;
      tui = footerTui;
      footerUnsubscribe?.();
      footerUnsubscribe = data.onBranchChange(() => {
        gitLastFetch = 0;
        prBranchKey = null;
        void refreshGit(true);
      });
      void refreshGit(true);
      return {
        dispose(): void {
          footerUnsubscribe?.();
          footerUnsubscribe = null;
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
          const statuses = Array.from(data.getExtensionStatuses().entries())
            .filter(
              ([key]) =>
                !(
                  STATUS_KEYS[key] === true &&
                  usedSegments.has(key as StatusLineSegmentId)
                ),
            )
            .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
            .map(([, text]) => truncateToWidth(sanitizeStatus(text), width));
          return statuses;
        },
      };
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    settings = readSettings(ctx.cwd);
    activeMs = 0;
    activeStartedAt = null;
    streamStartedAt = null;
    tokensPerSecond = null;
    gitLastFetch = 0;
    prBranchKey = null;
    gitState = { branch: null, staged: 0, unstaged: 0, untracked: 0, pr: null };
    if (ctx.mode === "tui") installUi(ctx);
    ticker ??= setInterval(() => {
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
      const output = numeric(usage["output"]);
      if (elapsed > 0 && output > 0) tokensPerSecond = output / elapsed;
    }
    requestRender();
  });
  pi.on("message_end", async (event, ctx) => {
    currentCtx = ctx;
    const usage = messageUsage(event.message);
    if (usage && streamStartedAt !== null) {
      const elapsed = (Date.now() - streamStartedAt) / 1000;
      const output = numeric(usage["output"]);
      if (elapsed > 0 && output > 0) tokensPerSecond = output / elapsed;
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
    if (
      event.toolName === "bash" &&
      isObjectRecord(event.input) &&
      typeof event.input["command"] === "string" &&
      /\bgit\s+(checkout|switch|branch|merge|rebase|pull|reset|worktree|stash)/.test(
        event.input["command"],
      )
    ) {
      gitLastFetch = 0;
      prBranchKey = null;
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
      gitLastFetch = 0;
      prBranchKey = null;
      setTimeout(() => void refreshGit(true), 150);
    }
  });
  pi.on("session_shutdown", async () => {
    clearInterval(ticker);
    ticker = undefined;
    footerUnsubscribe?.();
    footerUnsubscribe = null;
    currentCtx = null;
    footerData = null;
    tui = null;
  });
}
