import { mock, spyOn } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: Scoped spies isolate the adapter's configuration boundary.
import * as configuration from "../../configuration/index.ts";
import type { SandboxRuntime } from "../../runtime/index.ts";
// biome-ignore lint/performance/noNamespaceImport: Scoped spies isolate runtime acquisition and ownership.
import * as runtimeCapabilities from "../../runtime/index.ts";
import { unitRuntimeFixture } from "../../runtime/test/index.helper.ts";
import type { PiNativeCapabilities } from "../native-capabilities.ts";
import { adapterFixture, cachedStatus } from "./adapter.helper.ts";
import { nativeTextReader, piNativeFixture } from "./native.helper.ts";

const fixtureAgentDirectory = "/fixture/agent";

/** Minimal native policy loaded by the Pi fixture without host file I/O. */
export const baselinePolicy = `version: 1
filesystem_policy:
  include_workdir: false
  read_only: [/usr]
  read_write: [/sandbox, /tmp]
landlock:
  compatibility: hard_requirement
process:
  run_as_user: sandbox
  run_as_group: sandbox
network_policies: {}
`;

/** Supplies controlled native host, SDK, socket, and settings effects without host file I/O.
 * Restore spies after disposing any activation that uses this fixture.
 * @returns Pi adapter effects with native capabilities and fixture readers.
 * @example piUnitFixture().native.capture supplies the test-owned host capture.
 */
export function piUnitFixture() {
  const f = adapterFixture();
  const native = piNativeFixture();
  const settings = JSON.stringify({
    openShellSandbox: {
      policyPath: "/fixture-policy.yaml",
      image: "selected:tag",
      providers: [],
    },
  });
  const readFile = nativeTextReader((name) => {
    if (
      name === `${fixtureAgentDirectory}/settings.json` ||
      name === `${f.context.cwd}/.pi/settings.json`
    ) {
      return settings;
    }
    return name === "/fixture-policy.yaml" ||
      name.endsWith("assets/policy.yaml")
      ? baselinePolicy
      : undefined;
  }, native.filesystem.readFile);
  const read = spyOn(native.filesystem, "readFile").mockImplementation(
    readFile,
  );
  return {
    ...f,
    ...native,
    read,
    native: { ...native.native, agentDirectory: () => fixtureAgentDirectory },
    restore: () => {
      read.mockRestore();
      native.restore();
    },
  };
}

/** Isolates activation-owned decisions from configuration and native runtime preparation.
 * The runtime fixture supplies inert values and deterministic timers; no runtime is booted.
 * Restore spies after settling preparation and disposing activations.
 * @returns The adapter, controlled boundary outcomes, and owned spy restoration.
 * @example f.effects.mockRejectedValue(error) fails acquisition without filesystem or SDK work.
 */
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This fixture owns the adapter's complete set of configuration and runtime spies.
export function activationFixture() {
  const f = adapterFixture();
  const runtime = unitRuntimeFixture();
  const captureHome = mock(() => "/home/person");
  let identity = 0;
  const native: PiNativeCapabilities = {
    capture: {
      homedir: captureHome,
      ["randomUUID"]: () => {
        identity += 1;
        return `activation-${identity}`;
      },
      process: {
        env: { ["PATH"]: "/fixture/bin" },
        platform: "linux",
        arch: "x64",
        getuid: () => runtime.effects.host.uid,
      },
      filesystem: runtime.effects.filesystem,
      processEffects: runtime.effects.host.processEffects,
    },
    agentDirectory: () => "/fixture/agent",
    runtime: { execution: runtime.effects },
  };
  const load = spyOn(configuration, "loadSandboxEnvironment").mockResolvedValue(
    runtime.environment,
  );
  const effects = spyOn(
    runtimeCapabilities,
    "createRuntimeEffects",
  ).mockResolvedValue(runtime.effects);
  const dispose = mock(() => Promise.resolve());
  const handle: SandboxRuntime = {
    dispose,
    getStatus: () => cachedStatus(),
    exec: () => {
      throw new Error("unexpected execution");
    },
  };
  const create = spyOn(
    runtimeCapabilities,
    "createSandboxRuntime",
  ).mockResolvedValue(handle);
  return {
    ...f,
    runtime,
    native,
    captureHome,
    load,
    effects,
    create,
    dispose,
    handle,
    restore: () => {
      create.mockRestore();
      effects.mockRestore();
      load.mockRestore();
      runtime.clock.restore();
    },
  };
}
