import { describe, expect, test as it, mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { RuntimeFailure } from "../diagnostics/index.ts";
import type { ExecutionEvents } from "../runtime/index.ts";
import { registerModelBash } from "./bash.ts";
import { AdapterActivation } from "./session/index.ts";
import { adapterFixture } from "./test/adapter.helper.ts";

// Captures the live SDK capability used by the adapter's registration boundary.
const piCapabilities = await import("@earendil-works/pi-coding-agent");

const firstOutputByte = 65;
const secondOutputByte = 66;
const byteViewEnd = 3;
const commandTimeoutSeconds = 3;

/** Records calls into the external Pi formatter without replacing sandbox routing.
 * @example execute("call", { command: "pwd" }) resolves to SDK-formatted content.
 */
function sdkExecuteFixture() {
  return mock(
    (
      _id: string,
      _parameters: { command: string; timeout?: number },
      _signal?: AbortSignal,
      _onUpdate?: unknown,
    ) =>
      Promise.resolve({
        content: [{ type: "text" as const, text: "SDK_FORMATTED" }],
        details: {},
      }),
  );
}

/** Captures the external Pi Bash capability while exercising real routing and stream ownership.
 * @example f.operations().exec("pwd", "/project", options) runs the production adapter.
 */
function bashFixture() {
  const f = adapterFixture();
  const created: {
    cwd: string;
    operations: BashOperations;
    exposeSessionEnvironment: boolean | undefined;
  }[] = [];
  const sdkExecute = sdkExecuteFixture();
  const { createBashTool } = piCapabilities;
  const factory = spyOn(piCapabilities, "createBashTool").mockImplementation(
    (cwd, options) => {
      if (!options?.operations) {
        throw new Error("missing sandbox operations");
      }
      created.push({
        cwd,
        operations: options.operations,
        exposeSessionEnvironment: options.exposeSessionEnvironment,
      });
      return { ...createBashTool(cwd, options), execute: sdkExecute };
    },
  );
  const activation = new AdapterActivation(f.context);
  const execution = new EventEmitter<ExecutionEvents>();
  const exec = mock(
    (_command: string, _cwd: string, _options: unknown) => execution,
  );
  activation.runtime = {
    exec,
    dispose: () => Promise.resolve(),
    getStatus: () => {
      throw new Error("unexpected status");
    },
  };
  let current: AdapterActivation | undefined = activation;
  registerModelBash(f.pi, () => current);
  const operations = created[0]?.operations;
  if (!operations) {
    factory.mockRestore();
    throw new Error("missing operations");
  }
  return {
    ...f,
    created,
    factory,
    activation,
    execution,
    exec,
    sdkExecute,
    operations,
    setCurrent: (value: AdapterActivation | undefined) => {
      current = value;
    },
  };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("registerModelBash", () => {
  it("should rebuild the external formatter for the invocation cwd without exposing host environment", async () => {
    const f = bashFixture();
    try {
      const tool = f.tools.get("bash");
      if (!tool) {
        throw new Error("missing Bash tool");
      }
      expect(tool.label).toBe("bash (OpenShell)");
      await tool.execute("call", { command: "pwd" }, undefined, undefined, {
        ...f.context,
        cwd: "/project/sub",
      });
      expect(f.created[1]?.cwd).toBe("/project/sub");
      expect(
        f.created.every((entry) => entry.exposeSessionEnvironment === false),
      ).toBe(true);
      expect(f.sdkExecute.mock.calls).toEqual([
        ["call", { command: "pwd" }, undefined, undefined],
      ]);
      expect(f.events.has("user_bash")).toBe(false);
    } finally {
      f.factory.mockRestore();
    }
  });
  it.each(["missing", "unprepared", "retired"])(
    "should reject model execution without host fallback when activation is %s",
    async (state) => {
      const f = bashFixture();
      try {
        if (state === "missing") {
          f.setCurrent(undefined);
        }
        if (state === "unprepared") {
          f.activation.runtime = undefined;
        }
        if (state === "retired") {
          f.activation.retire();
        }
        await expect(
          f.operations.exec("!host-looking text", "/project", {
            onData: () => undefined,
          }),
        ).rejects.toThrow("model Bash is blocked");
        expect(f.exec).not.toHaveBeenCalled();
        expect(f.sdkExecute).not.toHaveBeenCalled();
      } finally {
        f.factory.mockRestore();
      }
    },
  );
  it("should preserve byte views and detach all subscriptions when execution exits nonzero", async () => {
    const f = bashFixture();
    const onData = mock((_chunk: Buffer) => undefined);
    const controller = new AbortController();
    try {
      const result = f.operations.exec("!still sandboxed", "/project/sub", {
        onData,
        signal: controller.signal,
        timeout: commandTimeoutSeconds,
        env: { ["SECRET"]: "private" },
      } as Parameters<BashOperations["exec"]>[2]);
      const bytes = new Uint8Array([0, firstOutputByte, secondOutputByte, 0]);
      const buffer = Buffer.from("C");
      f.execution.emit("data", bytes.subarray(1, byteViewEnd));
      f.execution.emit("data", buffer);
      f.execution.emit("exit", { exitCode: 7 });
      expect(await result).toEqual({ exitCode: 7 });
      expect(onData.mock.calls.map(([chunk]) => chunk.toString())).toEqual([
        "AB",
        "C",
      ]);
      expect(onData.mock.calls[1]?.[0]).toBe(buffer);
      expect(f.exec.mock.calls).toEqual([
        [
          "!still sandboxed",
          "/project/sub",
          { signal: controller.signal, timeout: commandTimeoutSeconds },
        ],
      ]);
      expect(f.execution.eventNames()).toEqual([]);
      f.execution.emit("data", Buffer.from("late"));
      expect(onData).toHaveBeenCalledTimes(2);
    } finally {
      f.factory.mockRestore();
    }
  });
  it.each([
    ["active", new AbortController().signal, "timeout:1.5"],
    ["aborted", AbortSignal.abort(), "aborted"],
  ] as const)(
    "should adapt a classified timeout to Pi's error contract when the caller is %s",
    async (_state, signal, expectedMessage) => {
      const f = bashFixture();
      try {
        const result = f.operations.exec("pwd", "/project", {
          onData: () => undefined,
          signal,
          timeout: 1.5,
        });
        const rejection = result.catch((error: unknown) => error);
        const failure = new RuntimeFailure(
          "timeout",
          "deadline",
          "Command timed out",
        );
        f.execution.emit("error", failure);
        expect(await rejection).toEqual(new Error(expectedMessage));
        expect(f.execution.eventNames()).toEqual([]);
      } finally {
        f.factory.mockRestore();
      }
    },
  );
  it.each([
    [
      "unclassified timeout text",
      new Error("Command timed out"),
      commandTimeoutSeconds,
    ],
    [
      "cleanup after a timeout",
      new RuntimeFailure("cleanup", "cleanup", "Cleanup failed", {
        cause: new RuntimeFailure("timeout", "deadline", "Command timed out"),
      }),
      commandTimeoutSeconds,
    ],
    [
      "caller cancellation",
      new RuntimeFailure("aborted", "cancellation", "aborted"),
      commandTimeoutSeconds,
    ],
    [
      "a timeout without a command deadline",
      new RuntimeFailure("timeout", "deadline", "Command timed out"),
      undefined,
    ],
  ] as const)(
    "should preserve the original error after detaching subscriptions when execution reports %s",
    async (_condition, failure, timeout) => {
      const f = bashFixture();
      const controller = new AbortController();
      try {
        const result = f.operations.exec("pwd", "/project", {
          onData: () => undefined,
          signal: controller.signal,
          ...(timeout === undefined ? {} : { timeout }),
        });
        const rejection = result.catch((error: unknown) => error);
        controller.abort();
        f.execution.emit("error", failure);
        expect(await rejection).toBe(failure);
        expect(f.execution.eventNames()).toEqual([]);
      } finally {
        f.factory.mockRestore();
      }
    },
  );
});
