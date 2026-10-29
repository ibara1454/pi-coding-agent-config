import { describe, expect, test as it } from "bun:test";
import { EventEmitter } from "node:events";
import { RuntimeFailure } from "../diagnostics/index.ts";
import type { ExecutionEvents, ExecutionOptions } from "../runtime/index.ts";
import { registerModelBash } from "./bash.ts";
import { AdapterActivation } from "./session/index.ts";
import { adapterFixture, cachedStatus } from "./test/adapter.helper.ts";
import { executeRegisteredBash } from "./test/lifecycle.helper.ts";

/** Runs Pi's real Bash formatting against a controllable external execution stream.
 * @example emit("exit", {exitCode: 0}) settles the public tool and releases stream listeners.
 */
function streamFixture(
  run: (
    events: EventEmitter<ExecutionEvents>,
    options: ExecutionOptions,
  ) => void,
) {
  const f = adapterFixture();
  const activation = new AdapterActivation(f.context);
  const events = new EventEmitter<ExecutionEvents>();
  activation.runtime = {
    exec: (_command, _cwd, options = {}) => {
      queueMicrotask(() => run(events, options));
      return events;
    },
    getStatus: () => cachedStatus(),
    dispose: () => Promise.resolve(),
  };
  registerModelBash(f.pi, () => activation);
  return { ...f, activation, events };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("registerModelBash", () => {
  it.each(["not started", "unprepared", "retired"])(
    "should reject model execution without host fallback when the activation is %s",
    async (state) => {
      const f = adapterFixture();
      const activation = new AdapterActivation(f.context);
      if (state === "retired") {
        activation.retire();
      }
      registerModelBash(f.pi, () =>
        state === "not started" ? undefined : activation,
      );
      await expect(
        executeRegisteredBash(f, "printf unexpected-host"),
      ).rejects.toBeInstanceOf(Error);
    },
  );

  it("should decode only the selected bytes and detach listeners when mixed buffers complete", async () => {
    const f = streamFixture((events) => {
      const bytes = new Uint8Array(
        Buffer.from("PRIVATE_PREFIXMODEL_RESULTPRIVATE_SUFFIX"),
      );
      const start = "PRIVATE_PREFIX".length;
      events.emit("data", bytes.subarray(start, start + "MODEL_RESULT".length));
      events.emit("data", Buffer.from("\ncomplete"));
      events.emit("exit", { exitCode: 0 });
    });
    const result = await executeRegisteredBash(f);
    expect(result.content).toEqual([
      { type: "text", text: "MODEL_RESULT\ncomplete" },
    ]);
    expect(f.events.listenerCount("data")).toBe(0);
    expect(f.events.listenerCount("exit")).toBe(0);
    expect(f.events.listenerCount("error")).toBe(0);
  });
  it("should reject nonzero results without retaining stream listeners", async () => {
    const nonzeroExit = 7;
    const f = streamFixture((events) => {
      events.emit("data", Buffer.from("COMMAND_FAILED"));
      events.emit("exit", { exitCode: nonzeroExit });
    });
    await expect(executeRegisteredBash(f)).rejects.toBeInstanceOf(Error);
    expect(f.events.listenerCount("data")).toBe(0);
    expect(f.events.listenerCount("exit")).toBe(0);
    expect(f.events.listenerCount("error")).toBe(0);
  });

  it("should detach the entire stream when execution reports an error", async () => {
    const f = streamFixture((events) =>
      events.emit("error", new Error("SAFE_EXECUTION_FAILURE")),
    );
    await expect(executeRegisteredBash(f)).rejects.toBeInstanceOf(Error);
    expect(f.events.listenerCount("data")).toBe(0);
    expect(f.events.listenerCount("exit")).toBe(0);
    expect(f.events.listenerCount("error")).toBe(0);
  });
  it("should retain stdout and stderr with the timeout status when the runtime deadline expires", async () => {
    const f = streamFixture((events) => {
      events.emit("data", Buffer.from("STDOUT_BEFORE_TIMEOUT\n"));
      events.emit("data", Buffer.from("STDERR_BEFORE_TIMEOUT"));
      events.emit(
        "error",
        new RuntimeFailure("timeout", "deadline", "Command timed out"),
      );
    });
    const tool = f.tools.get("bash");
    if (!tool) {
      throw new Error("missing Bash tool");
    }
    await expect(
      tool.execute(
        "timeout-call",
        { command: "fixture", timeout: 1.5 },
        undefined,
        undefined,
        f.context,
      ),
    ).rejects.toEqual(
      new Error(
        "STDOUT_BEFORE_TIMEOUT\nSTDERR_BEFORE_TIMEOUT\n\nCommand timed out after 1.5 seconds",
      ),
    );
    expect(f.events.eventNames()).toEqual([]);
  });
  it.each([
    [
      "a non-timeout failure",
      new RuntimeFailure("execution", "command", "Execution failed"),
    ],
    [
      "cleanup after a timeout",
      new RuntimeFailure("cleanup", "cleanup", "Cleanup failed", {
        cause: new RuntimeFailure("timeout", "deadline", "Command timed out"),
      }),
    ],
  ] as const)(
    "should preserve the runtime error instead of timeout formatting when execution reports %s",
    async (_condition, failure) => {
      const f = streamFixture((events) => {
        events.emit("data", Buffer.from("OUTPUT_BEFORE_FAILURE"));
        events.emit("error", failure);
      });
      const tool = f.tools.get("bash");
      if (!tool) {
        throw new Error("missing Bash tool");
      }
      await expect(
        tool.execute(
          "failure-call",
          { command: "fixture", timeout: 1.5 },
          undefined,
          undefined,
          f.context,
        ),
      ).rejects.toBe(failure);
      expect(f.events.eventNames()).toEqual([]);
    },
  );
  it("should cancel the model execution and release stream subscriptions when Pi aborts", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const f = streamFixture((events, options) => {
      events.emit("data", Buffer.from("OUTPUT_BEFORE_ABORT"));
      options.signal?.addEventListener(
        "abort",
        () =>
          events.emit(
            "error",
            new RuntimeFailure("aborted", "cancellation", "aborted"),
          ),
        { once: true },
      );
      entered.resolve();
    });
    const pending = executeRegisteredBash(f, "fixture", controller.signal);
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      controller.abort();
      expect(await outcome).toEqual(
        new Error("OUTPUT_BEFORE_ABORT\n\nCommand aborted"),
      );
      expect(f.events.listenerCount("data")).toBe(0);
      expect(f.events.listenerCount("exit")).toBe(0);
      expect(f.events.listenerCount("error")).toBe(0);
    } finally {
      controller.abort();
      if (f.events.listenerCount("error")) {
        f.events.emit("error", new Error("fixture cleanup"));
      }
    }
  });
});
