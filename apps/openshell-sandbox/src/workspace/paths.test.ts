import { describe, expect, test as it } from "bun:test";
import type { HostPaths } from "../host/index.ts";
import type { WorkspaceFilesystem } from "./inspection.ts";
import {
  canonicalHostPaths,
  containsPath,
  validateAbsolutePath,
  validateMountPath,
} from "./paths.ts";

const paths: HostPaths = {
  home: "/home/person",
  sshDirectory: "/home/person/.ssh",
  dockerSocket: "/run/docker.sock",
  stateRoot: "/home/person/.state/openshell",
};

function filesystem(
  aliases: Record<string, string>,
  denied?: string,
): WorkspaceFilesystem {
  const present = Object.fromEntries(
    [
      ...Object.values(paths),
      "/home/person/.state",
      "/home/person",
      "/run",
      "/",
    ].map((path) => [path, true]),
  );
  return {
    lstat: (path: unknown) =>
      Promise.resolve().then(() => {
        if (String(path) === denied) {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        if (!present[String(path)]) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return { isDirectory: () => true };
      }),
    realpath: (path: unknown) =>
      Promise.resolve(aliases[String(path)] ?? String(path)),
  } as WorkspaceFilesystem;
}

describe("containsPath", () => {
  it.each([
    ["/repo", "/repo", true],
    ["/repo", "/repo/src", true],
    ["/repo", "/repo-other", false],
    ["/repo", "/outside", false],
    ["/repo", "/repo/../outside", false],
  ])(
    "should classify containment under %s for child %s as %s",
    (parent, child, contained) => {
      expect(containsPath(parent, child)).toBe(contained);
    },
  );
});

describe("validateAbsolutePath", () => {
  it.each([
    "relative/path",
    "//remote/share",
    " /repo",
    "/repo ",
    "/repo\nchild",
    "/repo\u007fchild",
  ])("should reject ambiguous or non-local spelling when path is %s", (path) =>
    expect(() => validateAbsolutePath(path)).toThrow(),
  );
  it("should accept an ordinary absolute path without changing its spelling", () => {
    expect(validateAbsolutePath("/home/person/project")).toBeUndefined();
  });
});

describe("validateMountPath", () => {
  it.each([
    "/",
    "/home",
    paths.home,
    "/sandbox",
    "/run",
    paths.dockerSocket,
    paths.stateRoot,
    paths.sshDirectory,
    "/opt/openshell/project",
    "/etc/openshell",
    "/etc/openshell-tls",
    "/run/openshell-sidecar",
    "/proc/self",
    "/sys",
    "/dev",
  ])("should reject a protected mount overlap when path is %s", (path) => {
    expect(() => validateMountPath(path, paths)).toThrow();
  });
  it.each(["/home/person/project", "/work/repo", "/opt/openshell-other"])(
    "should permit an ordinary non-overlapping mount when path is %s",
    (path) => expect(validateMountPath(path, paths)).toBeUndefined(),
  );
});

describe("canonicalHostPaths", () => {
  it("should resolve missing protected descendants through a symlinked existing ancestor", async () => {
    const missing = filesystem({
      "/home/person/.state": "/work/linked-control",
    });
    const withoutState: HostPaths = {
      ...paths,
      stateRoot: "/home/person/.state/future/control",
    };
    const canonical = await canonicalHostPaths(withoutState, missing);
    expect(canonical.stateRoot).toBe("/work/linked-control/future/control");
    expect(() =>
      validateMountPath("/work/linked-control/future", canonical),
    ).toThrow();
  });

  it("should fail closed when protected ancestor is unreadable instead of assuming absence", async () => {
    const noAccess = filesystem({}, "/home/person/.state");
    await expect(
      canonicalHostPaths(
        { ...paths, stateRoot: "/home/person/.state/future/control" },
        noAccess,
      ),
    ).rejects.toThrow("Cannot resolve protected host paths");
  });

  it("should use canonical protected destinations rather than their symlink spellings", async () => {
    const canonical = await canonicalHostPaths(
      paths,
      filesystem({ [paths.sshDirectory]: "/work/private-ssh" }),
    );
    expect(canonical.sshDirectory).toBe("/work/private-ssh");
    expect(() =>
      validateMountPath("/work/private-ssh/repo", canonical),
    ).toThrow();
  });
  it("should fail closed when the root is missing rather than recurring past its own parent", async () => {
    const missing = {
      ...filesystem({}),
      lstat: () =>
        Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
    } as WorkspaceFilesystem;
    await expect(canonicalHostPaths(paths, missing)).rejects.toThrow(
      "Cannot resolve protected host paths",
    );
  });
  it("should reject a dangling protected symlink when canonical resolution fails", async () => {
    const missing = {
      ...filesystem({}),
      realpath: (path: Parameters<WorkspaceFilesystem["realpath"]>[0]) =>
        String(path) === paths.sshDirectory
          ? Promise.reject(
              Object.assign(new Error("dangling secret"), { code: "ENOENT" }),
            )
          : Promise.resolve(String(path)),
    } as WorkspaceFilesystem;
    await expect(canonicalHostPaths(paths, missing)).rejects.toThrow(
      "Cannot resolve protected host paths",
    );
  });
});
