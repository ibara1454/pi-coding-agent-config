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
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type BashOperations, CONFIG_DIR_NAME, createBashTool, getAgentDir } from "@earendil-works/pi-coding-agent";

interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
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

function loadConfig(cwd: string): SandboxConfig {
	const projectConfigPath = join(cwd, CONFIG_DIR_NAME, "sandbox.json");
	const globalConfigPath = join(getAgentDir(), "sandbox.json");

	let globalConfig: Partial<SandboxConfig> = {};
	let projectConfig: Partial<SandboxConfig> = {};

	if (existsSync(globalConfigPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
		}
	}

	if (existsSync(projectConfigPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
		}
	}

	return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

interface SymlinkedConfigPath {
	configuredPath: string;
	absolutePath: string;
	resolvedPath: string;
	isDirectory: boolean;
}

interface FilesystemSymlinkWarnings {
	denyReadDirectories: SymlinkedConfigPath[];
	allowReadPaths: SymlinkedConfigPath[];
	allowWritePaths: SymlinkedConfigPath[];
}

function findSymlinkedConfigPaths(paths: string[] | undefined, cwd: string): SymlinkedConfigPath[] {
	if (!paths) return [];

	const symlinks: SymlinkedConfigPath[] = [];
	for (const configuredPath of paths) {
		// Resolving a glob to one path would misrepresent the complete rule.
		if (/[*?[\]{}]/.test(configuredPath)) continue;

		const expandedPath = configuredPath === "~"
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

function isCrossBoundarySymlink({ absolutePath, resolvedPath }: SymlinkedConfigPath): boolean {
	// This is the Linux case of sandbox-runtime's isSymlinkOutsideBoundary():
	// only resolutions that remain at or beneath the configured path are accepted.
	return resolvedPath !== absolutePath && !resolvedPath.startsWith(`${absolutePath}/`);
}

function findFilesystemSymlinkWarnings(config: SandboxConfig, cwd: string): FilesystemSymlinkWarnings {
	const denyReadDirectories = findSymlinkedConfigPaths(config.filesystem?.denyRead, cwd)
		.filter((entry) => entry.isDirectory && isCrossBoundarySymlink(entry));
	const allowReadPaths = findSymlinkedConfigPaths(config.filesystem?.allowRead, cwd)
		.filter(isCrossBoundarySymlink);
	const allowWritePaths = findSymlinkedConfigPaths(config.filesystem?.allowWrite, cwd)
		.filter(isCrossBoundarySymlink);

	return { denyReadDirectories, allowReadPaths, allowWritePaths };
}

const SANDBOX_SYMLINK_WIDGET_KEY = "sandbox-symlink-warning";

function hasFilesystemSymlinkWarnings(warnings: FilesystemSymlinkWarnings): boolean {
	return Object.values(warnings).some((paths) => paths.length > 0);
}

function formatFilesystemSymlinkWidget(warnings: FilesystemSymlinkWarnings): string[] {
	const mappings = [
		...warnings.denyReadDirectories.map(
			({ configuredPath, resolvedPath }) => `denyRead: ${configuredPath} -> ${resolvedPath}`,
		),
		...warnings.allowReadPaths.map(
			({ configuredPath, resolvedPath }) => `allowRead: ${configuredPath} -> ${resolvedPath}`,
		),
		...warnings.allowWritePaths.map(
			({ configuredPath, resolvedPath }) => `allowWrite (skipped): ${configuredPath} -> ${resolvedPath}`,
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

function formatFilesystemSymlinkWarning(warnings: FilesystemSymlinkWarnings): string {
	const lines = ["Sandbox configuration warning:", "", "Cross-boundary filesystem symlinks detected:"];
	const addPaths = (heading: string, paths: SymlinkedConfigPath[]) => {
		if (paths.length === 0) return;
		lines.push("", heading, ...paths.map(({ configuredPath, resolvedPath }) => `  ${configuredPath} -> ${resolvedPath}`));
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

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	const result: SandboxConfig = { ...base };

	if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
	if (overrides.network) {
		result.network = { ...base.network, ...overrides.network };
	}
	if (overrides.filesystem) {
		result.filesystem = { ...base.filesystem, ...overrides.filesystem };
	}

	const extOverrides = overrides as {
		ignoreViolations?: Record<string, string[]>;
		enableWeakerNestedSandbox?: boolean;
	};
	const extResult = result as { ignoreViolations?: Record<string, string[]>; enableWeakerNestedSandbox?: boolean };

	if (extOverrides.ignoreViolations) {
		extResult.ignoreViolations = extOverrides.ignoreViolations;
	}
	if (extOverrides.enableWeakerNestedSandbox !== undefined) {
		extResult.enableWeakerNestedSandbox = extOverrides.enableWeakerNestedSandbox;
	}

	return result;
}

function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}

			const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

			return new Promise((resolve, reject) => {
				let mountPointsCleaned = false;
				const cleanupMountPoints = () => {
					if (mountPointsCleaned) return;
					mountPointsCleaned = true;
					try {
						// Linux bwrap creates host mount-point placeholders for absent deny paths.
						SandboxManager.cleanupAfterCommand();
					} catch {
						// Cleanup must not obscure the command result.
					}
				};

				const child = spawn("bash", ["-c", wrappedCommand], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								child.kill("SIGKILL");
							}
						}
					}, timeout * 1000);
				}

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					cleanupMountPoints();
					reject(err);
				});

				const onAbort = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};

				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);
					cleanupMountPoints();

					if (signal?.aborted) {
						reject(new Error("aborted"));
					} else if (timedOut) {
						reject(new Error(`timeout:${timeout}`));
					} else {
						resolve({ exitCode: code });
					}
				});
			});
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for bash commands",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	let sandboxEnabled = false;
	let sandboxInitialized = false;

	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			if (!sandboxEnabled || !sandboxInitialized) {
				return localBash.execute(id, params, signal, onUpdate);
			}

			const sandboxedBash = createBashTool(localCwd, {
				operations: createSandboxedBashOps(),
			});
			return sandboxedBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", () => {
		if (!sandboxEnabled || !sandboxInitialized) return;
		return { operations: createSandboxedBashOps() };
	});

	pi.on("session_start", async (_event, ctx) => {
		// Extension UI is recreated on session replacement, but explicitly clear this
		// so configuration changes also remove a warning during reload.
		ctx.ui.setWidget(SANDBOX_SYMLINK_WIDGET_KEY, undefined);

		const noSandbox = pi.getFlag("no-sandbox") as boolean;

		if (noSandbox) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		const config = loadConfig(ctx.cwd);

		if (!config.enabled) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via config", "info");
			return;
		}

		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			sandboxEnabled = false;
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
					ctx.ui.setWidget(SANDBOX_SYMLINK_WIDGET_KEY, formatFilesystemSymlinkWidget(symlinkWarnings));
				} else if (ctx.hasUI) {
					// RPC clients receive notifications but may not render TUI widgets.
					ctx.ui.notify(formatFilesystemSymlinkWarning(symlinkWarnings), "warning");
				}
			}
		}

		try {
			const configExt = config as unknown as {
				ignoreViolations?: Record<string, string[]>;
				enableWeakerNestedSandbox?: boolean;
			};

			await SandboxManager.initialize({
				network: config.network,
				filesystem: config.filesystem,
				ignoreViolations: configExt.ignoreViolations,
				enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
			});

			sandboxEnabled = true;
			sandboxInitialized = true;

			const networkCount = config.network?.allowedDomains?.length ?? 0;
			const writeCount = config.filesystem?.allowWrite?.length ?? 0;
			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`),
			);
			ctx.ui.notify("Sandbox initialized", "info");
		} catch (err) {
			sandboxEnabled = false;
			ctx.ui.notify(`Sandbox initialization failed: ${err instanceof Error ? err.message : err}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		if (sandboxInitialized) {
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	pi.registerCommand("sandbox", {
		description: "Show sandbox configuration",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const lines = [
				"Sandbox Configuration:",
				`  Status: ${sandboxEnabled && sandboxInitialized ? "initialized" : "disabled or not initialized"}`,
				"",
				"Network:",
				`  Allowed: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
				`  Denied: ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
				"",
				"Filesystem:",
				`  Deny Read: ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
				`  Allow Read: ${config.filesystem?.allowRead?.join(", ") || "(none)"}`,
				`  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
				`  Deny Write: ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
			];

			const symlinkWarnings = process.platform === "linux"
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
