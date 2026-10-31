import { EventEmitter } from "node:events";
import { isObjectRecord } from "../guards.ts";
import type { GitState } from "../rendering/types.ts";

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
 * Calculates failed Git publication without changing the current cache.
 * @param current Owner's snapshot after PR cancellation effects have finished.
 * @param branch Latest host branch, including undefined when unavailable.
 * @param completed Whether Git returned a nonzero exit rather than rejecting.
 * @returns Fresh snapshot with PR cleared; rejected commands preserve counts.
 * @example gitSnapshotAfterFailure(emptyGitState(), "main", false); // Branch main, zero counts, no PR.
 */
function gitSnapshotAfterFailure(
  current: GitSnapshot,
  branch: string | undefined,
  completed: boolean,
): GitSnapshot {
  if (completed) {
    return { ...emptyGitState(), branch };
  }
  return { ...current, branch, pr: undefined };
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
 * Reads optional gh output without letting malformed JSON hide Git status.
 * @param result Completed command, or undefined after rejection/cancellation.
 * @returns Number/URL fields when both have the expected types; otherwise undefined.
 * @example parsePullRequest({ code: 0, stdout: '{"number":42,"url":"https://example.com/42"}' }); // PR 42.
 */
function parsePullRequest(
  result: { code: number; stdout: string } | undefined,
): GitSnapshot["pr"] {
  try {
    const parsed: unknown =
      result?.code === 0 ? JSON.parse(result.stdout) : undefined;
    if (!isObjectRecord(parsed)) {
      return undefined;
    }
    const { number, url } = parsed;
    return typeof number === "number" && typeof url === "string"
      ? { number, url }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Owns Git/PR snapshots, throttling, commands, and cancellation across sessions.
 * Lifecycle calls must be serial; synchronous refresh signals never launch work.
 * @param effects Caller-owned context/branch reads, commands, and notifications.
 * @returns An owner whose start clears caches and whose stop joins current jobs,
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
    events: EventEmitter;
    gitImmediate?: NodeJS.Immediate | undefined;
    prImmediate?: NodeJS.Immediate | undefined;
    gitJob?: Promise<void> | undefined;
    prJob?: Promise<void> | undefined;
    gitController?: AbortController | undefined;
    prController?: AbortController | undefined;
    prKey?: string | undefined;
    prContext?: GitContext | undefined;
    prRequest?: PrRequest | undefined;
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
   * Notifies the host without allowing a failed UI callback to kill a job.
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
   * Ends a lifetime synchronously before joining it, including on job failure.
   * @param state Session whose queued events and commands must be cancelled.
   * @example cancelSession(state); // Late command completions cannot publish.
   */
  function cancelSession(state: Session): void {
    state.active = false;
    state.requested = false;
    state.forced = false;
    state.prRequest = undefined;
    clearImmediate(state.gitImmediate);
    clearImmediate(state.prImmediate);
    state.gitImmediate = undefined;
    state.prImmediate = undefined;
    state.gitController?.abort();
    state.prController?.abort();
  }

  /**
   * Queues one native Git dispatch only for an outstanding, unowned request.
   * @param state Session owning the cancellable event-loop handle.
   * @example scheduleGit(state); // Bursts share one queued dispatch.
   */
  function scheduleGit(state: Session): void {
    if (
      !(state.active && state.requested) ||
      state.gitJob ||
      state.gitImmediate
    ) {
      return;
    }
    state.gitImmediate = setImmediate(() => {
      state.gitImmediate = undefined;
      if (state.active && state.requested && !state.gitJob) {
        state.events.emit("git", state);
      }
    });
  }

  /**
   * Queues independent PR dispatch only for an outstanding, unowned lookup.
   * @param state Session owning the cancellable event-loop handle.
   * @example schedulePr(state); // A running Git job does not delay PR dispatch.
   */
  function schedulePr(state: Session): void {
    if (
      !(state.active && state.prRequest) ||
      state.prJob ||
      state.prImmediate
    ) {
      return;
    }
    state.prImmediate = setImmediate(() => {
      state.prImmediate = undefined;
      if (state.active && state.prRequest && !state.prJob) {
        state.events.emit("pr", state);
      }
    });
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
   * Runs a host command with a two-second timeout, racing completion against cancellation.
   * @param command External executable run through the host's command provider.
   * @param args Command arguments, passed unchanged to the provider.
   * @param context Captured host identity and cwd selecting the command directory.
   * @param controller Job-owned cancellation; only this operation's abort listener is released here.
   * @returns Completed exit code/stdout, or undefined for rejection/cancellation;
   * late rejections are consumed and the job owns cache policy.
   * @example await execute("git", args, context, controller);
   */
  async function execute(
    command: string,
    args: string[],
    context: GitContext,
    controller: AbortController,
  ): Promise<{ code: number; stdout: string } | undefined> {
    if (controller.signal.aborted) {
      return undefined;
    }
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
   * Queues PR dispatch, replacing stale branch/context work without waiting.
   * Missing/detached branches hide PR; cached owner/cwd/branch keys do no work.
   * @param state Session owning its PR cache, queued request, and controller.
   * @param context Captured command owner/cwd; stale completions are rejected.
   * @param branch Branch observed by the Git job, or undefined if unavailable.
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
    if (!state.active) {
      return;
    }
    state.prRequest = undefined;
    clearImmediate(state.prImmediate);
    state.prImmediate = undefined;
    state.prKey = key;
    state.prContext = context;
    snapshot = { ...snapshot, pr: undefined };
    if (key && branch) {
      state.prRequest = { context, key };
      schedulePr(state);
    }
  }

  /**
   * Reads job ownership with cancellation checks around the host context callback.
   * @param state Session owning the in-flight command; only read here.
   * @param context Command's captured host identity and working directory.
   * @param controller Job-owned cancellation checked before and after the host read.
   * @returns Undefined when cancelled, otherwise whether the context still matches.
   * @example readJobOwnership(state, context, controller); // False for a replaced host.
   */
  function readJobOwnership(
    state: Readonly<Session>,
    context: GitContext,
    controller: AbortController,
  ): boolean | undefined {
    if (!state.active || controller.signal.aborted) {
      return undefined;
    }
    const owned = ownsContext(context);
    if (!state.active || controller.signal.aborted) {
      return undefined;
    }
    return owned;
  }

  /**
   * Reads host ownership and calculates Git publication policy without changing state.
   * Host reads may reenter the owner; cancellation is checked around those effects.
   * @param state Session whose activity is read, never changed.
   * @param context Command's captured host identity and working directory.
   * @param controller Job-owned cancellation, read before and after host callbacks.
   * @param result Command outcome; rejection retains counts, while nonzero exits clear them.
   * @returns Undefined after cancellation; otherwise the owner's publication decision.
   * Clear decisions contain no snapshot: the owner must use its current cache after PR abort effects.
   * Unexpected calculation errors propagate to the owning job.
   * @example readGitPublication(state, context, controller, undefined); // Retains counts for an unchanged branch.
   */
  function readGitPublication(
    state: Readonly<Session>,
    context: GitContext,
    controller: AbortController,
    result: { code: number; stdout: string } | undefined,
  ):
    | { kind: "unowned" }
    | {
        kind: "refresh-pr";
        branch: string | undefined;
        changes: Pick<GitState, "staged" | "unstaged" | "untracked">;
      }
    | { kind: "clear-pr" | "retain"; branch: string | undefined }
    | undefined {
    const owned = readJobOwnership(state, context, controller);
    if (owned === undefined) {
      return undefined;
    }
    if (!owned) {
      return { kind: "unowned" };
    }
    const branch = readBranch();
    if (!state.active || controller.signal.aborted) {
      return undefined;
    }
    if (result?.code === 0) {
      return {
        kind: "refresh-pr",
        branch,
        changes: parseGitChanges(result.stdout),
      };
    }
    return {
      kind: result || branch !== snapshot.branch ? "clear-pr" : "retain",
      branch,
    };
  }

  /**
   * Reads the context eligible for a consumed Git request without changing state.
   * Host reads may reenter the owner; activity is checked after the callback.
   * @param state Job-owning session; activity and last-fetch timestamp are read only.
   * @param force Captured request flag that bypasses the one-second cache TTL.
   * @returns Current host context, or undefined when stopped, unavailable, or throttled.
   * Host context failures are treated as unavailable; no command is launched here.
   * @example readGitRequestContext(state, true); // Current context even within the TTL.
   */
  function readGitRequestContext(
    state: Readonly<Session>,
    force: boolean,
  ): GitContext | undefined {
    const context = readContext();
    if (
      !(state.active && context) ||
      (!force && Date.now() - state.lastFetch < GIT_TTL_MS)
    ) {
      return undefined;
    }
    return context;
  }

  /**
   * Owns one Git request's consumption, publication, PR invalidation, and cleanup.
   * Registers joinable work before host effects; forced arrivals stay queued.
   * @param state Active session delivered by its private emitter; this job owns
   * its request flags, command/controller, retry timestamp, and published cache updates.
   * @returns Completion after the one-second TTL skip or publication, followed by
   * controller/job release and rescheduling. Unexpected failures cancel the session.
   * @example state.events.emit("git", state); // At most one Git command.
   */
  async function runGit(state: Session): Promise<void> {
    if (!state.active || state.gitJob || !state.requested) {
      return;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    state.gitJob = promise;
    const controller = new AbortController();
    state.gitController = controller;
    try {
      const force = state.forced;
      state.requested = false;
      state.forced = false;
      const context = readGitRequestContext(state, force);
      if (!context) {
        return;
      }
      const result = await execute(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        context,
        controller,
      );
      const publication = readGitPublication(
        state,
        context,
        controller,
        result,
      );
      if (!publication) {
        return;
      }
      if (publication.kind === "unowned") {
        // Rejected Git retains retry throttling after a context replacement.
        if (!result) {
          state.lastFetch = Date.now();
        }
        notifyChanged();
        return;
      }
      const { branch } = publication;
      if (publication.kind === "refresh-pr") {
        snapshot = { ...snapshot, branch, ...publication.changes };
        requestPr(state, context, branch);
      } else if (publication.kind === "clear-pr") {
        state.prController?.abort();
        state.prRequest = undefined;
        clearImmediate(state.prImmediate);
        state.prImmediate = undefined;
        state.prKey = undefined;
        state.prContext = undefined;
        if (!state.active) {
          return;
        }
        // Read the current cache only after potentially reentrant abort effects.
        snapshot = gitSnapshotAfterFailure(
          snapshot,
          branch,
          result !== undefined,
        );
      }
      state.lastFetch = Date.now();
      if (state.active && !controller.signal.aborted) {
        notifyChanged();
      }
    } catch {
      // Own unexpected handler errors before its joinable completion settles.
      cancelSession(state);
    } finally {
      state.gitController = undefined;
      state.gitJob = undefined;
      resolve();
      scheduleGit(state);
    }
  }

  /**
   * Handles one optional PR lookup independently of Git and rejects stale data.
   * Records joinable ownership before commands, host reads, or notifications.
   * @param state Active session delivered by its private native event emitter.
   * @returns This lookup's completion; unavailable or malformed PR stays hidden.
   * @example state.events.emit("pr", state); // At most one gh command.
   */
  async function runPr(state: Session): Promise<void> {
    if (!state.active || state.prJob || !state.prRequest) {
      return;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    state.prJob = promise;
    const controller = new AbortController();
    state.prController = controller;
    try {
      const { context, key } = state.prRequest;
      state.prRequest = undefined;
      const result = await execute(
        "gh",
        ["pr", "view", "--json", "number,url"],
        context,
        controller,
      );
      const owned = readJobOwnership(state, context, controller);
      if (owned === undefined) {
        return;
      }
      if (owned && state.prKey === key) {
        const pr = parsePullRequest(result);
        snapshot = { ...snapshot, pr };
      }
      notifyChanged();
    } catch {
      cancelSession(state);
    } finally {
      state.prController = undefined;
      state.prJob = undefined;
      resolve();
      schedulePr(state);
    }
  }

  /**
   * Clears cached state and installs native dispatch after joining the old lifetime.
   * Unexpected job failures cancel the lifetime, retaining cached display values
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
      events: new EventEmitter({ captureRejections: true }),
    };
    session = state;
    state.events.on("git", runGit);
    state.events.on("pr", runPr);
    // Handlers own failures before completing; native rejection capture is a guard.
    state.events.on("error", () => cancelSession(state));
  }

  /**
   * Coalesces a normal TTL-bound request into cancellable native dispatch.
   * Stopped owners ignore signals; this operation launches no asynchronous work.
   * @example status.requestRefresh(); // Returns before any command starts.
   */
  function requestRefresh(): void {
    if (session?.active) {
      session.requested = true;
      scheduleGit(session);
    }
  }

  /**
   * Invalidates selected PR state and queues a forced Git refresh synchronously.
   * @param reason Branch clears PR/key; pending-pr aborts PR but preserves its
   * key; working-tree preserves PR. Every reason bypasses the Git TTL.
   * @example status.invalidate("working-tree"); // No separate refresh call needed.
   */
  function invalidate(reason: "working-tree" | "branch" | "pending-pr"): void {
    const state = session;
    if (!state?.active) {
      return;
    }
    if (reason !== "working-tree") {
      state.prController?.abort();
      if (!state.active) {
        return;
      }
      state.prRequest = undefined;
      clearImmediate(state.prImmediate);
      state.prImmediate = undefined;
    }
    if (reason === "branch") {
      state.prKey = undefined;
      state.prContext = undefined;
      snapshot = { ...snapshot, pr: undefined };
    }
    state.requested = true;
    state.forced = true;
    scheduleGit(state);
  }

  /**
   * Cancels queued dispatch, aborts and joins current jobs, and releases listeners.
   * Idempotent; ignored aborts cannot hold shutdown open or publish late results.
   * @example await status.stop(); status.requestRefresh(); // No commands.
   */
  async function stop(): Promise<void> {
    const state = session;
    if (!state) {
      return;
    }
    cancelSession(state);
    await Promise.all([state.gitJob, state.prJob]);
    state.events.removeAllListeners();
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
