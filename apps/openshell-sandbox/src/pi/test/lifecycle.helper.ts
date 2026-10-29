import { spyOn } from "bun:test";
import type { RuntimeFixture } from "../../runtime/test/index.helper.ts";
import { runtimeFixture } from "../../runtime/test/index.helper.ts";
import { adapterFixture } from "./adapter.helper.ts";
import { baselinePolicy } from "./unit.helper.ts";

const runtimeEffects = await import("../../runtime/index.ts");
const filesystem = await import("node:fs/promises");

/** Replaces only settings I/O and platform-effect construction, retaining real adapter/runtime logic.
 * All native/fs/RPC effects are existing in-memory runtime fixtures; no native child is launched.
 * @example await f.events.get("session_start")?.({}, f.context) prepares a simulated native runtime.
 */
export function adapterRuntimeFixture() {
  const f = adapterFixture();
  const runtimes: RuntimeFixture[] = [];
  const readSettings = spyOn(filesystem, "readFile").mockImplementation(((
    path: Parameters<typeof filesystem.readFile>[0],
  ) => {
    const name = String(path);
    if (name.endsWith("settings.json")) {
      return Promise.resolve(
        JSON.stringify({
          openShellSandbox: {
            policyPath: "/fixture-policy.yaml",
            image: "selected:tag",
            providers: [],
          },
        }),
      );
    }
    if (name === "/fixture-policy.yaml") {
      return Promise.resolve(baselinePolicy);
    }
    return Promise.reject(new Error("Unexpected fixture read"));
  }) as typeof filesystem.readFile);
  const factory = spyOn(
    runtimeEffects,
    "createRuntimeEffects",
  ).mockImplementation((controller) => {
    const runtime = runtimeFixture();
    runtimes.push(runtime);
    runtime.sdk.execute = async function* () {
      await Promise.resolve();
      yield { stream: "stdout", data: Buffer.from("MODEL_RESULT") };
      yield { type: "exit", exitCode: 0 };
    };
    return Promise.resolve({
      ...runtime.effects,
      activationSignal: controller.signal,
    });
  });
  return { ...f, runtimes, readSettings, factory };
}

/** Invokes Pi's actual Bash tool formatting through the registered model-only route.
 * @example executeRegisteredBash(f) returns MODEL_RESULT from the simulated SDK, never host Bash.
 */
export function executeRegisteredBash(
  f: Pick<ReturnType<typeof adapterFixture>, "tools" | "context">,
  command = "fixture",
  signal?: AbortSignal,
) {
  const tool = f.tools.get("bash");
  if (!tool) {
    throw new Error("Missing Bash registration");
  }
  return tool.execute(
    "fixture-tool-call",
    { command },
    signal,
    undefined,
    f.context,
  );
}
