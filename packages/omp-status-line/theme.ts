import type { StatusLineSeparatorStyle } from "./types.ts";

export const RESET = "\x1b[0m";
export const RESET_FG = "\x1b[39m";
export const DEFAULT_STATUS_BG = "\x1b[48;2;18;18;18m";
export const TRANSPARENT_BG = "\x1b[49m";
export const STATUS_BG_AS_FG = "\x1b[38;2;18;18;18m";
export const STATUS_SEPARATOR_FG = "\x1b[38;5;244m";

export const statusColor = {
  model: "\x1b[38;2;215;135;175m",
  path: "\x1b[38;2;0;175;175m",
  gitClean: "\x1b[38;2;95;175;95m",
  gitDirty: "\x1b[38;2;215;175;95m",
  context: "\x1b[38;2;135;135;175m",
  spend: "\x1b[38;2;95;175;175m",
  staged: "\x1b[38;5;70m",
  dirty: "\x1b[38;5;178m",
  untracked: "\x1b[38;5;39m",
  output: "\x1b[38;5;205m",
  cost: "\x1b[38;5;205m",
} as const;

export function color(ansi: string, text: string): string {
  return `${ansi}${text}${RESET_FG}`;
}

export interface StatusIcons {
  pi: string;
  model: string;
  folder: string;
  git: string;
  branch: string;
  pr: string;
  agents: string;
  tokens: string;
  context: string;
  time: string;
  cache: string;
  input: string;
  output: string;
  throughput: string;
  host: string;
  session: string;
  auto: string;
}

const UNICODE_ICONS: StatusIcons = {
  pi: "π",
  model: "⬢",
  folder: "📁",
  git: "⎇",
  branch: "⑂",
  pr: "⤴",
  agents: "👥",
  tokens: "🪙",
  context: "◫",
  time: "⏱",
  cache: "💾",
  input: "⤵",
  output: "⤴",
  throughput: "⚡",
  host: "🖥",
  session: "🆔",
  auto: "⟲",
};

const ASCII_ICONS: StatusIcons = {
  pi: "pi",
  model: "[M]",
  folder: "dir:",
  git: "git:",
  branch: "@",
  pr: "PR",
  agents: "agents:",
  tokens: "tok:",
  context: "ctx:",
  time: "time:",
  cache: "cache",
  input: "in:",
  output: "out:",
  throughput: "tok/s:",
  host: "host:",
  session: "session:",
  auto: "auto",
};

export function getIcons(ascii: boolean): StatusIcons {
  return ascii ? ASCII_ICONS : UNICODE_ICONS;
}

export interface SeparatorDef {
  left: string;
  right: string;
  endCaps?: { left: string; right: string };
}

export function getSeparator(
  style: StatusLineSeparatorStyle,
  ascii: boolean,
): SeparatorDef {
  if (ascii || style === "ascii") return { left: ">", right: "<" };
  switch (style) {
    case "powerline":
      return { left: "▶", right: "◀", endCaps: { left: "◀", right: "▶" } };
    case "powerline-thin":
      return { left: ">", right: "<", endCaps: { left: "◀", right: "▶" } };
    case "slash":
      return { left: "/", right: "/" };
    case "pipe":
      return { left: "│", right: "│" };
    case "block":
      return { left: "▌", right: "▌" };
    case "none":
      return { left: " ", right: " " };
  }
}

function hashName(name: string): number {
  let hash = 2166136261;
  for (const char of name) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function sessionAccentAnsi(name: string): string {
  const hue = hashName(name) % 360;
  const saturation = 68;
  const lightness = 64;
  const chroma = (1 - Math.abs((2 * lightness) / 100 - 1)) * (saturation / 100);
  const section = hue / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  const [r1, g1, b1] =
    section < 1
      ? [chroma, x, 0]
      : section < 2
        ? [x, chroma, 0]
        : section < 3
          ? [0, chroma, x]
          : section < 4
            ? [0, x, chroma]
            : section < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = lightness / 100 - chroma / 2;
  const r = Math.round((r1 + m) * 255);
  const g = Math.round((g1 + m) * 255);
  const b = Math.round((b1 + m) * 255);
  return `\x1b[38;2;${r};${g};${b}m`;
}
