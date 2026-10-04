import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
// biome-ignore lint/correctness/noUnresolvedImports: Biome 2.5.14 misses proper-lockfile's CommonJS default export, which Node and Bun provide.
import lockfile from "proper-lockfile";
import { commitSettings, type PersistenceIo } from "./persistence.ts";
import { parseSettingsDocument } from "./settings.ts";
import { validateTargetIdentity } from "./target-identity.ts";
import {
  manifestPackage,
  packageDrifts,
  withTemporaryRoot,
} from "./target-identity-test-fixtures.ts";
import type {
  CommitRequest,
  CommitResult,
  PackageToggleTarget,
  ResourceScope,
  SettingsDocument,
  SettingsMutation,
  TopLevelToggleTarget,
} from "./types.ts";

const settingsFileMode = 0o640;
const oversizedAtomicFilenamePadding = 230;

function topTarget(scope: ResourceScope): TopLevelToggleTarget {
  const baseDir = scope === "global" ? "/agent" : "/repo/.pi";
  const path = `${baseDir}/extensions/alpha.ts`;
  return {
    id: `${scope}-top`,
    type: "top-level",
    scope,
    kind: "extension",
    field: "extensions",
    canonicalPath: path,
    resolvedPath: path,
    filterPath: "extensions/alpha.ts",
    allPaths: [path],
    baseDir,
    occurrencePaths: [path],
  };
}

function request(
  documents: readonly SettingsDocument[],
  mutations: readonly SettingsMutation[],
): CommitRequest {
  return {
    documents: new Map(
      documents.map((candidate) => [candidate.scope, candidate]),
    ),
    mutations,
  };
}

/**
 * Keeps settings I/O in memory while validating real, test-owned package identity.
 * @example fakeIo(contents).io.validateTarget(target) // reads the package fixture
 */
function fakeIo(contents: Map<string, string | undefined>): {
  readonly io: PersistenceIo;
  readonly events: string[];
} {
  const events: string[] = [];
  return {
    events,
    io: {
      lock(path) {
        events.push(`lock:${path}`);
        return Promise.resolve(() => {
          events.push(`release:${path}`);
          return Promise.resolve();
        });
      },
      read(path) {
        events.push(`read:${path}`);
        return Promise.resolve(contents.get(path));
      },
      async validateTarget(target) {
        events.push(`validate:${target.id}`);
        await validateTargetIdentity(target);
      },
      writeAtomic(path, content) {
        events.push(`write:${path}`);
        contents.set(path, content);
        return Promise.resolve();
      },
    },
  };
}

function wrote(events: readonly string[]): boolean {
  return events.some((event) => event.startsWith("write:"));
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  await withTemporaryRoot("extension-manager-commit-", run);
}

/**
 * Creates a real, test-owned extension for default persistence validation.
 * @param root Canonical temporary root owned and removed by withRoot.
 * @returns A global target whose occurrence and canonical paths still exist.
 * @example await createFilesystemTarget(root) // root/extensions/alpha.ts exists
 */
async function createFilesystemTarget(
  root: string,
): Promise<TopLevelToggleTarget> {
  const path = join(root, "extensions", "alpha.ts");
  await mkdir(join(root, "extensions"));
  await writeFile(path, "export default () => {};\n");
  return {
    ...topTarget("global"),
    canonicalPath: path,
    resolvedPath: path,
    allPaths: [path],
    baseDir: root,
    occurrencePaths: [path],
  };
}

describe("commitSettings", () => {
  test("should atomically replace settings and retain permissions when an unrelated setting changes after staging", async () => {
    await withRoot(async (root) => {
      const target = await createFilesystemTarget(root);
      const path = join(root, "settings.json");
      const staged =
        '{\n\t"extensions": ["./extensions"],\n\t"theme": "dark"\n}\n';
      const current = staged.replace('"dark"', '"light"');
      const snapshot = parseSettingsDocument("global", path, staged);
      await writeFile(path, current);
      await chmod(path, settingsFileMode);
      const previous = await open(path, "r");

      try {
        const result = await commitSettings(
          request([snapshot], [{ scope: "global", target, enabled: false }]),
        );

        expect(result).toEqual({
          scopes: [{ scope: "global", status: "committed" }],
          committedScopes: ["global"],
        });
        expect(await readFile(path, "utf8")).toBe(
          `${JSON.stringify(
            {
              extensions: ["./extensions", "-extensions/alpha.ts"],
              theme: "light",
            },
            null,
            "\t",
          )}\n`,
        );
        expect((await stat(path)).mode & 0o777).toBe(settingsFileMode);
        expect(await previous.readFile("utf8")).toBe(current);
        expect((await previous.stat()).ino).not.toBe((await stat(path)).ino);
        expect((await readdir(root)).sort()).toEqual([
          "extensions",
          "settings.json",
        ]);
      } finally {
        await previous.close();
      }
    });
  });

  test("should create settings and parent directories when no settings file exists", async () => {
    await withRoot(async (root) => {
      const target = await createFilesystemTarget(root);
      const path = join(root, "nested", ".pi", "settings.json");
      const snapshot = parseSettingsDocument("global", path, undefined);

      const result = await commitSettings(
        request([snapshot], [{ scope: "global", target, enabled: false }]),
      );

      expect(result).toEqual({
        scopes: [{ scope: "global", status: "committed" }],
        committedScopes: ["global"],
      });
      expect(await readFile(path, "utf8")).toBe(
        '{\n  "extensions": [\n    "-extensions/alpha.ts"\n  ]\n}\n',
      );
      expect(await readdir(join(root, "nested", ".pi"))).toEqual([
        "settings.json",
      ]);
    });
  });

  test("should preserve both files and release earlier locks when another scope remains locked", async () => {
    await withRoot(async (root) => {
      const target = await createFilesystemTarget(root);
      const globalFile = join(root, "global.json");
      const projectFile = join(root, "project.json");
      const content = '{"extensions":["./extensions"]}\n';
      await writeFile(globalFile, content);
      await writeFile(projectFile, content);
      const input = request(
        [
          parseSettingsDocument("global", globalFile, content),
          parseSettingsDocument("project", projectFile, content),
        ],
        [
          { scope: "global", target, enabled: false },
          {
            scope: "project",
            target: { ...target, scope: "project", id: "project-top" },
            enabled: false,
          },
        ],
      );
      const release = await lockfile.lock(projectFile, { realpath: false });

      try {
        const result = await commitSettings(input);

        expect(result.committedScopes).toEqual([]);
        expect(result.scopes[0]).toEqual({
          scope: "global",
          status: "failed",
          message: "Not written because another settings lock failed",
        });
        expect(result.scopes[1]?.status).toBe("failed");
        expect(result.scopes[1]?.message).toContain(
          "Lock file is already being held",
        );
        expect(await readFile(globalFile, "utf8")).toBe(content);
        expect(await readFile(projectFile, "utf8")).toBe(content);
        expect((await readdir(root)).sort()).toEqual([
          "extensions",
          "global.json",
          "project.json",
          "project.json.lock",
        ]);
      } finally {
        await release();
      }

      expect(await commitSettings(input)).toEqual({
        scopes: [
          { scope: "global", status: "committed" },
          { scope: "project", status: "committed" },
        ],
        committedScopes: ["global", "project"],
      });
      for (const path of [globalFile, projectFile]) {
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
          extensions: ["./extensions", "-extensions/alpha.ts"],
        });
      }
      expect((await readdir(root)).sort()).toEqual([
        "extensions",
        "global.json",
        "project.json",
      ]);
    });
  });

  test("should commit once and reject stale input when concurrent commits share a snapshot", async () => {
    await withRoot(async (root) => {
      const target = await createFilesystemTarget(root);
      const path = join(root, "settings.json");
      const content = '{"extensions":["./extensions"]}\n';
      await writeFile(path, content);
      const input = request(
        [parseSettingsDocument("global", path, content)],
        [{ scope: "global", target, enabled: false }],
      );

      const results = await Promise.all([
        commitSettings(input),
        commitSettings(input),
      ]);

      expect(
        results.filter((result) => result.scopes[0]?.status === "committed"),
      ).toEqual([
        {
          scopes: [{ scope: "global", status: "committed" }],
          committedScopes: ["global"],
        },
      ]);
      expect(results.flatMap((result) => result.committedScopes)).toEqual([
        "global",
      ]);
      const conflictResult: CommitResult = {
        scopes: [
          {
            scope: "global",
            status: "conflict",
            message: "Relevant settings changed; close and reopen /extensions",
          },
        ],
        committedScopes: [],
      };
      const unsuccessful = results.filter(
        (result) => result.scopes[0]?.status !== "committed",
      );
      // Bounded lock retries can expire before the winning atomic write completes.
      const exactLockHeldFailure: CommitResult = {
        scopes: [
          {
            scope: "global",
            status: "failed",
            message: "Lock file is already being held",
          },
        ],
        committedScopes: [],
      };
      expect([[conflictResult], [exactLockHeldFailure]]).toContainEqual(
        unsuccessful,
      );
      expect(await commitSettings(input)).toEqual(conflictResult);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
        extensions: ["./extensions", "-extensions/alpha.ts"],
      });
      expect((await readdir(root)).sort()).toEqual([
        "extensions",
        "settings.json",
      ]);
    });
  });

  test("should report a read failure and release the lock when settings is a directory", async () => {
    await withRoot(async (root) => {
      const target = await createFilesystemTarget(root);
      const path = join(root, "settings.json");
      await mkdir(path);
      await writeFile(join(path, "sentinel"), "untouched");

      const result = await commitSettings(
        request(
          [parseSettingsDocument("global", path, undefined)],
          [{ scope: "global", target, enabled: false }],
        ),
      );

      expect(result.committedScopes).toEqual([]);
      expect(result.scopes[0]?.status).toBe("failed");
      expect(result.scopes[0]?.message).toContain("EISDIR");
      expect(await readFile(join(path, "sentinel"), "utf8")).toBe("untouched");
      expect(await readdir(path)).toEqual(["sentinel"]);
      expect((await readdir(root)).sort()).toEqual([
        "extensions",
        "settings.json",
      ]);
    });
  });

  test("should preserve the original file and remove locks when the atomic temporary filename exceeds the filesystem limit", async () => {
    await withRoot(async (root) => {
      const target = await createFilesystemTarget(root);
      // Settings and its .lock fit NAME_MAX; the unique atomic filename does not.
      const filename = `settings-${"x".repeat(oversizedAtomicFilenamePadding)}.json`;
      const path = join(root, filename);
      const content = '{"extensions":["./extensions"]}\n';
      await writeFile(path, content);
      await chmod(path, settingsFileMode);
      const before = await stat(path);

      const result = await commitSettings(
        request(
          [parseSettingsDocument("global", path, content)],
          [{ scope: "global", target, enabled: false }],
        ),
      );

      expect(result.committedScopes).toEqual([]);
      expect(result.scopes[0]?.status).toBe("failed");
      expect(result.scopes[0]?.message).toContain("ENAMETOOLONG");
      expect(await readFile(path, "utf8")).toBe(content);
      expect((await stat(path)).ino).toBe(before.ino);
      expect((await stat(path)).mode & 0o777).toBe(settingsFileMode);
      expect((await readdir(root)).sort()).toEqual(["extensions", filename]);
    });
  });

  test.each(packageDrifts)(
    "should leave settings untouched when %s",
    async (_label: string, prepare: (
      root: string,
    ) => PackageToggleTarget, drift: (
      target: PackageToggleTarget,
    ) => void, message: string) => {
      await withRoot(async (root) => {
        const target = prepare(root);
        const path = join(root, "settings.json");
        const content = '{"packages":["npm:kit"]}\n';
        const snapshot = parseSettingsDocument("global", path, content);
        const contents = new Map<string, string | undefined>([[path, content]]);
        const { io, events } = fakeIo(contents);

        drift(target);

        const result = await commitSettings(
          request([snapshot], [{ scope: "global", target, enabled: false }]),
          io,
        );

        expect(result.committedScopes).toEqual([]);
        expect(result.scopes[0]?.status).toBe("failed");
        expect(result.scopes[0]?.message).toContain(message);
        expect(wrote(events)).toBe(false);
        expect(contents.get(path)).toBe(content);
      });
    },
  );

  test("should commit when the real target identity still holds", async () => {
    await withRoot(async (root) => {
      const target = manifestPackage(root);
      const path = join(root, "settings.json");
      const content = '{"packages":["npm:kit"]}\n';
      const snapshot = parseSettingsDocument("global", path, content);
      const contents = new Map<string, string | undefined>([[path, content]]);
      const { io } = fakeIo(contents);

      const result = await commitSettings(
        request([snapshot], [{ scope: "global", target, enabled: false }]),
        io,
      );

      expect(result).toEqual({
        scopes: [{ scope: "global", status: "committed" }],
        committedScopes: ["global"],
      });
      expect(JSON.parse(contents.get(path) ?? "{}")).toEqual({
        packages: [{ source: "npm:kit", extensions: ["-alpha.ts"] }],
      });
    });
  });
});
