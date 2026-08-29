import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import lockfile from "proper-lockfile";
import {
  applySettingsMutations,
  captureMutationOwners,
  currentOwner,
  parseSettingsDocument,
} from "./settings.ts";
import { serializeSettings } from "./settings-serialization.ts";
import { validateTargetIdentity } from "./target-identity.ts";
import type {
  CommitRequest,
  CommitResult,
  JsonObject,
  ResourceScope,
  ScopeCommitResult,
  SettingsMutation,
  ToggleTarget,
} from "./types.ts";

export interface PersistenceIo {
  readonly lock: (path: string) => Promise<() => Promise<void>>;
  readonly read: (path: string) => Promise<string | undefined>;
  readonly validateTarget: (target: ToggleTarget) => void | Promise<void>;
  readonly writeAtomic: (path: string, content: string) => Promise<void>;
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function atomicReplace(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${path.split("/").at(-1) ?? "settings"}.extension-manager-${process.pid}-${randomUUID()}.tmp`,
  );

  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode;
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode });
    if (mode !== undefined) {
      await chmod(temporaryPath, mode);
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

const nodePersistenceIo: PersistenceIo = {
  async lock(path) {
    await mkdir(dirname(path), { recursive: true });
    return lockfile.lock(path, {
      realpath: false,
      retries: {
        retries: 9,
        factor: 1,
        minTimeout: 20,
        maxTimeout: 20,
      },
    });
  },
  read: readIfPresent,
  validateTarget: validateTargetIdentity,
  writeAtomic: atomicReplace,
};

function mutationsByScope(
  mutations: readonly SettingsMutation[],
): ReadonlyMap<ResourceScope, readonly SettingsMutation[]> {
  const grouped = new Map<ResourceScope, SettingsMutation[]>();
  for (const mutation of mutations) {
    const scoped = grouped.get(mutation.scope) ?? [];
    scoped.push(mutation);
    grouped.set(mutation.scope, scoped);
  }
  return grouped;
}

function scopeFailure(scope: ResourceScope, error: unknown): ScopeCommitResult {
  return {
    scope,
    status: "failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function commitSettings(
  request: CommitRequest,
  io: PersistenceIo = nodePersistenceIo,
): Promise<CommitResult> {
  const grouped = mutationsByScope(request.mutations);
  const scopes = (["global", "project"] as const).filter((scope) =>
    grouped.has(scope),
  );
  if (scopes.length === 0) {
    return { scopes: [], committedScopes: [] };
  }

  const releases: Array<() => Promise<void>> = [];
  try {
    for (const scope of scopes) {
      const document = request.documents.get(scope);
      if (document === undefined) {
        return {
          scopes: scopes.map((currentScope) => ({
            scope: currentScope,
            status: "failed",
            message: `Missing ${currentScope} settings snapshot`,
          })),
          committedScopes: [],
        };
      }
      try {
        releases.push(await io.lock(document.path));
      } catch (error) {
        return {
          scopes: scopes.map((currentScope) =>
            currentScope === scope
              ? scopeFailure(currentScope, error)
              : {
                  scope: currentScope,
                  status: "failed",
                  message: "Not written because another settings lock failed",
                },
          ),
          committedScopes: [],
        };
      }
    }

    const prepared = new Map<
      ResourceScope,
      {
        readonly content: string | undefined;
        readonly next: JsonObject;
        readonly path: string;
        readonly previous: JsonObject;
      }
    >();
    const conflicts = new Set<ResourceScope>();
    const validationFailures = new Map<ResourceScope, string>();

    for (const scope of scopes) {
      const document = request.documents.get(scope);
      const mutations = grouped.get(scope);
      if (document === undefined || mutations === undefined) {
        validationFailures.set(scope, "Missing commit input");
        continue;
      }
      if (document.error !== undefined) {
        validationFailures.set(scope, `Snapshot is invalid: ${document.error}`);
        continue;
      }

      try {
        const content = await io.read(document.path);
        const current = parseSettingsDocument(scope, document.path, content);
        if (current.error !== undefined) {
          validationFailures.set(
            scope,
            `Current settings are invalid: ${current.error}`,
          );
          continue;
        }

        const owners = captureMutationOwners(document.value, mutations);
        if (
          owners.some(
            (owner) =>
              !isDeepStrictEqual(
                owner.value,
                currentOwner(current.value, owner),
              ),
          )
        ) {
          conflicts.add(scope);
          continue;
        }

        for (const mutation of mutations) {
          await io.validateTarget(mutation.target);
        }
        prepared.set(scope, {
          content,
          next: applySettingsMutations(current.value, mutations),
          path: document.path,
          previous: current.value,
        });
      } catch (error) {
        validationFailures.set(
          scope,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (validationFailures.size > 0 || conflicts.size > 0) {
      return {
        scopes: scopes.map((scope) => {
          const failure = validationFailures.get(scope);
          if (failure !== undefined) {
            return { scope, status: "failed", message: failure };
          }
          if (conflicts.has(scope)) {
            return {
              scope,
              status: "conflict",
              message:
                "Relevant settings changed; close and reopen /extensions",
            };
          }
          return {
            scope,
            status: "failed",
            message: "Not written because another scope failed prevalidation",
          };
        }),
        committedScopes: [],
      };
    }

    const results: ScopeCommitResult[] = [];
    const committedScopes: ResourceScope[] = [];
    for (const scope of scopes) {
      const value = prepared.get(scope);
      if (value === undefined) {
        results.push({
          scope,
          status: "failed",
          message: "Missing validated settings",
        });
        continue;
      }
      if (isDeepStrictEqual(value.next, value.previous)) {
        results.push({ scope, status: "unchanged" });
        continue;
      }
      try {
        await io.writeAtomic(
          value.path,
          serializeSettings(value.next, value.content),
        );
        results.push({ scope, status: "committed" });
        committedScopes.push(scope);
      } catch (error) {
        results.push(scopeFailure(scope, error));
      }
    }
    return { scopes: results, committedScopes };
  } finally {
    for (const release of releases.reverse()) {
      await release().catch(() => undefined);
    }
  }
}
