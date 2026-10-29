import { describe, expect, test as it } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { type OpenShellClient, SandboxClient } from "@nvidia/openshell-sdk";
import { SandboxPhase, SandboxResponseSchema } from "@nvidia/openshell-sdk/raw";
import { executeRequest } from "../execution/index.ts";
import { completion } from "../execution/test/index.helper.ts";
import { runtimeFixture, unitRuntimeFixture } from "../test/index.helper.ts";
import { createGenerationSandbox, runGenerationSetup } from "./setup.ts";
import { gateway, work, workspace } from "./test/generation.helper.ts";
import type { GenerationEvent } from "./types.ts";

describe("createGenerationSandbox", () => {
  it.each([
    ["acknowledged", undefined, ["unknown", "acknowledged"]],
    [
      "rejected",
      new ConnectError("bad policy", Code.InvalidArgument),
      ["unknown", "rejected"],
    ],
    [
      "uncertain",
      new ConnectError("lost reply", Code.Unavailable),
      ["unknown"],
    ],
  ] as const)(
    "should record %s native creation outcome through actual settlement",
    async (_condition, error, expected) => {
      const fixture = runtimeFixture();
      const prepared = gateway(fixture);
      if (error) {
        fixture.sdk.beforeCreate = () => Promise.reject(error);
      }
      const current = work(fixture, prepared);
      const recorded: { outcome: string; id?: string }[] = [];
      try {
        const creation = createGenerationSandbox({
          work: current,
          gateway: prepared,
          workspace,
          image: "selected:tag",
          record: (outcome, id) =>
            recorded.push({ outcome, ...(id ? { id } : {}) }),
        });
        const [result] = await Promise.allSettled([creation]);
        expect(result?.status).toBe(error ? "rejected" : "fulfilled");
        expect(
          result?.status === "rejected" ? result.reason : result?.value,
        ).toBe(error ?? "sandbox-1");
        expect(recorded.map(({ outcome }) => outcome)).toEqual([...expected]);
      } finally {
        current.preparation.close();
      }
    },
  );
});

const MODEL_COMMAND_ARGUMENT_COUNT = 3;

/** Simulates readiness for the acknowledged sandbox before its name is reassigned.
 * @param client - SDK fixture updated with a real sandbox response and exec stream.
 * @param name - Name reassigned after the first readiness lookup.
 * @param labels - Owned gateway labels returned by readiness.
 * @param ownedPresent - Whether the acknowledged ID remains executable.
 * @returns Captured native targets and SDK lookup count after the fixture runs.
 * @example installReadyReplacement(client, "owned", {}, true).queries; // 0 before waitReady
 */
function installReadyReplacement(
  client: OpenShellClient,
  name: string,
  labels: Readonly<Record<string, string>>,
  ownedPresent: boolean,
) {
  const targets: string[] = [];
  const calls = { targets, queries: 0 };
  Object.assign(client.raw, {
    getSandbox: () => {
      const id = calls.queries === 0 ? "sandbox-1" : "replacement-b";
      calls.queries += 1;
      return Promise.resolve(
        create(SandboxResponseSchema, {
          sandbox: {
            metadata: { id, name, labels },
            status: { phase: SandboxPhase.READY },
          },
        }),
      );
    },
    async *execSandbox(request: { sandboxId: string; command: string[] }) {
      if (
        request.command.length !== MODEL_COMMAND_ARGUMENT_COUNT ||
        request.command[0] !== "/bin/bash" ||
        request.command[1] !== "-c" ||
        request.command[2] !== "printf MODEL_RESULT"
      ) {
        throw new Error("Only the requested model command is supported.");
      }
      targets.push(request.sandboxId);
      if (request.sandboxId === "sandbox-1" && !ownedPresent) {
        throw new Error("Owned sandbox is absent.");
      }
      await Promise.resolve();
      yield {
        payload: {
          case: "stdout",
          value: {
            data: Buffer.from("MODEL_RESULT"),
          },
        },
      };
      yield { payload: { case: "exit", value: { exitCode: 0 } } };
    },
  });
  Object.assign(client, {
    sandbox: new SandboxClient(client.sandbox.transport, client.raw),
  });
  return calls;
}
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("runGenerationSetup", () => {
  it("should refuse readiness when SDK returns the wrong acknowledged sandbox ID", async () => {
    const fixture = runtimeFixture();
    const prepared = gateway(fixture);
    const ready = fixture.sdk.client.sandbox.waitReady;
    fixture.sdk.client.sandbox.waitReady = async (...args) => ({
      ...(await ready(...args)),
      id: "replacement",
    });
    const current = work(fixture, prepared);
    try {
      await expect(runGenerationSetup(current)).rejects.toThrow("identity");
    } finally {
      current.preparation.close();
    }
  });

  it("should use the selected SDK image and return only sandbox locale without executing guest setup", async () => {
    const fixture = runtimeFixture();
    const prepared = gateway(fixture);
    fixture.native.sandboxId = "sandbox-1";
    fixture.native.sandboxName = "test-sandbox";
    fixture.native.labels = { ...prepared.handle.labels };
    const current = work(fixture, prepared);
    const events: GenerationEvent[] = [];
    try {
      const ready = await runGenerationSetup({
        ...current,
        report: (event) => events.push(event),
      });
      expect(ready.environment).toEqual({
        ["LANG"]: "C.UTF-8",
        ["LC_ALL"]: "C.UTF-8",
      });
      expect(fixture.sdk.commands).toEqual([]);
      expect(events).toContainEqual({
        generation: current.generation,
        kind: "image",
        image: "selected:tag",
      });
      expect(
        fixture.native.calls.some(
          (args) => args.includes("container") && args.includes("ls"),
        ),
      ).toBe(false);
    } finally {
      current.preparation.close();
    }
  });
  it.each([true, false])(
    "should execute model Bash only on the acknowledged ID when its name changes after readiness and owned presence is %s",
    async (ownedPresent) => {
      const fixture = unitRuntimeFixture();
      try {
        const prepared = gateway(fixture);
        const current = work(fixture, prepared);
        const calls = installReadyReplacement(
          fixture.sdk.client,
          current.generation.sandboxName,
          prepared.handle.labels,
          ownedPresent,
        );
        try {
          const ready = await runGenerationSetup(current);
          expect(ready.sandboxId).toBe("sandbox-1");
          expect(calls.targets).toEqual([]);
          const raw: Promise<unknown>[] = [];
          const result = await completion(
            executeRequest(
              "printf MODEL_RESULT",
              "/project",
              {},
              {
                effects: fixture.effects,
                admit: () => ({
                  ...current.generation,
                  readiness: Promise.resolve(ready),
                }),
                trackRaw: (operation) => raw.push(operation),
              },
            ),
          );
          await Promise.allSettled(raw);
          expect(result).toEqual(
            ownedPresent
              ? { output: "MODEL_RESULT", exitCode: 0, terminals: 1 }
              : expect.objectContaining({ output: "", terminals: 1 }),
          );
          expect(ownedPresent || result.error !== undefined).toBe(true);
          expect(calls.targets).toEqual(["sandbox-1"]);
          expect(calls.queries).toBe(1);
        } finally {
          current.preparation.close();
        }
        expect(fixture.clock.pending()).toBe(0);
      } finally {
        fixture.clock.restore();
      }
    },
  );
});
