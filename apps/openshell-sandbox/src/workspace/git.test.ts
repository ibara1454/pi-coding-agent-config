import { describe, expect, test as it, mock } from "bun:test";
import { setImmediate } from "node:timers/promises";
import type { HostPaths } from "../host/index.ts";
import { inspectGitMetadata } from "./git.ts";
import type { GitProcess, WorkspaceFilesystem } from "./inspection.ts";

const root = "/work/topic";
const commonDir = "/work/repo/.git";
const gitDir = `${commonDir}/worktrees/topic`;
const OVERSIZED_METADATA_BYTES = 4097;
const paths: HostPaths = {
  home: "/home/person",
  sshDirectory: "/home/person/.ssh",
  dockerSocket: "/run/docker.sock",
  stateRoot: "/state/openshell",
};
interface Entry {
  type: "directory" | "file" | "symlink";
  text?: string;
  real?: string;
  size?: number;
}
/** Model Git metadata without filesystem or process effects and record forbidden Git calls.
 * @example fixture().noGit remains uncalled when linkage validation fails.
 */
function fixture(linked = true) {
  const entries: Record<string, Entry> = linked
    ? {
        [`${root}/.git`]: { type: "file", text: `gitdir: ${gitDir}\r\n` },
        [gitDir]: { type: "directory" },
        [commonDir]: { type: "directory" },
        [`${gitDir}/commondir`]: { type: "file", text: "../..\n" },
        [`${gitDir}/gitdir`]: { type: "file", text: `${root}/.git\n` },
      }
    : { [`${root}/.git`]: { type: "directory" } };
  const get = (path: unknown) => {
    const entry = entries[String(path)];
    if (!entry) {
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    }
    return entry;
  };
  const filesystem = {
    lstat: (path: unknown) =>
      Promise.resolve().then(() => {
        const entry = get(path);
        return {
          isDirectory: () => entry.type === "directory",
          isFile: () => entry.type === "file",
          size: entry.size ?? entry.text?.length ?? 0,
        };
      }),
    realpath: async (path: unknown) => get(path).real ?? String(path),
    readFile: async (path: unknown) => get(path).text ?? "",
  } as WorkspaceFilesystem;
  const recorded: string[][] = [];
  const run: GitProcess = (argv) => {
    recorded.push([...argv]);
    const metadata = argv.includes("--absolute-git-dir") ? gitDir : commonDir;
    return Promise.resolve({
      exitCode: 0,
      stderr: "",
      stdout: `${linked ? metadata : `${root}/.git`}\n`,
    });
  };
  const noGit = mock(() => Promise.reject(new Error("Git must not run")));
  return { entries, filesystem, run, calls: recorded, noGit };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("inspectGitMetadata", () => {
  it("should return absence without querying Git when dotgit is missing", async () => {
    const f = fixture();
    delete f.entries[`${root}/.git`];
    expect(
      await inspectGitMetadata(root, paths, f.filesystem, f.noGit),
    ).toBeUndefined();
    expect(f.noGit).not.toHaveBeenCalled();
  });
  it("should redact unreadable metadata rather than treating it as absent when lstat fails", async () => {
    const f = fixture();
    const filesystem = {
      ...f.filesystem,
      lstat: () =>
        Promise.reject(
          Object.assign(new Error("secret permission"), { code: "EACCES" }),
        ),
    };
    const error = await inspectGitMetadata(
      root,
      paths,
      filesystem,
      f.noGit,
    ).catch((failure: unknown) => failure);
    expect(String(error)).toContain("Cannot inspect workspace Git metadata");
    expect(String(error)).not.toContain("secret permission");
    expect(f.noGit).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "should return frozen verified metadata when linked checkout is %p",
    async (linked) => {
      const f = fixture(linked);
      const result = await inspectGitMetadata(root, paths, f.filesystem, f.run);
      expect(result).toEqual(
        linked
          ? { gitDir, commonDir }
          : { gitDir: `${root}/.git`, commonDir: `${root}/.git` },
      );
      expect(Object.isFrozen(result)).toBe(true);
      expect(f.calls).toEqual([
        ["-C", root, "rev-parse", "--absolute-git-dir"],
        ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      ]);
    },
  );
  it.each([
    ["symlink entry", { type: "symlink" }],
    [
      "oversized stat",
      {
        type: "file",
        text: `gitdir: ${gitDir}`,
        size: OVERSIZED_METADATA_BYTES,
      },
    ],
    [
      "oversized contents",
      { type: "file", text: "x".repeat(OVERSIZED_METADATA_BYTES), size: 0 },
    ],
    ["empty contents", { type: "file", text: "" }],
    ["missing pointer prefix", { type: "file", text: gitDir }],
    ["embedded newline", { type: "file", text: `gitdir: ${gitDir}\nextra` }],
    ["delete control", { type: "file", text: `gitdir: ${gitDir}\u007f` }],
    [
      "canonical alias",
      { type: "file", text: `gitdir: ${gitDir}`, real: "/outside/link" },
    ],
  ] satisfies readonly (readonly [string, Entry])[])(
    "should reject linkage before querying Git when dotgit has %s",
    async (_condition, entry) => {
      const f = fixture();
      f.entries[`${root}/.git`] = entry;
      await expect(
        inspectGitMetadata(root, paths, f.filesystem, f.noGit),
      ).rejects.toThrow();
      expect(f.noGit).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["metadata alias", gitDir, { type: "directory", real: "/elsewhere/git" }],
    ["non-directory metadata", gitDir, { type: "file" }],
    ["non-file common pointer", `${gitDir}/commondir`, { type: "directory" }],
    [
      "foreign back pointer",
      `${gitDir}/gitdir`,
      { type: "file", text: "/other/.git" },
    ],
    [
      "foreign common pointer",
      `${gitDir}/commondir`,
      { type: "file", text: "/work/foreign" },
    ],
  ] satisfies readonly (readonly [string, string, Entry])[])(
    "should reject linked metadata before querying Git when it has %s",
    async (_condition, path, entry) => {
      const f = fixture();
      f.entries[path] = entry;
      f.entries["/work/foreign"] = { type: "directory" };
      await expect(
        inspectGitMetadata(root, paths, f.filesystem, f.noGit),
      ).rejects.toThrow();
      expect(f.noGit).not.toHaveBeenCalled();
    },
  );
  it("should reject a protected metadata directory before accessing it when the pointer names SSH state", async () => {
    const f = fixture();
    f.entries[`${root}/.git`] = {
      type: "file",
      text: `gitdir: ${paths.sshDirectory}`,
    };
    await expect(
      inspectGitMetadata(root, paths, f.filesystem, f.noGit),
    ).rejects.toThrow("protected");
    expect(f.noGit).not.toHaveBeenCalled();
  });
  it.each([
    ["nonzero exit", { exitCode: 1, stdout: gitDir, stderr: "secret" }],
    [
      "oversized output",
      { exitCode: 0, stdout: "x".repeat(OVERSIZED_METADATA_BYTES), stderr: "" },
    ],
    [
      "noncanonical output",
      { exitCode: 0, stdout: `${gitDir}/../topic`, stderr: "" },
    ],
    ["disagreeing output", { exitCode: 0, stdout: "/other/git", stderr: "" }],
  ])(
    "should reject native metadata when Git returns %s",
    async (_condition, result) => {
      const f = fixture();
      await expect(
        inspectGitMetadata(root, paths, f.filesystem, async () => result),
      ).rejects.toThrow("Git metadata");
    },
  );
  it("should settle both queries and suppress raw process errors when one query rejects", async () => {
    const f = fixture();
    const queried: string[][] = [];
    const secondStarted = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<void>();
    const run: GitProcess = (argv) => {
      queried.push([...argv]);
      if (argv.includes("--absolute-git-dir")) {
        return Promise.reject(new Error("secret process"));
      }
      secondStarted.resolve();
      return pending.promise.then(() => ({
        exitCode: 0,
        stdout: commonDir,
        stderr: "",
      }));
    };
    let settled = false;
    const observed = inspectGitMetadata(root, paths, f.filesystem, run)
      .catch((failure: unknown) => failure)
      .finally(() => {
        settled = true;
      });
    try {
      await secondStarted.promise;
      await setImmediate();
      expect(settled).toBe(false);
      expect(queried).toEqual([
        ["-C", root, "rev-parse", "--absolute-git-dir"],
        ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      ]);
      pending.resolve();
      expect(String(await observed)).toBe("Error: Git metadata query failed");
    } finally {
      pending.resolve();
      await observed;
    }
  });
});
