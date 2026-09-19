// Adapted from Oh My Pi's MIT-licensed Biome and SwiftLint adapters; see LICENSE.
import { open } from "node:fs/promises";
import path from "node:path";
import type {
  Diagnostic,
  DiagnosticSeverity,
  Position,
} from "vscode-languageserver-protocol";
import { runCommand } from "./process.ts";
import type { ServerConfig } from "./types.ts";

const CLI_TIMEOUT_MS = 30_000;
const MAX_DIAGNOSTICS = 1000;

const MUTATING_FLAG =
  /^(?:--write|--fix|--unsafe|--autocorrect|--format)(?:=|$)/;
const LINE_BREAK = /\r?\n/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cliArguments(
  server: ServerConfig,
  action: "lint" | "format",
): string[] {
  if (server.args.some((argument) => MUTATING_FLAG.test(argument))) {
    throw new Error(
      `${server.name}: mutating CLI flags are not allowed in LSP diagnostic or formatting computations`,
    );
  }
  const args: string[] = [];
  for (let index = 0; index < server.args.length; index++) {
    const argument = server.args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--reporter" || argument === "--max-diagnostics") {
      index++;
      continue;
    }
    if (
      argument.startsWith("--reporter=") ||
      argument.startsWith("--max-diagnostics=")
    ) {
      continue;
    }
    args.push(argument);
  }
  const mode = args.findIndex(
    (argument) =>
      argument === "lsp-proxy" ||
      argument === "lint" ||
      argument === "format" ||
      argument === "check",
  );
  if (mode >= 0) {
    args[mode] = action;
  } else {
    args.unshift(action);
  }
  return args;
}

async function sourceLines(
  file: string,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  const handle = await open(file, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) {
      throw new Error(
        "CLI diagnostics require a regular source file no larger than 8 MiB",
      );
    }
    const bytes = Buffer.alloc(metadata.size + 1);
    let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const result = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (result.bytesRead === 0) {
        break;
      }
      length += result.bytesRead;
    }
    if (length > metadata.size) {
      throw new Error(
        "Source file changed while being read for CLI diagnostics",
      );
    }
    return bytes.toString("utf8", 0, length).split(LINE_BREAK);
  } finally {
    await handle.close();
  }
}

function position(
  value: unknown,
  label: string,
  lines: readonly string[],
): Position {
  if (!record(value)) {
    throw new Error(`Biome returned an invalid ${label} position`);
  }
  const { line: rawLine, column } = value;
  // Biome uses (0, 0) for a file-level diagnostic without a source span.
  if (rawLine === 0 && column === 0) {
    return { line: 0, character: 0 };
  }
  if (
    typeof rawLine !== "number" ||
    !Number.isSafeInteger(rawLine) ||
    rawLine < 1 ||
    typeof column !== "number" ||
    !Number.isSafeInteger(column) ||
    column < 1
  ) {
    throw new Error(`Biome returned an invalid ${label} position`);
  }
  const line = rawLine - 1;
  const text = lines[line];
  if (text === undefined) {
    throw new Error(`Biome returned an out-of-bounds ${label} line`);
  }
  // The JSON reporter counts Unicode scalar values, not LSP's UTF-16 code units.
  let remaining = column - 1;
  let character = 0;
  for (const scalar of text) {
    if (remaining === 0) {
      break;
    }
    character += scalar.length;
    remaining--;
  }
  if (remaining !== 0) {
    throw new Error(`Biome returned an out-of-bounds ${label} column`);
  }
  return { line, character };
}

function severity(value: unknown, source: string): DiagnosticSeverity {
  switch (typeof value === "string" ? value.toLowerCase() : value) {
    case "fatal":
    case "error":
      return 1;
    case "warning":
      return 2;
    case "information":
    case "info":
      return 3;
    case "hint":
      return 4;
    default:
      throw new Error(
        `${source} returned an unrecognized diagnostic severity: ${String(value)}`,
      );
  }
}

function biomeDiagnostics(
  value: unknown,
  server: ServerConfig,
  file: string,
  lines: readonly string[],
): Diagnostic[] {
  if (!record(value)) {
    throw new Error("Biome JSON reporter did not return diagnostics array");
  }
  const { diagnostics: rawDiagnostics, summary } = value;
  if (!Array.isArray(rawDiagnostics)) {
    throw new Error("Biome JSON reporter did not return a diagnostics array");
  }
  if (rawDiagnostics.length > MAX_DIAGNOSTICS) {
    throw new Error(
      `Biome returned more than ${MAX_DIAGNOSTICS} diagnostics; narrow the file or rule configuration`,
    );
  }
  const diagnostics: Diagnostic[] = [];
  for (const item of rawDiagnostics) {
    if (!record(item)) {
      throw new Error(
        "Biome JSON reporter returned diagnostic without a message",
      );
    }
    const { message, location } = item;
    if (typeof message !== "string" || !message) {
      throw new Error(
        "Biome JSON reporter returned a diagnostic without a message",
      );
    }
    if (!record(location)) {
      throw new Error(`Biome could not locate diagnostic: ${message}`);
    }
    const { path: diagnosticPath, start: rawStart, end: rawEnd } = location;
    if (typeof diagnosticPath !== "string" || !diagnosticPath) {
      throw new Error(`Biome could not locate diagnostic: ${message}`);
    }
    if (path.resolve(server.root, diagnosticPath) !== file) {
      continue;
    }
    const start = position(rawStart, "start", lines);
    const end = rawEnd === undefined ? start : position(rawEnd, "end", lines);
    if (
      end.line < start.line ||
      (end.line === start.line && end.character < start.character)
    ) {
      throw new Error("Biome returned a reversed diagnostic range");
    }
    const { category, severity: diagnosticSeverity } = item;
    if (category !== undefined && typeof category !== "string") {
      throw new Error("Biome returned an invalid diagnostic category");
    }
    diagnostics.push({
      range: { start, end },
      severity: severity(diagnosticSeverity, "Biome"),
      message,
      source: "biome",
      ...(typeof category === "string" ? { code: category } : {}),
    });
  }
  if (record(summary)) {
    const { diagnosticsNotPrinted } = summary;
    if (
      typeof diagnosticsNotPrinted === "number" &&
      diagnosticsNotPrinted > 0
    ) {
      throw new Error(
        `Biome omitted ${diagnosticsNotPrinted} diagnostics; result is incomplete`,
      );
    }
  }
  return diagnostics;
}

function swiftlintDiagnostics(
  value: unknown,
  server: ServerConfig,
  file: string,
): Diagnostic[] {
  if (!Array.isArray(value)) {
    throw new Error(
      "SwiftLint JSON reporter did not return a violations array",
    );
  }
  if (value.length > MAX_DIAGNOSTICS) {
    throw new Error(
      `SwiftLint returned more than ${MAX_DIAGNOSTICS} diagnostics; narrow the file or rule configuration`,
    );
  }
  const diagnostics: Diagnostic[] = [];
  for (const item of value) {
    if (!record(item)) {
      throw new Error("SwiftLint JSON reporter returned an invalid violation");
    }
    const { reason, file: diagnosticFile } = item;
    if (
      typeof reason !== "string" ||
      !reason ||
      typeof diagnosticFile !== "string" ||
      !diagnosticFile
    ) {
      throw new Error("SwiftLint JSON reporter returned an invalid violation");
    }
    if (path.resolve(server.root, diagnosticFile) !== file) {
      continue;
    }
    const {
      line,
      character,
      rule_id: ruleId,
      severity: diagnosticSeverity,
    } = item;
    if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) {
      throw new Error("SwiftLint returned an invalid diagnostic line");
    }
    const column = character ?? 1;
    if (
      typeof column !== "number" ||
      !Number.isSafeInteger(column) ||
      column < 1
    ) {
      throw new Error("SwiftLint returned an invalid diagnostic column");
    }
    if (typeof ruleId !== "string") {
      throw new Error("SwiftLint returned an invalid rule identifier");
    }
    const start = { line: line - 1, character: column - 1 };
    diagnostics.push({
      range: { start, end: start },
      severity: severity(diagnosticSeverity, "SwiftLint"),
      message: reason,
      source: "swiftlint",
      code: ruleId,
    });
  }
  return diagnostics;
}

/** Runs a read-only CLI check and normalizes its findings; invalid output is never treated as clean. */
export async function lintWithCli(
  server: ServerConfig,
  file: string,
  signal?: AbortSignal,
): Promise<Diagnostic[]> {
  signal?.throwIfAborted();
  if (server.name !== "biome" && server.name !== "swiftlint") {
    throw new Error(`${server.name} is not a CLI linter`);
  }
  if (server.disabled || !server.resolvedCommand) {
    throw new Error(`${server.name}: executable is unavailable or disabled`);
  }
  const target = path.resolve(server.root, file);
  const lines =
    server.name === "biome" ? await sourceLines(target, signal) : [];
  const args = cliArguments(server, "lint");
  if (server.name === "biome") {
    args.push(
      "--reporter=json",
      `--max-diagnostics=${MAX_DIAGNOSTICS}`,
      target,
    );
  } else {
    if (!args.includes("--quiet")) {
      args.push("--quiet");
    }
    args.push("--reporter", "json", target);
  }
  const result = await runCommand(server.resolvedCommand, args, {
    cwd: server.root,
    ...(server.env ? { env: server.env } : {}),
    ...(signal ? { signal } : {}),
    timeoutMs: CLI_TIMEOUT_MS,
  });
  signal?.throwIfAborted();
  let report: unknown;
  try {
    report = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error(
      `${server.name}: invalid or missing JSON diagnostics (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 1500) || result.stdout.trim().slice(0, 1500) || String(error)}`,
    );
  }
  const diagnostics =
    server.name === "biome"
      ? biomeDiagnostics(report, server, target, lines)
      : swiftlintDiagnostics(report, server, target);
  // A nonzero exit with actual violations is normal. Empty output is never proof of a clean file after failure.
  if (
    (result.exitCode !== 0 && diagnostics.length === 0) ||
    result.exitCode < 0 ||
    result.exitCode > (server.name === "swiftlint" ? 2 : 1)
  ) {
    throw new Error(
      `${server.name} exited with code ${result.exitCode}; file was not verified: ${result.stderr.trim().slice(0, 1500) || "no usable diagnostics"}`,
    );
  }
  return diagnostics;
}

/** Formats the supplied snapshot through stdin without writing files; SwiftLint remains lint-only. */
export async function formatWithCli(
  server: ServerConfig,
  file: string,
  content: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  // Like the upstream adapter, SwiftLint is lint-only. SourceKit supplies Swift formatting.
  if (server.name === "swiftlint") {
    return content;
  }
  if (server.name !== "biome") {
    throw new Error(`${server.name} is not a CLI formatter`);
  }
  if (server.disabled || !server.resolvedCommand) {
    throw new Error(`${server.name}: executable is unavailable or disabled`);
  }
  const args = [
    ...cliArguments(server, "format"),
    `--stdin-file-path=${path.resolve(server.root, file)}`,
  ];
  const result = await runCommand(server.resolvedCommand, args, {
    cwd: server.root,
    input: content,
    ...(server.env ? { env: server.env } : {}),
    ...(signal ? { signal } : {}),
    timeoutMs: CLI_TIMEOUT_MS,
    maxOutputBytes: 16 * 1024 * 1024,
  });
  signal?.throwIfAborted();
  if (result.exitCode !== 0) {
    throw new Error(
      `Biome formatting failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 1500) || "no error output"}`,
    );
  }
  if (content.trim() && !result.stdout.trim()) {
    throw new Error(
      "Biome formatter returned empty output for a non-empty file",
    );
  }
  return result.stdout;
}
