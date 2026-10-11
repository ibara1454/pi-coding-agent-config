import { isObjectRecord } from "./guards.ts";
import type { GitState } from "./types.ts";

const GIT_TTL_MS = 1000;
const COMMAND_TIMEOUT_MS = 2000;

type GitSnapshot = Readonly<Omit<GitState, "pr">> & {
  readonly pr: Readonly<NonNullable<GitState["pr"]>> | null;
};

interface GitContext {
  readonly owner: unknown;
  readonly cwd: string;
}

interface GitEffects {
  readonly now: () => number;
  readonly exec: (
    command: string,
    args: string[],
    options: { cwd: string; timeout: number; signal: AbortSignal },
  ) => Promise<{ code: number; stdout: string }>;
  readonly readContext: () => GitContext | null;
  readonly readBranch: () => string | null;
  readonly changed: () => void;
}

/**
 * Creates empty owned state without sharing mutable data between sessions.
 * @returns A fresh snapshot with no branch, counts, or pull request; no effects.
 * @example emptyGitState().staged === 0
 */
function emptyGitState(): GitSnapshot {
  return { branch: null, staged: 0, unstaged: 0, untracked: 0, pr: null };
}

/**
 * Counts porcelain-v1 index, working-tree, and untracked entries independently.
 * @param output Git status stdout; short/empty lines are ignored.
 * @returns Counts only, without changing state or performing effects.
 * @example parseGitChanges("M  staged\n M unstaged\n?? new\n"); // One of each.
 */
function parseGitChanges(
  output: string,
): Pick<GitState, "staged" | "unstaged" | "untracked"> {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of output.split("\n")) {
    if (line.length < 2) {
      continue;
    }
    const [x, y] = line;
    if (x === "?" && y === "?") {
      untracked++;
      continue;
    }
    if (x !== " " && x !== "?") {
      staged++;
    }
    if (y !== " " && y !== "?") {
      unstaged++;
    }
  }
  return { staged, unstaged, untracked };
}

/**
 * Owns Git/PR snapshots, throttling, commands, and cancellation across sessions.
 * Git requires the original context owner; PR also requires its cwd/branch key.
 * Snapshots are replaced, not mutated. Optional PR lookup never delays Git.
 * @param effects Data-only context, lazy branch reads, clock, commands, and notification.
 * Effects stay caller-owned; creating this owner acquires no command resources.
 * @returns Reusable owner; dispose aborts its commands and reset clears its values
 * without aborting in-flight work. The host must replace context ownership at session start.
 * @example const status = createGitStatus(effects); await status.refresh(true);
 */
export function createGitStatus(effects: GitEffects) {
  let snapshot = emptyGitState();
  let lastFetch = 0;
  let gitController: AbortController | null = null;
  let prController: AbortController | null = null;
  let prBranchKey: string | null = null;

  /**
   * Checks opaque context identity without treating an absent host as an owner.
   * @param context Data captured before command execution; never mutated.
   * @returns Whether the original context still owns the command result.
   * @example ownsContext(context); // False after the host releases context.
   */
  function ownsContext(context: GitContext): boolean {
    const current = effects.readContext();
    return current !== null && current.owner === context.owner;
  }

  /**
   * Cancels the owned PR command without changing the cache or notifying the host.
   * @example cancelPr(); // A late completion cannot publish or notify.
   */
  function cancelPr(): void {
    prController?.abort();
    prController = null;
  }

  /**
   * Looks up optional PR data once per cwd/branch without delaying Git completion.
   * Detached/missing branches hide PR data. Command and JSON failures clear PR
   * only while the command, context owner, and cache key still belong to this lookup.
   * @param branch Branch observed lazily after Git status completed.
   * @returns Optional lookup completion; command/JSON failures are absorbed.
   * @example await refreshPr("main"); // Queries gh once for this cwd/branch.
   */
  async function refreshPr(branch: string | null): Promise<void> {
    const context = effects.readContext();
    if (!(context && branch) || branch === "detached" || prController) {
      if (!branch || branch === "detached") {
        snapshot = { ...snapshot, pr: null };
      }
      return;
    }
    const key = `${context.cwd}\0${branch}`;
    if (prBranchKey === key) {
      return;
    }
    prBranchKey = key;
    const controller = new AbortController();
    prController = controller;
    try {
      const result = await effects.exec(
        "gh",
        ["pr", "view", "--json", "number,url"],
        {
          cwd: context.cwd,
          timeout: COMMAND_TIMEOUT_MS,
          signal: controller.signal,
        },
      );
      if (
        prController !== controller ||
        !ownsContext(context) ||
        prBranchKey !== key
      ) {
        return;
      }
      let pr: GitSnapshot["pr"] = null;
      if (result.code === 0) {
        const parsed: unknown = JSON.parse(result.stdout);
        if (isObjectRecord(parsed)) {
          const { number, url } = parsed;
          if (typeof number === "number" && typeof url === "string") {
            pr = { number, url };
          }
        }
      }
      snapshot = { ...snapshot, pr };
    } catch {
      if (
        prController === controller &&
        ownsContext(context) &&
        prBranchKey === key
      ) {
        snapshot = { ...snapshot, pr: null };
      }
    } finally {
      if (prController === controller) {
        prController = null;
        effects.changed();
      }
    }
  }

  /**
   * Refreshes counts at most once per 1000 ms, never duplicating in-flight Git.
   * Nonzero exits clear state; rejected commands retain state and throttle retries.
   * Completion observes the branch lazily and starts PR lookup nonblocking.
   * @param force Bypasses the TTL only, not the in-flight guard or PR cache.
   * @returns Git completion; optional command failures are absorbed.
   * @example await status.refresh(true); // PR may still be pending afterward.
   */
  async function refresh(force = false): Promise<void> {
    const context = effects.readContext();
    if (
      !context ||
      gitController ||
      (!force && effects.now() - lastFetch < GIT_TTL_MS)
    ) {
      return;
    }
    const controller = new AbortController();
    gitController = controller;
    try {
      const result = await effects.exec(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        {
          cwd: context.cwd,
          timeout: COMMAND_TIMEOUT_MS,
          signal: controller.signal,
        },
      );
      if (gitController !== controller || !ownsContext(context)) {
        return;
      }
      if (result.code !== 0) {
        snapshot = emptyGitState();
        prBranchKey = null;
      } else {
        const changes = parseGitChanges(result.stdout);
        const branch = effects.readBranch() ?? snapshot.branch;
        const branchChanged = branch !== snapshot.branch;
        snapshot = {
          ...snapshot,
          branch,
          ...changes,
          pr: branchChanged ? null : snapshot.pr,
        };
        if (branchChanged) {
          prBranchKey = null;
        }
        // biome-ignore lint/complexity/noVoid: PR errors are absorbed and must not delay Git.
        void refreshPr(branch);
      }
      lastFetch = effects.now();
    } catch {
      if (gitController === controller) {
        lastFetch = effects.now();
      }
    } finally {
      if (gitController === controller) {
        gitController = null;
        effects.changed();
      }
    }
  }

  /**
   * Invalidates the cache/resources selected by the host transition.
   * @param reason Working-tree resets Git TTL only; branch also clears the PR
   * cache and aborts PR. Pending-PR cancellation preserves both caches.
   * @example status.invalidate("branch"); await status.refresh(true);
   */
  function invalidate(reason: "working-tree" | "branch" | "pending-pr"): void {
    if (reason !== "pending-pr") {
      lastFetch = 0;
    }
    if (reason === "branch") {
      prBranchKey = null;
    }
    if (reason !== "working-tree") {
      cancelPr();
    }
  }

  /**
   * Resets snapshots and caches without cancelling in-flight commands.
   * The host must replace context ownership to reject previous-session results.
   * @example status.reset(); // Retains existing in-flight guards.
   */
  function reset(): void {
    snapshot = emptyGitState();
    lastFetch = 0;
    prBranchKey = null;
  }

  /**
   * Aborts owned commands and discards late completions without changing state.
   * Idempotent; the owner remains reusable for the next host session.
   * @example status.dispose(); // Host also releases context before reuse.
   */
  function dispose(): void {
    gitController?.abort();
    gitController = null;
    cancelPr();
  }

  return {
    /**
     * Reads the deeply readonly snapshot without copying or effects.
     * @returns Owned state; earlier snapshots remain unchanged after refresh.
     * @example status.snapshot.pr?.number; // Cached PR number or undefined.
     */
    get snapshot(): GitSnapshot {
      return snapshot;
    },
    refresh,
    invalidate,
    reset,
    dispose,
  };
}
