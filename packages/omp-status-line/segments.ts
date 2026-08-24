import * as os from "node:os";
import * as path from "node:path";
import { color, getIcons, sessionAccentAnsi, statusColor } from "./theme.ts";
import type { RenderedSegment, SegmentContext, StatusLineSegmentId } from "./types.ts";

function withIcon(icon: string, text: string): string {
  return icon ? `${icon} ${text}` : text;
}

function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1).replace(/\.0$/, "")}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return Math.round(value).toString();
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  if (minutes > 0) return `${minutes}m${remainder > 0 ? ` ${remainder}s` : ""}`;
  return `${remainder}s`;
}

function sanitize(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").trim();
}

function clampPathLength(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `…${value.slice(-Math.max(0, maxLength - 1))}`;
}

function statusValue(ctx: SegmentContext, key: string): string | undefined {
  const value = ctx.footerData?.getExtensionStatuses().get(key);
  return value ? sanitize(value) : undefined;
}

function thinkingDisplay(ctx: SegmentContext): string {
  if (ctx.options.model?.showThinkingLevel === false || !ctx.extensionContext.model?.reasoning) return "";
  const level = ctx.extensionContext.thinkingLevel ?? "off";
  const ascii = ctx.settings.preset === "ascii";
  if (ascii) return level === "off" ? "[off]" : `[${level === "medium" ? "med" : level === "xhigh" ? "xhi" : level}]`;
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

function renderModel(ctx: SegmentContext): RenderedSegment {
  const icons = getIcons(ctx.settings.preset === "ascii");
  let name = ctx.extensionContext.model?.name || ctx.extensionContext.model?.id || "no-model";
  if (name.startsWith("Claude ")) name = name.slice(7);
  if (/^gpt-[\d.]+-[a-z][a-z0-9-]*$/i.test(ctx.extensionContext.model?.id ?? "")) {
    name = (ctx.extensionContext.model?.id ?? name)
      .split("-")
      .map((part, index) => index === 0 ? part.toUpperCase() : /^[\d.]+$/.test(part) ? part : `${part[0]?.toUpperCase()}${part.slice(1)}`)
      .join("-");
  }
  const thinking = thinkingDisplay(ctx);
  const compact = ctx.settings.compactThinkingLevel && thinking !== "";
  const icon = compact ? (thinking.split(" ", 1)[0] ?? icons.model) : icons.model;
  const tail = !compact && thinking ? ` · ${thinking}` : "";
  return { content: color(statusColor.model, `${withIcon(icon, name)}${tail}`), visible: true };
}

function renderPath(ctx: SegmentContext): RenderedSegment {
  const icons = getIcons(ctx.settings.preset === "ascii");
  const opts = ctx.options.path ?? {};
  let cwd = ctx.extensionContext.cwd;
  if (opts.stripWorkPrefix !== false) {
    for (const root of [path.join(os.homedir(), "Projects"), "/work"]) {
      const relative = path.relative(root, cwd);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        cwd = relative;
        break;
      }
    }
  }
  if (opts.abbreviate !== false && (cwd === os.homedir() || cwd.startsWith(`${os.homedir()}${path.sep}`))) {
    cwd = `~${cwd.slice(os.homedir().length)}`;
  }
  cwd = clampPathLength(cwd, opts.maxLength ?? 40);
  return { content: color(statusColor.path, withIcon(icons.folder, cwd)), visible: true };
}

function renderGit(ctx: SegmentContext): RenderedSegment {
  const icons = getIcons(ctx.settings.preset === "ascii");
  const opts = ctx.options.git ?? {};
  const { branch, staged, unstaged, untracked } = ctx.git;
  if (!branch && staged === 0 && unstaged === 0 && untracked === 0) return { content: "", visible: false };
  const dirty = staged > 0 || unstaged > 0 || untracked > 0;
  let content = opts.showBranch === false || !branch ? "" : withIcon(icons.branch, branch);
  const indicators: string[] = [];
  if (opts.showUnstaged !== false && unstaged > 0) indicators.push(color(statusColor.dirty, `*${unstaged}`));
  if (opts.showStaged !== false && staged > 0) indicators.push(color(statusColor.staged, `+${staged}`));
  if (opts.showUntracked !== false && untracked > 0) indicators.push(color(statusColor.untracked, `?${untracked}`));
  if (indicators.length > 0) content += `${content ? " " : withIcon(icons.git, "")}${indicators.join(" ")}`;
  if (!content) return { content: "", visible: false };
  return { content: color(dirty ? statusColor.gitDirty : statusColor.gitClean, content), visible: true };
}

function contextColor(ctx: SegmentContext): string {
  const pct = ctx.contextPercent ?? 0;
  const window = ctx.contextWindow;
  const reaches = (percent: number, tokens: number) => pct >= Math.min(percent, window > 0 ? (tokens / window) * 100 : percent);
  if (reaches(90, 500_000)) return ctx.theme.getFgAnsi("error");
  if (reaches(70, 270_000)) return ctx.theme.getFgAnsi("thinkingHigh");
  if (reaches(50, 150_000)) return ctx.theme.getFgAnsi("warning");
  return statusColor.context;
}

function renderContext(ctx: SegmentContext): RenderedSegment {
  const icons = getIcons(ctx.settings.preset === "ascii");
  const usage = ctx.contextWindow > 0
    ? `${ctx.contextPercent === null ? "?" : `${ctx.contextPercent.toFixed(1)}%`}/${formatNumber(ctx.contextWindow)}`
    : `${formatNumber(ctx.contextTokens)}/?`;
  const auto = ctx.autoCompactEnabled && icons.auto ? ` ${icons.auto}` : "";
  return { content: withIcon(icons.context, color(contextColor(ctx), `${usage}${auto}`)), visible: true };
}

function renderTime(ctx: SegmentContext): RenderedSegment {
  const icons = getIcons(ctx.settings.preset === "ascii");
  const opts = ctx.options.time ?? {};
  const now = new Date();
  let hours = now.getHours();
  let suffix = "";
  if (opts.format === "12h") {
    suffix = hours >= 12 ? "pm" : "am";
    hours = hours % 12 || 12;
  }
  let value = `${hours}:${now.getMinutes().toString().padStart(2, "0")}`;
  if (opts.showSeconds) value += `:${now.getSeconds().toString().padStart(2, "0")}`;
  return { content: withIcon(icons.time, `${value}${suffix}`), visible: true };
}

export function renderSegment(id: StatusLineSegmentId, ctx: SegmentContext): RenderedSegment {
  const icons = getIcons(ctx.settings.preset === "ascii");
  const extensionStatus = statusValue(ctx, id);
  switch (id) {
    case "pi":
      return { content: ctx.theme.fg("accent", icons.pi ? `${icons.pi} ` : ""), visible: true };
    case "model":
      return renderModel(ctx);
    case "mode":
    case "collab":
    case "usage":
      return extensionStatus ? { content: ctx.theme.fg("accent", extensionStatus), visible: true } : { content: "", visible: false };
    case "path":
      return renderPath(ctx);
    case "git":
      return renderGit(ctx);
    case "pr": {
      if (!ctx.git.pr) return { content: "", visible: false };
      const label = withIcon(icons.pr, `#${ctx.git.pr.number}`);
      return { content: ctx.theme.fg("accent", `\x1b]8;;${ctx.git.pr.url}\x07${label}\x1b]8;;\x07`), visible: true };
    }
    case "subagents":
      return extensionStatus ? { content: ctx.theme.fg("accent", withIcon(icons.agents, extensionStatus)), visible: true } : { content: "", visible: false };
    case "token_in":
      return ctx.usage.input > 0 ? { content: color(statusColor.spend, withIcon(icons.input, formatNumber(ctx.usage.input))), visible: true } : { content: "", visible: false };
    case "token_out":
      return ctx.usage.output > 0 ? { content: color(statusColor.output, withIcon(icons.output, formatNumber(ctx.usage.output))), visible: true } : { content: "", visible: false };
    case "token_total": {
      const total = ctx.usage.input + ctx.usage.output + ctx.usage.cacheWrite;
      return total > 0 ? { content: color(statusColor.spend, withIcon(icons.tokens, formatNumber(total))), visible: true } : { content: "", visible: false };
    }
    case "token_rate":
      return ctx.usage.tokensPerSecond ? { content: color(statusColor.output, withIcon(icons.throughput, `${ctx.usage.tokensPerSecond.toFixed(1)} tok/s`)), visible: true } : { content: "", visible: false };
    case "cost": {
      const subscription = ctx.extensionContext.model
        ? ctx.extensionContext.modelRegistry.isUsingOAuth(ctx.extensionContext.model)
        : false;
      const premium = Math.round((ctx.usage.premiumRequests + Number.EPSILON) * 100) / 100;
      const parts: string[] = [];
      if (ctx.usage.cost > 0) parts.push(`$${ctx.usage.cost.toFixed(2)}`);
      if (premium > 0) parts.push(`★ ${formatNumber(premium)}`);
      if (subscription) parts.push("(sub)");
      return parts.length > 0 ? { content: color(statusColor.cost, parts.join(" ")), visible: true } : { content: "", visible: false };
    }
    case "context_pct":
      return renderContext(ctx);
    case "context_total":
      return ctx.contextWindow > 0 ? { content: color(statusColor.context, withIcon(icons.context, formatNumber(ctx.contextWindow))), visible: true } : { content: "", visible: false };
    case "time_spent":
      return ctx.activeMs >= 1000 ? { content: withIcon(icons.time, formatDuration(ctx.activeMs)), visible: true } : { content: "", visible: false };
    case "time":
      return renderTime(ctx);
    case "session": {
      const idValue = ctx.extensionContext.sessionManager.getSessionId()?.slice(0, 8) || "new";
      return { content: withIcon(icons.session, idValue), visible: true };
    }
    case "hostname":
      return { content: withIcon(icons.host, os.hostname().split(".")[0] ?? os.hostname()), visible: true };
    case "cache_read":
      return ctx.usage.cacheRead > 0 ? { content: color(statusColor.spend, withIcon(icons.cache, formatNumber(ctx.usage.cacheRead))), visible: true } : { content: "", visible: false };
    case "cache_write":
      return ctx.usage.cacheWrite > 0 ? { content: color(statusColor.output, withIcon(icons.cache, formatNumber(ctx.usage.cacheWrite))), visible: true } : { content: "", visible: false };
    case "cache_hit": {
      const total = ctx.usage.cacheRead + ctx.usage.cacheWrite + ctx.usage.input;
      if (ctx.usage.cacheRead <= 0 || total <= 0) return { content: "", visible: false };
      return { content: withIcon(icons.cache, color(statusColor.spend, `${((ctx.usage.cacheRead / total) * 100).toFixed(2)}%`)), visible: true };
    }
    case "session_name": {
      const name = ctx.extensionContext.sessionManager.getSessionName();
      if (!name) return { content: "", visible: false };
      const ansi = ctx.settings.sessionAccent ? sessionAccentAnsi(name) : ctx.theme.getFgAnsi("accent");
      return { content: color(ansi, sanitize(name)), visible: true };
    }
  }
}
