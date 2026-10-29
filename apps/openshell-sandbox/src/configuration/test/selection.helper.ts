import type { SettingsFilesystem } from "../selection.ts";

export const CONTEXT = {
  agentDir: "/agent",
  cwd: "/project",
  projectTrusted: true,
};
export const POLICY =
  "version: 1\nfilesystem_policy:\n  read_write: [/explicit]\n";

/** Provide isolated file effects and record protected reads through the production loader.
 * @example files({"/agent/settings.json":"{}"}) treats every unlisted path as ENOENT.
 */
export function files(
  documents: Readonly<Record<string, string>>,
): SettingsFilesystem & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readFile(path) {
      reads.push(path);
      const value = documents[path];
      return value === undefined
        ? Promise.reject(
            Object.assign(new Error("missing"), { code: "ENOENT" }),
          )
        : Promise.resolve(value);
    },
  };
}

export const GLOBAL = JSON.stringify({
  openShellSandbox: { policyPath: "policy.yaml" },
});

/** Encode settings fixtures without mutating the supplied override declaration.
 * @example settings({providers:[]}) supplies an explicit empty provider override.
 */
export function settings(value: unknown): string {
  return JSON.stringify({ openShellSandbox: value });
}
