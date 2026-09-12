// Adapted from Oh My Pi's MIT-licensed workspace diagnostics; see LICENSE.
import { access } from "node:fs/promises";
import * as path from "node:path";
import { resolveCommand } from "./config.js";
import { runCommand } from "./process.js";
import type { LspResult } from "./types.js";

interface Checker {
  language: "rust" | "typescript" | "go" | "python";
  command: string;
  args: string[];
  description: string;
  goWorkspace?: boolean;
}

interface CheckerResult {
  description: string;
  output: string;
  isError: boolean;
  exitCode?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CONCURRENT_CHECKERS = 2;
const MAX_GO_MODULES = 256;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function marker(cwd: string, name: string): Promise<boolean> {
  try {
    await access(path.join(cwd, name));
    return true;
  } catch (error) {
    if (record(error)) {
      const { code } = error;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
    }
    throw error;
  }
}

async function detectCheckers(
  cwd: string,
  signal?: AbortSignal,
): Promise<Checker[]> {
  const checkers: Checker[] = [];
  signal?.throwIfAborted();
  if (await marker(cwd, "Cargo.toml")) {
    checkers.push({
      language: "rust",
      command: "cargo",
      args: ["check", "--message-format=short"],
      description: "Rust (cargo check)",
    });
  }
  if (await marker(cwd, "tsconfig.json")) {
    checkers.push({
      language: "typescript",
      command: "tsc",
      args: ["--noEmit", "--pretty", "false"],
      description: "TypeScript (tsc --noEmit)",
    });
  }
  const goWorkspace = await marker(cwd, "go.work");
  if (goWorkspace || (await marker(cwd, "go.mod"))) {
    checkers.push({
      language: "go",
      command: "go",
      args: ["build", "./..."],
      description: goWorkspace ? "Go workspace (go build)" : "Go (go build)",
      goWorkspace,
    });
  }
  if (
    (await marker(cwd, "pyproject.toml")) ||
    (await marker(cwd, "pyrightconfig.json"))
  ) {
    checkers.push({
      language: "python",
      command: "pyright",
      args: [],
      description: "Python (pyright)",
    });
  }
  signal?.throwIfAborted();
  return checkers;
}

function goWorkspacePatterns(output: string): string[] {
  const parsed: unknown = JSON.parse(output);
  if (!record(parsed))
    throw new Error(
      "go work edit -json returned no workspace modules; workspace was not verified",
    );
  const { Use: modules } = parsed;
  if (!Array.isArray(modules) || modules.length === 0)
    throw new Error(
      "go work edit -json returned no workspace modules; workspace was not verified",
    );
  if (modules.length > MAX_GO_MODULES)
    throw new Error(
      `Go workspace exceeds ${MAX_GO_MODULES} modules; select a smaller workspace`,
    );
  const patterns = new Set<string>();
  for (const entry of modules) {
    if (!record(entry))
      throw new Error("go work edit -json returned an invalid module path");
    const { DiskPath: modulePath } = entry;
    if (
      typeof modulePath !== "string" ||
      !modulePath.trim() ||
      modulePath.includes("\0")
    )
      throw new Error("go work edit -json returned an invalid module path");
    const directory =
      modulePath.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
    if (directory === ".") patterns.add("./...");
    else {
      const absolute =
        path.isAbsolute(directory) || path.win32.isAbsolute(directory);
      const prefix =
        absolute || directory.startsWith("./") || directory.startsWith("../")
          ? ""
          : "./";
      patterns.add(`${prefix}${directory === "/" ? "" : directory}/...`);
    }
  }
  return [...patterns];
}

function boundedOutput(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  const displayed = lines
    .slice(0, 50)
    .map((line) =>
      line.length > 1000 ? `${line.slice(0, 1000)} [line truncated]` : line,
    )
    .join("\n");
  const bounded =
    displayed.length > 20_000
      ? `${displayed.slice(0, 20_000)}\n[output truncated at 20000 characters]`
      : displayed;
  return lines.length > 50
    ? `${bounded}\n[${lines.length - 50} additional lines omitted]`
    : bounded;
}

async function runChecker(
  cwd: string,
  checker: Checker,
  deadline: number,
  signal?: AbortSignal,
): Promise<CheckerResult> {
  const remaining = (): number => {
    signal?.throwIfAborted();
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0)
      throw new Error(
        "workspace diagnostics deadline exceeded; workspace was not verified",
      );
    return timeoutMs;
  };
  try {
    remaining();
    let command = await resolveCommand(checker.command, cwd);
    if (!command && checker.language === "typescript")
      command = await resolveCommand("tsgo", cwd);
    if (!command)
      throw new Error(
        `installed '${checker.command}' executable was not found in project binaries or PATH; install the checker explicitly (no dependencies were downloaded)`,
      );
    const options = { cwd, ...(signal ? { signal } : {}) };
    let args = checker.args;
    if (checker.goWorkspace) {
      const workspace = await runCommand(command, ["work", "edit", "-json"], {
        ...options,
        timeoutMs: remaining(),
      });
      signal?.throwIfAborted();
      if (workspace.exitCode !== 0)
        throw new Error(
          `go work edit -json exited with code ${workspace.exitCode}: ${boundedOutput(workspace.stderr || workspace.stdout) || "no output"}`,
        );
      args = ["build", ...goWorkspacePatterns(workspace.stdout)];
    }
    const result = await runCommand(command, args, {
      ...options,
      timeoutMs: remaining(),
    });
    signal?.throwIfAborted();
    const output = [result.stdout.trim(), result.stderr.trim()]
      .filter(Boolean)
      .join("\n");
    if (!output && result.exitCode !== 0)
      return {
        description: checker.description,
        isError: true,
        exitCode: result.exitCode,
        output: `Failed to run ${checker.command} ${args.join(" ")}: checker exited with code ${result.exitCode} without reporting anything; workspace was not verified`,
      };
    return {
      description: checker.description,
      // Nonzero checker exits with output report findings, not tool failures.
      isError: false,
      exitCode: result.exitCode,
      output: output
        ? `${boundedOutput(output)}${result.exitCode !== 0 ? `\n[checker exited with code ${result.exitCode}]` : ""}`
        : "No issues found",
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      description: checker.description,
      isError: true,
      output: `Failed to run ${checker.command}: ${boundedOutput(error instanceof Error ? error.message : String(error))}`,
    };
  }
}

/** Root-only detection; two finite checkers at a time under one deadline. */
export async function runWorkspaceDiagnostics(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<LspResult> {
  signal?.throwIfAborted();
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  )
    return {
      text: "Workspace diagnostics timeout must be a positive, finite millisecond duration no greater than 2147483647",
      isError: true,
    };
  const deadline = Date.now() + timeoutMs;
  let checkers: Checker[];
  try {
    checkers = await detectCheckers(path.resolve(cwd), signal);
  } catch (error) {
    signal?.throwIfAborted();
    return {
      text: `Workspace checker discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
  if (checkers.length === 0)
    return {
      text: "Cannot detect project type. Supported: Rust (Cargo.toml), TypeScript (tsconfig.json), Go (go.work/go.mod), Python (pyproject.toml/pyrightconfig.json). Workspace was not verified.",
      isError: true,
    };
  const results: CheckerResult[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < checkers.length) {
      const index = cursor++;
      const checker = checkers[index];
      if (checker)
        results[index] = await runChecker(cwd, checker, deadline, signal);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_CHECKERS, checkers.length) },
      worker,
    ),
  );
  signal?.throwIfAborted();
  return {
    text:
      results.length === 1
        ? (results[0]?.output ?? "Workspace was not verified")
        : results
            .map((result) => `=== ${result.description} ===\n${result.output}`)
            .join("\n\n"),
    ...(results.some((result) => result.isError) ? { isError: true } : {}),
    details: {
      projectTypes: checkers.map((checker) => checker.language),
      checkers: results,
    },
  };
}
