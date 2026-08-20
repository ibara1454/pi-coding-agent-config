import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";

export type StatusLinePreset = "default" | "minimal" | "compact" | "full" | "nerd" | "ascii" | "custom";

export type StatusLineSegmentId =
  | "pi"
  | "model"
  | "mode"
  | "path"
  | "git"
  | "pr"
  | "subagents"
  | "token_in"
  | "token_out"
  | "token_total"
  | "token_rate"
  | "cost"
  | "context_pct"
  | "context_total"
  | "time_spent"
  | "time"
  | "session"
  | "hostname"
  | "cache_read"
  | "cache_write"
  | "cache_hit"
  | "session_name"
  | "usage"
  | "collab";

export type StatusLineSeparatorStyle =
  | "powerline"
  | "powerline-thin"
  | "slash"
  | "pipe"
  | "block"
  | "none"
  | "ascii";

export interface StatusLineSegmentOptions {
  model?: { showThinkingLevel?: boolean };
  path?: { abbreviate?: boolean; maxLength?: number; stripWorkPrefix?: boolean };
  git?: { showBranch?: boolean; showStaged?: boolean; showUnstaged?: boolean; showUntracked?: boolean };
  time?: { format?: "12h" | "24h"; showSeconds?: boolean };
}

export interface StatusLineSettings {
  preset: StatusLinePreset;
  leftSegments?: StatusLineSegmentId[];
  rightSegments?: StatusLineSegmentId[];
  separator?: StatusLineSeparatorStyle;
  segmentOptions?: StatusLineSegmentOptions;
  showHookStatus: boolean;
  sessionAccent: boolean;
  transparent: boolean;
  compactThinkingLevel: boolean;
}

export interface PresetDef {
  leftSegments: StatusLineSegmentId[];
  rightSegments: StatusLineSegmentId[];
  separator: StatusLineSeparatorStyle;
  segmentOptions: StatusLineSegmentOptions;
}

export interface GitState {
  branch: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
  pr: { number: number; url: string } | null;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  premiumRequests: number;
  cost: number;
  tokensPerSecond: number | null;
}

export interface SegmentContext {
  extensionContext: ExtensionContext;
  footerData: ReadonlyFooterDataProvider | null;
  theme: Theme;
  settings: StatusLineSettings;
  options: StatusLineSegmentOptions;
  usage: UsageStats;
  contextTokens: number;
  contextPercent: number | null;
  contextWindow: number;
  autoCompactEnabled: boolean;
  activeMs: number;
  git: GitState;
}

export interface RenderedSegment {
  content: string;
  visible: boolean;
}
