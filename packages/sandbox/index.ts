/**
 * Sandbox Extension - OS-level sandboxing for bash commands
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux).
 *
 * Note: this example intentionally overrides the built-in `bash` tool to show
 * how built-in tools can be replaced. Alternatively, you could sandbox `bash`
 * via `tool_call` input mutation without replacing the tool.
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/sandbox.json (global)
 * - <cwd>/.pi/sandbox.json (project-local)
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh", "~/.aws"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   }
 * }
 * ```
 *
 * Usage:
 * - `PI_CODING_AGENT_DIR="$PWD/apps/agent" pi` - load the extension from the tracked agent settings
 * - `pi -e ./packages/sandbox --no-sandbox` - load it directly with sandboxing disabled
 * - `/sandbox` - show current sandbox configuration
 *
 * Setup:
 * 1. Run `npm ci` from the repository root
 * 2. Use `apps/agent` as `PI_CODING_AGENT_DIR`
 *
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import {
  type BashOperations,
  CONFIG_DIR_NAME,
  createBashTool,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import deepMerge from "deepmerge";

interface SandboxConfig extends SandboxRuntimeConfig {
  enabled: boolean;
}

function formatError(error: unknown): string {
  return String(error);
}

function formatConfigValues(values: string[] | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "(none)";
}

const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  network: {
    allowedDomains: [
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
  },
};

type RecursivePartial<T> = T extends readonly unknown[]
  ? T
  : T extends (...args: never[]) => unknown
    ? T
    : T extends object
      ? { [P in keyof T]?: RecursivePartial<T[P]> }
      : T;

function readConfig(configPath: string): RecursivePartial<SandboxConfig> {
  if (!existsSync(configPath)) return {};

  // Config files are assumed to match RecursivePartial<SandboxConfig>. Keep
  // the assertion at this I/O seam so the rest of the extension receives typed
  // config data; malformed JSON intentionally propagates to session startup.
  return JSON.parse(
    readFileSync(configPath, "utf-8"),
  ) as RecursivePartial<SandboxConfig>;
}

const DEEP_MERGE_OPTIONS = {
  arrayMerge: (_target: unknown[], source: unknown[]) => source,
};

function mergeConfig(
  base: SandboxConfig,
  overrides: RecursivePartial<SandboxConfig>,
): SandboxConfig {
  return deepMerge<SandboxConfig, RecursivePartial<SandboxConfig>>(
    base,
    overrides,
    DEEP_MERGE_OPTIONS,
  );
}

function loadConfig(cwd: string, projectTrusted: boolean): SandboxConfig {
  const globalConfigPath = join(getAgentDir(), "sandbox.json");
  const config = mergeConfig(DEFAULT_CONFIG, readConfig(globalConfigPath));

  if (!projectTrusted) return config;

  const projectConfigPath = join(cwd, CONFIG_DIR_NAME, "sandbox.json");
  return mergeConfig(config, readConfig(projectConfigPath));
}

interface SymlinkedConfigPath {
  configuredPath: string;
  absolutePath: string;
  resolvedPath: string;
  isDirectory: boolean;
}

function formatSymlinkMapping({
  configuredPath,
  resolvedPath,
}: SymlinkedConfigPath): string {
  return `${configuredPath} -> ${resolvedPath}`;
}

interface FilesystemSymlinkWarnings {
  denyReadDirectories: SymlinkedConfigPath[];
  allowReadPaths: SymlinkedConfigPath[];
  allowWritePaths: SymlinkedConfigPath[];
}

function findSymlinkedConfigPaths(
  paths: string[] | undefined,
  cwd: string,
): SymlinkedConfigPath[] {
  if (!paths) return [];

  const symlinks: SymlinkedConfigPath[] = [];
  for (const configuredPath of paths) {
    // Resolving a glob to one path would misrepresent the complete rule.
    if (/[*?[\]{}]/.test(configuredPath)) continue;

    const expandedPath =
      configuredPath === "~"
        ? homedir()
        : configuredPath.startsWith("~/")
          ? join(homedir(), configuredPath.slice(2))
          : configuredPath;
    const absolutePath = resolve(cwd, expandedPath);

    try {
      const stats = statSync(absolutePath);
      const resolvedPath = realpathSync(absolutePath);
      if (resolvedPath !== absolutePath) {
        symlinks.push({
          configuredPath,
          absolutePath,
          resolvedPath,
          isDirectory: stats.isDirectory(),
        });
      }
    } catch {
      // Missing, dangling, or inaccessible paths are handled by sandbox-runtime.
    }
  }

  return symlinks;
}

function isCrossBoundarySymlink({
  absolutePath,
  resolvedPath,
}: SymlinkedConfigPath): boolean {
  // This is the Linux case of sandbox-runtime's isSymlinkOutsideBoundary():
  // only resolutions that remain at or beneath the configured path are accepted.
  return (
    resolvedPath !== absolutePath &&
    !resolvedPath.startsWith(`${absolutePath}/`)
  );
}

function findFilesystemSymlinkWarnings(
  config: SandboxConfig,
  cwd: string,
): FilesystemSymlinkWarnings {
  const denyReadDirectories = findSymlinkedConfigPaths(
    config.filesystem?.denyRead,
    cwd,
  ).filter((entry) => entry.isDirectory && isCrossBoundarySymlink(entry));
  const allowReadPaths = findSymlinkedConfigPaths(
    config.filesystem?.allowRead,
    cwd,
  ).filter(isCrossBoundarySymlink);
  const allowWritePaths = findSymlinkedConfigPaths(
    config.filesystem?.allowWrite,
    cwd,
  ).filter(isCrossBoundarySymlink);

  return { denyReadDirectories, allowReadPaths, allowWritePaths };
}

const SANDBOX_SYMLINK_WIDGET_KEY = "sandbox-symlink-warning";

function hasFilesystemSymlinkWarnings(
  warnings: FilesystemSymlinkWarnings,
): boolean {
  return Object.values(warnings).some((paths) => paths.length > 0);
}

function formatFilesystemSymlinkWidget(
  warnings: FilesystemSymlinkWarnings,
): string[] {
  const mappings = [
    ...warnings.denyReadDirectories.map(
      (entry) => `denyRead: ${formatSymlinkMapping(entry)}`,
    ),
    ...warnings.allowReadPaths.map(
      (entry) => `allowRead: ${formatSymlinkMapping(entry)}`,
    ),
    ...warnings.allowWritePaths.map(
      (entry) => `allowWrite (skipped): ${formatSymlinkMapping(entry)}`,
    ),
  ];
  const visibleMappings = mappings.slice(0, 5);
  const hiddenCount = mappings.length - visibleMappings.length;

  return [
    "⚠ Sandbox filesystem symlink warning",
    ...visibleMappings,
    ...(hiddenCount > 0 ? [`... and ${hiddenCount} more`] : []),
    "Run /sandbox for behavior details and upstream references.",
  ];
}

function formatFilesystemSymlinkWarning(
  warnings: FilesystemSymlinkWarnings,
): string {
  const lines = [
    "Sandbox configuration warning:",
    "",
    "Cross-boundary filesystem symlinks detected:",
  ];
  const addPaths = (heading: string, paths: SymlinkedConfigPath[]) => {
    if (paths.length === 0) return;
    lines.push(
      "",
      heading,
      ...paths.map((entry) => `  ${formatSymlinkMapping(entry)}`),
    );
  };

  addPaths(
    "Directory denyRead paths (left unresolved; may prevent bubblewrap from starting):",
    warnings.denyReadDirectories,
  );
  addPaths(
    "allowRead paths (left in their configured spelling; keep them consistent with denyRead):",
    warnings.allowReadPaths,
  );
  addPaths(
    "allowWrite paths (skipped to avoid unexpectedly making their targets writable):",
    warnings.allowWritePaths,
  );

  lines.push(
    "",
    "Behavior:",
    "- File denyRead symlinks are resolved to their targets.",
    "- Cross-boundary directory denyRead symlinks remain unresolved; use canonical targets.",
    "- allowRead rebinds matching carve-outs read-only; use canonical paths when denyRead is canonical.",
    "- Cross-boundary allowWrite symlinks are skipped; use canonical targets only when write access is intended.",
    "- denyWrite symlinks and symlinked ancestors are resolved.",
    "",
    "References:",
    "- PR #289: resolves file denyRead symlinks but preserves directory paths for allowRead carve-outs.",
    "  https://github.com/anthropic-experimental/sandbox-runtime/pull/289",
    "- PR #166: adds allowRead by rebinding carve-outs after denyRead overlays.",
    "  https://github.com/anthropic-experimental/sandbox-runtime/pull/166",
    "- PR #138: skips cross-boundary allowWrite symlinks to prevent unintended write access.",
    "  https://github.com/anthropic-experimental/sandbox-runtime/pull/138",
    "- PR #392: canonicalizes denyWrite paths before creating bubblewrap mounts.",
    "  https://github.com/anthropic-experimental/sandbox-runtime/pull/392",
  );

  return lines.join("\n");
}

function createSandboxedBashOps(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

      try {
        const { promise, resolve, reject } = Promise.withResolvers<{
          exitCode: number | null;
        }>();
        const child = spawn("bash", ["-c", wrappedCommand], {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let settled = false;
        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        function terminateChild(): void {
          if (!child.pid) return;

          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {
              // The process may already have exited.
            }
          }
        }

        function releaseExecutionResources(): void {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
            timeoutHandle = undefined;
          }
          signal?.removeEventListener("abort", terminateChild);
          child.stdout?.off("data", onData);
          child.stderr?.off("data", onData);
          child.off("error", onChildError);
          child.off("close", onChildClose);
        }

        function beginSettlement(): boolean {
          if (settled) return false;
          settled = true;
          releaseExecutionResources();
          return true;
        }

        function onChildError(error: Error): void {
          if (!beginSettlement()) return;
          reject(error);
        }

        function onChildClose(code: number | null): void {
          if (!beginSettlement()) return;

          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            resolve({ exitCode: code });
          }
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.once("error", onChildError);
        child.once("close", onChildClose);

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            terminateChild();
          }, timeout * 1000);
        }

        signal?.addEventListener("abort", terminateChild, { once: true });
        if (signal?.aborted) terminateChild();

        return await promise;
      } finally {
        try {
          // Linux bwrap creates host mount-point placeholders for absent deny paths.
          SandboxManager.cleanupAfterCommand();
        } catch {
          // Cleanup must not obscure the command result.
        }
      }
    },
  };
}

function clearSandboxUi(ctx: Pick<ExtensionContext, "ui">): void {
  ctx.ui.setStatus("sandbox", undefined);
  ctx.ui.setWidget(SANDBOX_SYMLINK_WIDGET_KEY, undefined);
}

export default function sandbox(pi: ExtensionAPI): void {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();
  const localBash = createBashTool(localCwd);

  let sandboxState: "inactive" | "initializing" | "active" = "inactive";
  let managerNeedsReset = false;

  async function releaseSandboxManager(): Promise<void> {
    sandboxState = "inactive";
    if (!managerNeedsReset) return;

    await SandboxManager.reset();
    managerNeedsReset = false;
  }

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, _ctx) {
      if (sandboxState !== "active") {
        return localBash.execute(id, params, signal, onUpdate);
      }

      const sandboxedBash = createBashTool(localCwd, {
        operations: createSandboxedBashOps(),
      });
      return sandboxedBash.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("user_bash", () => {
    if (sandboxState !== "active") return;
    return { operations: createSandboxedBashOps() };
  });

  pi.on("session_start", async (_event, ctx) => {
    clearSandboxUi(ctx);

    const noSandbox = pi.getFlag("no-sandbox") === true;
    if (noSandbox) {
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }

    const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    if (!config.enabled) {
      ctx.ui.notify("Sandbox disabled via config", "info");
      return;
    }

    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
      return;
    }

    // These symlink behaviors are specific to Linux's bubblewrap mount rules;
    // macOS uses Seatbelt profiles and does not create the same bind/tmpfs mounts.
    if (platform === "linux") {
      const symlinkWarnings = findFilesystemSymlinkWarnings(config, ctx.cwd);
      if (hasFilesystemSymlinkWarnings(symlinkWarnings)) {
        if (ctx.mode === "tui") {
          // Notifications emitted during session_start can scroll behind restored
          // history, while a widget remains visible beside the resumed editor.
          ctx.ui.setWidget(
            SANDBOX_SYMLINK_WIDGET_KEY,
            formatFilesystemSymlinkWidget(symlinkWarnings),
          );
        } else if (ctx.hasUI) {
          // RPC clients receive notifications but may not render TUI widgets.
          ctx.ui.notify(
            formatFilesystemSymlinkWarning(symlinkWarnings),
            "warning",
          );
        }
      }
    }

    sandboxState = "initializing";
    try {
      await SandboxManager.initialize({
        network: config.network,
        filesystem: config.filesystem,
        ignoreViolations: config.ignoreViolations,
        enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
      });
    } catch (error) {
      sandboxState = "inactive";
      const message = formatError(
        error instanceof Error ? error.message : error,
      );
      ctx.ui.notify(`Sandbox initialization failed: ${message}`, "error");
      return;
    }
    managerNeedsReset = true;

    const networkCount = config.network.allowedDomains.length;
    const writeCount = config.filesystem.allowWrite.length;
    const status = ctx.ui.theme.fg(
      "accent",
      `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`,
    );
    ctx.ui.setStatus("sandbox", status);
    ctx.ui.notify("Sandbox initialized", "info");
    sandboxState = "active";
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Pi awaits shutdown before reload or session replacement. Await the
    // process-global manager reset so the next extension instance cannot start
    // while the previous sandbox still owns runtime resources, and report
    // failures instead of hiding cleanup state from that next instance.
    try {
      await releaseSandboxManager();
    } catch (error) {
      const message = formatError(
        error instanceof Error ? error.message : error,
      );
      ctx.ui.notify(`Sandbox cleanup failed: ${message}`, "error");
    }
    clearSandboxUi(ctx);
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox configuration",
    handler: async (_args, ctx) => {
      const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
      const lines = [
        "Sandbox Configuration:",
        `  Status: ${sandboxState === "active" ? "initialized" : "disabled or not initialized"}`,
        "",
        "Network:",
        `  Allowed: ${formatConfigValues(config.network.allowedDomains)}`,
        `  Denied: ${formatConfigValues(config.network.deniedDomains)}`,
        "",
        "Filesystem:",
        `  Deny Read: ${formatConfigValues(config.filesystem.denyRead)}`,
        `  Allow Read: ${formatConfigValues(config.filesystem.allowRead)}`,
        `  Allow Write: ${formatConfigValues(config.filesystem.allowWrite)}`,
        `  Deny Write: ${formatConfigValues(config.filesystem.denyWrite)}`,
      ];

      const symlinkWarnings =
        process.platform === "linux"
          ? findFilesystemSymlinkWarnings(config, ctx.cwd)
          : undefined;
      const hasSymlinkWarnings = symlinkWarnings
        ? hasFilesystemSymlinkWarnings(symlinkWarnings)
        : false;
      if (symlinkWarnings && hasSymlinkWarnings) {
        lines.push("", formatFilesystemSymlinkWarning(symlinkWarnings));
      }

      ctx.ui.notify(lines.join("\n"), hasSymlinkWarnings ? "warning" : "info");
    },
  });
}
