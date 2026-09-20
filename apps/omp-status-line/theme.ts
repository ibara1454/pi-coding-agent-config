import type { StatusLineSeparatorStyle } from "./types.ts";

const FNV_PRIME = 16_777_619;
const HUE_CYCLE_DEGREES = 360;
const HSL_PERCENT_SCALE = 100;
const HUE_SECTION_CYAN_START = 3;
const HUE_SECTION_BLUE_START = 4;
const HUE_SECTION_MAGENTA_START = 5;
const RGB_CHANNEL_MAX = 255;

export const RESET = "\x1b[0m";
export const RESET_FG = "\x1b[39m";
export const DEFAULT_STATUS_BG = "\x1b[48;2;18;18;18m";
export const TRANSPARENT_BG = "\x1b[49m";
export const STATUS_BG_AS_FG = "\x1b[38;2;18;18;18m";
export const STATUS_SEPARATOR_FG = "\x1b[38;5;244m";
export const EMPTY_END_CAPS = { left: "", right: "" } as const;

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
  endCaps: { left: string; right: string };
}

/**
 * Returns the separators for a configured style, using ASCII separators when requested.
 *
 * @param style The configured separator style.
 * @param ascii Whether the status line should override the configured style with ASCII separators.
 * @returns Left/right separators and a required cap pair; unused caps are empty strings.
 * @throws If the configured style is unsupported.
 *
 * @example
 * getSeparator("powerline", true);
 * // { left: ">", right: "<", endCaps: { left: "", right: "" } }
 */
export function getSeparator(
  style: StatusLineSeparatorStyle,
  ascii: boolean,
): SeparatorDef {
  const effectiveStyle = ascii ? "ascii" : style;
  switch (effectiveStyle) {
    case "ascii":
      return { left: ">", right: "<", endCaps: EMPTY_END_CAPS };
    case "powerline":
      return { left: "▶", right: "◀", endCaps: { left: "◀", right: "▶" } };
    case "powerline-thin":
      return { left: ">", right: "<", endCaps: { left: "◀", right: "▶" } };
    case "slash":
      return { left: "/", right: "/", endCaps: EMPTY_END_CAPS };
    case "pipe":
      return { left: "│", right: "│", endCaps: EMPTY_END_CAPS };
    case "block":
      return { left: "▌", right: "▌", endCaps: EMPTY_END_CAPS };
    case "none":
      return { left: " ", right: " ", endCaps: EMPTY_END_CAPS };
    default:
      throw new Error(`Unexpected value: ${effectiveStyle satisfies never}`);
  }
}

/**
 * Hashes Unicode code points with FNV-style XOR/multiply steps, not UTF-8 bytes.
 * @param name Session name, including any whitespace; no normalization is applied.
 * @returns Deterministic unsigned 32-bit hash, not a cryptographic identifier.
 * @example hashName(""); // 2166136261 (the initial offset basis)
 */
function hashName(name: string): number {
  let hash = 2_166_136_261;
  for (const char of name) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * Derives a stable truecolor foreground from the name's hash modulo 360 degrees.
 * Uses 68% saturation and 64% lightness, rounding RGB channels to 0–255.
 * @param name Name to hash verbatim; it is never embedded in the escape sequence.
 * @returns ANSI foreground prefix only; the caller owns applying and resetting it.
 * @example sessionAccentAnsi(""); // "\x1b[38;2;224;226;101m"
 */
export function sessionAccentAnsi(name: string): string {
  const hue = hashName(name) % HUE_CYCLE_DEGREES;
  const saturation = 68;
  const lightness = 64;
  const chroma =
    (1 - Math.abs((2 * lightness) / HSL_PERCENT_SCALE - 1)) *
    (saturation / HSL_PERCENT_SCALE);
  const section = hue / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  let r1: number;
  let g1: number;
  let b1: number;
  if (section < 1) {
    r1 = chroma;
    g1 = x;
    b1 = 0;
  } else if (section < 2) {
    r1 = x;
    g1 = chroma;
    b1 = 0;
  } else if (section < HUE_SECTION_CYAN_START) {
    r1 = 0;
    g1 = chroma;
    b1 = x;
  } else if (section < HUE_SECTION_BLUE_START) {
    r1 = 0;
    g1 = x;
    b1 = chroma;
  } else if (section < HUE_SECTION_MAGENTA_START) {
    r1 = x;
    g1 = 0;
    b1 = chroma;
  } else {
    r1 = chroma;
    g1 = 0;
    b1 = x;
  }
  const m = lightness / HSL_PERCENT_SCALE - chroma / 2;
  const r = Math.round((r1 + m) * RGB_CHANNEL_MAX);
  const g = Math.round((g1 + m) * RGB_CHANNEL_MAX);
  const b = Math.round((b1 + m) * RGB_CHANNEL_MAX);
  return `\x1b[38;2;${r};${g};${b}m`;
}
