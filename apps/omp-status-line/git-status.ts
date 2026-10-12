import { isObjectRecord } from "./guards.ts";
import type { GitState } from "./types.ts";

const GIT_TTL_MS = 1000;
const COMMAND_TIMEOUT_MS = 2000;

type GitSnapshot = Readonly<Omit<GitState, "pr">> & {
  readonly pr: Readonly<NonNullable<GitState["pr"]>> | undefined;
};

interface GitContext {
  readonly owner: unknown;
  readonly cwd: string;
}

interface GitEffects {
  readonly exec: (
    command: string,
    args: string[],
    options: { cwd: string; timeout: number; signal: AbortSignal },
  ) => Promise<{ code: number; stdout: string }>;
  readonly readContext: () => GitContext | undefined;
  readonly readBranch: () => string | undefined;
  readonly changed: () => void;
}

/**
 * Creates empty owned state without sharing mutable data between sessions.
 * @returns A fresh snapshot with undefined branch/PR and zero counts; no effects.
 * @example emptyGitState().staged === 0
 */
function emptyGitState(): GitSnapshot {
  return {
    branch: undefined,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    pr: undefined,
  };
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
 * Lifecycle calls must be serial; synchronous refresh signals never launch work.
 * @param effects Caller-owned context/branch reads, commands, and notifications.
 * @returns An owner whose start clears caches and whose stop joins both workers,
 * even when an external command ignores abort. Earlier snapshots stay unchanged.
 * @example await status.start(); status.requestRefresh(); await status.stop();
 */
export function createGitStatus(effects: GitEffects) {
  let snapshot = emptyGitState();
  interface PrRequest {
    context: GitContext;
    key: string;
  }
  interface Session {
    active: boolean;
    requested: boolean;
    forced: boolean;
    lastFetch: number;
    gitController?: AbortController | undefined;
    prController?: AbortController | undefined;
    prKey?: string | undefined;
    prContext?: GitContext | undefined;
    prRequest?: PrRequest | undefined;
    wakeGit?: (() => void) | undefined;
    wakePr?: (() => void) | undefined;
    workers: Promise<void>[];
  }
  let session: Session | undefined;

  /**
   * Treats a failing host context provider as unavailable, retaining cached state.
   * @returns Current owner/cwd, or undefined on absence or provider failure.
   * @example readContext(); // Undefined after host release or a failed host read.
   */
  function readContext(): GitContext | undefined {
    try {
      return effects.readContext();
    } catch {
      return undefined;
    }
  }

  /**
   * Reads the host branch without sacrificing Git counts if its provider fails.
   * @returns Observed branch, falling back to the cached branch on absence/failure.
   * @example readBranch(); // Retains "main" if its provider is unavailable.
   */
  function readBranch(): string | undefined {
    try {
      return effects.readBranch() ?? snapshot.branch;
    } catch {
      return snapshot.branch;
    }
  }

  /**
   * Notifies the host without allowing a failed UI callback to kill either worker.
   * Cache updates remain usable and later refresh signals still progress.
   * @example notifyChanged(); // A throwing host observer does not reject work.
   */
  function notifyChanged(): void {
    try {
      effects.changed();
    } catch {
      // Optional host rendering must not break ownership or future refreshes.
    }
  }

  /**
   * Ends a lifetime synchronously before joining it, including on worker failure.
   * @param state Session whose commands and sleeping workers must be released.
   * @example cancelSession(state); // Late command completions cannot publish.
   */
  function cancelSession(state: Session): void {
    state.active = false;
    state.gitController?.abort();
    state.prController?.abort();
    state.wakeGit?.();
    state.wakePr?.();
  }

  /**
   * Rejects results from a replaced context or changed working directory.
   * @param context Captured command owner and cwd; never mutated.
   * @returns Whether both still match the active host context.
   * @example ownsContext(context); // False after the host releases context.
   */
  function ownsContext(context: GitContext): boolean {
    const current = readContext();
    return (
      current !== undefined &&
      current.owner === context.owner &&
      current.cwd === context.cwd
    );
  }

  /**
   * Waits for a command or cancellation and consumes even a late rejection.
   * @param command External executable; args and context select its request.
   * @param controller Worker-owned cancellation, with listeners released here.
   * @returns Undefined for rejection/cancellation; the worker owns state policy.
   * @example await execute("git", args, context, controller);
   */
  async function execute(
    command: string,
    args: string[],
    context: GitContext,
    controller: AbortController,
  ): Promise<{ code: number; stdout: string } | undefined> {
    const { promise: cancelled, resolve } = Promise.withResolvers<undefined>();
    const abort = () => resolve(undefined);
    controller.signal.addEventListener("abort", abort, { once: true });
    try {
      return await Promise.race([
        effects.exec(command, args, {
          cwd: context.cwd,
          timeout: COMMAND_TIMEOUT_MS,
          signal: controller.signal,
        }),
        cancelled,
      ]);
    } catch {
      return undefined;
    } finally {
      controller.signal.removeEventListener("abort", abort);
    }
  }

  /**
   * Signals the PR worker, replacing stale branch/context work without waiting.
   * Missing/detached branches hide PR; cached owner/cwd/branch keys do no work.
   * @param state Session owning its PR cache, queued request, and controller.
   * @param context Captured command owner/cwd; stale completions are rejected.
   * @param branch Branch observed by the Git worker, or undefined if unavailable.
   * @example requestPr(state, context, "main"); // Cached keys do not query again.
   */
  function requestPr(
    state: Session,
    context: GitContext,
    branch: string | undefined,
  ): void {
    const key =
      branch && branch !== "detached" ? `${context.cwd}\0${branch}` : undefined;
    if (
      state.prKey === key &&
      state.prContext !== undefined &&
      state.prContext.owner === context.owner &&
      state.prContext.cwd === context.cwd
    ) {
      return;
    }
    state.prController?.abort();
    state.prRequest = undefined;
    state.prKey = key;
    state.prContext = context;
    snapshot = { ...snapshot, pr: undefined };
    if (key && branch) {
      state.prRequest = { context, key };
      state.wakePr?.();
    }
  }

  /**
   * Serializes queued Git requests; forced invalidations survive pending work.
   * @returns Session completion, with Git failures absorbed by cache policy.
   * @example state.workers = [runGit(state), runPr(state)];
   */
  async function runGit(state: Session): Promise<void> {
    while (state.active) {
      if (!state.requested) {
        const { promise, resolve } = Promise.withResolvers<void>();
        state.wakeGit = resolve;
        await promise;
        state.wakeGit = undefined;
        continue;
      }
      const force = state.forced;
      state.requested = false;
      state.forced = false;
      const context = readContext();
      if (!context || (!force && Date.now() - state.lastFetch < GIT_TTL_MS)) {
        continue;
      }
      const controller = new AbortController();
      state.gitController = controller;
      const result = await execute(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        context,
        controller,
      );
      state.gitController = undefined;
      if (!state.active || controller.signal.aborted) {
        continue;
      }
      const owned = ownsContext(context);
      if (!result) {
        // Rejected Git retains counts and throttles retries.
        if (owned) {
          const branch = readBranch();
          if (branch !== snapshot.branch) {
            state.prController?.abort();
            state.prRequest = undefined;
            state.prKey = undefined;
            state.prContext = undefined;
            snapshot = { ...snapshot, branch, pr: undefined };
          }
        }
        state.lastFetch = Date.now();
      } else if (owned) {
        if (result.code !== 0) {
          const branch = readBranch();
          snapshot = { ...emptyGitState(), branch };
          state.prController?.abort();
          state.prRequest = undefined;
          state.prKey = undefined;
          state.prContext = undefined;
        } else {
          const branch = readBranch();
          snapshot = { ...snapshot, branch, ...parseGitChanges(result.stdout) };
          requestPr(state, context, branch);
        }
        state.lastFetch = Date.now();
      }
      notifyChanged();
    }
  }

  /**
   * Runs optional PR work independently of Git, publishing only owned results.
   * @returns Session completion; unavailable/malformed PR data stays hidden.
   * @example state.workers = [runGit(state), runPr(state)];
   */
  async function runPr(state: Session): Promise<void> {
    while (state.active) {
      if (!state.prRequest) {
        const { promise, resolve } = Promise.withResolvers<void>();
        state.wakePr = resolve;
        await promise;
        state.wakePr = undefined;
        continue;
      }
      const { context, key } = state.prRequest;
      state.prRequest = undefined;
      const controller = new AbortController();
      state.prController = controller;
      const result = await execute(
        "gh",
        ["pr", "view", "--json", "number,url"],
        context,
        controller,
      );
      state.prController = undefined;
      if (!state.active || controller.signal.aborted) {
        continue;
      }
      if (ownsContext(context) && state.prKey === key) {
        let pr: GitSnapshot["pr"];
        try {
          const parsed: unknown =
            result?.code === 0 ? JSON.parse(result.stdout) : undefined;
          if (isObjectRecord(parsed)) {
            const { number, url } = parsed;
            if (typeof number === "number" && typeof url === "string") {
              pr = { number, url };
            }
          }
        } catch {
          // Optional gh output may be malformed; Git remains usable.
        }
        snapshot = { ...snapshot, pr };
      }
      notifyChanged();
    }
  }

  /**
   * Clears cached state and starts sleeping workers after joining the old lifetime.
   * Unexpected worker failures cancel the lifetime, retaining cached display values
   * until a later start replaces it; optional status errors never reject shutdown.
   * @returns Setup completion only; no Git/gh command is requested by startup.
   * @example await status.start(); status.requestRefresh();
   */
  async function start(): Promise<void> {
    await stop();
    snapshot = emptyGitState();
    const state: Session = {
      active: true,
      requested: false,
      forced: false,
      lastFetch: 0,
      workers: [],
    };
    session = state;
    /**
     * Ends this lifetime if either worker fails, retaining its cached snapshot.
     * @example cancelWorkers(); // Abort both commands and wake both workers.
     */
    const cancelWorkers = (): void => cancelSession(state);
    state.workers = [
      runGit(state).catch(cancelWorkers),
      runPr(state).catch(cancelWorkers),
    ];
  }

  /**
   * Coalesces a normal TTL-bound request by waking the existing Git worker.
   * Stopped owners ignore signals; this operation launches no asynchronous work.
   * @example status.requestRefresh(); // Returns before any command starts.
   */
  function requestRefresh(): void {
    if (session?.active) {
      session.requested = true;
      session.wakeGit?.();
    }
  }

  /**
   * Invalidates selected PR state and queues a forced Git refresh synchronously.
   * @param reason Branch clears PR/key; pending-pr aborts PR but preserves its
   * key; working-tree preserves PR. Every reason bypasses the Git TTL.
   * @example status.invalidate("working-tree"); // No separate refresh call needed.
   */
  function invalidate(reason: "working-tree" | "branch" | "pending-pr"): void {
    if (!session?.active) {
      return;
    }
    if (reason !== "working-tree") {
      session.prController?.abort();
      session.prRequest = undefined;
    }
    if (reason === "branch") {
      session.prKey = undefined;
      session.prContext = undefined;
      snapshot = { ...snapshot, pr: undefined };
    }
    session.requested = true;
    session.forced = true;
    session.wakeGit?.();
  }

  /**
   * Aborts commands, wakes and joins workers, and releases the session.
   * Idempotent; ignored aborts cannot hold shutdown open or publish late results.
   * @example await status.stop(); status.requestRefresh(); // No commands.
   */
  async function stop(): Promise<void> {
    const state = session;
    if (!state) {
      return;
    }
    cancelSession(state);
    await Promise.all(state.workers);
    if (session === state) {
      session = undefined;
    }
  }

  return {
    /**
     * Reads cached readonly values without copying, commands, or notifications.
     * @returns Owned state; earlier snapshots remain stable after updates.
     * @example status.snapshot.pr?.number; // Cached PR number or undefined.
     */
    get snapshot(): GitSnapshot {
      return snapshot;
    },
    start,
    requestRefresh,
    invalidate,
    stop,
  };
}
