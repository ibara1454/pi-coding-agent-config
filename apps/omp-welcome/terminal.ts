const ESC = "\x1b";
const BEL = "\x07";
const CSI_FINAL_BYTE_MIN = 0x40;
const CSI_FINAL_BYTE_MAX = 0x7e;
const HANGUL_JAMO_START = 0x11_00;
const HANGUL_JAMO_END = 0x11_5f;
const LEFT_ANGLE_BRACKET = 0x23_29;
const RIGHT_ANGLE_BRACKET = 0x23_2a;
const CJK_SYMBOLS_START = 0x2e_80;
const CJK_SYMBOLS_END = 0xa4_cf;
const HANGUL_SYLLABLE_START = 0xac_00;
const HANGUL_SYLLABLE_END = 0xd7_a3;
const CJK_COMPATIBILITY_IDEOGRAPH_START = 0xf9_00;
const CJK_COMPATIBILITY_IDEOGRAPH_END = 0xfa_ff;
const VERTICAL_FORM_START = 0xfe_10;
const VERTICAL_FORM_END = 0xfe_19;
const CJK_COMPATIBILITY_FORM_START = 0xfe_30;
const CJK_COMPATIBILITY_FORM_END = 0xfe_6f;
const FULLWIDTH_FORM_START = 0xff_00;
const FULLWIDTH_FORM_END = 0xff_60;
const HALFWIDTH_FORM_START = 0xff_e0;
const HALFWIDTH_FORM_END = 0xff_e6;
const CJK_SUPPLEMENT_START = 0x1_b0_00;
const CJK_SUPPLEMENT_END = 0x1_b2_ff;
const CJK_EXTENDED_START = 0x1_f2_00;
const CJK_EXTENDED_END = 0x1_f2_51;
const CJK_PLANES_START = 0x2_00_00;
const CJK_PLANES_END = 0x3_ff_fd;
const TAB_WIDTH_CELLS = 3;
const OSC8_PREFIX_LENGTH = 4;
const ZERO_WIDTH_GRAPHEME =
  /^[\p{Control}\p{Mark}\p{Default_Ignorable_Code_Point}\p{Format}]+$/u;
const EMOJI_GRAPHEME = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR detection requires ESC.
const ANSI_SGR = /^\x1b\[[0-?]*[ -/]*m$/;
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

interface TerminalToken {
  ansi?: string;
  grapheme?: string;
}

/**
 * Scans a terminal escape beginning at a known ESC, without executing it.
 * @param value Source string; offsets are UTF-16 code units, not terminal cells.
 * @param start Index of ESC.
 * @returns Exclusive end; unterminated CSI/string controls consume the remaining input.
 * @example ansiSequenceEnd("\x1b[31mX", 0); // 5
 */
function ansiSequenceEnd(value: string, start: number): number {
  const kind = value[start + 1];
  if (kind === "[") {
    for (let index = start + 2; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= CSI_FINAL_BYTE_MIN && code <= CSI_FINAL_BYTE_MAX) {
        return index + 1;
      }
    }
    return value.length;
  }

  if (
    kind === "]" ||
    kind === "P" ||
    kind === "_" ||
    kind === "^" ||
    kind === "X"
  ) {
    for (let index = start + 2; index < value.length; index++) {
      if (value[index] === BEL) {
        return index + 1;
      }
      if (value[index] === ESC && value[index + 1] === "\\") {
        return index + 2;
      }
    }
    return value.length;
  }

  return Math.min(start + 2, value.length);
}

function terminalTokens(value: string): TerminalToken[] {
  const tokens: TerminalToken[] = [];
  let index = 0;
  while (index < value.length) {
    if (value[index] === ESC) {
      const end = ansiSequenceEnd(value, index);
      tokens.push({ ansi: value.slice(index, end) });
      index = end;
      continue;
    }

    const escapeIndex = value.indexOf(ESC, index);
    const end = escapeIndex < 0 ? value.length : escapeIndex;
    for (const { segment } of graphemeSegmenter.segment(
      value.slice(index, end),
    )) {
      tokens.push({ grapheme: segment });
    }
    index = end;
  }
  return tokens;
}

/**
 * Tests the fixed East Asian/fullwidth ranges used by this terminal-width estimate.
 * @param codePoint Unicode scalar value, not a UTF-16 code unit or string length.
 * @returns Whether a containing non-emoji grapheme occupies two terminal cells.
 * @example isWideCodePoint("界".codePointAt(0)!); // true
 */
function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= HANGUL_JAMO_START && codePoint <= HANGUL_JAMO_END) ||
    codePoint === LEFT_ANGLE_BRACKET ||
    codePoint === RIGHT_ANGLE_BRACKET ||
    (codePoint >= CJK_SYMBOLS_START && codePoint <= CJK_SYMBOLS_END) ||
    (codePoint >= HANGUL_SYLLABLE_START && codePoint <= HANGUL_SYLLABLE_END) ||
    (codePoint >= CJK_COMPATIBILITY_IDEOGRAPH_START &&
      codePoint <= CJK_COMPATIBILITY_IDEOGRAPH_END) ||
    (codePoint >= VERTICAL_FORM_START && codePoint <= VERTICAL_FORM_END) ||
    (codePoint >= CJK_COMPATIBILITY_FORM_START &&
      codePoint <= CJK_COMPATIBILITY_FORM_END) ||
    (codePoint >= FULLWIDTH_FORM_START && codePoint <= FULLWIDTH_FORM_END) ||
    (codePoint >= HALFWIDTH_FORM_START && codePoint <= HALFWIDTH_FORM_END) ||
    (codePoint >= CJK_SUPPLEMENT_START && codePoint <= CJK_SUPPLEMENT_END) ||
    (codePoint >= CJK_EXTENDED_START && codePoint <= CJK_EXTENDED_END) ||
    (codePoint >= CJK_PLANES_START && codePoint <= CJK_PLANES_END)
  );
}

/**
 * Estimates cells for one complete grapheme, not its code-point count.
 * @param grapheme Cluster from Intl.Segmenter; tabs always use three cells.
 * @returns Zero for control/mark-only clusters, two for emoji/wide text, otherwise one.
 * @example graphemeWidth("e\u0301"); // 1; graphemeWidth("界") is 2.
 */
function graphemeWidth(grapheme: string): number {
  if (grapheme === "\t") {
    return TAB_WIDTH_CELLS;
  }
  if (ZERO_WIDTH_GRAPHEME.test(grapheme)) {
    return 0;
  }
  if (EMOJI_GRAPHEME.test(grapheme) || grapheme.includes("\u20e3")) {
    return 2;
  }

  for (const character of grapheme) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isWideCodePoint(codePoint)) {
      return 2;
    }
  }
  return 1;
}

/**
 * Identifies the closing delimiter needed for an opening OSC 8 hyperlink.
 * @param sequence Complete terminal sequence, including its BEL or ST terminator.
 * @returns Matching delimiter, or undefined for non-links, closes, or missing URI fields.
 * @example osc8Terminator("\x1b]8;;https://example.com\x07"); // "\x07"
 */
function osc8Terminator(sequence: string): string | undefined {
  if (!sequence.startsWith("\x1b]8;")) {
    return undefined;
  }
  const content = sequence.slice(
    OSC8_PREFIX_LENGTH,
    sequence.endsWith("\x1b\\") ? -2 : -1,
  );
  const separator = content.indexOf(";");
  if (separator < 0 || content.slice(separator + 1).length === 0) {
    return undefined;
  }
  return sequence.endsWith("\x1b\\") ? "\x1b\\" : BEL;
}

/** Remove CSI, OSC, DCS, APC, and two-byte terminal control sequences. */
function stripTerminalSequences(value: string): string {
  let result = "";
  for (const token of terminalTokens(value)) {
    if (token.grapheme) {
      result += token.grapheme;
    }
  }
  return result;
}

/** Strip terminal sequences and controls from untrusted single-line text. */
export function sanitizeInline(value: string): string {
  const plain = stripTerminalSequences(value);
  return plain.replace(
    / *[\p{Bidi_Control}\p{Cc}\p{Zl}\p{Zp}]+ */gu,
    (match, offset) =>
      offset === 0 || offset + match.length === plain.length ? "" : " ",
  );
}

/** Width in terminal cells, not UTF-16 code units or Unicode code points. */
export function visibleWidth(value: string): number {
  let width = 0;
  for (const token of terminalTokens(value)) {
    if (token.grapheme) {
      width += graphemeWidth(token.grapheme);
    }
  }
  return width;
}

/**
 * Preserve complete terminal sequences and grapheme clusters while truncating.
 * A reset and any open OSC 8 hyperlink closure precede the ellipsis, so color
 * and hyperlink state cannot leak into the rest of the terminal frame.
 */
export function truncateToWidth(
  value: string,
  width: number,
  ellipsis = "…",
): string {
  if (width <= 0) {
    return "";
  }
  if (visibleWidth(value) <= width) {
    return value;
  }

  let clippedEllipsis = "";
  let ellipsisWidth = 0;
  for (const token of terminalTokens(ellipsis)) {
    if (!token.grapheme) {
      continue;
    }
    const cells = graphemeWidth(token.grapheme);
    if (ellipsisWidth + cells > width) {
      break;
    }
    clippedEllipsis += token.grapheme;
    ellipsisWidth += cells;
  }
  const contentWidth = Math.max(0, width - ellipsisWidth);
  let result = "";
  let pendingAnsi = "";
  let cells = 0;
  let hasSgr = false;
  let hyperlinkTerminator: string | undefined;

  for (const token of terminalTokens(value)) {
    if (token.ansi) {
      pendingAnsi += token.ansi;
      if (ANSI_SGR.test(token.ansi)) {
        hasSgr = true;
      }
      const terminator = osc8Terminator(token.ansi);
      if (terminator) {
        hyperlinkTerminator = terminator;
      } else if (token.ansi.startsWith("\x1b]8;;")) {
        hyperlinkTerminator = undefined;
      }
      continue;
    }
    if (!token.grapheme) {
      continue;
    }
    const graphemeCells = graphemeWidth(token.grapheme);
    if (cells + graphemeCells > contentWidth) {
      break;
    }
    result += pendingAnsi;
    pendingAnsi = "";
    result += token.grapheme;
    cells += graphemeCells;
  }

  if (result.length > 0 && hyperlinkTerminator) {
    result += `\x1b]8;;${hyperlinkTerminator}`;
  }
  if (result.length > 0 && hasSgr) {
    result += "\x1b[0m";
  }
  return hasSgr
    ? `${result}${clippedEllipsis}\x1b[0m`
    : `${result}${clippedEllipsis}`;
}

/** Wrap plain welcome-tip text by terminal cells. ANSI-aware truncation handles long words. */
export function wrapTextWithAnsi(value: string, width: number): string[] {
  if (width < 1) {
    return [];
  }
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) {
      line = truncateToWidth(word, width);
    } else if (visibleWidth(`${line} ${word}`) <= width) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = truncateToWidth(word, width);
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}
