import type { realpath } from "node:fs/promises";

/** Controls raw canonicalization settlement while preserving Node's string/buffer encoding contract.
 * @param operation - Test-owned external canonicalization result; may remain pending until explicitly released.
 * @returns An external realpath adapter that waits for the planned result and honors buffer encoding.
 * @example plannedRealpath(async () => "/project")("/alias", "buffer") resolves to Buffer.from("/project").
 */
export function plannedRealpath(
  operation: (path: Parameters<typeof realpath>[0]) => Promise<string>,
) {
  return (async (
    path: Parameters<typeof realpath>[0],
    options?:
      | Parameters<typeof realpath>[1]
      | "buffer"
      | { encoding: "buffer" },
  ) => {
    const resolved = await operation(path);
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding === "buffer" ? Buffer.from(resolved) : resolved;
  }) as typeof realpath;
}
