import { afterEach, describe, expect, spyOn, test } from "bun:test";
import process from "node:process";
import { createGitStatus } from "./git-status.ts";

const START_MS = 10_000;
const TTL_MS = 1000;
const COMMAND_TIMEOUT_MS = 2000;
const THIRD_GIT_FETCH = 3;
const FIRST_PR = { number: 42, url: "https://example.com/pr/42" };
const SECOND_PR = { number: 73, url: "https://example.com/pr/73" };
const EMPTY_SNAPSHOT = {
  branch: undefined,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  pr: undefined,
};

interface CommandResult {
  code: number;
  stdout: string;
}

interface CommandCall {
  command: string;
  args: string[];
  options: { cwd: string; timeout: number; signal: AbortSignal };
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
}

const owners: ReturnType<typeof createGitStatus>[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.stop()));
});

/**
 * Records real owner effects and waits only for test-owned observable latches.
 * Commands ignore abort deliberately so shutdown must own their cancellation.
 * @returns The public owner, controlled inputs, commands, and effect observations.
 * @example const fixture = createStatus(); await fixture.status.start();
 */
function createStatus() {
  const input: {
    now: number;
    context: { owner: symbol; cwd: string } | undefined;
    branch: string | undefined;
    contextReads: number;
    branchReads: number;
    changes: number;
  } = {
    now: START_MS,
    context: { owner: Symbol("session"), cwd: "/repo" },
    branch: "main",
    contextReads: 0,
    branchReads: 0,
    changes: 0,
  };
  const calls: CommandCall[] = [];
  const observers = new Set<() => void>();
  let contextRead: (() => void) | undefined;
  spyOn(Date, "now").mockImplementation(() => input.now);
  /** Delivers observations after each external effect; never runs owner work. */
  function notify(): void {
    for (const observer of observers) {
      observer();
    }
  }
  /**
   * Waits for a predicate over recorded external effects, including earlier effects.
   * @example await waitFor(() => input.changes === 1);
   */
  function waitFor(predicate: () => boolean): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const observer = () => {
      if (predicate()) {
        observers.delete(observer);
        resolve();
      }
    };
    observers.add(observer);
    observer();
    return promise;
  }
  /**
   * Observes the next host context read without depending on its call count.
   * @returns A test-owned latch; it neither requests nor drains production work.
   * @example const read = observeContextRead(); status.requestRefresh(); await read;
   */
  function observeContextRead(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    contextRead = resolve;
    return promise;
  }
  const status = createGitStatus({
    readContext: () => {
      input.contextReads++;
      contextRead?.();
      contextRead = undefined;
      notify();
      return input.context;
    },
    readBranch: () => {
      input.branchReads++;
      return input.branch;
    },
    changed: () => {
      input.changes++;
      notify();
    },
    exec: (executable, args, options) => {
      const { promise, resolve, reject } =
        Promise.withResolvers<CommandResult>();
      calls.push({ command: executable, args, options, resolve, reject });
      notify();
      return promise;
    },
  });
  owners.push(status);
  /**
   * Observes an actual command start without draining internal job queues.
   * @example const git = await command("git", 2);
   */
  async function command(name: string, occurrence = 1): Promise<CommandCall> {
    await waitFor(
      () =>
        calls.filter((entry) => entry.command === name).length >= occurrence,
    );
    const call = calls.filter((entry) => entry.command === name)[
      occurrence - 1
    ];
    if (!call) {
      throw new Error(`Missing observed ${name} command ${occurrence}`);
    }
    return call;
  }
  return { status, input, calls, waitFor, command, observeContextRead };
}

type Fixture = ReturnType<typeof createStatus>;

/**
 * Completes a recorded Git command and observes its production notification.
 * @example await finishGit(fixture, 2, " M changed\n");
 */
async function finishGit(
  fixture: Fixture,
  occurrence = 1,
  stdout = "M  staged\n",
  code = 0,
): Promise<CommandCall> {
  const call = await fixture.command("git", occurrence);
  const nextChange = fixture.input.changes + 1;
  call.resolve({ code, stdout });
  await fixture.waitFor(() => fixture.input.changes >= nextChange);
  return call;
}

/**
 * Completes a recorded PR command and observes its production notification.
 * @example await finishPr(fixture, 1, FIRST_PR);
 */
async function finishPr(
  fixture: Fixture,
  occurrence = 1,
  pr = FIRST_PR,
): Promise<CommandCall> {
  const call = await fixture.command("gh", occurrence);
  const nextChange = fixture.input.changes + 1;
  call.resolve({ code: 0, stdout: JSON.stringify(pr) });
  await fixture.waitFor(() => fixture.input.changes >= nextChange);
  return call;
}

/** Starts the public lifetime and observes the first Git and PR publications. */
async function startAndFetch(fixture: Fixture): Promise<void> {
  await fixture.status.start();
  fixture.status.requestRefresh();
  await finishGit(fixture);
  await finishPr(fixture);
}

describe("createGitStatus.start", () => {
  test("should clear values without starting commands when a lifetime starts", async () => {
    const fixture = createStatus();
    await startAndFetch(fixture);
    const previous = fixture.status.snapshot;
    await fixture.status.start();
    expect(fixture.status.snapshot).toEqual(EMPTY_SNAPSHOT);
    expect(previous.pr).toEqual(FIRST_PR);
    expect(fixture.calls).toHaveLength(2);
  });

  test("should discard queued refreshes when a session is replaced before Git starts", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    fixture.status.invalidate("working-tree");
    fixture.status.requestRefresh();
    expect(fixture.calls).toHaveLength(0);
    fixture.input.context = {
      owner: Symbol("replacement"),
      cwd: "/other-repo",
    };
    await fixture.status.start();
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.status.snapshot).toEqual(EMPTY_SNAPSHOT);
    fixture.status.requestRefresh();
    await finishGit(fixture, 1, " M current\n");
    await finishPr(fixture, 1, SECOND_PR);
    await fixture.status.stop();
    expect(fixture.calls).toHaveLength(2);
    expect(
      fixture.calls.every((call) => call.options.cwd === "/other-repo"),
    ).toBe(true);
    expect(fixture.status.snapshot.pr).toEqual(SECOND_PR);
    expect(fixture.status.snapshot.unstaged).toBe(1);
  });

  test("should discard queued PR lookup when a session is replaced after Git publication", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture);
    expect(fixture.calls.map((call) => call.command)).toEqual(["git"]);
    fixture.input.context = {
      owner: Symbol("replacement"),
      cwd: "/other-repo",
    };
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture, 2, " M current\n");
    await finishPr(fixture, 1, SECOND_PR);
    await fixture.status.stop();
    expect(fixture.calls.map((call) => call.command)).toEqual([
      "git",
      "git",
      "gh",
    ]);
    expect(fixture.calls.at(-1)?.options.cwd).toBe("/other-repo");
    expect(fixture.status.snapshot.pr).toEqual(SECOND_PR);
    expect(fixture.status.snapshot.unstaged).toBe(1);
  });

  test("should abort and join the old Git before accepting refreshes when a session is replaced", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    const oldGit = await fixture.command("git");
    fixture.status.invalidate("working-tree");
    fixture.status.invalidate("working-tree");
    fixture.status.requestRefresh();
    fixture.input.context = {
      owner: Symbol("replacement"),
      cwd: "/other-repo",
    };
    await fixture.status.start();
    expect(oldGit.options.signal.aborted).toBe(true);
    expect(fixture.status.snapshot).toEqual(EMPTY_SNAPSHOT);
    fixture.status.requestRefresh();
    const newGit = await fixture.command("git", 2);
    expect(newGit.options.cwd).toBe("/other-repo");
    oldGit.resolve({ code: 0, stdout: "MM old\n" });
    await finishGit(fixture, 2, " M current\n");
    await finishPr(fixture);
    await fixture.status.stop();
    expect(fixture.calls.filter((call) => call.command === "git")).toEqual([
      oldGit,
      newGit,
    ]);
    expect(fixture.status.snapshot).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "main",
      unstaged: 1,
      pr: FIRST_PR,
    });
    expect(fixture.input.changes).toBe(2);
  });

  test("should clear PR keys and join old lookup work when serial sessions reuse the owner", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture);
    const oldPr = await fixture.command("gh");
    await fixture.status.stop();
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture, 2);
    await finishPr(fixture, 2, SECOND_PR);
    const { changes } = fixture.input;
    oldPr.reject(new Error("old session lookup rejected"));
    await fixture.status.stop();
    expect(oldPr.options.signal.aborted).toBe(true);
    expect(fixture.status.snapshot.pr).toEqual(SECOND_PR);
    expect(fixture.input.changes).toBe(changes);
  });
});

describe("createGitStatus.requestRefresh", () => {
  test("should coalesce synchronous and pending normal requests when Git has not completed", async () => {
    const fixture = createStatus();
    fixture.input.branch = undefined;
    await fixture.status.start();
    expect(fixture.status.requestRefresh()).toBeUndefined();
    fixture.status.requestRefresh();
    fixture.status.requestRefresh();
    expect(fixture.calls).toHaveLength(0);
    const git = await fixture.command("git");
    fixture.status.requestRefresh();
    fixture.status.requestRefresh();
    expect(fixture.calls).toHaveLength(1);
    fixture.input.branch = "feature";
    await finishGit(fixture);
    await finishPr(fixture);
    await fixture.status.stop();
    expect(fixture.calls.filter((call) => call.command === "git")).toEqual([
      git,
    ]);
    expect(fixture.status.snapshot.branch).toBe("feature");
  });

  test("should coalesce queued forced and normal requests when no Git job is running", async () => {
    const fixture = createStatus();
    await startAndFetch(fixture);
    const firstGit = await fixture.command("git");
    fixture.status.requestRefresh();
    fixture.status.invalidate("working-tree");
    fixture.status.invalidate("working-tree");
    fixture.status.requestRefresh();
    expect(fixture.calls).toHaveLength(2);
    const git = await fixture.command("git", 2);
    expect(fixture.calls.filter((call) => call.command === "git")).toHaveLength(
      2,
    );
    await finishGit(fixture, 2, " M fresh\n");
    await fixture.status.stop();
    expect(fixture.calls.filter((call) => call.command === "git")).toEqual([
      firstGit,
      git,
    ]);
    expect(fixture.status.snapshot.unstaged).toBe(1);
    expect(fixture.status.snapshot.pr).toEqual(FIRST_PR);
  });

  test("should publish independent porcelain counts and bounded commands when Git succeeds", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(
      fixture,
      1,
      "M  staged\n M unstaged\nMM both\n?? new\n\nx\n ? ignored\n?  ignored\n",
    );
    await finishPr(fixture);
    expect(fixture.status.snapshot).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "main",
      staged: 2,
      unstaged: 2,
      untracked: 1,
      pr: FIRST_PR,
    });
    expect(
      fixture.calls.map(({ command, args, options }) => ({
        command,
        args,
        cwd: options.cwd,
        timeout: options.timeout,
      })),
    ).toEqual([
      {
        command: "git",
        args: ["status", "--porcelain=v1", "--untracked-files=normal"],
        cwd: "/repo",
        timeout: COMMAND_TIMEOUT_MS,
      },
      {
        command: "gh",
        args: ["pr", "view", "--json", "number,url"],
        cwd: "/repo",
        timeout: COMMAND_TIMEOUT_MS,
      },
    ]);
    expect(fixture.calls.every((call) => !call.options.signal.aborted)).toBe(
      true,
    );
  });

  test("should throttle normal requests until exactly 1000 ms after completion when the cache is fresh", async () => {
    const fixture = createStatus();
    fixture.input.branch = undefined;
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture);
    fixture.input.now += TTL_MS - 1;
    const read = fixture.observeContextRead();
    fixture.status.requestRefresh();
    await read;
    expect(fixture.calls).toHaveLength(1);
    fixture.input.now++;
    fixture.status.requestRefresh();
    await finishGit(fixture, 2);
    expect(fixture.calls).toHaveLength(2);
  });

  test("should retain Git values and throttle retries when a command rejects", async () => {
    const fixture = createStatus();
    fixture.input.branch = undefined;
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture);
    const previous = fixture.status.snapshot;
    fixture.status.invalidate("working-tree");
    const failing = await fixture.command("git", 2);
    const nextChange = fixture.input.changes + 1;
    failing.reject(new Error("git unavailable"));
    await fixture.waitFor(() => fixture.input.changes >= nextChange);
    expect(fixture.status.snapshot).toBe(previous);
    const read = fixture.observeContextRead();
    fixture.status.requestRefresh();
    await read;
    expect(fixture.calls).toHaveLength(2);
    fixture.input.now += TTL_MS;
    fixture.status.requestRefresh();
    await finishGit(fixture, THIRD_GIT_FETCH);
  });

  test("should clear counts and invalidate PR caching when Git exits nonzero", async () => {
    const fixture = createStatus();
    await startAndFetch(fixture);
    fixture.status.invalidate("working-tree");
    await finishGit(fixture, 2, "", 1);
    expect(fixture.status.snapshot).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "main",
    });
    fixture.status.invalidate("working-tree");
    await finishGit(fixture, THIRD_GIT_FETCH);
    await finishPr(fixture, 2, SECOND_PR);
    expect(fixture.status.snapshot.pr).toEqual(SECOND_PR);
  });

  test("should cache the new branch and clear PR and counts when owned Git exits nonzero after a branch change", async () => {
    const fixture = createStatus();
    await startAndFetch(fixture);
    const previous = fixture.status.snapshot;
    fixture.input.branch = "feature";
    fixture.status.invalidate("working-tree");
    await finishGit(fixture, 2, "", 1);
    expect(fixture.status.snapshot).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "feature",
    });
    expect(previous.pr).toEqual(FIRST_PR);
    expect(fixture.calls.filter((call) => call.command === "gh")).toHaveLength(
      1,
    );
  });

  test("should cache the new branch and clear stale PR but retain counts when owned Git rejects after a branch change", async () => {
    const fixture = createStatus();
    await startAndFetch(fixture);
    fixture.input.branch = "feature";
    fixture.status.invalidate("working-tree");
    const git = await fixture.command("git", 2);
    const nextChange = fixture.input.changes + 1;
    git.reject(new Error("git unavailable"));
    await fixture.waitFor(() => fixture.input.changes >= nextChange);
    expect(fixture.status.snapshot).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "feature",
      staged: 1,
    });
    expect(fixture.calls.filter((call) => call.command === "gh")).toHaveLength(
      1,
    );
  });

  test("should skip absent contexts without reading branches when refresh is requested", async () => {
    const fixture = createStatus();
    fixture.input.context = undefined;
    await fixture.status.start();
    const read = fixture.observeContextRead();
    fixture.status.requestRefresh();
    await read;
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.input.branchReads).toBe(0);
    expect(fixture.status.snapshot).toEqual(EMPTY_SNAPSHOT);
    fixture.input.context = { owner: Symbol("available"), cwd: "/repo" };
    fixture.status.requestRefresh();
    await finishGit(fixture);
    await finishPr(fixture);
  });

  test("should skip missing branches and retain the cached branch when the branch provider becomes unavailable", async () => {
    const fixture = createStatus();
    fixture.input.branch = undefined;
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.status.snapshot).toEqual({ ...EMPTY_SNAPSHOT, staged: 1 });
    fixture.input.branch = "main";
    fixture.status.invalidate("working-tree");
    await finishGit(fixture, 2);
    await finishPr(fixture);
    fixture.input.branch = undefined;
    fixture.status.invalidate("working-tree");
    await finishGit(fixture, THIRD_GIT_FETCH);
    expect(fixture.status.snapshot.branch).toBe("main");
    expect(fixture.status.snapshot.pr).toEqual(FIRST_PR);
    expect(fixture.calls.filter((call) => call.command === "gh")).toHaveLength(
      1,
    );
  });

  test("should keep Git progressive without duplicating lookups when PR remains slow", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture);
    const pr = await fixture.command("gh");
    fixture.status.invalidate("working-tree");
    await finishGit(fixture, 2, " M newer\n?? new\n");
    expect(fixture.status.snapshot).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "main",
      unstaged: 1,
      untracked: 1,
    });
    expect(fixture.calls.filter((call) => call.command === "gh")).toEqual([pr]);
    await finishPr(fixture);
    expect(fixture.status.snapshot.unstaged).toBe(1);
    expect(fixture.status.snapshot.pr).toEqual(FIRST_PR);
  });

  test.each([
    { condition: "invalid JSON", result: { code: 0, stdout: "{" } },
    { condition: "a non-object response", result: { code: 0, stdout: "[]" } },
    {
      condition: "invalid fields",
      result: { code: 0, stdout: '{"number":"42","url":null}' },
    },
    {
      condition: "a nonzero exit",
      result: { code: 1, stdout: JSON.stringify(SECOND_PR) },
    },
  ])(
    "should hide PR data and preserve Git counts when gh returns $condition",
    async ({ result }) => {
      const fixture = createStatus();
      await startAndFetch(fixture);
      fixture.input.branch = "feature";
      fixture.status.invalidate("branch");
      await finishGit(fixture, 2, " M changed\n");
      const pr = await fixture.command("gh", 2);
      const nextChange = fixture.input.changes + 1;
      pr.resolve(result);
      await fixture.waitFor(() => fixture.input.changes >= nextChange);
      expect(fixture.status.snapshot).toEqual({
        ...EMPTY_SNAPSHOT,
        branch: "feature",
        unstaged: 1,
      });
      fixture.status.invalidate("working-tree");
      await finishGit(fixture, THIRD_GIT_FETCH);
      expect(
        fixture.calls.filter((call) => call.command === "gh"),
      ).toHaveLength(2);
    },
  );

  test("should hide PR data without retrying its key when optional gh rejects", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture);
    const pr = await fixture.command("gh");
    const nextChange = fixture.input.changes + 1;
    pr.reject(new Error("gh unavailable"));
    await fixture.waitFor(() => fixture.input.changes >= nextChange);
    expect(fixture.status.snapshot).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "main",
      staged: 1,
    });
    fixture.status.invalidate("working-tree");
    await finishGit(fixture, 2);
    expect(fixture.calls.filter((call) => call.command === "gh")).toHaveLength(
      1,
    );
  });

  test.each(["owner", "cwd"] as const)(
    "should reject stale Git success when context %s changes during a command",
    async (field) => {
      const fixture = createStatus();
      await fixture.status.start();
      fixture.status.requestRefresh();
      await fixture.command("git");
      const { context } = fixture.input;
      if (!context) {
        throw new Error("Expected test context");
      }
      fixture.input.context =
        field === "owner"
          ? { ...context, owner: Symbol("replacement") }
          : { ...context, cwd: "/other-repo" };
      await finishGit(fixture);
      expect(fixture.status.snapshot).toEqual(EMPTY_SNAPSHOT);
      expect(fixture.input.branchReads).toBe(0);
      fixture.status.requestRefresh();
      await finishGit(fixture, 2);
      await finishPr(fixture);
    },
  );

  test("should retain retry throttling when an old context command rejects", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    const git = await fixture.command("git");
    fixture.input.context = { owner: Symbol("replacement"), cwd: "/repo" };
    git.reject(new Error("old context failure"));
    await fixture.waitFor(() => fixture.input.changes === 1);
    const read = fixture.observeContextRead();
    fixture.status.requestRefresh();
    await read;
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.status.snapshot).toEqual(EMPTY_SNAPSHOT);
  });

  test.each(["owner", "cwd", "release"] as const)(
    "should reject stale PR success when context %s changes during lookup",
    async (transition) => {
      const fixture = createStatus();
      await fixture.status.start();
      fixture.status.requestRefresh();
      await finishGit(fixture);
      await fixture.command("gh");
      const { context } = fixture.input;
      if (!context) {
        throw new Error("Expected test context");
      }
      fixture.input.context =
        transition === "release"
          ? undefined
          : {
              owner:
                transition === "owner" ? Symbol("replacement") : context.owner,
              cwd: transition === "cwd" ? "/other-repo" : context.cwd,
            };
      await finishPr(fixture);
      expect(fixture.status.snapshot.pr).toBeUndefined();
    },
  );

  test.each(["owner", "cwd"] as const)(
    "should replace PR caching when context %s changes with the same branch",
    async (field) => {
      const fixture = createStatus();
      await startAndFetch(fixture);
      const { context } = fixture.input;
      if (!context) {
        throw new Error("Expected test context");
      }
      fixture.input.context =
        field === "owner"
          ? { ...context, owner: Symbol("replacement") }
          : { ...context, cwd: "/other-repo" };
      fixture.status.invalidate("working-tree");
      await finishGit(fixture, 2);
      expect(fixture.status.snapshot.pr).toBeUndefined();
      await finishPr(fixture, 2, SECOND_PR);
      expect(fixture.status.snapshot.pr).toEqual(SECOND_PR);
      expect(fixture.calls.at(-1)?.options.cwd).toBe(fixture.input.context.cwd);
    },
  );

  test("should abort old PR and replace its key when cwd changes during a slow lookup", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture);
    const oldPr = await fixture.command("gh");
    const { context } = fixture.input;
    if (!context) {
      throw new Error("Expected test context");
    }
    fixture.input.context = { ...context, cwd: "/other-repo" };
    fixture.status.invalidate("working-tree");
    await finishGit(fixture, 2);
    expect(oldPr.options.signal.aborted).toBe(true);
    const newPr = await fixture.command("gh", 2);
    expect(newPr.options.cwd).toBe("/other-repo");
    const { changes } = fixture.input;
    oldPr.reject(new Error("old cwd lookup rejected"));
    await finishPr(fixture, 2, SECOND_PR);
    expect(fixture.status.snapshot.pr).toEqual(SECOND_PR);
    expect(fixture.input.changes).toBe(changes + 1);
  });

  test.each(["context", "branch", "notification"] as const)(
    "should recover without leaking rejections when %s callbacks throw",
    async (failurePoint) => {
      let failing = false;
      let stdout = "M  initial\n";
      const initial = Promise.withResolvers<void>();
      const failed = Promise.withResolvers<void>();
      const recovered = Promise.withResolvers<void>();
      const context = { owner: Symbol("session"), cwd: "/repo" };
      const unhandled: unknown[] = [];
      const recordUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      /**
       * Signals and throws a controlled failure at the selected host callback.
       * @example injectFailure("branch"); // Throws only while that callback is selected.
       */
      const injectFailure = (callback: typeof failurePoint): void => {
        if (failing && callback === failurePoint) {
          failed.resolve();
          throw new Error("host callback unavailable");
        }
      };
      const status = createGitStatus({
        readContext: () => {
          injectFailure("context");
          return context;
        },
        readBranch: () => {
          injectFailure("branch");
          return "main";
        },
        changed: () => {
          injectFailure("notification");
          if (status.snapshot.staged === 1) {
            initial.resolve();
          }
          if (status.snapshot.unstaged === 1) {
            recovered.resolve();
          }
        },
        exec: async (command) => ({
          code: command === "git" ? 0 : 1,
          stdout: command === "git" ? stdout : "",
        }),
      });
      owners.push(status);
      process.on("unhandledRejection", recordUnhandled);
      try {
        await status.start();
        status.requestRefresh();
        await initial.promise;
        failing = true;
        status.invalidate("working-tree");
        await failed.promise;
        failing = false;
        stdout = " M recovered\n";
        status.invalidate("working-tree");
        await recovered.promise;
        await status.stop();
        // Permit runtime rejection-event delivery, not refresh-queue flushing.
        const turn = Promise.withResolvers<void>();
        setImmediate(turn.resolve);
        await turn.promise;
        expect(unhandled).toEqual([]);
        expect(status.snapshot).toEqual({
          ...EMPTY_SNAPSHOT,
          branch: "main",
          unstaged: 1,
        });
      } finally {
        await status.stop();
        process.off("unhandledRejection", recordUnhandled);
      }
    },
  );
});

describe("createGitStatus.invalidate", () => {
  test.each(["working-tree", "branch", "pending-pr"] as const)(
    "should queue one forced follow-up when %s invalidation arrives during Git",
    async (reason) => {
      const fixture = createStatus();
      fixture.input.branch = undefined;
      await fixture.status.start();
      fixture.status.requestRefresh();
      await fixture.command("git");
      expect(fixture.status.invalidate(reason)).toBeUndefined();
      fixture.status.invalidate(reason);
      fixture.status.requestRefresh();
      expect(fixture.calls).toHaveLength(1);
      await finishGit(fixture);
      expect(fixture.status.snapshot.staged).toBe(1);
      await fixture.command("git", 2);
      expect(fixture.status.snapshot.staged).toBe(1);
      await finishGit(fixture, 2, " M fresh\n");
      await fixture.status.stop();
      expect(fixture.calls).toHaveLength(2);
      expect(fixture.status.snapshot.unstaged).toBe(1);
    },
  );

  test("should preserve cached PR and stable previous snapshots when only the working tree changes", async () => {
    const fixture = createStatus();
    await startAndFetch(fixture);
    const previous = fixture.status.snapshot;
    fixture.status.invalidate("working-tree");
    await finishGit(fixture, 2, "?? new\n");
    expect(fixture.status.snapshot.pr).toEqual(FIRST_PR);
    expect(fixture.calls.filter((call) => call.command === "gh")).toHaveLength(
      1,
    );
    expect(previous).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "main",
      staged: 1,
      pr: FIRST_PR,
    });
  });

  test("should abort old PR and reject late success when branch invalidation replaces its key", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture);
    const oldPr = await fixture.command("gh");
    fixture.input.branch = "feature";
    fixture.status.invalidate("branch");
    expect(oldPr.options.signal.aborted).toBe(true);
    await finishGit(fixture, 2, " M current\n");
    await finishPr(fixture, 2, SECOND_PR);
    const { changes } = fixture.input;
    oldPr.resolve({ code: 0, stdout: JSON.stringify(FIRST_PR) });
    await fixture.status.stop();
    expect(fixture.status.snapshot.pr).toEqual(SECOND_PR);
    expect(fixture.input.changes).toBe(changes);
  });

  test("should abort old PR when a newer Git refresh discovers an unannounced branch change", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture);
    const oldPr = await fixture.command("gh");
    fixture.input.branch = "feature";
    fixture.status.invalidate("working-tree");
    await finishGit(fixture, 2);
    expect(oldPr.options.signal.aborted).toBe(true);
    await finishPr(fixture, 2, SECOND_PR);
    const { changes } = fixture.input;
    oldPr.reject(new Error("obsolete branch lookup"));
    await fixture.status.stop();
    expect(fixture.status.snapshot.pr).toEqual(SECOND_PR);
    expect(fixture.input.changes).toBe(changes);
  });

  test("should clear stale cached PR immediately and skip gh when the branch becomes detached", async () => {
    const fixture = createStatus();
    await startAndFetch(fixture);
    fixture.input.branch = "detached";
    fixture.status.invalidate("branch");
    expect(fixture.status.snapshot.pr).toBeUndefined();
    await finishGit(fixture, 2);
    expect(fixture.status.snapshot).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "detached",
      staged: 1,
    });
    expect(fixture.calls.filter((call) => call.command === "gh")).toHaveLength(
      1,
    );
  });

  test("should abort pending PR without retrying its key when pending-pr queues forced Git", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture);
    const oldPr = await fixture.command("gh");
    fixture.status.invalidate("pending-pr");
    expect(oldPr.options.signal.aborted).toBe(true);
    await finishGit(fixture, 2);
    oldPr.reject(new Error("cancelled lookup"));
    await fixture.status.stop();
    expect(fixture.calls.filter((call) => call.command === "gh")).toHaveLength(
      1,
    );
    expect(fixture.status.snapshot.pr).toBeUndefined();
    expect(fixture.input.changes).toBe(2);
  });

  test("should preserve completed PR caching when pending-pr forces Git", async () => {
    const fixture = createStatus();
    await startAndFetch(fixture);
    fixture.status.invalidate("pending-pr");
    await finishGit(fixture, 2);
    expect(fixture.status.snapshot.pr).toEqual(FIRST_PR);
    expect(fixture.calls.filter((call) => call.command === "gh")).toHaveLength(
      1,
    );
  });
});

describe("createGitStatus.stop", () => {
  test.each(["context", "branch"] as const)(
    "should keep cancelled Git unpublished when the %s provider synchronously stops during publication",
    async (provider) => {
      spyOn(Date, "now").mockReturnValue(START_MS);
      const started = Promise.withResolvers<void>();
      const command = Promise.withResolvers<CommandResult>();
      const stopped = Promise.withResolvers<void>();
      const context = { owner: Symbol("session"), cwd: "/repo" };
      const armedProviders = new Set<"context" | "branch">();
      let commands = 0;
      let changes = 0;
      const status = createGitStatus({
        readContext: () => {
          if (armedProviders.delete("context")) {
            status.stop().then(stopped.resolve, stopped.reject);
          }
          return context;
        },
        readBranch: () => {
          if (armedProviders.delete("branch")) {
            status.stop().then(stopped.resolve, stopped.reject);
          }
          return "main";
        },
        exec: () => {
          commands++;
          started.resolve();
          return command.promise;
        },
        changed: () => {
          changes++;
        },
      });
      owners.push(status);
      await status.start();
      status.requestRefresh();
      await started.promise;
      armedProviders.add(provider);
      command.resolve({ code: 0, stdout: "M  staged\n" });
      await stopped.promise;
      expect(status.snapshot).toEqual(EMPTY_SNAPSHOT);
      expect(commands).toBe(1);
      expect(changes).toBe(0);
    },
  );

  test("should retain the previous snapshot when a PR abort listener synchronously stops rejected Git publication", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture);
    const pr = await fixture.command("gh");
    const previous = fixture.status.snapshot;
    const { changes } = fixture.input;
    fixture.input.branch = "feature";
    fixture.status.invalidate("working-tree");
    const git = await fixture.command("git", 2);
    const stopped = Promise.withResolvers<void>();
    pr.options.signal.addEventListener(
      "abort",
      () => {
        fixture.status.stop().then(stopped.resolve, stopped.reject);
      },
      { once: true },
    );
    git.reject(new Error("Git unavailable"));
    await stopped.promise;
    expect(fixture.status.snapshot).toBe(previous);
    expect(fixture.status.snapshot.branch).toBe("main");
    expect(fixture.input.changes).toBe(changes);
    expect(fixture.calls.map((call) => call.command)).toEqual([
      "git",
      "gh",
      "git",
    ]);
  });

  test("should stop idempotently and ignore requests when the owner is stopped", async () => {
    const fixture = createStatus();
    fixture.status.requestRefresh();
    fixture.status.invalidate("branch");
    await fixture.status.stop();
    await fixture.status.start();
    await Promise.all([fixture.status.stop(), fixture.status.stop()]);
    fixture.status.requestRefresh();
    fixture.status.invalidate("working-tree");
    fixture.status.invalidate("pending-pr");
    fixture.status.invalidate("branch");
    await fixture.status.stop();
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.input.contextReads).toBe(0);
    expect(fixture.input.changes).toBe(0);
  });

  test("should cancel queued Git without executing commands when stopped before dispatch", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    fixture.status.invalidate("working-tree");
    fixture.status.requestRefresh();
    expect(fixture.calls).toHaveLength(0);
    await fixture.status.stop();
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.input.changes).toBe(0);
    expect(fixture.status.snapshot).toEqual(EMPTY_SNAPSHOT);
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture);
    await finishPr(fixture);
    await fixture.status.stop();
    expect(fixture.calls.map((call) => call.command)).toEqual(["git", "gh"]);
  });

  test("should cancel queued PR without changing published Git when stopped before lookup dispatch", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture);
    expect(fixture.calls.map((call) => call.command)).toEqual(["git"]);
    const before = fixture.status.snapshot;
    const { changes } = fixture.input;
    await fixture.status.stop();
    expect(fixture.calls.map((call) => call.command)).toEqual(["git"]);
    expect(fixture.status.snapshot).toBe(before);
    expect(fixture.status.snapshot.staged).toBe(1);
    expect(fixture.status.snapshot.pr).toBeUndefined();
    expect(fixture.input.changes).toBe(changes);
  });

  test("should abort both commands and make late successes inert when shutdown joins pending jobs", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture);
    const pr = await fixture.command("gh");
    fixture.status.invalidate("working-tree");
    const git = await fixture.command("git", 2);
    const before = fixture.status.snapshot;
    const { changes } = fixture.input;
    await fixture.status.stop();
    expect(git.options.signal.aborted).toBe(true);
    expect(pr.options.signal.aborted).toBe(true);
    git.resolve({ code: 0, stdout: "MM obsolete\n" });
    pr.resolve({ code: 0, stdout: JSON.stringify(FIRST_PR) });
    await fixture.status.start();
    fixture.status.requestRefresh();
    await finishGit(fixture, THIRD_GIT_FETCH, " M current\n");
    await finishPr(fixture, 2, SECOND_PR);
    expect(before).toEqual({ ...EMPTY_SNAPSHOT, branch: "main", staged: 1 });
    expect(fixture.status.snapshot).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "main",
      unstaged: 1,
      pr: SECOND_PR,
    });
    expect(fixture.input.changes).toBe(changes + 2);
  });

  test("should consume late command rejections without notifying when ignored aborts outlive stop", async () => {
    const fixture = createStatus();
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", recordUnhandled);
    try {
      await fixture.status.start();
      fixture.status.requestRefresh();
      await finishGit(fixture);
      const pr = await fixture.command("gh");
      fixture.status.invalidate("working-tree");
      const git = await fixture.command("git", 2);
      const before = fixture.status.snapshot;
      const { changes } = fixture.input;
      await fixture.status.stop();
      git.reject(new Error("late Git rejection"));
      pr.reject(new Error("late gh rejection"));
      // A real event-loop turn lets the runtime deliver unhandled-rejection events.
      const turn = Promise.withResolvers<void>();
      setImmediate(turn.resolve);
      await turn.promise;
      expect(unhandled).toEqual([]);
      expect(fixture.status.snapshot).toBe(before);
      expect(fixture.input.changes).toBe(changes);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
  });

  test("should remove owned abort listeners when command completion and shutdown release resources", async () => {
    const fixture = createStatus();
    await fixture.status.start();
    fixture.status.requestRefresh();
    const git = await fixture.command("git");
    const removeGit = spyOn(git.options.signal, "removeEventListener");
    await finishGit(fixture);
    const pr = await fixture.command("gh");
    const removePr = spyOn(pr.options.signal, "removeEventListener");
    await fixture.status.stop();
    for (const remove of [removeGit, removePr]) {
      expect(remove.mock.calls).toHaveLength(1);
      expect(remove.mock.calls[0]).toEqual(["abort", expect.any(Function)]);
    }
  });
});
