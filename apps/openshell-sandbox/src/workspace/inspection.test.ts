import { describe, expect, test as it, mock } from "bun:test";
import type { HostPaths } from "../host/index.ts";
import {
  type GitProcess,
  inspectWorkspace,
  mapCommandDirectory,
  type WorkspaceFilesystem,
} from "./inspection.ts";

const paths: HostPaths = Object.freeze({
  home: "/home/person",
  sshDirectory: "/home/person/.ssh",
  dockerSocket: "/run/docker.sock",
  stateRoot: "/home/person/.local/state/openshell",
});

interface Entry {
  type: "directory" | "file" | "symlink";
  text?: string;
  real?: string;
  error?: Error;
}

/** Supply read-only filesystem facts and record forbidden Git calls; unknown files are absent rather than guessed.
 * @example fixture({'/work': {type:'directory'}}) supports a non-Git project.
 */
function fixture(entries: Record<string, Entry>) {
  const records: Record<string, Entry> = {
    ...Object.fromEntries(
      Object.values(paths).map((path) => [path, { type: "directory" }]),
    ),
    ...entries,
  };
  const get = (path: unknown): Entry => {
    const entry = records[String(path)];
    if (!entry) {
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    }
    if (entry.error) {
      throw entry.error;
    }
    return entry;
  };
  const stat = (path: unknown) =>
    Promise.resolve().then(() => {
      const entry = get(path);
      return {
        size: entry.text?.length ?? 0,
        isDirectory: () => entry.type === "directory",
        isFile: () => entry.type === "file",
        isSymbolicLink: () => entry.type === "symlink",
      };
    });
  const filesystem = {
    lstat: stat,
    stat,
    access: (path: unknown) =>
      Promise.resolve().then(() => {
        get(path);
      }),
    realpath: (path: unknown) =>
      Promise.resolve().then(() => get(path).real ?? String(path)),
    readFile: (path: unknown) =>
      Promise.resolve().then(() => get(path).text ?? ""),
  } as WorkspaceFilesystem;
  const unexpectedGit = mock(() =>
    Promise.reject(new Error("Git must not run")),
  );
  return { filesystem, records, unexpectedGit };
}

const root = "/home/person/projects/topic";
const commonDir = "/work/repo/.git";
const gitDir = `${commonDir}/worktrees/topic`;

/** Model a genuine linked checkout with explicit forward and backward linkage.
 * @example linkedFixture() requires only root and commonDir mounts.
 */
function linkedFixture() {
  return fixture({
    [root]: { type: "directory" },
    [`${root}/.git`]: { type: "file", text: `gitdir: ${gitDir}\n` },
    [gitDir]: { type: "directory" },
    [commonDir]: { type: "directory" },
    [`${gitDir}/commondir`]: { type: "file", text: "../..\n" },
    [`${gitDir}/gitdir`]: { type: "file", text: `${root}/.git\n` },
  });
}

const linkedGit: GitProcess = (argv) =>
  Promise.resolve({
    exitCode: 0,
    stderr: "",
    stdout: `${argv.includes("--absolute-git-dir") ? gitDir : commonDir}\n`,
  });

const MAX_GIT_METADATA_BYTES = 4096;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("inspectWorkspace", () => {
  it("should report only explicit native grants when a project is a normal child of home", async () => {
    const { filesystem, records, unexpectedGit } = fixture({
      [root]: { type: "directory" },
    });
    const before = structuredClone(records);
    const workspace = await inspectWorkspace(
      root,
      paths,
      filesystem,
      unexpectedGit,
    );
    expect(unexpectedGit).not.toHaveBeenCalled();
    expect(workspace.requiredNativeReadWritePaths).toEqual([root]);
    expect(workspace.mounts).toEqual([
      { type: "bind", source: root, target: root, readOnly: false },
    ]);
    expect(records).toEqual(before);
    expect(Object.isFrozen(workspace.requiredNativeReadWritePaths)).toBe(true);
  });

  it("should preserve linked checkout paths while deduplicating shared metadata", async () => {
    const { filesystem } = linkedFixture();
    const workspace = await inspectWorkspace(
      root,
      paths,
      filesystem,
      linkedGit,
    );
    expect(workspace.mounts.map((mount) => mount.target)).toEqual([
      root,
      commonDir,
    ]);
    expect(workspace.requiredNativeReadWritePaths).toEqual([root, commonDir]);
  });
  it("should avoid a separate metadata mount when an ordinary checkout contains its git directory", async () => {
    const { filesystem } = fixture({
      [root]: { type: "directory" },
      [`${root}/.git`]: { type: "directory" },
    });
    const git: GitProcess = () =>
      Promise.resolve({
        exitCode: 0,
        stdout: `${root}/.git\n`,
        stderr: "",
      });
    expect(
      (await inspectWorkspace(root, paths, filesystem, git))
        .requiredNativeReadWritePaths,
    ).toEqual([root]);
  });

  it.each([
    "/",
    "/home",
    paths.home,
    paths.sshDirectory,
    paths.stateRoot,
    "/run",
    "/opt/openshell/nested",
    "/sandbox",
    "/proc/project",
  ])(
    "should reject unsafe exposure when the selected root is %s",
    async (path) => {
      const { filesystem, unexpectedGit } = fixture({
        [path]: { type: "directory" },
      });
      await expect(
        inspectWorkspace(path, paths, filesystem, unexpectedGit),
      ).rejects.toThrow();
      expect(unexpectedGit).not.toHaveBeenCalled();
    },
  );
  it("should protect missing control directories through canonical ancestors", async () => {
    const { filesystem, records, unexpectedGit } = fixture({
      [root]: { type: "directory" },
    });
    delete records[paths.stateRoot];
    records["/home/person/.local/state"] = { type: "directory", real: root };
    await expect(
      inspectWorkspace(root, paths, filesystem, unexpectedGit),
    ).rejects.toThrow();
    expect(unexpectedGit).not.toHaveBeenCalled();
  });

  it("should reject a symlinked dotgit instead of mounting its target", async () => {
    const { filesystem, unexpectedGit } = fixture({
      [root]: { type: "directory" },
      [`${root}/.git`]: { type: "symlink", real: commonDir },
    });
    await expect(
      inspectWorkspace(root, paths, filesystem, unexpectedGit),
    ).rejects.toThrow();
    expect(unexpectedGit).not.toHaveBeenCalled();
  });

  it("should reject external metadata aliases before querying git", async () => {
    const { filesystem, records, unexpectedGit } = linkedFixture();
    records[gitDir] = { type: "directory", real: "/outside/metadata" };
    await expect(
      inspectWorkspace(root, paths, filesystem, unexpectedGit),
    ).rejects.toThrow();
    expect(unexpectedGit).not.toHaveBeenCalled();
  });

  it("should reject linked metadata that identifies a different checkout", async () => {
    const { filesystem, records, unexpectedGit } = linkedFixture();
    records[`${gitDir}/gitdir`] = {
      type: "file",
      text: "/other/worktree/.git\n",
    };
    await expect(
      inspectWorkspace(root, paths, filesystem, unexpectedGit),
    ).rejects.toThrow();
    expect(unexpectedGit).not.toHaveBeenCalled();
  });
  it("should reject native metadata disagreement without disclosing process diagnostics", async () => {
    const { filesystem } = linkedFixture();
    const git: GitProcess = () =>
      Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: "synthetic-secret",
      });
    const failure = await inspectWorkspace(root, paths, filesystem, git).catch(
      (error) => error,
    );
    expect(String(failure)).not.toContain("synthetic-secret");
    expect(String(failure)).toContain("Workspace inspection failed");
  });
  it("should reject a protected metadata mount even when the project itself is safe", async () => {
    const { filesystem, records, unexpectedGit } = linkedFixture();
    records[`${root}/.git`] = {
      type: "file",
      text: `gitdir: ${paths.sshDirectory}/worktrees/topic\n`,
    };
    await expect(
      inspectWorkspace(root, paths, filesystem, unexpectedGit),
    ).rejects.toThrow();
    expect(unexpectedGit).not.toHaveBeenCalled();
  });
  it("should reject successful native queries that disagree with on-disk linkage", async () => {
    const { filesystem } = linkedFixture();
    const git: GitProcess = () =>
      Promise.resolve({
        exitCode: 0,
        stdout: "/different/.git\n",
        stderr: "",
      });
    await expect(
      inspectWorkspace(root, paths, filesystem, git),
    ).rejects.toThrow();
  });
  it("should reject a non-directory project even when its realpath is safe", async () => {
    const { filesystem, unexpectedGit } = fixture({ [root]: { type: "file" } });
    await expect(
      inspectWorkspace(root, paths, filesystem, unexpectedGit),
    ).rejects.toThrow("Workspace inspection failed");
    expect(unexpectedGit).not.toHaveBeenCalled();
  });

  it("should reject ambiguous project spelling before any filesystem access", async () => {
    const { filesystem, unexpectedGit } = fixture({});
    await expect(
      inspectWorkspace("relative/project", paths, filesystem, unexpectedGit),
    ).rejects.toThrow("Workspace inspection failed");
    expect(unexpectedGit).not.toHaveBeenCalled();
  });

  it("should reject a protected canonical project even when the requested path appears safe", async () => {
    const { filesystem, unexpectedGit } = fixture({
      [root]: { type: "directory", real: paths.sshDirectory },
    });
    await expect(
      inspectWorkspace(root, paths, filesystem, unexpectedGit),
    ).rejects.toThrow("Workspace inspection failed");
    expect(unexpectedGit).not.toHaveBeenCalled();
  });

  it("should propagate unreadable Git metadata instead of treating it as an absent checkout", async () => {
    const { filesystem, records, unexpectedGit } = fixture({
      [root]: { type: "directory" },
    });
    records[`${root}/.git`] = {
      type: "file",
      error: Object.assign(new Error("secret filesystem permission"), {
        code: "EACCES",
      }),
    };
    const failure = await inspectWorkspace(
      root,
      paths,
      filesystem,
      unexpectedGit,
    ).catch((error) => error);
    expect(String(failure)).toContain("Workspace inspection failed");
    expect(String(failure)).not.toContain("secret filesystem permission");
    expect(unexpectedGit).not.toHaveBeenCalled();
  });
  it.each([
    ["oversized linkage", `gitdir: ${"a".repeat(MAX_GIT_METADATA_BYTES)}`],
    ["multiline linkage", `gitdir: ${gitDir}\nsecond line`],
    ["missing pointer prefix", `${gitDir}\n`],
    ["control character", `gitdir: ${gitDir}\t`],
  ])("should reject %s before running Git", async (_name, text) => {
    const { filesystem, records, unexpectedGit } = linkedFixture();
    records[`${root}/.git`] = { type: "file", text };
    await expect(
      inspectWorkspace(root, paths, filesystem, unexpectedGit),
    ).rejects.toThrow("Workspace inspection failed");
    expect(unexpectedGit).not.toHaveBeenCalled();
  });

  it("should reject linked metadata when the common directory is an alias", async () => {
    const { filesystem, records, unexpectedGit } = linkedFixture();
    records[commonDir] = { type: "directory", real: "/elsewhere/.git" };
    await expect(
      inspectWorkspace(root, paths, filesystem, unexpectedGit),
    ).rejects.toThrow("Workspace inspection failed");
    expect(unexpectedGit).not.toHaveBeenCalled();
  });

  it("should reject Git output with a noncanonical selected metadata path", async () => {
    const { filesystem } = linkedFixture();
    const noncanonical: GitProcess = (argv) =>
      Promise.resolve({
        exitCode: 0,
        stdout: `${argv.includes("--absolute-git-dir") ? `${gitDir}/../topic` : commonDir}\n`,
        stderr: "",
      });
    await expect(
      inspectWorkspace(root, paths, filesystem, noncanonical),
    ).rejects.toThrow("Workspace inspection failed");
  });
  it("should reject a linked common directory that would overlap its workspace mount", async () => {
    const enclosing = "/home/person/projects";
    const linked = `${enclosing}/worktrees/topic`;
    const { filesystem } = fixture({
      [root]: { type: "directory" },
      [`${root}/.git`]: { type: "file", text: `gitdir: ${linked}\n` },
      [enclosing]: { type: "directory" },
      [linked]: { type: "directory" },
      [`${linked}/commondir`]: { type: "file", text: "../..\n" },
      [`${linked}/gitdir`]: { type: "file", text: `${root}/.git\n` },
    });
    const git: GitProcess = (argv) =>
      Promise.resolve({
        exitCode: 0,
        stdout: `${argv.includes("--absolute-git-dir") ? linked : enclosing}\n`,
        stderr: "",
      });
    await expect(
      inspectWorkspace(root, paths, filesystem, git),
    ).rejects.toThrow("Workspace inspection failed");
  });

  it("should reject oversized Git query output before interpreting paths", async () => {
    const { filesystem } = linkedFixture();
    const git: GitProcess = () =>
      Promise.resolve({
        exitCode: 0,
        stdout: "x".repeat(MAX_GIT_METADATA_BYTES + 1),
        stderr: "",
      });
    await expect(
      inspectWorkspace(root, paths, filesystem, git),
    ).rejects.toThrow("Workspace inspection failed");
  });

  it("should reject a Git linkage file whose canonical target differs from its location", async () => {
    const { filesystem, records, unexpectedGit } = linkedFixture();
    records[`${root}/.git`] = {
      type: "file",
      real: "/outside/link",
      text: `gitdir: ${gitDir}\n`,
    };
    await expect(
      inspectWorkspace(root, paths, filesystem, unexpectedGit),
    ).rejects.toThrow("Workspace inspection failed");
    expect(unexpectedGit).not.toHaveBeenCalled();
  });
});

describe("mapCommandDirectory", () => {
  const workspace = Object.freeze({
    projectRoot: root,
    mounts: [],
    requiredNativeReadWritePaths: [],
  });

  it("should preserve an internal symlink spelling without mutating grants", () => {
    expect(mapCommandDirectory(workspace, `${root}/link`, `${root}/src`)).toBe(
      `${root}/link`,
    );
    expect(workspace.requiredNativeReadWritePaths).toEqual([]);
    expect(workspace.mounts).toEqual([]);
  });

  it.each([
    [`${root}/link`, "/outside"],
    [`${root}-other`, `${root}-other`],
    [`${root}/../outside`, `${root}/src`],
    ["relative", `${root}/src`],
  ])(
    "should reject an escaping or ambiguous cwd when requested %s resolves to %s",
    (requested, resolved) => {
      expect(() =>
        mapCommandDirectory(workspace, requested, resolved),
      ).toThrow();
    },
  );
  const unsafeWorkspace = Object.freeze({
    projectRoot: root,
    mounts: [],
    requiredNativeReadWritePaths: [],
  });
  it.each([
    [`${root}/link`, `${root}-other`],
    [`${root}/link`, "relative"],
    [`${root}/link`, `${root}/bad\npath`],
  ])(
    "should reject command cwd when requested %s resolves to unsafe %s",
    (requested, resolved) => {
      expect(() =>
        mapCommandDirectory(unsafeWorkspace, requested, resolved),
      ).toThrow();
    },
  );
});
