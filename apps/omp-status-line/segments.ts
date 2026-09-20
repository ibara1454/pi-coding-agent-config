import { homedir, hostname } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { URL } from "node:url";
import {
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { color, getIcons, sessionAccentAnsi, statusColor } from "./theme.ts";
import type {
  RenderedSegment,
  SegmentContext,
  StatusLineSegmentId,
} from "./types.ts";

const TRAILING_DECIMAL_ZERO_RE = /\.0$/;
const WHITESPACE_RE = /\s/u;
const GPT_MODEL_ID_RE = /^gpt-[\d.]+-[a-z][a-z0-9-]*$/i;
const MODEL_VERSION_RE = /^[\d.]+$/;
const BILLION_UNIT = 1_000_000_000;
const BILLION_ROUNDING_THRESHOLD = 10_000_000_000;
const MILLION_UNIT = 1_000_000;
const MILLION_ROUNDING_THRESHOLD = 10_000_000;
const THOUSAND_UNIT = 1000;
const THOUSAND_ROUNDING_THRESHOLD = 10_000;
const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;
const C0_CONTROL_CHARACTER_MAX = 0x1f;
const DELETE_CHARACTER_CODE = 0x7f;
const C1_CONTROL_CHARACTER_MAX = 0x9f;
const CLAUDE_MODEL_PREFIX = "Claude ";
const DEFAULT_PATH_MAX_LENGTH = 40;
const PERCENT_SCALE = 100;
const CONTEXT_ERROR_PERCENT = 90;
const CONTEXT_ERROR_TOKEN_THRESHOLD = 500_000;
const CONTEXT_THINKING_HIGH_PERCENT = 70;
const CONTEXT_THINKING_HIGH_TOKEN_THRESHOLD = 270_000;
const CONTEXT_WARNING_PERCENT = 50;
const CONTEXT_WARNING_TOKEN_THRESHOLD = 150_000;
const HOURS_PER_HALF_DAY = 12;
const PREMIUM_REQUEST_DECIMAL_FACTOR = 100;
const MINIMUM_ACTIVE_TIME_MS = MILLISECONDS_PER_SECOND;
const SESSION_ID_DISPLAY_WIDTH = 8;

function withIcon(icon: string, text: string): string {
  return icon ? `${icon} ${text}` : text;
}

/**
 * Formats a count with K/M/B suffixes, preserving sign and omitting decimal zeros.
 * @param value Count; suffixes use magnitude, with one decimal below ten units.
 * @returns Compact text, rounding values below 1000 to an integer.
 * @example formatNumber(1500); // "1.5K"
 */
function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= BILLION_UNIT) {
    return `${(value / BILLION_UNIT).toFixed(abs >= BILLION_ROUNDING_THRESHOLD ? 0 : 1).replace(TRAILING_DECIMAL_ZERO_RE, "")}B`;
  }
  if (abs >= MILLION_UNIT) {
    return `${(value / MILLION_UNIT).toFixed(abs >= MILLION_ROUNDING_THRESHOLD ? 0 : 1).replace(TRAILING_DECIMAL_ZERO_RE, "")}M`;
  }
  if (abs >= THOUSAND_UNIT) {
    return `${(value / THOUSAND_UNIT).toFixed(abs >= THOUSAND_ROUNDING_THRESHOLD ? 0 : 1).replace(TRAILING_DECIMAL_ZERO_RE, "")}K`;
  }
  return Math.round(value).toString();
}

/**
 * Formats nonnegative elapsed milliseconds, discarding subsecond precision.
 * @param milliseconds Elapsed duration in milliseconds, not a wall-clock timestamp.
 * @returns Hours/minutes, minutes/seconds, or seconds; zero trailing units are omitted.
 * @example formatDuration(61000); // "1m 1s"
 */
function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / MILLISECONDS_PER_SECOND);
  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const remainder = seconds % SECONDS_PER_MINUTE;
  if (hours > 0) {
    return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  }
  if (minutes > 0) {
    return `${minutes}m${remainder > 0 ? ` ${remainder}s` : ""}`;
  }
  return `${remainder}s`;
}

/**
 * Removes terminal sequences and replaces each remaining C0/DEL/C1 run with a space.
 * @param text Untrusted inline text; ordinary Unicode and surrounding spaces remain.
 * @returns Plain single-line text without emitting terminal effects.
 * @example sanitizeInlineText("\x1b[31ma\n\tb"); // "a b"
 */
export function sanitizeInlineText(text: string): string {
  const source = stripTerminalSequences(text);
  let sanitized = "";
  let previousWasControl = false;
  for (const character of source) {
    const codePoint = character.codePointAt(0);
    const isControl =
      codePoint !== undefined &&
      (codePoint <= C0_CONTROL_CHARACTER_MAX ||
        (codePoint >= DELETE_CHARACTER_CODE &&
          codePoint <= C1_CONTROL_CHARACTER_MAX));
    if (isControl) {
      if (!previousWasControl) {
        sanitized += " ";
      }
      previousWasControl = true;
      continue;
    }
    sanitized += character;
    previousWasControl = false;
  }
  return sanitized;
}

function safeHyperlinkUrl(text: string): string | null {
  const sanitized = sanitizeInlineText(text).trim();
  if (sanitized !== text || WHITESPACE_RE.test(sanitized)) {
    return null;
  }
  try {
    const url = new URL(sanitized);
    return url.protocol === "http:" || url.protocol === "https:"
      ? sanitized
      : null;
  } catch {
    return null;
  }
}

function clampPathWidth(value: string, maxWidth: number): string {
  const width = visibleWidth(value);
  if (width <= maxWidth) {
    return value;
  }
  const ellipsis = "…";
  const tailWidth = Math.max(0, maxWidth - visibleWidth(ellipsis));
  return `${ellipsis}${sliceByColumn(
    value,
    Math.max(0, width - tailWidth),
    tailWidth,
    true,
  )}`;
}

function statusValue(ctx: SegmentContext, key: string): string | undefined {
  const value = ctx.footerData?.getExtensionStatuses().get(key);
  if (value === undefined) {
    return undefined;
  }
  const sanitized = sanitizeInlineText(value).trim();
  return sanitized || undefined;
}

function thinkingDisplay(ctx: SegmentContext): string {
  if (
    ctx.options.model?.showThinkingLevel === false ||
    !ctx.extensionContext.model?.reasoning
  ) {
    return "";
  }
  const level = ctx.extensionContext.thinkingLevel ?? "off";
  const ascii = ctx.settings.preset === "ascii";
  if (ascii) {
    if (level === "off") {
      return "[off]";
    }
    let label: string = level;
    if (level === "medium") {
      label = "med";
    } else if (level === "xhigh") {
      label = "xhi";
    }
    return `[${label}]`;
  }
  const glyphs: Record<string, string> = {
    off: "⊘ off",
    minimal: "○ min",
    low: "◔ low",
    medium: "◑ med",
    high: "◒ high",
    xhigh: "◕ xhigh",
    max: "◉ max",
  };
  return glyphs[level] ?? level;
}

/**
 * Renders a sanitized model label and configured reasoning indicator without mutation.
 * @param ctx Model and display options; absent names fall back to ID, then "no-model".
 * @returns Visible styled segment, shortening Claude names and canonicalizing GPT IDs.
 * @example With model.name "Claude Sonnet", the label contains "Sonnet", not "Claude".
 */
function renderModel(ctx: SegmentContext): RenderedSegment {
  const icons = getIcons(ctx.settings.preset === "ascii");
  const modelName = sanitizeInlineText(
    ctx.extensionContext.model?.name ?? "",
  ).trim();
  const modelId = sanitizeInlineText(
    ctx.extensionContext.model?.id ?? "",
  ).trim();
  let name = modelName || modelId || "no-model";
  if (name.startsWith(CLAUDE_MODEL_PREFIX)) {
    name = name.slice(CLAUDE_MODEL_PREFIX.length);
  }
  if (GPT_MODEL_ID_RE.test(modelId)) {
    name = modelId
      .split("-")
      .map((part, index) => {
        if (index === 0) {
          return part.toUpperCase();
        }
        if (MODEL_VERSION_RE.test(part)) {
          return part;
        }
        return `${part[0]?.toUpperCase()}${part.slice(1)}`;
      })
      .join("-");
  }
  const thinking = thinkingDisplay(ctx);
  const compact = ctx.settings.compactThinkingLevel && thinking !== "";
  const icon = compact
    ? (thinking.split(" ", 1)[0] ?? icons.model)
    : icons.model;
  const tail = !compact && thinking ? ` · ${thinking}` : "";
  return {
    content: color(statusColor.model, `${withIcon(icon, name)}${tail}`),
    visible: true,
  };
}

/**
 * Renders cwd after configured work-root/home abbreviation and terminal sanitization.
 * @param ctx Path options; maxLength is terminal cells of path text, excluding the icon.
 * @returns Visible styled path, retaining its tail after an ellipsis when too wide.
 * @example With cwd "/work/demo" and default options, the path text is "demo".
 */
function renderPath(ctx: SegmentContext): RenderedSegment {
  const icons = getIcons(ctx.settings.preset === "ascii");
  const opts = ctx.options.path ?? {};
  let { cwd } = ctx.extensionContext;
  if (opts.stripWorkPrefix !== false) {
    for (const root of [join(homedir(), "Projects"), "/work"]) {
      const relativePath = relative(root, cwd);
      if (
        relativePath &&
        !relativePath.startsWith("..") &&
        !isAbsolute(relativePath)
      ) {
        cwd = relativePath;
        break;
      }
    }
  }
  if (
    opts.abbreviate !== false &&
    (cwd === homedir() || cwd.startsWith(`${homedir()}${sep}`))
  ) {
    cwd = `~${cwd.slice(homedir().length)}`;
  }
  cwd = clampPathWidth(
    sanitizeInlineText(cwd),
    opts.maxLength ?? DEFAULT_PATH_MAX_LENGTH,
  );
  return {
    content: color(statusColor.path, withIcon(icons.folder, cwd)),
    visible: true,
  };
}

function renderGit(ctx: SegmentContext): RenderedSegment {
  const icons = getIcons(ctx.settings.preset === "ascii");
  const opts = ctx.options.git ?? {};
  const { branch, staged, unstaged, untracked } = ctx.git;
  if (!branch && staged === 0 && unstaged === 0 && untracked === 0) {
    return { content: "", visible: false };
  }
  const dirty = staged > 0 || unstaged > 0 || untracked > 0;
  const safeBranch = sanitizeInlineText(branch ?? "").trim();
  let content =
    opts.showBranch === false || !safeBranch
      ? ""
      : withIcon(icons.branch, safeBranch);
  const indicators: string[] = [];
  if (opts.showUnstaged !== false && unstaged > 0) {
    indicators.push(color(statusColor.dirty, `*${unstaged}`));
  }
  if (opts.showStaged !== false && staged > 0) {
    indicators.push(color(statusColor.staged, `+${staged}`));
  }
  if (opts.showUntracked !== false && untracked > 0) {
    indicators.push(color(statusColor.untracked, `?${untracked}`));
  }
  if (indicators.length > 0) {
    content += `${content ? " " : withIcon(icons.git, "")}${indicators.join(" ")}`;
  }
  if (!content) {
    return { content: "", visible: false };
  }
  return {
    content: color(
      dirty ? statusColor.gitDirty : statusColor.gitClean,
      content,
    ),
    visible: true,
  };
}

/**
 * Selects context severity at the lower percentage or equivalent token threshold.
 * @param ctx Usage percentage in 0–100 units; unknown usage is zero, not an error.
 * @returns Foreground ANSI; an unknown window uses percentage thresholds alone.
 * @example With contextPercent 90, returns ctx.theme.getFgAnsi("error").
 */
function contextColor(ctx: SegmentContext): string {
  const pct = ctx.contextPercent ?? 0;
  const window = ctx.contextWindow;
  /**
   * Compares current percentage against a percentage or absolute-token boundary.
   * @example reaches(50, 150000) is true at 15% of a million-token window.
   */
  const reaches = (percent: number, tokens: number) =>
    pct >=
    Math.min(percent, window > 0 ? (tokens / window) * PERCENT_SCALE : percent);
  if (reaches(CONTEXT_ERROR_PERCENT, CONTEXT_ERROR_TOKEN_THRESHOLD)) {
    return ctx.theme.getFgAnsi("error");
  }
  if (
    reaches(
      CONTEXT_THINKING_HIGH_PERCENT,
      CONTEXT_THINKING_HIGH_TOKEN_THRESHOLD,
    )
  ) {
    return ctx.theme.getFgAnsi("thinkingHigh");
  }
  if (reaches(CONTEXT_WARNING_PERCENT, CONTEXT_WARNING_TOKEN_THRESHOLD)) {
    return ctx.theme.getFgAnsi("warning");
  }
  return statusColor.context;
}

function renderContext(ctx: SegmentContext): RenderedSegment {
  const icons = getIcons(ctx.settings.preset === "ascii");
  const usage =
    ctx.contextWindow > 0
      ? `${ctx.contextPercent === null ? "?" : `${ctx.contextPercent.toFixed(1)}%`}/${formatNumber(ctx.contextWindow)}`
      : `${formatNumber(ctx.contextTokens)}/?`;
  const auto = ctx.autoCompactEnabled && icons.auto ? ` ${icons.auto}` : "";
  return {
    content: withIcon(
      icons.context,
      color(contextColor(ctx), `${usage}${auto}`),
    ),
    visible: true,
  };
}

/**
 * Reads the local wall clock on each render; it does not own a refresh timer.
 * @param ctx Time options choose 12h/24h display and optional seconds.
 * @returns Visible uncolored time text with the configured icon.
 * @example At local 13:05 with format "12h", the time text is "1:05pm".
 */
function renderTime(ctx: SegmentContext): RenderedSegment {
  const icons = getIcons(ctx.settings.preset === "ascii");
  const opts = ctx.options.time ?? {};
  const now = new Date();
  let hours = now.getHours();
  let suffix = "";
  if (opts.format === "12h") {
    suffix = hours >= HOURS_PER_HALF_DAY ? "pm" : "am";
    hours = hours % HOURS_PER_HALF_DAY || HOURS_PER_HALF_DAY;
  }
  let value = `${hours}:${now.getMinutes().toString().padStart(2, "0")}`;
  if (opts.showSeconds) {
    value += `:${now.getSeconds().toString().padStart(2, "0")}`;
  }
  return { content: withIcon(icons.time, `${value}${suffix}`), visible: true };
}

/**
 * Renders one configured segment with its visibility and terminal styling.
 * @param id Segment selected by the active preset.
 * @param ctx Current settings, usage, and host state; nothing is mutated.
 * @returns The rendered segment, or undefined for an invalid runtime ID.
 * @example renderSegment("token_in", ctx); // Hidden when ctx.usage.input is zero.
 */
export function renderSegment(
  id: StatusLineSegmentId,
  ctx: SegmentContext,
): RenderedSegment;
export function renderSegment(
  id: string,
  ctx: SegmentContext,
): RenderedSegment | undefined {
  const icons = getIcons(ctx.settings.preset === "ascii");
  const extensionStatus = statusValue(ctx, id);
  switch (id) {
    case "pi":
      return {
        content: ctx.theme.fg("accent", icons.pi ? `${icons.pi} ` : ""),
        visible: true,
      };
    case "model":
      return renderModel(ctx);
    case "mode":
    case "collab":
    case "usage":
      return extensionStatus
        ? { content: ctx.theme.fg("accent", extensionStatus), visible: true }
        : { content: "", visible: false };
    case "path":
      return renderPath(ctx);
    case "git":
      return renderGit(ctx);
    case "pr": {
      if (!ctx.git.pr) {
        return { content: "", visible: false };
      }
      const label = withIcon(icons.pr, `#${ctx.git.pr.number}`);
      const url = safeHyperlinkUrl(ctx.git.pr.url);
      return {
        content: ctx.theme.fg(
          "accent",
          url ? `\x1b]8;;${url}\x07${label}\x1b]8;;\x07` : label,
        ),
        visible: true,
      };
    }
    case "subagents":
      return extensionStatus
        ? {
            content: ctx.theme.fg(
              "accent",
              withIcon(icons.agents, extensionStatus),
            ),
            visible: true,
          }
        : { content: "", visible: false };
    case "token_in":
      return ctx.usage.input > 0
        ? {
            content: color(
              statusColor.spend,
              withIcon(icons.input, formatNumber(ctx.usage.input)),
            ),
            visible: true,
          }
        : { content: "", visible: false };
    case "token_out":
      return ctx.usage.output > 0
        ? {
            content: color(
              statusColor.output,
              withIcon(icons.output, formatNumber(ctx.usage.output)),
            ),
            visible: true,
          }
        : { content: "", visible: false };
    case "token_total": {
      const total = ctx.usage.input + ctx.usage.output + ctx.usage.cacheWrite;
      return total > 0
        ? {
            content: color(
              statusColor.spend,
              withIcon(icons.tokens, formatNumber(total)),
            ),
            visible: true,
          }
        : { content: "", visible: false };
    }
    case "token_rate":
      return ctx.usage.tokensPerSecond
        ? {
            content: color(
              statusColor.output,
              withIcon(
                icons.throughput,
                `${ctx.usage.tokensPerSecond.toFixed(1)} tok/s`,
              ),
            ),
            visible: true,
          }
        : { content: "", visible: false };
    case "cost": {
      const subscription = ctx.extensionContext.model
        ? ctx.extensionContext.modelRegistry.isUsingOAuth(
            ctx.extensionContext.model,
          )
        : false;
      const premium =
        Math.round(
          (ctx.usage.premiumRequests + Number.EPSILON) *
            PREMIUM_REQUEST_DECIMAL_FACTOR,
        ) / PREMIUM_REQUEST_DECIMAL_FACTOR;
      const parts: string[] = [];
      if (ctx.usage.cost > 0) {
        parts.push(`$${ctx.usage.cost.toFixed(2)}`);
      }
      if (premium > 0) {
        parts.push(`★ ${formatNumber(premium)}`);
      }
      if (subscription) {
        parts.push("(sub)");
      }
      return parts.length > 0
        ? { content: color(statusColor.cost, parts.join(" ")), visible: true }
        : { content: "", visible: false };
    }
    case "context_pct":
      return renderContext(ctx);
    case "context_total":
      return ctx.contextWindow > 0
        ? {
            content: color(
              statusColor.context,
              withIcon(icons.context, formatNumber(ctx.contextWindow)),
            ),
            visible: true,
          }
        : { content: "", visible: false };
    case "time_spent":
      return ctx.activeMs >= MINIMUM_ACTIVE_TIME_MS
        ? {
            content: withIcon(icons.time, formatDuration(ctx.activeMs)),
            visible: true,
          }
        : { content: "", visible: false };
    case "time":
      return renderTime(ctx);
    case "session": {
      const idValue =
        sliceByColumn(
          sanitizeInlineText(
            ctx.extensionContext.sessionManager.getSessionId() ?? "",
          ).trim(),
          0,
          SESSION_ID_DISPLAY_WIDTH,
          true,
        ) || "new";
      return { content: withIcon(icons.session, idValue), visible: true };
    }
    case "hostname": {
      const hostName = sanitizeInlineText(hostname()).trim();
      return {
        content: withIcon(icons.host, hostName.split(".")[0] ?? hostName),
        visible: true,
      };
    }
    case "cache_read":
      return ctx.usage.cacheRead > 0
        ? {
            content: color(
              statusColor.spend,
              withIcon(icons.cache, formatNumber(ctx.usage.cacheRead)),
            ),
            visible: true,
          }
        : { content: "", visible: false };
    case "cache_write":
      return ctx.usage.cacheWrite > 0
        ? {
            content: color(
              statusColor.output,
              withIcon(icons.cache, formatNumber(ctx.usage.cacheWrite)),
            ),
            visible: true,
          }
        : { content: "", visible: false };
    case "cache_hit": {
      const total =
        ctx.usage.cacheRead + ctx.usage.cacheWrite + ctx.usage.input;
      if (ctx.usage.cacheRead <= 0 || total <= 0) {
        return { content: "", visible: false };
      }
      return {
        content: withIcon(
          icons.cache,
          color(
            statusColor.spend,
            `${((ctx.usage.cacheRead / total) * PERCENT_SCALE).toFixed(2)}%`,
          ),
        ),
        visible: true,
      };
    }
    case "session_name": {
      const name = sanitizeInlineText(
        ctx.extensionContext.sessionManager.getSessionName() ?? "",
      ).trim();
      if (!name) {
        return { content: "", visible: false };
      }
      const ansi = ctx.settings.sessionAccent
        ? sessionAccentAnsi(name)
        : ctx.theme.getFgAnsi("accent");
      return { content: color(ansi, name), visible: true };
    }
    default:
      // Preserve the prior fallthrough for untyped callers with an unknown ID.
      return undefined;
  }
}
