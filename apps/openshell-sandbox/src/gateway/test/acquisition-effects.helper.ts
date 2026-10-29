import type { SpawnOptions, spawn } from "node:child_process";
import { ChildProcess } from "node:child_process";
import type { Stats } from "node:fs";
import type * as filesystem from "node:fs/promises";
import { PassThrough } from "node:stream";
import { nativeResponseChild } from "../../host/test/index.helper.ts";
import type { GatewayHostContext as HostContext } from "../types.ts";

const DOCKER_COMMAND_END = 4;
export const directory = "/state/pi-openshell-abcdefghijklmnop";
export const labels = {
  "io.pi.openshell-sandbox.instance-id": "abcdefghijklmnop",
};
export const network = { name: "pi-openshell-abcdefghijklmnop", labels };

/** Intercepts simulated lstat facts without mutating the shared fixture.
 * @param host - The fixture host whose filesystem remains untouched.
 * @param change - Maps each observed path and stat to its test-owned value.
 * @returns A host with the altered lstat effect; original reads still fail normally.
 * @example withStats(host, (path, stat) => path === "/state" ? {...stat, uid: 99} : stat)
 */

export function withStats(
  host: HostContext,
  change: (path: string, stat: Stats) => Stats,
): HostContext {
  return {
    ...host,
    filesystem: {
      ...host.filesystem,
      lstat: async (path) =>
        change(String(path), await host.filesystem.lstat(path)),
    } as typeof filesystem,
  };
}

/** Replaces only test-owned read bytes, preserving original filesystem errors.
 * @param host - The original simulated host.
 * @param change - Maps the path and bytes before production consumes them.
 * @returns A host with altered readFile effect and unchanged underlying fixture.
 * @example withRead(host, (path, bytes) => path.endsWith("/tls.crt") ? Buffer.from("bad") : bytes)
 */

export function withRead(
  host: HostContext,
  change: (path: string, value: Buffer) => Buffer,
): HostContext {
  return {
    ...host,
    filesystem: {
      ...host.filesystem,
      readFile: async (
        path: Parameters<typeof filesystem.readFile>[0],
        options?: Parameters<typeof filesystem.readFile>[1],
      ) => {
        const value = await host.filesystem.readFile(path);
        const changed = change(String(path), value);
        return options === "utf8" ? changed.toString("utf8") : changed;
      },
    } as typeof filesystem,
  };
}

/** Simulates one Docker subprocess reply while delegating unrelated commands.
 * @param host - The original simulated host, never a native Docker process.
 * @param operation - The first two Docker words, such as "network inspect".
 * @param stdout - Bytes the synthetic child emits.
 * @param exitCode - Synthetic exit status, zero on success.
 * @returns A host with a synthetic subprocess seam.
 * @example withDockerOutput(host, "info --format", "bad").processEffects.spawn
 */

export function withDockerOutput(
  host: HostContext,
  operation: string,
  stdout: string,
  exitCode = 0,
): HostContext {
  const original = host.processEffects.spawn;
  return {
    ...host,
    processEffects: {
      ...host.processEffects,
      spawn: ((
        executable: string,
        argv: readonly string[],
        options: SpawnOptions,
      ) => {
        if (argv.slice(2, DOCKER_COMMAND_END).join(" ") !== operation) {
          return original(executable, argv, options);
        }
        const child = new ChildProcess();
        Object.defineProperties(child, {
          stdout: { value: new PassThrough() },
          stderr: { value: new PassThrough() },
        });
        queueMicrotask(() => {
          child.emit("spawn");
          child.stdout?.emit("data", Buffer.from(stdout));
          Object.defineProperty(child, "exitCode", { value: exitCode });
          // biome-ignore lint/plugin/biome-rules/use-undefined: Node child close reports null when no termination signal was received.
          child.emit("close", exitCode, null);
        });
        return child;
      }) as typeof spawn,
    },
  };
}

/** Simulate an unacknowledged network create followed by a planned recovery query.
 * @param host - In-memory host capabilities whose unrelated native replies remain unchanged.
 * @param candidate - Native listing bytes returned only after recovery is requested.
 * @returns The injected host and recorded recovery argv.
 * @example unacknowledgedNetwork(host, "").host supplies an empty exact recovery listing.
 */
export function unacknowledgedNetwork(host: HostContext, candidate: string) {
  const inspections: string[][] = [];
  const creation = withDockerOutput(host, "network create", "uncertain");
  return {
    host: {
      ...creation,
      processEffects: {
        ...creation.processEffects,
        spawn: ((
          executable: string,
          args: readonly string[],
          options: SpawnOptions,
        ) => {
          if (
            args[2] === "network" &&
            args[3] === "ls" &&
            args.includes("--no-trunc")
          ) {
            inspections.push([...args]);
            return nativeResponseChild(candidate);
          }
          return creation.processEffects.spawn(executable, args, options);
        }) as typeof spawn,
      },
    },
    inspections,
  };
}
