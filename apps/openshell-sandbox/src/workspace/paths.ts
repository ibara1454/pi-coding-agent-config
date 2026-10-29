import {
  dirname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import type { HostPaths } from "../host/index.ts";
import type { WorkspaceFilesystem } from "./inspection.ts";

const FIRST_CONTROL_CODE = 32;
const DELETE_CODE = 127;

const reserved = [
  "/opt/openshell",
  "/etc/openshell",
  "/etc/openshell-tls",
  "/run/openshell",
  "/run/openshell-sidecar",
  "/proc",
  "/sys",
  "/dev",
];

/** Test segment containment, including equality; /repo-other is not inside /repo.
 * @example containsPath('/repo', '/repo/src') === true
 */
export function containsPath(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return (
    suffix === "" ||
    (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}

/** Reject ambiguous/non-local path spellings before filesystem or Git access.
 * @example validateAbsolutePath('/work/repo') returns without effects.
 */
export function validateAbsolutePath(path: string): void {
  if (!isAbsolute(path) || path.startsWith("//") || path.trim() !== path) {
    throw new Error("Workspace requires an unambiguous absolute local path");
  }
  for (const char of path) {
    if (
      char.charCodeAt(0) < FIRST_CONTROL_CODE ||
      char.charCodeAt(0) === DELETE_CODE
    ) {
      throw new Error("Workspace requires an unambiguous absolute local path");
    }
  }
}

/** Resolve absent protected descendants through their nearest existing ancestor.
 * Dangling symlinks and unreadable ancestors fail closed instead of hiding exposure.
 * @example resolveProtectedPath('/home/me/.ssh', fs) protects it even before creation.
 */
async function resolveProtectedPath(
  path: string,
  filesystem: WorkspaceFilesystem,
): Promise<string> {
  validateAbsolutePath(path);
  try {
    await filesystem.lstat(path);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
    const parent = dirname(path);
    if (parent === path) {
      throw error;
    }
    return resolve(
      await resolveProtectedPath(parent, filesystem),
      relative(parent, path),
    );
  }
  return filesystem.realpath(path);
}

/** Capture canonical host exclusions without globals or writes; missing future state is protected.
 * @param paths - Untrusted host path spellings that require canonical exclusion.
 * @param filesystem - Read-only host filesystem for symlink resolution.
 * @returns Canonical protected paths without writing host files.
 * @throws If any protected ancestor is inaccessible or ambiguous.
 * @example canonicalHostPaths(paths, fs) resolves a symlinked host home.
 */
export async function canonicalHostPaths(
  paths: HostPaths,
  filesystem: WorkspaceFilesystem,
): Promise<HostPaths> {
  const results = await Promise.allSettled(
    [paths.home, paths.sshDirectory, paths.dockerSocket, paths.stateRoot].map(
      (path) => resolveProtectedPath(path, filesystem),
    ),
  );
  const [home, sshDirectory, dockerSocket, stateRoot] = results.map(
    (result) => {
      if (result.status === "rejected") {
        throw new Error("Cannot resolve protected host paths");
      }
      return result.value;
    },
  );
  if (!(home && sshDirectory && dockerSocket && stateRoot)) {
    throw new Error("Cannot resolve protected host paths");
  }
  return { home, sshDirectory, dockerSocket, stateRoot };
}

/** Enforce host exposure and native control-target exclusions for each mirrored source.
 * Normal children of home remain allowed; ancestors of home never do.
 * @param path - Absolute mirrored host path being considered.
 * @param paths - Canonical host paths to protect from sandbox mounts.
 * @throws If the path overlaps host controls, reserved targets or an ancestor of home.
 * @example validateMountPath('/home/me/project', paths) allows an ordinary checkout.
 */
export function validateMountPath(path: string, paths: HostPaths): void {
  validateAbsolutePath(path);
  const protectedPaths = [
    paths.sshDirectory,
    paths.dockerSocket,
    paths.stateRoot,
  ];
  const overlap = (other: string): boolean =>
    containsPath(path, other) || containsPath(other, path);
  if (
    normalize(path) === sep ||
    containsPath(path, paths.home) ||
    containsPath(path, "/sandbox") ||
    [...reserved, ...protectedPaths].some(overlap)
  ) {
    throw new Error(
      "Workspace mount overlaps a protected host path or reserved sandbox target",
    );
  }
}
