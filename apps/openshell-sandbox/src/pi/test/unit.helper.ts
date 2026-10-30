import { spyOn } from "bun:test";
import { adapterFixture } from "./adapter.helper.ts";
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
