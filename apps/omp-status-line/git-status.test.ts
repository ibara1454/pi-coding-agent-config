import { describe, expect, test } from "bun:test";
import { createGitStatus } from "./git-status.ts";

const START_MS = 10_000;
const TTL_MS = 1000;
const COMMAND_TIMEOUT_MS = 2000;
const FIRST_PR_NUMBER = 42;
const SECOND_PR_NUMBER = 73;
const RETRY_FETCH_COUNT = 3;
const TWO_REFRESH_NOTIFICATIONS = 4;
const FIRST_PR = {
  number: FIRST_PR_NUMBER,
  url: "https://example.com/pr/42",
};
const SECOND_PR = {
  number: SECOND_PR_NUMBER,
  url: "https://example.com/pr/73",
};
const EMPTY_SNAPSHOT = {
  branch: null,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  pr: null,
};

interface CommandResult {
  code: number;
  stdout: string;
}

interface CommandCall {
  command: string;
  args: string[];
  options: { cwd: string; timeout: number; signal: AbortSignal };
}

type Execute = (call: CommandCall) => Promise<CommandResult>;

/**
 * Creates in-memory command/clock effects with separately controlled context and branch.
 * @param execute Planned external command outcomes; parsing and policy remain real.
 * @returns Production owner plus mutable test-owned inputs and effect records.
 * @example const { status } = createStatus(); await status.refresh(true);
 */
function createStatus(
  execute: Execute = ({ command }) =>
    Promise.resolve({
      code: 0,
      stdout: command === "git" ? "M  staged\n" : JSON.stringify(FIRST_PR),
    }),
) {
  const input: {
    now: number;
    context: { owner: symbol; cwd: string } | null;
    branch: string | null;
    branchReads: number;
    changes: number;
  } = {
    now: START_MS,
    context: { owner: Symbol("session"), cwd: "/repo" },
    branch: "main",
    branchReads: 0,
    changes: 0,
  };
  const calls: CommandCall[] = [];
  const status = createGitStatus({
    now: () => input.now,
    readContext: () => input.context,
    readBranch: () => {
      input.branchReads++;
      return input.branch;
    },
    changed: () => {
      input.changes++;
    },
    exec: (command, args, options) => {
      const call = { command, args, options };
      calls.push(call);
      return execute(call);
    },
  });
  return { status, input, calls };
}

/**
 * Holds an external command completion until the test triggers it.
 * @returns Promise plus completion effects; never executes a real command.
 * @example const pending = deferredCommand(); pending.resolve({ code: 0, stdout: "" });
 */
function deferredCommand() {
  let resolve!: (result: CommandResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<CommandResult>(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    },
  );
  return { promise, resolve, reject };
}

describe("createGitStatus.refresh", () => {
  test("should retain a cached PR until a branch change and hide it when the branch becomes detached", async () => {
    let pr = FIRST_PR;
    const { status, input, calls } = createStatus(({ command }) =>
      Promise.resolve({
        code: 0,
        stdout: command === "git" ? "M  staged\n" : JSON.stringify(pr),
      }),
    );
    await status.refresh(true);
    const previous = status.snapshot;
    expect(previous).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "main",
      staged: 1,
      pr,
    });

    pr = SECOND_PR;
    status.invalidate("working-tree");
    await status.refresh(true);
    expect(status.snapshot.pr).toEqual(FIRST_PR);
    expect(calls.filter(({ command }) => command === "gh")).toHaveLength(1);

    input.branch = "feature";
    status.invalidate("branch");
    await status.refresh(true);
    expect(status.snapshot).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "feature",
      staged: 1,
      pr: SECOND_PR,
    });
    expect(previous.pr).toEqual(FIRST_PR);

    input.branch = "detached";
    status.invalidate("branch");
    await status.refresh(true);
    expect(status.snapshot).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "detached",
      staged: 1,
    });
    expect(calls.filter(({ command }) => command === "gh")).toHaveLength(2);
    status.dispose();
  });

  test.each([
    {
      condition: "invalid JSON",
      response: Promise.resolve({ code: 0, stdout: "{" }),
    },
    {
      condition: "a non-object response",
      response: Promise.resolve({ code: 0, stdout: "[]" }),
    },
    {
      condition: "invalid PR fields",
      response: Promise.resolve({
        code: 0,
        stdout: '{"number":"42","url":null}',
      }),
    },
    { condition: "a rejected command", response: null },
  ])(
    "should clear the previous PR and preserve Git counts when lookup returns $condition",
    async ({ response }) => {
      let failing = false;
      const { status, input, calls } = createStatus(({ command }) => {
        if (command === "gh" && failing) {
          return response ?? Promise.reject(new Error("lookup unavailable"));
        }
        return Promise.resolve({
          code: 0,
          stdout: command === "git" ? " M changed\n" : JSON.stringify(FIRST_PR),
        });
      });
      await status.refresh(true);
      expect(status.snapshot.pr).toEqual(FIRST_PR);
      failing = true;
      input.branch = "feature";
      status.invalidate("branch");
      await status.refresh(true);
      expect(status.snapshot).toEqual({
        ...EMPTY_SNAPSHOT,
        branch: "feature",
        unstaged: 1,
      });
      expect(calls.filter(({ command }) => command === "gh")).toHaveLength(2);
      expect(input.changes).toBe(TWO_REFRESH_NOTIFICATIONS);
      status.dispose();
    },
  );

  test("should retain Git counts and throttle retries when a refresh rejects", async () => {
    let failing = false;
    const { status, input, calls } = createStatus(({ command }) => {
      if (command === "git" && failing) {
        return Promise.reject(new Error("git unavailable"));
      }
      return Promise.resolve({
        code: command === "git" ? 0 : 1,
        stdout: "M  staged\n",
      });
    });
    await status.refresh(true);
    const previous = status.snapshot;
    failing = true;
    status.invalidate("working-tree");
    await status.refresh(true);
    await status.refresh();
    expect(status.snapshot).toBe(previous);
    expect(calls.filter(({ command }) => command === "git")).toHaveLength(2);
    input.now += TTL_MS - 1;
    await status.refresh();
    expect(calls.filter(({ command }) => command === "git")).toHaveLength(2);
    input.now++;
    await status.refresh();
    expect(calls.filter(({ command }) => command === "git")).toHaveLength(
      RETRY_FETCH_COUNT,
    );
    expect(status.snapshot).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "main",
      staged: 1,
    });
    status.dispose();
  });

  test("should count independent porcelain columns and send bounded commands when Git succeeds", async () => {
    const { status, calls } = createStatus(({ command }) =>
      Promise.resolve({
        code: 0,
        stdout:
          command === "git"
            ? "M  staged\n M unstaged\nMM both\n?? new\n\nx\n ? ignored\n?  ignored\n"
            : JSON.stringify(FIRST_PR),
      }),
    );
    await status.refresh(true);
    expect(status.snapshot).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "main",
      staged: 2,
      unstaged: 2,
      untracked: 1,
      pr: FIRST_PR,
    });
    expect(
      calls.map(({ command, args, options }) => ({
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
    status.dispose();
  });

  test("should skip commands without a context or before the initial TTL expires", async () => {
    const { status, input, calls } = createStatus();
    input.context = null;
    await status.refresh(true);
    input.context = { owner: Symbol("session"), cwd: "/repo" };
    input.now = TTL_MS - 1;
    await status.refresh();
    expect(calls).toHaveLength(0);
    expect(input.branchReads).toBe(0);
    expect(status.snapshot).toEqual(EMPTY_SNAPSHOT);
    status.dispose();
  });

  test("should bypass only the Git TTL and share the pending command when force is requested", async () => {
    const pending = deferredCommand();
    const { status, input, calls } = createStatus(({ command }) =>
      command === "git"
        ? pending.promise
        : Promise.resolve({ code: 1, stdout: "" }),
    );
    const first = status.refresh(true);
    await status.refresh(true);
    await status.refresh();
    expect(calls).toHaveLength(1);
    expect(input.branchReads).toBe(0);
    input.branch = "feature";
    pending.resolve({ code: 0, stdout: " M changed\n" });
    await first;
    expect(status.snapshot.branch).toBe("feature");
    expect(input.branchReads).toBe(1);
    await status.refresh();
    expect(calls.filter(({ command }) => command === "git")).toHaveLength(1);
    await status.refresh(true);
    expect(calls.filter(({ command }) => command === "git")).toHaveLength(2);
    status.dispose();
  });

  test("should clear counts and the PR cache when Git returns a nonzero exit", async () => {
    let code = 0;
    const { status, calls } = createStatus(({ command }) =>
      Promise.resolve({
        code: command === "git" ? code : 0,
        stdout: command === "git" ? "M  staged\n" : JSON.stringify(FIRST_PR),
      }),
    );
    await status.refresh(true);
    code = 1;
    await status.refresh(true);
    expect(status.snapshot).toEqual(EMPTY_SNAPSHOT);
    code = 0;
    await status.refresh(true);
    expect(status.snapshot.pr).toEqual(FIRST_PR);
    expect(calls.filter(({ command }) => command === "gh")).toHaveLength(2);
    status.dispose();
  });

  test("should clear optional PR data when gh returns a nonzero exit", async () => {
    const { status } = createStatus(({ command }) =>
      Promise.resolve({
        code: command === "gh" ? 1 : 0,
        stdout: "M  staged\n",
      }),
    );
    await status.refresh(true);
    expect(status.snapshot).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "main",
      staged: 1,
    });
    status.dispose();
  });

  test("should skip PR lookup without a branch and retain the branch when the provider becomes unavailable", async () => {
    const { status, input, calls } = createStatus();
    input.branch = null;
    await status.refresh(true);
    expect(status.snapshot).toEqual({ ...EMPTY_SNAPSHOT, staged: 1 });
    expect(calls).toHaveLength(1);
    input.branch = "main";
    await status.refresh(true);
    input.branch = null;
    await status.refresh(true);
    expect(status.snapshot.branch).toBe("main");
    expect(status.snapshot.pr).toEqual(FIRST_PR);
    expect(calls.filter(({ command }) => command === "gh")).toHaveLength(1);
    status.dispose();
  });

  test("should key PR caching by cwd as well as branch when the working directory changes", async () => {
    const { status, input, calls } = createStatus();
    await status.refresh(true);
    input.context = { owner: Symbol("next-context"), cwd: "/other-repo" };
    await status.refresh(true);
    expect(
      calls
        .filter(({ command }) => command === "gh")
        .map(({ options }) => options.cwd),
    ).toEqual(["/repo", "/other-repo"]);
    status.dispose();
  });

  test("should complete Git without duplicating PR lookup when a previous PR command remains pending", async () => {
    const pending = deferredCommand();
    const { status, calls } = createStatus(({ command }) =>
      command === "gh"
        ? pending.promise
        : Promise.resolve({ code: 0, stdout: "M  staged\n" }),
    );
    await status.refresh(true);
    expect(status.snapshot).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "main",
      staged: 1,
    });
    await status.refresh(true);
    expect(calls.filter(({ command }) => command === "git")).toHaveLength(2);
    expect(calls.filter(({ command }) => command === "gh")).toHaveLength(1);
    pending.resolve({ code: 0, stdout: JSON.stringify(FIRST_PR) });
    await pending.promise;
    expect(status.snapshot.pr).toEqual(FIRST_PR);
    status.dispose();
  });

  test("should discard stale Git results and allow a retry when context ownership changes", async () => {
    const pending = deferredCommand();
    const { status, input, calls } = createStatus(({ command }) =>
      command === "git"
        ? pending.promise
        : Promise.resolve({ code: 1, stdout: "" }),
    );
    const refresh = status.refresh(true);
    input.context = { owner: Symbol("replacement"), cwd: "/repo" };
    pending.resolve({ code: 0, stdout: "M  old\n" });
    await refresh;
    expect(status.snapshot).toEqual(EMPTY_SNAPSHOT);
    expect(input.branchReads).toBe(0);
    expect(input.changes).toBe(1);
    await status.refresh();
    expect(calls.filter(({ command }) => command === "git")).toHaveLength(2);
    status.dispose();
  });

  test("should retain the retry TTL when an owned Git command rejects after context replacement", async () => {
    const pending = deferredCommand();
    const { status, input, calls } = createStatus(() => pending.promise);
    const refresh = status.refresh(true);
    input.context = { owner: Symbol("replacement"), cwd: "/repo" };
    pending.reject(new Error("old command failed"));
    await refresh;
    expect(status.snapshot).toEqual(EMPTY_SNAPSHOT);
    expect(input.branchReads).toBe(0);
    expect(input.changes).toBe(1);
    await status.refresh();
    expect(calls).toHaveLength(1);
    status.dispose();
  });

  test("should discard stale PR results when context ownership changes", async () => {
    const pending = deferredCommand();
    const { status, input } = createStatus(({ command }) =>
      command === "gh"
        ? pending.promise
        : Promise.resolve({ code: 0, stdout: "M  staged\n" }),
    );
    await status.refresh(true);
    input.context = { owner: Symbol("replacement"), cwd: "/repo" };
    pending.resolve({ code: 0, stdout: JSON.stringify(FIRST_PR) });
    await pending.promise;
    expect(status.snapshot.pr).toBeNull();
    expect(input.changes).toBe(2);
    status.dispose();
  });

  test("should discard stale PR failures when the host context is released", async () => {
    const pending = deferredCommand();
    const { status, input } = createStatus(({ command }) =>
      command === "gh"
        ? pending.promise
        : Promise.resolve({ code: 0, stdout: "M  staged\n" }),
    );
    await status.refresh(true);
    input.context = null;
    pending.reject(new Error("old lookup failed"));
    await pending.promise.catch(() => undefined);
    expect(status.snapshot.pr).toBeNull();
    expect(input.changes).toBe(2);
    status.dispose();
  });
});

describe("createGitStatus.invalidate", () => {
  test("should abort an old PR and ignore its late response when a branch is replaced", async () => {
    const pending = deferredCommand();
    let lookups = 0;
    const { status, input, calls } = createStatus(({ command }) => {
      if (command === "git") {
        return Promise.resolve({ code: 0, stdout: "M  staged\n" });
      }
      lookups++;
      return lookups === 1
        ? pending.promise
        : Promise.resolve({ code: 0, stdout: JSON.stringify(SECOND_PR) });
    });
    await status.refresh(true);
    const oldSignal = calls.find(({ command }) => command === "gh")?.options
      .signal;
    input.branch = "feature";
    status.invalidate("branch");
    expect(oldSignal?.aborted).toBe(true);
    await status.refresh(true);
    const { changes } = input;
    pending.resolve({ code: 0, stdout: JSON.stringify(FIRST_PR) });
    await pending.promise;
    expect(status.snapshot.pr).toEqual(SECOND_PR);
    expect(input.changes).toBe(changes);
    status.dispose();
  });

  test("should cancel pending PR without clearing its cache or Git TTL when a shell refresh is scheduled", async () => {
    const pending = deferredCommand();
    const { status, input, calls } = createStatus(({ command }) =>
      command === "gh"
        ? pending.promise
        : Promise.resolve({ code: 0, stdout: "M  staged\n" }),
    );
    await status.refresh(true);
    status.invalidate("pending-pr");
    expect(calls.at(1)?.options.signal.aborted).toBe(true);
    await status.refresh();
    expect(calls).toHaveLength(2);
    await status.refresh(true);
    expect(calls.filter(({ command }) => command === "gh")).toHaveLength(1);
    pending.reject(new Error("cancelled lookup"));
    await pending.promise.catch(() => undefined);
    expect(status.snapshot.pr).toBeNull();
    expect(input.changes).toBe(2);
    status.dispose();
  });
});

describe("createGitStatus.reset", () => {
  test("should reset values but retain owned in-flight guards when a session starts", async () => {
    const pending = deferredCommand();
    const { status, input, calls } = createStatus(({ command }) =>
      command === "git"
        ? pending.promise
        : Promise.resolve({ code: 1, stdout: "" }),
    );
    const refresh = status.refresh(true);
    input.context = { owner: Symbol("new-session"), cwd: "/repo" };
    status.reset();
    await status.refresh(true);
    expect(status.snapshot).toEqual(EMPTY_SNAPSHOT);
    expect(calls).toHaveLength(1);
    expect(calls.at(0)?.options.signal.aborted).toBe(false);
    pending.resolve({ code: 0, stdout: "M  old\n" });
    await refresh;
    await status.refresh(true);
    expect(calls.filter(({ command }) => command === "git")).toHaveLength(2);
    status.dispose();
  });

  test("should invalidate the PR cache without aborting its owner when session values reset", async () => {
    const pending = deferredCommand();
    const { status, input, calls } = createStatus(({ command }) =>
      command === "gh"
        ? pending.promise
        : Promise.resolve({ code: 0, stdout: "M  staged\n" }),
    );
    await status.refresh(true);
    status.reset();
    expect(calls.at(1)?.options.signal.aborted).toBe(false);
    pending.resolve({ code: 0, stdout: JSON.stringify(FIRST_PR) });
    await pending.promise;
    expect(status.snapshot).toEqual(EMPTY_SNAPSHOT);
    expect(input.changes).toBe(2);
    status.dispose();
  });
});

describe("createGitStatus.dispose", () => {
  test("should abort owned commands and preserve newer controllers when disposed work completes late", async () => {
    const oldGit = deferredCommand();
    const newGit = deferredCommand();
    let gitCalls = 0;
    const { status, input, calls } = createStatus(({ command }) => {
      if (command === "gh") {
        return Promise.resolve({ code: 1, stdout: "" });
      }
      gitCalls++;
      return gitCalls === 1 ? oldGit.promise : newGit.promise;
    });
    const oldRefresh = status.refresh(true);
    status.dispose();
    status.dispose();
    expect(calls.at(0)?.options.signal.aborted).toBe(true);
    const newRefresh = status.refresh(true);
    oldGit.reject(new Error("cancelled Git"));
    await oldRefresh;
    expect(input.changes).toBe(0);
    await status.refresh(true);
    expect(calls.filter(({ command }) => command === "git")).toHaveLength(2);
    newGit.resolve({ code: 0, stdout: " M current\n" });
    await newRefresh;
    expect(status.snapshot).toEqual({
      ...EMPTY_SNAPSHOT,
      branch: "main",
      unstaged: 1,
    });
    status.dispose();
  });

  test("should cancel both command owners and discard late results when shutdown occurs", async () => {
    const pendingPr = deferredCommand();
    const pendingGit = deferredCommand();
    let gitCalls = 0;
    const { status, input, calls } = createStatus(({ command }) => {
      if (command === "gh") {
        return pendingPr.promise;
      }
      gitCalls++;
      return gitCalls === 1
        ? Promise.resolve({ code: 0, stdout: "M  staged\n" })
        : pendingGit.promise;
    });
    await status.refresh(true);
    const before = status.snapshot;
    const refresh = status.refresh(true);
    status.dispose();
    expect(calls.at(1)?.options.signal.aborted).toBe(true);
    expect(calls.at(2)?.options.signal.aborted).toBe(true);
    pendingGit.resolve({ code: 0, stdout: " M obsolete\n" });
    pendingPr.resolve({ code: 0, stdout: JSON.stringify(FIRST_PR) });
    await refresh;
    await pendingPr.promise;
    expect(status.snapshot).toBe(before);
    expect(input.changes).toBe(1);
  });
});
