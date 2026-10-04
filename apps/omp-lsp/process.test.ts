import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: Spies must intercept live named imports of Node's process launcher.
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import process from "node:process";
import { PassThrough } from "node:stream";
import { runCommand, stopProcess } from "./process.ts";

const OUTPUT_OVERFLOW_BYTES = 600_000;
// 512 KiB (512 * 1024 bytes).
const DEFAULT_OUTPUT_LIMIT_BYTES = 524_288;
const TEST_CHILD_PID = 12_345;
const INERT_TIMEOUT_MS = 60_000;
const TEST_FAILURE_EXIT_CODE = 7;
const NON_INTEGER_OUTPUT_LIMIT = 1.5;
const EXCESSIVE_OUTPUT_LIMIT_BYTES = 16_777_217;
const FORCE_KILL_DELAY_MS = 1000;
const FORCE_KILL_DEADLINE_MS = 2000;

const spawning: {
  spawn: (
    command: string,
    args: string[],
    options: childProcess.SpawnOptionsWithoutStdio,
  ) => childProcess.ChildProcessWithoutNullStreams;
} = childProcess;

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: childProcess.ChildProcessWithoutNullStreams["kill"];
}

const children: FakeChild[] = [];
const ownedTimers: NodeJS.Timeout[] = [];
const timeouts: {
  setTimeout: (callback: () => void, delay?: number) => NodeJS.Timeout;
} = globalThis;

/**
 * Creates a test-owned piped child with child and process-group signal mocks.
 * afterEach owns stream/listener cleanup; neither signaling API touches real processes.
 * @returns The controllable child, spawn/group spies, and the platform's active signal mock.
 * @example fixture().child.emit("close", 0, null) completes a pending command.
 */
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: TEST_CHILD_PID,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: mock<childProcess.ChildProcessWithoutNullStreams["kill"]>(() => true),
  });
  children.push(child);
  const nativeChild: Pick<
    childProcess.ChildProcessWithoutNullStreams,
    "stdin" | "stdout" | "stderr" | "pid" | "exitCode" | "signalCode" | "kill"
  > &
    EventEmitter = child;
  const processChild =
    nativeChild as childProcess.ChildProcessWithoutNullStreams;
  const spawn = spyOn(spawning, "spawn").mockReturnValue(processChild);
  const signals = spyOn(process, "kill").mockReturnValue(true);
  const activeSignals = process.platform === "win32" ? child.kill : signals;
  return { child, processChild, spawn, signals, activeSignals };
}

/**
 * Captures timeout callbacks so lifecycle deadlines advance without clock delays.
 * @returns Scheduled callbacks and delays; afterEach clears their inert timer handles.
 * @example timers()[0]?.run() triggers the first scheduled escalation.
 */
function timers() {
  const scheduled: Array<{ delay: number | undefined; run: () => void }> = [];
  const setTimer = timeouts.setTimeout;
  spyOn(timeouts, "setTimeout").mockImplementation(
    (callback: () => void, delay?: number) => {
      const timer = setTimer(() => undefined, INERT_TIMEOUT_MS);
      ownedTimers.push(timer);
      scheduled.push({ delay, run: () => callback() });
      return timer;
    },
  );
  return scheduled;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    child.exitCode = 0;
    child.emit("close", 0, null);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.removeAllListeners();
  }
  for (const timer of ownedTimers.splice(0)) {
    clearTimeout(timer);
  }
  mock.restore();
});

describe("runCommand", () => {
  test("should reject incomplete stdout when a successful process exceeds the capture limit", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child: Pick<
      childProcess.ChildProcessWithoutNullStreams,
      "stdin" | "stdout" | "stderr" | "signalCode"
    > &
      EventEmitter & { exitCode: number | null } = Object.assign(
      new EventEmitter(),
      {
        stdin: new PassThrough(),
        stdout,
        stderr,
        exitCode: null,
        signalCode: null,
      },
    );
    spyOn(spawning, "spawn").mockImplementation(() => {
      queueMicrotask(() => {
        stdout.end(Buffer.alloc(OUTPUT_OVERFLOW_BYTES, "x"));
        stderr.end();
        child.exitCode = 0;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child as childProcess.ChildProcessWithoutNullStreams;
    });
    try {
      await expect(
        runCommand("formatter", [], {
          cwd: "/project",
          maxOutputBytes: DEFAULT_OUTPUT_LIMIT_BYTES,
        }),
      ).rejects.toThrow("output is incomplete");
    } finally {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });

  test("should stop a noisy process once when overflow and cancellation overlap", async () => {
    const { child, signals } = fixture();
    const controller = new AbortController();
    const result = runCommand("noisy", [], {
      cwd: "/project",
      maxOutputBytes: 4,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    try {
      child.stdout.write("overflow");
      child.stdout.write("more output");
      child.stderr.write("also overflowing");
      controller.abort(new Error("cancelled after overflow"));
    } finally {
      child.exitCode = 1;
      child.emit("close", 1, null);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    expect(await result).toMatchObject({
      message: expect.stringContaining("stdout exceeded"),
    });
    expect(signals.mock.calls).toEqual(
      process.platform === "win32" ? [] : [[-TEST_CHILD_PID, "SIGTERM"]],
    );
    expect(child.kill.mock.calls).toEqual(
      process.platform === "win32" ? [["SIGTERM"]] : [],
    );
  });

  test("should capture complete UTF-8 streams and preserve nonzero status when stdin is supplied", async () => {
    const { child, signals } = fixture();
    const controller = new AbortController();
    const removed = spyOn(controller.signal, "removeEventListener");
    const pending = runCommand("formatter", ["--stdin"], {
      cwd: "/project",
      input: "source text",
      signal: controller.signal,
    });
    expect(child.stdin.read()?.toString()).toBe("source text");
    const encoded = Buffer.from("雪");
    child.stdout.write(encoded.subarray(0, 2));
    child.stdout.write(encoded.subarray(2));
    child.stderr.write("warning");
    child.exitCode = TEST_FAILURE_EXIT_CODE;
    child.emit("exit", TEST_FAILURE_EXIT_CODE, null);
    child.emit("close", TEST_FAILURE_EXIT_CODE, null);
    expect(await pending).toEqual({
      stdout: "雪",
      stderr: "warning",
      exitCode: TEST_FAILURE_EXIT_CODE,
    });
    expect(signals.mock.calls).toEqual(
      process.platform === "win32" ? [] : [[-TEST_CHILD_PID, "SIGKILL"]],
    );
    expect(child.kill.mock.calls).toEqual([]);
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.stdin.listenerCount("error")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
  });

  test("should reject spawn failures and remove command listeners when the executable cannot start", async () => {
    const { child } = fixture();
    const failure = Object.assign(new Error("executable missing"), {
      code: "ENOENT",
    });
    const pending = runCommand("missing", [], { cwd: "/project" }).catch(
      (error: unknown) => error,
    );
    child.emit("error", failure);
    expect(await pending).toBe(failure);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdin.listenerCount("error")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
  });

  test("should preserve exit status when the child closes stdin before consuming it", async () => {
    const { child, signals } = fixture();
    const pending = runCommand("early-exit", [], { cwd: "/project" });
    child.stdin.emit(
      "error",
      Object.assign(new Error("broken pipe"), { code: "EPIPE" }),
    );
    child.exitCode = 2;
    child.emit("close", 2, null);
    expect(await pending).toEqual({ stdout: "", stderr: "", exitCode: 2 });
    expect(signals.mock.calls).toEqual([]);
    expect(child.kill.mock.calls).toEqual([]);
  });

  test("should stop the child and reject its input error when stdin fails for a reason other than a broken pipe", async () => {
    const { child, signals } = fixture();
    const failure = Object.assign(new Error("input stream failed"), {
      code: "EIO",
    });
    const pending = runCommand("reader", [], { cwd: "/project" }).catch(
      (error: unknown) => error,
    );
    child.stdin.emit("error", failure);
    expect(signals.mock.calls).toEqual(
      process.platform === "win32" ? [] : [[-TEST_CHILD_PID, "SIGTERM"]],
    );
    expect(child.kill.mock.calls).toEqual(
      process.platform === "win32" ? [["SIGTERM"]] : [],
    );
    child.signalCode = "SIGTERM";
    child.emit("close", null, "SIGTERM");
    expect(await pending).toBe(failure);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.stdin.listenerCount("error")).toBe(0);
  });

  test("should reject the cancellation reason and remove its listener when a running command is aborted", async () => {
    const { child, signals } = fixture();
    const controller = new AbortController();
    const removed = spyOn(controller.signal, "removeEventListener");
    const failure = new Error("caller cancelled");
    const pending = runCommand("server", [], {
      cwd: "/project",
      signal: controller.signal,
    }).catch((error: unknown) => error);
    controller.abort(failure);
    expect(signals.mock.calls).toEqual(
      process.platform === "win32" ? [] : [[-TEST_CHILD_PID, "SIGTERM"]],
    );
    expect(child.kill.mock.calls).toEqual(
      process.platform === "win32" ? [["SIGTERM"]] : [],
    );
    child.signalCode = "SIGTERM";
    child.emit("close", null, "SIGTERM");
    expect(await pending).toBe(failure);
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(child.listenerCount("close")).toBe(0);
  });

  test("should reject a deadline failure and stop once when the command timeout expires", async () => {
    const { child, signals } = fixture();
    const scheduled = timers();
    const pending = runCommand("hung", [], {
      cwd: "/project",
      timeoutMs: 0,
    }).catch((error: unknown) => error);
    expect(scheduled[0]?.delay).toBe(1);
    scheduled[0]?.run();
    expect(signals.mock.calls).toEqual(
      process.platform === "win32" ? [] : [[-TEST_CHILD_PID, "SIGTERM"]],
    );
    expect(child.kill.mock.calls).toEqual(
      process.platform === "win32" ? [["SIGTERM"]] : [],
    );
    child.emit("close", null, "SIGTERM");
    expect(await pending).toMatchObject({ message: "Command timed out: hung" });
    expect(child.listenerCount("close")).toBe(0);
  });

  test.each([
    0,
    -1,
    NON_INTEGER_OUTPUT_LIMIT,
    Number.NaN,
    EXCESSIVE_OUTPUT_LIMIT_BYTES,
  ])(
    "should reject before spawning when the output limit is %s",
    async (maxOutputBytes) => {
      const { spawn } = fixture();
      await expect(
        runCommand("formatter", [], { cwd: "/project", maxOutputBytes }),
      ).rejects.toThrow(
        "Command output limit must be between 1 byte and 16 MiB",
      );
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  test("should reject an already-aborted caller before spawning a command", async () => {
    const { spawn } = fixture();
    const failure = new Error("cancelled before launch");
    await expect(
      runCommand("formatter", [], {
        cwd: "/project",
        signal: AbortSignal.abort(failure),
      }),
    ).rejects.toBe(failure);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("stopProcess", () => {
  if (process.platform !== "win32") {
    test("should fall back to the child signal when its process group has disappeared", async () => {
      const { child, processChild, signals } = fixture();
      signals.mockImplementation(() => {
        throw Object.assign(new Error("group disappeared"), { code: "ESRCH" });
      });
      const pending = stopProcess(processChild);
      expect(signals.mock.calls).toEqual([[-TEST_CHILD_PID, "SIGTERM"]]);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
      child.emit("close", null, "SIGTERM");
      await pending;
      expect(child.listenerCount("close")).toBe(0);
    });
  }

  test("should reject signaling failures and remove its close listener when termination cannot be requested", async () => {
    const { child, processChild, signals, activeSignals } = fixture();
    const scheduled = timers();
    const failure = Object.assign(new Error("permission denied"), {
      code: "EPERM",
    });
    activeSignals.mockImplementation(() => {
      throw failure;
    });
    await expect(stopProcess(processChild)).rejects.toBe(failure);
    expect(signals.mock.calls).toEqual(
      process.platform === "win32" ? [] : [[-TEST_CHILD_PID, "SIGTERM"]],
    );
    expect(child.kill.mock.calls).toEqual(
      process.platform === "win32" ? [["SIGTERM"]] : [],
    );
    expect(scheduled).toEqual([]);
    expect(child.listenerCount("close")).toBe(0);
  });

  test("should escalate to SIGKILL when graceful termination has not closed the child", async () => {
    const { child, processChild, signals } = fixture();
    const scheduled = timers();
    const pending = stopProcess(processChild);
    expect(scheduled[0]?.delay).toBe(FORCE_KILL_DELAY_MS);
    expect(signals.mock.calls).toEqual(
      process.platform === "win32" ? [] : [[-TEST_CHILD_PID, "SIGTERM"]],
    );
    expect(child.kill.mock.calls).toEqual(
      process.platform === "win32" ? [["SIGTERM"]] : [],
    );
    scheduled[0]?.run();
    expect(signals.mock.calls).toEqual(
      process.platform === "win32"
        ? []
        : [
            [-TEST_CHILD_PID, "SIGTERM"],
            [-TEST_CHILD_PID, "SIGKILL"],
          ],
    );
    expect(child.kill.mock.calls).toEqual(
      process.platform === "win32" ? [["SIGTERM"], ["SIGKILL"]] : [],
    );
    expect(scheduled[1]?.delay).toBe(FORCE_KILL_DEADLINE_MS);
    child.signalCode = "SIGKILL";
    child.emit("close", null, "SIGKILL");
    await pending;
    expect(child.listenerCount("close")).toBe(0);
  });

  test("should reject an unobserved exit when the force-kill deadline expires", async () => {
    const { child, processChild, signals } = fixture();
    const scheduled = timers();
    const pending = stopProcess(processChild).catch((error: unknown) => error);
    scheduled[0]?.run();
    scheduled[1]?.run();
    expect(await pending).toMatchObject({
      message: "Language-server process did not exit after SIGKILL",
    });
    expect(signals.mock.calls).toEqual(
      process.platform === "win32"
        ? []
        : [
            [-TEST_CHILD_PID, "SIGTERM"],
            [-TEST_CHILD_PID, "SIGKILL"],
          ],
    );
    expect(child.kill.mock.calls).toEqual(
      process.platform === "win32" ? [["SIGTERM"], ["SIGKILL"]] : [],
    );
    expect(child.listenerCount("close")).toBe(0);
  });
});
