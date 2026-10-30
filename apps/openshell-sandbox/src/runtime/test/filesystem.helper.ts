import type { Stats } from "node:fs";
import type * as filesystem from "node:fs/promises";
import { GATEWAY_TEST_CERTIFICATES } from "../../gateway/test/index.helper.ts";

const TLS_FILE = /\.(?:crt|key|pem)$/u;
const FILE_MODE = 0o10_0600;
const DIRECTORY_MODE = 0o4_0700;
type TestStat = Pick<
  Stats,
  | "dev"
  | "ino"
  | "uid"
  | "gid"
  | "mode"
  | "size"
  | "isDirectory"
  | "isFile"
  | "isSymbolicLink"
  | "isSocket"
>;
interface FakeFilesystemState {
  files: Map<string, string>;
  inodes: Map<string, number>;
  absent: Set<string>;
  identity: (path: string) => TestStat;
  read: (path: string) => string;
}

export type RuntimeTestFilesystem = Readonly<{
  filesystem: typeof filesystem;
  files: Map<string, string>;
  replace: (path: string) => void;
  missing: (path: string) => void;
}>;

/** In-memory external filesystem with stable inode ownership and synthetic TLS.
 * @example runtimeTestFilesystem().replace("/project/file") changes its identity.
 */
export function runtimeTestFilesystem(): RuntimeTestFilesystem {
  const files = new Map<string, string>();
  const inodes = new Map<string, number>();
  const absent = new Set<string>();
  let inode = 1;
  const identity = (path: string) => {
    if (isAbsent(path, absent) || path.endsWith("/.git")) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    if (!inodes.has(path)) {
      inode += 1;
      inodes.set(path, inode);
    }
    const file =
      files.has(path) ||
      TLS_FILE.test(path) ||
      path.endsWith("/kid") ||
      path === "/usr/bin/openshell-gateway";
    return {
      dev: 1,
      ino: inodes.get(path) ?? inode,
      uid: 1000,
      gid: 1000,
      mode: file ? FILE_MODE : DIRECTORY_MODE,
      size: 2048,
      isDirectory: () => !file,
      isFile: () => file,
      isSymbolicLink: () => false,
      isSocket: () => path === "/run/docker.sock",
    };
  };
  return {
    filesystem: fakeFilesystem({
      files,
      inodes,
      absent,
      identity,
      read: (path) => readExternalFile(path, files, absent),
    }),
    files,
    replace: (path) => {
      inode += 1;
      inodes.set(path, inode);
    },
    missing: (path) => {
      absent.add(path);
      files.delete(path);
      inodes.delete(path);
    },
  };
}

/** A removed directory makes every nested test-owned path unavailable.
 * @example isAbsent("/state/gateway/tls", new Set(["/state/gateway"])) is true.
 */
function isAbsent(path: string, absent: ReadonlySet<string>): boolean {
  for (const missing of absent) {
    if (path === missing || path.startsWith(`${missing}/`)) {
      return true;
    }
  }
  return false;
}

/** Reads synthetic TLS and test-owned files, refusing removed paths. */
function readExternalFile(
  path: string,
  files: Map<string, string>,
  absent: ReadonlySet<string>,
): string {
  if (isAbsent(path, absent)) {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }
  const [, relative] = path.split("/tls/");
  if (relative && GATEWAY_TEST_CERTIFICATES[relative]) {
    return GATEWAY_TEST_CERTIFICATES[relative];
  }
  const value = files.get(path);
  if (value === undefined) {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }
  return value;
}

/** Supplies filesystem side effects only; production ownership and readback remain real. */
function fakeFilesystem(state: FakeFilesystemState): typeof filesystem {
  const { files, inodes, absent, identity, read } = state;
  return Object.assign({} as typeof filesystem, {
    realpath: (path: string) => Promise.resolve(path),
    stat: (path: string) => Promise.resolve().then(() => identity(path)),
    access: (path: string) =>
      path === "/usr/bin/openshell-gateway"
        ? Promise.resolve()
        : Promise.reject(
            Object.assign(new Error("missing executable"), {
              code: "ENOENT",
            }),
          ),
    lstat: (path: string) => Promise.resolve().then(() => identity(path)),
    readlink: () => Promise.resolve("/usr/bin/openshell-gateway"),
    readFile: (path: string, encoding?: string) =>
      Promise.resolve().then(() =>
        encoding ? read(path) : Buffer.from(read(path)),
      ),
    mkdir: (path: string) =>
      Promise.resolve().then(() => {
        absent.delete(path);
        identity(path);
      }),
    chmod: () => Promise.resolve(),
    writeFile: (path: string, value: string) => {
      files.set(path, String(value));
      absent.delete(path);
      return Promise.resolve();
    },
    rm: (path: string) => {
      absent.add(path);
      for (const key of files.keys()) {
        if (key === path || key.startsWith(`${path}/`)) {
          files.delete(key);
        }
      }
      for (const key of inodes.keys()) {
        if (key === path || key.startsWith(`${path}/`)) {
          inodes.delete(key);
        }
      }
      return Promise.resolve();
    },
  });
}
