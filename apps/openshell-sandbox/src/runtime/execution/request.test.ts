import { describe, expect, test as it, spyOn } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { type OpenShellClient, SandboxClient } from "@nvidia/openshell-sdk";
import { SandboxResponseSchema } from "@nvidia/openshell-sdk/raw";
import { RuntimeFailure } from "../../diagnostics/index.ts";
import { plannedRealpath } from "../test/index.helper.ts";
import { executeRequest } from "./request.ts";
import { completion, requestFixture } from "./test/request.helper.ts";

const OVERSIZED_TIMEOUT_SECONDS = 2_147_484;
const FRACTIONAL_EXIT_CODE = 1.5;
const ELAPSED_TIMEOUT_MS = 1001;
const TIMEOUT_BUDGET_MS = 1000;
const STARTUP_DELAY_MS = 250;
const NONZERO_EXIT_CODE = 7;

/** Installs a same-name replacement; only the acknowledged ID remains executable.
 * @param client - SDK fixture whose raw lookup and sandbox view are replaced.
 * @param name - The original sandbox name now occupied by another ID.
 * @param ownedPresent - Whether the acknowledged ID can execute.
 * @returns Native execution targets and requests recorded by the SDK fixture.
 * @example installReplacement(client, "owned", true).targets; // [] before execution
 */
function installReplacement(
  client: OpenShellClient,
  name: string,
  ownedPresent: boolean,
) {
  const targets: string[] = [];
  const requests: unknown[] = [];
  Object.assign(client.raw, {
    getSandbox: () =>
      Promise.resolve(
        create(SandboxResponseSchema, {
          sandbox: { metadata: { id: "replacement-b", name } },
        }),
      ),
    async *execSandbox(request: { sandboxId: string }) {
      await Promise.resolve();
      targets.push(request.sandboxId);
      requests.push(request);
      if (request.sandboxId === "owned-a" && !ownedPresent) {
        throw new Error("Owned sandbox is absent.");
      }
      yield { payload: { case: "exit", value: { exitCode: 0 } } };
    },
  });
  Object.assign(client, {
    sandbox: new SandboxClient(client.sandbox.transport, client.raw),
  });
  return { targets, requests };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("executeRequest", () => {
  it.each([
    ["a nul command", "bad\0command", "/project", undefined],
    ["a relative cwd", "true", "relative", undefined],
    ["a nul cwd", "true", "/project\0", undefined],
    ["a zero timeout", "true", "/project", 0],
    ["an infinite timeout", "true", "/project", Number.POSITIVE_INFINITY],
    ["an oversized timeout", "true", "/project", OVERSIZED_TIMEOUT_SECONDS],
  ] as const)(
    "should reject before admission when input contains %s",
    async (_condition, command, cwd, timeout) => {
      const { fixture, owner } = requestFixture();
      try {
        let admissions = 0;
        const result = await completion(
          executeRequest(
            command,
            cwd,
            timeout === undefined ? {} : { timeout },
            {
              ...owner,
              admit: () => {
                admissions += 1;
                return owner.admit();
              },
            },
          ),
        );
        expect(result.error).toMatchObject({ failure: { code: "validation" } });
        expect(result.terminals).toBe(1);
        expect(admissions).toBe(0);
      } finally {
        fixture.clock.restore();
      }
    },
  );
  it("should reject cwd without native execution when it is not a directory", async () => {
    const { fixture, owner, raw } = requestFixture();
    try {
      fixture.filesystem.files.set("/project/file", "not a directory");
      const result = await completion(
        executeRequest("true", "/project/file", {}, owner),
      );
      expect(result.error).toMatchObject({
        failure: { code: "validation", operation: "cwd" },
      });
      expect(result.exitCode).toBeUndefined();
      expect(result.output).toBe("");
      expect(result.terminals).toBe(1);
      expect(raw).toHaveLength(1);
      expect(fixture.sdk.commands).toEqual([]);
    } finally {
      fixture.clock.restore();
    }
  });
  it("should deliver bytes before one nonzero exit", async () => {
    const { owner, fixture, raw } = requestFixture();
    try {
      fixture.sdk.execute = async function* () {
        await Promise.resolve();
        yield { stream: "stdout", data: Buffer.from("first") };
        yield { stream: "stderr", data: Buffer.from("second") };
        yield { type: "exit", exitCode: 124 };
      };
      const result = await completion(
        executeRequest("exit 124", "/project", {}, owner),
      );
      expect(result).toEqual({
        output: "firstsecond",
        exitCode: 124,
        terminals: 1,
      });
      expect(raw).toHaveLength(1);
    } finally {
      fixture.clock.restore();
    }
  });
  it.each([
    ["has no exit", []],
    [
      "has a fractional exit",
      [{ type: "exit", exitCode: FRACTIONAL_EXIT_CODE }],
    ],
    [
      "has data after exit",
      [
        { type: "exit", exitCode: 0 },
        { stream: "stdout", data: Buffer.from("late") },
      ],
    ],
    [
      "has duplicate exits",
      [
        { type: "exit", exitCode: 0 },
        { type: "exit", exitCode: 0 },
      ],
    ],
  ] as const)(
    "should invalidate execution when terminal stream %s",
    async (_condition, events) => {
      const { owner, fixture } = requestFixture();
      try {
        fixture.sdk.execute = async function* () {
          await Promise.resolve();
          yield* events;
        };
        const result = await completion(
          executeRequest("true", "/project", {}, owner),
        );
        expect(result.error).toMatchObject({
          failure: { code: "execution", operation: "stream" },
        });
        expect(result.terminals).toBe(1);
        expect(result.output).toBe("");
      } finally {
        fixture.clock.restore();
      }
    },
  );
  it("should fail without admission when the caller was already aborted", async () => {
    const { fixture, owner, raw } = requestFixture();
    try {
      const caller = new AbortController();
      caller.abort();
      let admitted = false;
      const result = await completion(
        executeRequest(
          "true",
          "/project",
          { signal: caller.signal },
          {
            ...owner,
            admit: () => {
              admitted = true;
              return owner.admit();
            },
          },
        ),
      );
      expect(result.error).toMatchObject({ failure: { code: "aborted" } });
      expect(admitted).toBe(false);
      expect(raw).toEqual([]);
    } finally {
      fixture.clock.restore();
    }
  });

  it("should subtract deferred startup and close the timer when a finite timeout exits normally", async () => {
    const { fixture, owner } = requestFixture();
    const setTimer = spyOn(fixture.effects, "setTimer");
    try {
      const result = completion(
        executeRequest("exit 7", "/project", { timeout: 1 }, owner),
      );
      fixture.clock.advance(STARTUP_DELAY_MS);
      expect((await result).exitCode).toBe(NONZERO_EXIT_CODE);
      expect(setTimer).toHaveBeenCalledWith(
        expect.any(Function),
        TIMEOUT_BUDGET_MS - STARTUP_DELAY_MS,
      );
      expect(fixture.clock.pending()).toBe(0);
    } finally {
      fixture.clock.restore();
    }
  });
  it("should report timeout and close the timer when readiness exceeds a finite timeout", async () => {
    const { fixture, owner, handle, raw } = requestFixture();
    const ready = await handle.readiness;
    const readiness = Promise.withResolvers<typeof ready>();
    const admitted = Promise.withResolvers<void>();
    try {
      const result = completion(
        executeRequest(
          "true",
          "/project",
          { timeout: 1 },
          {
            ...owner,
            admit: () => {
              admitted.resolve();
              return { ...handle, readiness: readiness.promise };
            },
          },
        ),
      );
      await admitted.promise;
      expect(fixture.clock.pending()).toBe(1);
      fixture.clock.advance(TIMEOUT_BUDGET_MS);
      fixture.clock.fire();
      expect((await result).error).toMatchObject({
        failure: { code: "timeout", operation: "deadline" },
      });
      expect(fixture.clock.pending()).toBe(0);
      expect(fixture.sdk.commands).toEqual([]);
    } finally {
      readiness.resolve(ready);
      await Promise.allSettled(raw);
      fixture.clock.restore();
    }
  });
  it("should include deferred startup in timeout and close its timer", async () => {
    const { fixture, owner } = requestFixture();
    try {
      const result = completion(
        executeRequest("true", "/project", { timeout: 1 }, owner),
      );
      fixture.clock.advance(ELAPSED_TIMEOUT_MS);
      expect((await result).error).toMatchObject({
        failure: { code: "timeout" },
      });
      expect(fixture.clock.pending()).toBe(0);
    } finally {
      fixture.clock.restore();
    }
  });
  it("should recover the preparation failure hidden by generation cancellation", async () => {
    const { fixture, owner, handle } = requestFixture();
    try {
      const canceled = new AbortController();
      canceled.abort();
      const failure = new RuntimeFailure(
        "preparation",
        "sandbox",
        "Sandbox readiness unavailable",
      );
      const readiness = Promise.reject(failure);
      readiness.catch(() => undefined);
      const result = await completion(
        executeRequest(
          "true",
          "/project",
          {},
          {
            ...owner,
            admit: () => ({ ...handle, signal: canceled.signal, readiness }),
          },
        ),
      );
      expect(result.error).toMatchObject({ failure: { operation: "sandbox" } });
      expect(fixture.sdk.commands).toEqual([]);
    } finally {
      fixture.clock.restore();
    }
  });
  it("should preserve cancellation when generation readiness resolves after generation-only cancellation", async () => {
    const { fixture, owner, handle, raw } = requestFixture();
    const ready = await handle.readiness;
    const readiness = Promise.withResolvers<typeof ready>();
    const admitted = Promise.withResolvers<void>();
    const canceled = new AbortController();
    try {
      const result = completion(
        executeRequest(
          "true",
          "/project",
          {},
          {
            ...owner,
            admit: () => {
              admitted.resolve();
              return {
                ...handle,
                signal: canceled.signal,
                readiness: readiness.promise,
              };
            },
          },
        ),
      );
      await admitted.promise;
      canceled.abort();
      readiness.resolve(ready);
      const outcome = await result;
      expect(outcome.error).toMatchObject({
        failure: { code: "aborted", operation: "cancellation" },
      });
      expect(outcome.exitCode).toBeUndefined();
      expect(outcome.terminals).toBe(1);
      expect(fixture.activation.signal.aborted).toBe(false);
      expect(fixture.sdk.commands).toEqual([]);
    } finally {
      readiness.resolve(ready);
      await Promise.allSettled(raw);
      fixture.clock.restore();
    }
  });
  it("should stop waiting while retaining raw filesystem work until settlement", async () => {
    const { fixture, owner, raw } = requestFixture();
    try {
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<string>();
      const caller = new AbortController();
      const effects = {
        ...fixture.effects,
        filesystem: {
          ...fixture.effects.filesystem,
          realpath: plannedRealpath(() => {
            entered.resolve();
            return released.promise;
          }),
        },
      };
      const result = completion(
        executeRequest(
          "true",
          "/project",
          { signal: caller.signal },
          { ...owner, effects },
        ),
      );
      await entered.promise;
      caller.abort();
      expect((await result).error).toMatchObject({
        failure: { code: "aborted" },
      });
      expect(raw).toHaveLength(1);
      released.resolve("/project");
      await Promise.allSettled(raw);
      expect(fixture.sdk.commands).toEqual([]);
    } finally {
      fixture.clock.restore();
    }
  });
  it("should surface cleanup failure when a data observer throws", async () => {
    const { fixture, owner } = requestFixture();
    try {
      const cleanup = new RuntimeFailure(
        "cleanup",
        "owned-resource",
        "Resource retained",
      );
      const emitter = executeRequest(
        "true",
        "/project",
        {},
        {
          ...owner,
          admit: () => ({
            ...owner.admit(),
            invalidate: () => Promise.reject(cleanup),
          }),
        },
      );
      emitter.on("data", () => {
        throw new Error("private observer failure");
      });
      const result = await completion(emitter);
      expect(result.error).toMatchObject({
        failure: { code: "cleanup", operation: "owned-resource" },
      });
      expect(result.terminals).toBe(1);
    } finally {
      fixture.clock.restore();
    }
  });

  it("should convert an unexpected lifetime failure into one deferred safe terminal error", async () => {
    const { fixture, owner, handle } = requestFixture();
    try {
      const result = await completion(
        executeRequest(
          "true",
          "/project",
          {},
          {
            ...owner,
            admit: () => ({
              ...handle,
              get signal(): AbortSignal {
                throw new Error("private lifetime failure");
              },
            }),
          },
        ),
      );
      expect(result.error).toMatchObject({ failure: { code: "execution" } });
      expect(JSON.stringify(result.error)).not.toContain("private lifetime");
      expect(result.terminals).toBe(1);
    } finally {
      fixture.clock.restore();
    }
  });
  it.each([true, false])(
    "should address only the acknowledged ID when its name resolves to a replacement and owned presence is %s",
    async (ownedPresent) => {
      const { fixture, owner, handle, raw } = requestFixture();
      try {
        const { targets, requests } = installReplacement(
          fixture.sdk.client,
          handle.sandboxName,
          ownedPresent,
        );
        const ready = {
          ...(await handle.readiness),
          sandboxId: "owned-a",
          environment: { ["LANG"]: "C.UTF-8" },
        };
        const result = await completion(
          executeRequest(
            "true",
            "/project",
            {},
            {
              ...owner,
              admit: () => ({
                ...owner.admit(),
                readiness: Promise.resolve(ready),
              }),
            },
          ),
        );
        expect(targets).toEqual(["owned-a"]);
        expect(requests).toEqual([
          {
            sandboxId: "owned-a",
            command: ["/bin/bash", "-c", "true"],
            workdir: "/project",
            environment: { ["LANG"]: "C.UTF-8" },
            timeoutSeconds: 0,
            stdin: new Uint8Array(),
            tty: false,
          },
        ]);
        expect(result.terminals).toBe(1);
        expect(result.exitCode).toBe(ownedPresent ? 0 : undefined);
        expect(Boolean(result.error)).toBe(!ownedPresent);
        await Promise.allSettled(raw);
      } finally {
        fixture.clock.restore();
      }
    },
  );
  it("should preserve stdout and stderr bytes without text decoding", async () => {
    const { fixture, owner, raw } = requestFixture();
    try {
      const stdout = Buffer.from("ff00c3", "hex");
      const stderr = Buffer.from("a91b", "hex");
      fixture.sdk.execute = async function* () {
        await Promise.resolve();
        yield { stream: "stdout", data: stdout };
        yield { stream: "stderr", data: stderr };
        yield { type: "exit", exitCode: 0 };
      };
      const chunks: Uint8Array[] = [];
      const emitter = executeRequest("true", "/project", {}, owner);
      emitter.on("data", (chunk) => chunks.push(chunk));
      const result = await completion(emitter);
      expect(chunks).toEqual([stdout, stderr]);
      expect(chunks[0]).toBe(stdout);
      expect(chunks[1]).toBe(stderr);
      expect(result.exitCode).toBe(0);
      expect(result.terminals).toBe(1);
      await Promise.allSettled(raw);
    } finally {
      fixture.clock.restore();
    }
  });
});
