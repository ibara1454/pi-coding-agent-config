import type { Stats } from "node:fs";
import type * as filesystem from "node:fs/promises";
import type { GatewayHostContext as HostContext } from "../types.ts";

export const directory = "/state/pi-openshell-abcdefghijklmnop";

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
