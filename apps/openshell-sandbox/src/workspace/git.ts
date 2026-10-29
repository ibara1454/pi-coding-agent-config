import { dirname, join, normalize, resolve } from "node:path";
import type { HostPaths } from "../host/index.ts";
import { nativeFailure } from "../host/index.ts";
import type { GitProcess, WorkspaceFilesystem } from "./inspection.ts";
import { validateMountPath } from "./paths.ts";

const MAX_GIT_METADATA_BYTES = 4096;
const GIT_POINTER_PREFIX = "gitdir: ";
const TRAILING_NEWLINE = /\r?\n$/u;
const FIRST_CONTROL_CODE = 32;
const DELETE_CODE = 127;

interface GitMetadata {
  readonly gitDir: string;
  readonly commonDir: string;
}

/** Inspect a possibly absent linkage file without interpreting permission failures as absence.
 * @example optionalMetadata('/repo/.git', fs) returns undefined only for ENOENT.
 */
async function optionalMetadata(path: string, filesystem: WorkspaceFilesystem) {
  try {
    return await filesystem.lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw nativeFailure("Cannot inspect workspace Git metadata", error);
  }
}

/** Read one bounded ordinary Git linkage file; reject symlinks, devices and multiline paths.
 * @example readLinkage('/repo/.git', fs) returns 'gitdir: /repo.git/worktrees/topic'.
 */
async function readLinkage(
  path: string,
  filesystem: WorkspaceFilesystem,
): Promise<string> {
  const stat = await filesystem.lstat(path);
  if (
    !stat.isFile() ||
    stat.size > MAX_GIT_METADATA_BYTES ||
    (await filesystem.realpath(path)) !== path
  ) {
    throw new Error("Unsupported Git linkage file");
  }
  const text = await filesystem.readFile(path, "utf8");
  const value = text.replace(TRAILING_NEWLINE, "");
  if (!value || text.length > MAX_GIT_METADATA_BYTES) {
    throw new Error("Malformed Git linkage file");
  }
  for (const char of value) {
    if (
      char.charCodeAt(0) < FIRST_CONTROL_CODE ||
      char.charCodeAt(0) === DELETE_CODE
    ) {
      throw new Error("Malformed Git linkage file");
    }
  }
  return value;
}

/** Validate a metadata directory without permitting a symlink alias to enlarge mounts.
 * @example validateMetadataDirectory('/repo/.git', paths, fs) returns its unchanged path.
 */
async function validateMetadataDirectory(
  path: string,
  paths: HostPaths,
  filesystem: WorkspaceFilesystem,
): Promise<void> {
  validateMountPath(path, paths);
  if (
    (await filesystem.realpath(path)) !== path ||
    !(await filesystem.lstat(path)).isDirectory()
  ) {
    throw new Error("Unsupported Git metadata directory alias");
  }
}

/** Verify native Git's selected metadata matches the already checked linkage, hiding raw diagnostics.
 * The injected runner owns deadline, output limits, shell-free spawn and clean GIT_* environment.
 * @example queryMetadata('/work/topic', ['--absolute-git-dir'], run) returns one absolute path.
 */
async function queryMetadata(
  root: string,
  flags: readonly string[],
  run: GitProcess,
): Promise<string> {
  const result = await run(["-C", root, "rev-parse", ...flags]);
  if (result.exitCode !== 0 || result.stdout.length > MAX_GIT_METADATA_BYTES) {
    throw new Error("Git metadata query failed");
  }
  const path = result.stdout.replace(TRAILING_NEWLINE, "");
  if (normalize(path) !== path) {
    throw new Error("Git returned noncanonical metadata");
  }
  return path;
}

/** Resolve and verify linked-worktree forward/common/back pointers before executing Git.
 * @example linkedMetadata('/work/topic', paths, fs) identifies only its gitDir/commonDir.
 */
async function linkedMetadata(
  root: string,
  paths: HostPaths,
  filesystem: WorkspaceFilesystem,
): Promise<GitMetadata> {
  const pointer = await readLinkage(join(root, ".git"), filesystem);
  if (!pointer.startsWith(GIT_POINTER_PREFIX)) {
    throw new Error("Malformed Git worktree pointer");
  }
  const gitDir = resolve(root, pointer.slice(GIT_POINTER_PREFIX.length));
  await validateMetadataDirectory(gitDir, paths, filesystem);
  const commonDir = resolve(
    gitDir,
    await readLinkage(join(gitDir, "commondir"), filesystem),
  );
  await validateMetadataDirectory(commonDir, paths, filesystem);
  const backlink = resolve(
    gitDir,
    await readLinkage(join(gitDir, "gitdir"), filesystem),
  );
  if (
    backlink !== join(root, ".git") ||
    dirname(dirname(gitDir)) !== commonDir ||
    dirname(gitDir) !== join(commonDir, "worktrees")
  ) {
    throw new Error("Git metadata does not identify this linked checkout");
  }
  return { gitDir, commonDir };
}

/** Discover only ordinary or linked-worktree metadata, confirming native Git agrees with disk facts.
 * Malformed metadata fails closed, not as an implicit mount grant or non-Git checkout.
 * @example inspectGitMetadata('/repo', paths, fs, run) returns undefined without a .git entry.
 */
export async function inspectGitMetadata(
  root: string,
  paths: HostPaths,
  filesystem: WorkspaceFilesystem,
  run: GitProcess,
): Promise<GitMetadata | undefined> {
  const dotGit = join(root, ".git");
  const entry = await optionalMetadata(dotGit, filesystem);
  if (!entry) {
    return undefined;
  }
  let expected: GitMetadata;
  if (entry.isDirectory()) {
    await validateMetadataDirectory(dotGit, paths, filesystem);
    expected = { gitDir: dotGit, commonDir: dotGit };
  } else if (entry.isFile()) {
    expected = await linkedMetadata(root, paths, filesystem);
  } else {
    throw new Error("Unsupported Git metadata entry");
  }
  const results = await Promise.allSettled([
    queryMetadata(root, ["--absolute-git-dir"], run),
    queryMetadata(root, ["--path-format=absolute", "--git-common-dir"], run),
  ]);
  const [gitDir, commonDir] = results.map((result) => {
    if (result.status === "rejected") {
      throw new Error("Git metadata query failed");
    }
    return result.value;
  });
  if (gitDir !== expected.gitDir || commonDir !== expected.commonDir) {
    throw new Error("Git metadata disagrees with selected checkout linkage");
  }
  return Object.freeze(expected);
}
