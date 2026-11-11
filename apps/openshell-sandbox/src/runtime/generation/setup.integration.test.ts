import { describe, expect, test as it } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { type OpenShellClient, SandboxClient } from "@nvidia/openshell-sdk";
import { SandboxPhase, SandboxResponseSchema } from "@nvidia/openshell-sdk/raw";
import { executeRequest } from "../execution/index.ts";
import { completion } from "../execution/test/index.helper.ts";
import { unitRuntimeFixture } from "../test/index.helper.ts";
import { runGenerationSetup } from "./setup.ts";
import { gateway, work } from "./test/generation.helper.ts";

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
describe("runGenerationSetup", () => {
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
