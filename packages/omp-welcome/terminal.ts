const ESC = "\x1b";
const BEL = "\x07";
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

interface TerminalToken {
  ansi?: string;
  grapheme?: string;
}

function ansiSequenceEnd(value: string, start: number): number {
  const kind = value[start + 1];
  if (kind === "[") {
    for (let index = start + 2; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index + 1;
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
      if (value[index] === BEL) return index + 1;
      if (value[index] === ESC && value[index + 1] === "\\") return index + 2;
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
    ))
      tokens.push({ grapheme: segment });
    index = end;
  }
  return tokens;
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1b000 && codePoint <= 0x1b2ff) ||
    (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function graphemeWidth(grapheme: string): number {
  if (grapheme === "\t") return 3;
  if (
    /^[\p{Control}\p{Mark}\p{Default_Ignorable_Code_Point}\p{Format}]+$/u.test(
      grapheme,
    )
  )
    return 0;
  if (
    /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(grapheme) ||
    grapheme.includes("\u20e3")
  )
    return 2;

  for (const character of grapheme) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isWideCodePoint(codePoint)) return 2;
  }
  return 1;
}

function osc8Terminator(sequence: string): string | undefined {
  if (!sequence.startsWith("\x1b]8;")) return undefined;
  const content = sequence.slice(4, sequence.endsWith("\x1b\\") ? -2 : -1);
  const separator = content.indexOf(";");
  if (separator < 0 || content.slice(separator + 1).length === 0)
    return undefined;
  return sequence.endsWith("\x1b\\") ? "\x1b\\" : BEL;
}

/** Remove CSI, OSC, DCS, APC, and two-byte terminal control sequences. */
export function stripTerminalSequences(value: string): string {
  let result = "";
  for (const token of terminalTokens(value)) {
    if (token.grapheme) result += token.grapheme;
  }
  return result;
}

/** Width in terminal cells, not UTF-16 code units or Unicode code points. */
export function visibleWidth(value: string): number {
  let width = 0;
  for (const token of terminalTokens(value)) {
    if (token.grapheme) width += graphemeWidth(token.grapheme);
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
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;

  let clippedEllipsis = "";
  let ellipsisWidth = 0;
  for (const token of terminalTokens(ellipsis)) {
    if (!token.grapheme) continue;
    const cells = graphemeWidth(token.grapheme);
    if (ellipsisWidth + cells > width) break;
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
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR detection requires ESC.
      if (/^\x1b\[[0-?]*[ -/]*m$/.test(token.ansi)) hasSgr = true;
      const terminator = osc8Terminator(token.ansi);
      if (terminator) hyperlinkTerminator = terminator;
      else if (token.ansi.startsWith("\x1b]8;;"))
        hyperlinkTerminator = undefined;
      continue;
    }
    if (!token.grapheme) continue;
    const graphemeCells = graphemeWidth(token.grapheme);
    if (cells + graphemeCells > contentWidth) break;
    result += pendingAnsi;
    pendingAnsi = "";
    result += token.grapheme;
    cells += graphemeCells;
  }

  if (result.length > 0 && hyperlinkTerminator)
    result += `\x1b]8;;${hyperlinkTerminator}`;
  if (result.length > 0 && hasSgr) result += "\x1b[0m";
  return hasSgr
    ? `${result}${clippedEllipsis}\x1b[0m`
    : `${result}${clippedEllipsis}`;
}

/** Wrap plain welcome-tip text by terminal cells. ANSI-aware truncation handles long words. */
export function wrapTextWithAnsi(value: string, width: number): string[] {
  if (width < 1) return [];
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
  if (line) lines.push(line);
  return lines;
}
