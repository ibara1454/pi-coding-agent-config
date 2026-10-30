import { describe, expect, test as it, spyOn } from "bun:test";
import type { spawn } from "node:child_process";
import { ChildProcess } from "node:child_process";
import {
  defaultProcessEffects,
  nativeFailure,
  type ProcessEffects,
  runHostProcess,
} from "./process.ts";
import { HostProcessError } from "./process-types.ts";
import { processScenario } from "./test/process.helper.ts";

const NONZERO_EXIT = 7;
const TEST_DEADLINE_MS = 1000;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("runHostProcess", () => {
  it("should preserve nonzero exit and cap combined output when streams exceed the limit", async () => {
    const scenario = processScenario((child) => {
      child.stdout?.emit("data", Buffer.from("abcdef"));
      child.stderr?.emit("data", Buffer.from("secret-tail"));
      // biome-ignore lint/plugin/biome-rules/use-undefined: Node close reports a null signal after a numeric exit.
      child.emit("close", NONZERO_EXIT, null);
    });
    const launch = spyOn(scenario.effects, "spawn");
    const result = await runHostProcess(
      "/native",
      ["literal;not-shell"],
      { environment: {}, mode: "finite", timeoutMs: 1000, maxOutputBytes: 8 },
      scenario.effects,
    );
    expect(launch).toHaveBeenCalledWith("/native", ["literal;not-shell"], {
      env: {},
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result).toEqual({
      exitCode: NONZERO_EXIT,
      stdout: "abcdef",
      stderr: "se",
    });
  });
  it("should keep the owned direct child alive when the launch signal aborts", async () => {
    const scenario = processScenario(() => undefined);
    const effects = {
      ...scenario.effects,
      spawn: ((...args: Parameters<typeof spawn>) => {
        expect(args[2]?.detached).not.toBe(true);
        expect(args[2]?.stdio).toEqual(["ignore", "pipe", "pipe"]);
        return scenario.effects.spawn(...args);
      }) as typeof spawn,
    };
    const controller = new AbortController();
    const child = await runHostProcess(
      "/native",
      [],
      {
        environment: {},
        mode: "managed",
        timeoutMs: 1000,
        signal: controller.signal,
      },
      effects,
    );
    controller.abort();
    expect(scenario.signals).toEqual([]);
    await child.terminate();
    // biome-ignore lint/plugin/biome-rules/use-undefined: Node close reports a null exit code after signal termination.
    expect(await child.closed).toEqual({ exitCode: null, signal: "SIGTERM" });
  });

  it("should reject finite cancellation only after observing process close", async () => {
    const controller = new AbortController();
    const scenario = processScenario(() => controller.abort());
    const operation = runHostProcess(
      "/native",
      [],
      {
        environment: {},
        mode: "finite",
        timeoutMs: 1000,
        signal: controller.signal,
      },
      scenario.effects,
    );
    await expect(operation).rejects.toBeInstanceOf(HostProcessError);
    expect(scenario.signals).toEqual(["SIGTERM"]);
  });
  it("should retain uncertain process ownership instead of reporting successful cancellation", async () => {
    const controller = new AbortController();
    const scenario = processScenario(() => controller.abort(), false);
    const failure = await runHostProcess(
      "/native",
      [],
      {
        environment: {},
        mode: "finite",
        timeoutMs: 1000,
        signal: controller.signal,
      },
      scenario.effects,
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(HostProcessError);
    expect(scenario.signals).toEqual(["SIGTERM", "SIGKILL"]);
    // biome-ignore lint/plugin/biome-rules/use-undefined: Node close reports a null exit code after signal termination.
    scenario.child.emit("close", null, "SIGKILL");
    await expect(failure.process.closed).resolves.toEqual({
      // biome-ignore lint/plugin/biome-rules/use-undefined: Retained process ownership must expose Node's null exit code after signal termination.
      exitCode: null,
      signal: "SIGKILL",
    });
  });

  it("should not expose native error payloads when launch fails", async () => {
    const scenario = processScenario((child) => {
      child.emit("error", new Error("private-token-123"));
      // biome-ignore lint/plugin/biome-rules/use-undefined: Node close reports a null signal after a numeric exit.
      child.emit("close", -1, null);
    });
    const failure = await runHostProcess(
      "/native",
      [],
      { environment: {}, mode: "finite", timeoutMs: 1000 },
      scenario.effects,
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(HostProcessError);
    expect(String(failure)).not.toContain("private-token-123");
    expect(failure.cause).toBeInstanceOf(HostProcessError);
    expect((failure.cause as HostProcessError).cause).toBeUndefined();
  });
  it("should make managed termination idempotent when the child already closed", async () => {
    const scenario = processScenario((child) =>
      child.emit("close", 0, child.signalCode),
    );
    const managed = await runHostProcess(
      "/native",
      [],
      {
        environment: {},
        mode: "managed",
        timeoutMs: 1000,
      },
      scenario.effects,
    );
    await managed.terminate();
    await managed.terminate();
    expect(scenario.signals).toEqual([]);
    const closed = await managed.closed;
    expect(closed.exitCode).toBe(0);
    expect(closed.signal).toBeNull();
  });
  it("should wait for asynchronous observed close and release termination timers when SIGTERM completes", async () => {
    const scenario = processScenario(() => undefined, false);
    const scheduled: NodeJS.Timeout[] = [];
    const cleared: NodeJS.Timeout[] = [];
    const effects = {
      ...scenario.effects,
      signal: (
        child: Parameters<typeof scenario.effects.signal>[0],
        signal: NodeJS.Signals,
      ) => {
        scenario.signals.push(signal);
        queueMicrotask(() => child.emit("close", child.exitCode, signal));
      },
      setTimer: () => {
        const timer = {} as NodeJS.Timeout;
        scheduled.push(timer);
        return timer;
      },
      clearTimer: (timer: NodeJS.Timeout) => {
        cleared.push(timer);
      },
    };
    const managed = await runHostProcess(
      "/native",
      [],
      {
        environment: {},
        mode: "managed",
        timeoutMs: 1000,
      },
      effects,
    );
    const termination = managed.terminate();
    expect(managed.terminate()).toBe(termination);
    await termination;
    const closed = await managed.closed;
    await managed.terminate();
    expect(closed.exitCode).toBeNull();
    expect(closed.signal).toBe("SIGTERM");
    expect(scenario.signals).toEqual(["SIGTERM"]);
    expect(scheduled).toHaveLength(2);
    expect(cleared).toEqual(scheduled);
  });

  it("should sanitize synchronous spawn failure without creating a child", async () => {
    const scenario = processScenario(() => undefined);
    const effects: ProcessEffects = {
      ...scenario.effects,
      spawn: (() => {
        throw new Error("secret launch argument");
      }) as typeof spawn,
    };
    const error = await runHostProcess(
      "/native",
      [],
      { environment: {}, mode: "finite", timeoutMs: 1000 },
      effects,
    ).catch((failure) => failure as HostProcessError);
    expect(error).toBeInstanceOf(HostProcessError);
    expect(String(error)).not.toContain("secret launch argument");
    if (!(error instanceof HostProcessError)) {
      throw new Error("Expected sanitized spawn failure");
    }
    expect(error.process).toBeUndefined();
  });
  it("should return empty output when the output limit is zero", async () => {
    const scenario = processScenario((child) => {
      child.stdout?.emit("data", Buffer.from("discard"));
      child.stderr?.emit("data", Buffer.from("discard"));
      // biome-ignore lint/plugin/biome-rules/use-undefined: Node close reports a null signal after a numeric exit.
      child.emit("close", 0, null);
    });
    const result = await runHostProcess(
      "/native",
      [],
      {
        environment: {},
        mode: "finite",
        timeoutMs: 1000,
        maxOutputBytes: 0,
      },
      scenario.effects,
    );
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("should reject a finite process closed by signal instead of returning a false exit status", async () => {
    const scenario = processScenario((child) =>
      // biome-ignore lint/plugin/biome-rules/use-undefined: Node close reports a null exit code after signal termination.
      child.emit("close", null, "SIGTERM"),
    );
    await expect(
      runHostProcess(
        "/native",
        [],
        { environment: {}, mode: "finite", timeoutMs: 1000 },
        scenario.effects,
      ),
    ).rejects.toBeInstanceOf(HostProcessError);
  });
  it("should terminate a timed-out child and release the deadline", async () => {
    const scenario = processScenario(() => undefined);
    let deadline: (() => void) | undefined;
    let cleared = false;
    const effects: ProcessEffects = {
      ...scenario.effects,
      setTimer(callback, ms) {
        if (ms === TEST_DEADLINE_MS) {
          deadline = callback;
        }
        return {} as NodeJS.Timeout;
      },
      clearTimer: () => {
        cleared = true;
      },
    };
    const operation = runHostProcess(
      "/native",
      [],
      { environment: {}, mode: "finite", timeoutMs: 1000 },
      effects,
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    deadline?.();
    await expect(operation).rejects.toBeInstanceOf(HostProcessError);
    expect(scenario.signals).toEqual(["SIGTERM"]);
    expect(cleared).toBe(true);
  });

  it("should escalate termination to SIGKILL when SIGTERM has not closed the child", async () => {
    const scenario = processScenario(() => undefined, false);
    const effects: ProcessEffects = {
      ...scenario.effects,
      signal(child, signal) {
        scenario.signals.push(signal);
        if (signal === "SIGKILL") {
          // biome-ignore lint/plugin/biome-rules/use-undefined: Node close reports a null exit code after signal termination.
          child.emit("close", null, signal);
        }
      },
    };
    const managed = await runHostProcess(
      "/native",
      [],
      { environment: {}, mode: "managed", timeoutMs: 1000 },
      effects,
    );
    await managed.terminate();
    expect(scenario.signals).toEqual(["SIGTERM", "SIGKILL"]);
    // biome-ignore lint/plugin/biome-rules/use-undefined: Node close reports a null exit code after signal termination.
    expect(await managed.closed).toEqual({ exitCode: null, signal: "SIGKILL" });
    await managed.terminate();
    expect(scenario.signals).toHaveLength(2);
  });
  it("should retain process ownership until close after a termination signal throws", async () => {
    const scenario = processScenario(() => undefined);
    const effects: ProcessEffects = {
      ...scenario.effects,
      signal() {
        throw new Error("secret signal failure");
      },
    };
    const managed = await runHostProcess(
      "/native",
      [],
      { environment: {}, mode: "managed", timeoutMs: 1000 },
      effects,
    );
    const error = await managed
      .terminate()
      .catch((failure) => failure as HostProcessError);
    expect(error).toBeInstanceOf(HostProcessError);
    expect(String(error)).not.toContain("secret signal failure");
    await expect(managed.terminate()).rejects.toBeInstanceOf(HostProcessError);
    // biome-ignore lint/plugin/biome-rules/use-undefined: Node close reports a null exit code after signal termination.
    scenario.child.emit("close", null, "SIGTERM");
    // biome-ignore lint/plugin/biome-rules/use-undefined: Retained process ownership must expose Node's null exit code after signal termination.
    expect(await managed.closed).toEqual({ exitCode: null, signal: "SIGTERM" });
    await expect(managed.terminate()).resolves.toBeUndefined();
  });
  it("should accept observed close when the signal effect throws afterward", async () => {
    const scenario = processScenario(() => undefined, false);
    const effects: ProcessEffects = {
      ...scenario.effects,
      signal(child, signal) {
        // biome-ignore lint/plugin/biome-rules/use-undefined: Node close reports a null exit code after signal termination.
        child.emit("close", null, signal);
        throw new Error("signal threw after close");
      },
    };
    const managed = await runHostProcess(
      "/native",
      [],
      { environment: {}, mode: "managed", timeoutMs: 1000 },
      effects,
    );
    await expect(managed.terminate()).resolves.toBeUndefined();
    // biome-ignore lint/plugin/biome-rules/use-undefined: Node close reports a null exit code after signal termination.
    expect(await managed.closed).toEqual({ exitCode: null, signal: "SIGTERM" });
  });

  it("should fail closed when process output emits an error", async () => {
    const scenario = processScenario((child) => {
      child.stdout?.emit("error", new Error("private stream path"));
    });
    await expect(
      runHostProcess(
        "/native",
        [],
        { environment: {}, mode: "finite", timeoutMs: 1000 },
        scenario.effects,
      ),
    ).rejects.toBeInstanceOf(HostProcessError);
    expect(scenario.signals).toEqual(["SIGTERM"]);
  });
  it("should reject an already-aborted launch without spawning a process", async () => {
    const controller = new AbortController();
    controller.abort();
    let launches = 0;
    const scenario = processScenario(() => undefined);
    const effects: ProcessEffects = {
      ...scenario.effects,
      spawn: (() => {
        launches += 1;
        return scenario.child;
      }) as typeof spawn,
    };
    await expect(
      runHostProcess(
        "/native",
        [],
        {
          environment: {},
          mode: "finite",
          timeoutMs: 1000,
          signal: controller.signal,
        },
        effects,
      ),
    ).rejects.toBeInstanceOf(HostProcessError);
    expect(launches).toBe(0);
  });
});
describe("nativeFailure", () => {
  it("should retain only an already-sanitized cause when wrapping native failures", () => {
    const privateError = new Error("private-token-123");
    const safeError = new HostProcessError("Safe failure");
    expect(
      nativeFailure("Operation failed", privateError).cause,
    ).toBeUndefined();
    expect(nativeFailure("Operation failed", safeError).cause).toBe(safeError);
  });
});
describe("defaultProcessEffects.signal", () => {
  it.each([
    // biome-ignore lint/plugin/biome-rules/use-undefined: Node ChildProcess.signalCode is null before the child receives a signal.
    ["SIGTERM", null],
    ["SIGKILL", "SIGTERM"],
  ] as const)(
    "should signal the owned direct child handle with %s after previous signal %s",
    (signal, previous) => {
      const child = new ChildProcess();
      Object.defineProperty(child, "signalCode", { value: previous });
      const kill = spyOn(child, "kill").mockImplementation(() => true);
      try {
        defaultProcessEffects.signal(child, signal);
        expect(kill).toHaveBeenCalledWith(signal);
        expect(kill).toHaveBeenCalledTimes(1);
      } finally {
        kill.mockRestore();
      }
    },
  );

  it("should expose a child signal failure instead of claiming confirmed termination", () => {
    const child = new ChildProcess();
    const kill = spyOn(child, "kill").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      expect(() => defaultProcessEffects.signal(child, "SIGTERM")).toThrow(
        "denied",
      );
    } finally {
      kill.mockRestore();
    }
  });
});
