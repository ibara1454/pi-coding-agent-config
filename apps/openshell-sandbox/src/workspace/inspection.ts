import type * as fs from "node:fs/promises";
import type { HostPaths } from "../host/index.ts";
import { nativeFailure } from "../host/index.ts";
import { inspectGitMetadata } from "./git.ts";
import {
  canonicalHostPaths,
  containsPath,
  validateAbsolutePath,
  validateMountPath,
} from "./paths.ts";

export type WorkspaceFilesystem = Pick<
  typeof fs,
  "readFile" | "realpath" | "stat" | "lstat" | "access"
>;
/** A bounded, shell-free Git invocation with no inherited GIT_* overrides. */
export type GitProcess = (
  argv: readonly string[],
  signal?: AbortSignal,
) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export interface ProjectWorkspace {
  readonly projectRoot: string;
  readonly mounts: readonly {
    readonly type: "bind";
    readonly source: string;
    readonly target: string;
    readonly readOnly: false;
  }[];
  readonly requiredNativeReadWritePaths: readonly string[];
}

/** Inspect canonical project and required Git metadata with supplied read-only host effects.
 * Returns mirrored writable binds and required native grants, never mutates policy or host files.
 * Throws sanitized errors for missing directories, unsafe exposure and inconsistent Git linkage.
 * The runner must bound execution and strip inherited GIT_* overrides; no implicit host globals.
 * @example inspectWorkspace('/home/me/repo', paths, fs, git) reports '/home/me/repo' as a required grant.
 */
export async function inspectWorkspace(
  projectRoot: string,
  hostPaths: HostPaths,
  filesystem: WorkspaceFilesystem,
  gitProcess: GitProcess,
): Promise<ProjectWorkspace> {
  try {
    validateAbsolutePath(projectRoot);
    const root = await filesystem.realpath(projectRoot);
    const paths = await canonicalHostPaths(hostPaths, filesystem);
    validateMountPath(root, paths);
    if (!(await filesystem.stat(root)).isDirectory()) {
      throw new Error("Workspace root must be a directory");
    }
    const git = await inspectGitMetadata(root, paths, filesystem, gitProcess);
    const targets = [root];
    for (const path of git ? [git.commonDir, git.gitDir] : []) {
      if (!targets.some((target) => containsPath(target, path))) {
        if (targets.some((target) => containsPath(path, target))) {
          throw new Error("Overlapping workspace mounts");
        }
        targets.push(path);
      }
    }
    const mounts = targets.map((path) =>
      Object.freeze({
        type: "bind" as const,
        source: path,
        target: path,
        readOnly: false as const,
      }),
    );
    return Object.freeze({
      projectRoot: root,
      mounts: Object.freeze(mounts),
      requiredNativeReadWritePaths: Object.freeze(targets),
    });
  } catch (error) {
    throw nativeFailure(
      "Workspace inspection failed: select a local directory with safe canonical project/Git paths; host home, SSH, Docker and OpenShell control paths cannot be mounted",
      error,
    );
  }
}

/** Map a command directory using captured canonical facts only, without changing grants or mounts.
 * Both lexical and resolved cwd must stay inside the project; internal symlinks remain usable.
 * @param resolvedCwd - Canonical command directory returned by native realpath.
 * @throws If either cwd escapes the project or uses unsupported path spelling.
 * @example mapCommandDirectory(workspace, '/repo/link', '/repo/src') returns '/repo/link'.
 */
export function mapCommandDirectory(
  workspace: ProjectWorkspace,
  requestedCwd: string,
  resolvedCwd: string,
): string {
  validateAbsolutePath(requestedCwd);
  validateAbsolutePath(resolvedCwd);
  if (
    !(
      containsPath(workspace.projectRoot, requestedCwd) &&
      containsPath(workspace.projectRoot, resolvedCwd)
    )
  ) {
    throw new Error(
      "Command directory must remain inside the canonical project root",
    );
  }
  return requestedCwd;
}
