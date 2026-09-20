import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: Spies must intercept live named imports of Node's process launcher.
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import process from "node:process";
import { PassThrough } from "node:stream";
import { runCommand } from "./process.ts";

const OUTPUT_OVERFLOW_BYTES = 600_000;
// 512 KiB (512 * 1024 bytes).
const DEFAULT_OUTPUT_LIMIT_BYTES = 524_288;
const TEST_CHILD_PID = 12_345;

const spawning: {
  spawn: (
    command: string,
    args: string[],
    options: childProcess.SpawnOptionsWithoutStdio,
  ) => childProcess.ChildProcessWithoutNullStreams;
} = childProcess;

afterEach(() => mock.restore());

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
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child: Pick<
      childProcess.ChildProcessWithoutNullStreams,
      "stdin" | "stdout" | "stderr" | "pid" | "signalCode"
    > &
      EventEmitter & { exitCode: number | null } = Object.assign(
      new EventEmitter(),
      {
        stdin: new PassThrough(),
        stdout,
        stderr,
        pid: TEST_CHILD_PID,
        exitCode: null,
        signalCode: null,
      },
    );
    spyOn(spawning, "spawn").mockReturnValue(
      child as childProcess.ChildProcessWithoutNullStreams,
    );
    const signals = spyOn(process, "kill").mockReturnValue(true);
    const controller = new AbortController();
    const result = runCommand("noisy", [], {
      cwd: "/project",
      maxOutputBytes: 4,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    try {
      stdout.write("overflow");
      stdout.write("more output");
      stderr.write("also overflowing");
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
    expect(signals.mock.calls).toEqual([[-TEST_CHILD_PID, "SIGTERM"]]);
  });
});
