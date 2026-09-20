import fs from "node:fs/promises";
import path from "node:path";
import { Minimatch } from "minimatch";
import type {
  Diagnostic,
  FormattingOptions,
  Position,
  Range,
} from "vscode-languageserver-protocol";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";
import { uriToFile } from "./edits.ts";

const LINE_BREAK = /\r\n|\r|\n/;
const NON_WHITESPACE = /\S/;
const SYMBOL_OCCURRENCE = /^(.+)#(\d+)$/;
const IDENTIFIER = /^[$A-Za-z_][\w$]*$/;
const IDENTIFIER_CHARACTER = /[\w$]/;
const GLOB_CHARACTER = /[*?[{]/;
const LEADING_SPACES = /^ +/;
const EDITORCONFIG_ROOT = /^\s*root\s*=\s*true\s*$/im;
const CONFIG_LINE_BREAK = /\r?\n/;
const CONFIG_COMMENT = /^[#;]/;
const CONFIG_SECTION = /^\[(.*)\]$/;
const DIAGNOSTIC_SEVERITIES: readonly number[] =
  Object.values(DiagnosticSeverity);
const MAX_DISPLAYED_DIAGNOSTICS = 200;
const MAX_SYMBOL_DEPTH = 100;
const MAX_SYMBOL_RESULTS = 10_000;
const MAX_GLOB_PATTERN_LENGTH = 2048;
const MAX_GLOB_ENTRIES = 10_000;
const MAX_DIAGNOSTIC_TARGET_FILES = 20;
const MAX_EDITORCONFIG_DEPTH = 64;
// 1 MiB (1024 * 1024 bytes).
const MAX_EDITORCONFIG_BYTES = 1_048_576;

/**
 * Recognizes a missing filesystem path without assuming what an external operation threw.
 * @param error - Untrusted thrown value; null and primitives are not filesystem errors.
 * @returns Whether the value reports ENOENT.
 * @example missing({ code: "ENOENT" }) is true; missing(null) is false.
 */
function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label} response`);
  }
  return value as Record<string, unknown>;
}

function protocolPosition(value: unknown): Position {
  const { line, character } = object(value, "position");
  if (
    !(Number.isSafeInteger(line) && Number.isSafeInteger(character)) ||
    Number(line) < 0 ||
    Number(character) < 0
  ) {
    throw new Error("Invalid LSP position");
  }
  return { line: Number(line), character: Number(character) };
}

function protocolRange(value: unknown): Range {
  const { start: rawStart, end: rawEnd } = object(value, "range");
  const start = protocolPosition(rawStart);
  const end = protocolPosition(rawEnd);
  if (
    end.line < start.line ||
    (end.line === start.line && end.character < start.character)
  ) {
    throw new Error("Invalid reversed LSP range");
  }
  return { start, end };
}

/**
 * Resolves a 1-based line and optional symbol#N to UTF-16 coordinates.
 * Throws when the line or requested occurrence is missing.
 */
export function resolvePosition(
  content: string,
  line = 1,
  specification?: string,
): Position {
  if (!Number.isSafeInteger(line) || line < 1) {
    throw new Error("line must be a positive 1-based integer");
  }
  const text = content.split(LINE_BREAK)[line - 1];
  if (text === undefined) {
    throw new Error(`Line ${line} is outside the document`);
  }
  if (!specification) {
    return {
      line: line - 1,
      character:
        text.search(NON_WHITESPACE) < 0 ? 0 : text.search(NON_WHITESPACE),
    };
  }
  const occurrenceMatch = specification.match(SYMBOL_OCCURRENCE);
  const symbol = occurrenceMatch?.[1] ?? specification;
  const occurrence = Math.max(1, Number(occurrenceMatch?.[2] ?? 1));
  const bare = IDENTIFIER.test(symbol);
  const find = (insensitive: boolean): number[] => {
    const haystack = insensitive ? text.toLowerCase() : text;
    const needle = insensitive ? symbol.toLowerCase() : symbol;
    const indexes: number[] = [];
    for (let from = 0; from <= haystack.length - needle.length; ) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) {
        break;
      }
      from = index + Math.max(1, needle.length);
      const isStandalone = !(
        IDENTIFIER_CHARACTER.test(haystack[index - 1] ?? "") ||
        IDENTIFIER_CHARACTER.test(haystack[index + needle.length] ?? "")
      );
      if (!bare || isStandalone) {
        indexes.push(index);
      }
    }
    return indexes;
  };
  const exact = find(false);
  const matches = exact.length > 0 ? exact : find(true);
  const character = matches[occurrence - 1];
  if (character === undefined) {
    throw new Error(
      matches.length === 0
        ? `Symbol "${symbol}" not found on line ${line}`
        : `Symbol "${symbol}" occurrence ${occurrence} out of bounds on line ${line} (found ${matches.length})`,
    );
  }
  return { line: line - 1, character };
}

/**
 * Validates and deduplicates findings by message/range, retaining the strongest severity.
 * @param value - Untrusted diagnostic array with zero-based UTF-16 protocol ranges.
 * @returns Findings sorted by severity, position, and message; absent severity counts as error.
 * @throws For malformed arrays, messages, ranges, or severity values.
 * @example normalizeDiagnostics([]) returns []; normalizeDiagnostics(null) throws.
 */
export function normalizeDiagnostics(value: unknown): Diagnostic[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid diagnostics response: expected an array");
  }
  const unique = new Map<string, Diagnostic & { message: string }>();
  for (const item of value) {
    const diagnostic = object(item, "diagnostic");
    const { message, range: rawRange, severity } = diagnostic;
    if (typeof message !== "string") {
      throw new Error("Invalid diagnostic message");
    }
    const range = protocolRange(rawRange);
    if (
      severity !== undefined &&
      (typeof severity !== "number" ||
        !DIAGNOSTIC_SEVERITIES.includes(severity))
    ) {
      throw new Error("Invalid diagnostic severity");
    }
    const parsed: Diagnostic & { message: string } = {
      ...diagnostic,
      range,
      message,
    };
    const key = JSON.stringify([range, parsed.message]);
    const prior = unique.get(key);
    if (!prior || (parsed.severity ?? 1) < (prior.severity ?? 1)) {
      unique.set(key, parsed);
    }
  }
  return [...unique.values()].sort(
    (a, b) =>
      (a.severity ?? 1) - (b.severity ?? 1) ||
      a.range.start.line - b.range.start.line ||
      a.range.start.character - b.range.start.character ||
      a.message.localeCompare(b.message),
  );
}

/**
 * Renders a bounded report without presenting unversioned silence as verified clean.
 * @param file - Diagnostic file path, displayed relative to cwd when possible.
 * @param diagnostics - Validated findings in display order.
 * @param cwd - Root used to shorten paths.
 * @param unverifiedSources - Sources whose freshness cannot be established.
 * @returns Counts and at most 200 findings with one-based positions and any freshness warning.
 * @example diagnosticsText("/project/a.ts", [], "/project", []) returns "a.ts: OK".
 */
export function diagnosticsText(
  file: string,
  diagnostics: readonly Diagnostic[],
  cwd: string,
  unverifiedSources: readonly string[],
): string {
  const label = path.relative(cwd, file) || file;
  const freshness =
    unverifiedSources.length > 0
      ? `\nDiagnostic freshness-unverified from ${unverifiedSources.join(", ")}: unversioned publications may be stale.`
      : "";
  if (diagnostics.length === 0) {
    return `${label}: ${unverifiedSources.length > 0 ? "No diagnostics reported" : "OK"}${freshness}`;
  }
  const severities: Record<number, string> = {
    1: "error",
    2: "warning",
    3: "info",
    4: "hint",
  };
  const errors = diagnostics.filter(
    (item) => (item.severity ?? 1) === 1,
  ).length;
  const warnings = diagnostics.filter((item) => item.severity === 2).length;
  const lines = diagnostics
    .slice(0, MAX_DISPLAYED_DIAGNOSTICS)
    .map(
      (item) =>
        `${label}:${item.range.start.line + 1}:${item.range.start.character + 1} [${severities[item.severity ?? 1]}] ${item.message}${item.source ? ` (${item.source})` : ""}`,
    );
  return `${label}: ${errors} error(s), ${warnings} warning(s), ${diagnostics.length} diagnostic(s)${freshness}\n${lines.join("\n")}${diagnostics.length > MAX_DISPLAYED_DIAGNOSTICS ? `\n…${diagnostics.length - MAX_DISPLAYED_DIAGNOSTICS} diagnostics elided…` : ""}`;
}

export interface NavigationLocation {
  file: string;
  range: Range;
}

/** Normalizes Location and LocationLink responses to distinct file/range targets. */
export function locations(value: unknown): NavigationLocation[] {
  if (value === null || value === undefined) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  const unique = new Map<string, NavigationLocation>();
  for (const raw of values) {
    const {
      uri: rawUri,
      targetUri,
      range: rawRange,
      targetSelectionRange,
      targetRange,
    } = object(raw, "location");
    const uri = rawUri ?? targetUri;
    if (typeof uri !== "string") {
      throw new Error("Invalid location URI");
    }
    const range = protocolRange(
      rawRange ?? targetSelectionRange ?? targetRange,
    );
    const file = uriToFile(uri);
    unique.set(JSON.stringify([file, range]), { file, range });
  }
  return [...unique.values()];
}

export interface DisplaySymbol {
  name: string;
  kind: number;
  container: string;
  file: string;
  position: Position | undefined;
  depth: number;
}

/**
 * Flattens document or workspace symbols while preserving unresolved locations.
 * @param value - Untrusted protocol symbol array; null/undefined means no symbols.
 * @param documentFile - File path for document symbols that omit their own URI.
 * @returns Depth-first display symbols with zero-based UTF-16 positions, when supplied.
 * @throws For invalid metadata, missing file locations, or excessive nesting/result size.
 * @example symbols(null, "/project/a.ts") returns [].
 */
export function symbols(
  value: unknown,
  documentFile?: string,
): DisplaySymbol[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Invalid symbol response: expected an array");
  }
  const result: DisplaySymbol[] = [];
  /**
   * Appends one validated symbol and its descendants in depth-first order.
   * @param raw - Untrusted document/workspace symbol.
   * @param depth - Zero-based nesting level recorded on the output entry.
   * @throws On invalid metadata, depth over 100, or more than 10000 results already accumulated.
   * @example A parent with one child appends entries at depths 0 and 1 when visited at depth 0.
   */
  const visit = (raw: unknown, depth: number): void => {
    if (depth > MAX_SYMBOL_DEPTH || result.length > MAX_SYMBOL_RESULTS) {
      throw new Error("Symbol response exceeds nesting or size limits");
    }
    const {
      name,
      kind,
      location,
      selectionRange,
      range,
      containerName,
      children,
    } = object(raw, "symbol");
    if (typeof name !== "string" || !Number.isSafeInteger(kind)) {
      throw new Error("Invalid symbol name or kind");
    }
    let file = documentFile;
    let start: Position | undefined;
    if (location !== undefined) {
      const { uri, range: locationRange } = object(location, "symbol location");
      if (typeof uri !== "string") {
        throw new Error("Invalid symbol location URI");
      }
      file = uriToFile(uri);
      // LSP 3.17 WorkspaceSymbol locations may omit their range until resolution.
      start =
        locationRange === undefined
          ? undefined
          : protocolRange(locationRange).start;
    } else {
      ({ start } = protocolRange(selectionRange ?? range));
    }
    if (!file) {
      throw new Error("Symbol is missing its document URI");
    }
    result.push({
      name,
      kind: Number(kind),
      container: typeof containerName === "string" ? containerName : "",
      file,
      position: start,
      depth,
    });
    if (children !== undefined) {
      if (!Array.isArray(children)) {
        throw new Error("Invalid symbol children");
      }
      for (const child of children) {
        visit(child, depth + 1);
      }
    }
  };
  for (const item of value) {
    visit(item, 0);
  }
  return result;
}

/** Converts LSP hover content variants to plain text or fenced source without changing the payload. */
export function hoverText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const { contents: hoverContents } = object(value, "hover");
  const render = (contents: unknown): string => {
    if (typeof contents === "string") {
      return contents;
    }
    if (Array.isArray(contents)) {
      return contents.map((item) => render(item)).join("\n\n");
    }
    const { value: markupValue, language } = object(contents, "hover contents");
    if (typeof markupValue !== "string") {
      throw new Error("Invalid hover contents");
    }
    return typeof language === "string"
      ? `\`\`\`${language}\n${markupValue}\n\`\`\``
      : markupValue;
  };
  return render(hoverContents);
}

/**
 * Compiles a bounded, dotfile-aware glob without negation or comment interpretation.
 * @param pattern - Glob limited to 2048 UTF-16 code units, with bounded brace/globstar expansion.
 * @returns A matcher used for diagnostic targets and EditorConfig sections.
 * @throws If the pattern exceeds the length limit or compilation fails.
 * @example globMatcher("*.ts").match(".hidden.ts") returns true.
 */
function globMatcher(pattern: string): Minimatch {
  if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
    throw new Error("Glob pattern exceeds 2048 characters");
  }
  return new Minimatch(pattern, {
    dot: true,
    nonegate: true,
    nocomment: true,
    optimizationLevel: 2,
    braceExpandMax: 1000,
    maxGlobstarRecursion: 16,
  });
}

/**
 * Resolves a literal file or bounded glob walk without claiming complete truncated coverage.
 * @param pattern - Literal or glob resolved relative to cwd; missing literals are returned unchanged.
 * @param cwd - Base directory for relative targets.
 * @param signal - Optional cancellation during directory traversal.
 * @returns Sorted glob matches (at most 20) and truncation status, or one resolved literal.
 * @throws For cancellation, invalid globs, over 10000 visited entries, or non-missing I/O errors.
 * Walks skip .git/node_modules and do not descend symlinks; iterators close directory handles.
 * @example diagnosticTargets("a.ts", "/project") yields { files: ["/project/a.ts"], truncated: false }.
 */
export async function diagnosticTargets(
  pattern: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ files: string[]; truncated: boolean }> {
  const absolute = path.resolve(cwd, pattern);
  try {
    if ((await fs.stat(absolute)).isFile()) {
      return { files: [absolute], truncated: false };
    }
  } catch (error: unknown) {
    if (!missing(error)) {
      throw error;
    }
  }
  if (!GLOB_CHARACTER.test(pattern)) {
    return { files: [absolute], truncated: false };
  }
  const normalized = absolute.split(path.sep).join("/");
  const firstGlob = normalized.search(GLOB_CHARACTER);
  const root =
    normalized.slice(0, normalized.lastIndexOf("/", firstGlob)) ||
    path.parse(absolute).root;
  const matcher = globMatcher(normalized);
  const files: string[] = [];
  let visited = 0;
  let truncated = false;
  /**
   * Accumulates glob matches without descending ignored or symlinked directories.
   * @param directory - Directory whose iterator owns and closes its handle.
   * Marks truncation on a twenty-first match; shares a 10000-entry traversal budget.
   * @throws On cancellation, traversal-budget exhaustion, or filesystem errors.
   * @example Visiting a directory with 21 matching files retains 20 and sets truncated to true.
   */
  const visit = async (directory: string): Promise<void> => {
    signal?.throwIfAborted();
    const handle = await fs.opendir(directory);
    for await (const item of handle) {
      signal?.throwIfAborted();
      if (++visited > MAX_GLOB_ENTRIES) {
        throw new Error(
          "Diagnostics glob search exceeds 10000 entries; narrow the pattern",
        );
      }
      const file = path.join(directory, item.name);
      if (item.isDirectory()) {
        if (item.name !== ".git" && item.name !== "node_modules") {
          await visit(file);
        }
      } else if (
        (item.isFile() || item.isSymbolicLink()) &&
        matcher.match(file.split(path.sep).join("/"))
      ) {
        if (files.length === MAX_DIAGNOSTIC_TARGET_FILES) {
          truncated = true;
          return;
        }
        files.push(file);
      }
      if (truncated) {
        return;
      }
    }
  };
  try {
    await visit(root);
  } catch (error: unknown) {
    if (!missing(error)) {
      throw error;
    }
  }
  return {
    files: files.sort((left, right) => {
      if (left < right) {
        return -1;
      }
      if (left > right) {
        return 1;
      }
      return 0;
    }),
    truncated,
  };
}

/**
 * Infers indentation from a snapshot, then applies matching ancestor EditorConfig overrides.
 * @param file - Target path used for ancestor lookup and section matching.
 * @param content - Document text supplying fallback indentation.
 * @param cwd - Workspace boundary; lookup also stops at root=true or after 64 directories.
 * @returns LSP formatting options with a positive tab width and whitespace/newline cleanup enabled.
 * @throws For non-missing I/O failures, configs over 1 MiB, or invalid/oversized globs.
 * @example With no EditorConfig, formattingOptions("/project/a.ts", "  x\n", "/project") uses tabSize: 2 and insertSpaces: true.
 */
export async function formattingOptions(
  file: string,
  content: string,
  cwd: string,
): Promise<FormattingOptions> {
  let insertSpaces: boolean | undefined;
  let width = 0;
  for (const line of content.split("\n")) {
    if (!line.trim() || (line[0] !== " " && line[0] !== "\t")) {
      continue;
    }
    insertSpaces ??= line[0] === " ";
    const spaces = line.match(LEADING_SPACES)?.[0].length ?? 0;
    if (spaces === 0) {
      continue;
    }
    let next = spaces;
    while (next > 0) {
      const remainder = width % next;
      width = next;
      next = remainder;
    }
  }
  const configs: Array<{ directory: string; content: string }> = [];
  let directory = path.dirname(file);
  for (let depth = 0; depth < MAX_EDITORCONFIG_DEPTH; depth++) {
    try {
      const configPath = path.join(directory, ".editorconfig");
      if ((await fs.stat(configPath)).size > MAX_EDITORCONFIG_BYTES) {
        throw new Error(`EditorConfig exceeds 1 MiB: ${configPath}`);
      }
      const text = await fs.readFile(configPath, "utf8");
      configs.unshift({ directory, content: text });
      if (EDITORCONFIG_ROOT.test(text)) {
        break;
      }
    } catch (error: unknown) {
      if (!missing(error)) {
        throw error;
      }
    }
    if (directory === cwd || directory === path.dirname(directory)) {
      break;
    }
    directory = path.dirname(directory);
  }
  const settings: Partial<Record<string, string>> = {};
  for (const config of configs) {
    let applies = false;
    const relative = path
      .relative(config.directory, file)
      .split(path.sep)
      .join("/");
    for (const raw of config.content.split(CONFIG_LINE_BREAK)) {
      const line = raw.trim();
      if (!line || CONFIG_COMMENT.test(line)) {
        continue;
      }
      const section = line.match(CONFIG_SECTION)?.[1];
      if (section !== undefined) {
        const pattern = section.startsWith("/") ? section.slice(1) : section;
        applies = globMatcher(pattern).match(
          pattern.includes("/") ? relative : path.basename(file),
        );
      } else if (applies) {
        const separator = line.indexOf("=");
        if (separator < 0) {
          continue;
        }
        const key = line.slice(0, separator).trim().toLowerCase();
        const value = line
          .slice(separator + 1)
          .trim()
          .toLowerCase();
        if (value === "unset") {
          delete settings[key];
        } else {
          settings[key] = value;
        }
      }
    }
  }
  const {
    indent_size: indentSize,
    tab_width: tabWidth,
    indent_style: indentStyle,
  } = settings;
  const configuredWidth = Number(
    indentSize === "tab" ? tabWidth : (indentSize ?? tabWidth),
  );
  let insertSpacesValue = insertSpaces ?? true;
  if (indentStyle === "tab") {
    insertSpacesValue = false;
  } else if (indentStyle === "space") {
    insertSpacesValue = true;
  }
  return {
    tabSize:
      Number.isSafeInteger(configuredWidth) && configuredWidth > 0
        ? configuredWidth
        : width || 2,
    insertSpaces: insertSpacesValue,
    trimTrailingWhitespace: true,
    insertFinalNewline: true,
    trimFinalNewlines: true,
  };
}
