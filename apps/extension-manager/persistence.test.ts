import { describe, expect, test } from "bun:test";
import { commitSettings, type PersistenceIo } from "./persistence.ts";
import { parseSettingsDocument } from "./settings.ts";
import type {
  CommitRequest,
  CommitResult,
  ResourceScope,
  ScopeCommitResult,
  SettingsDocument,
  SettingsMutation,
  TopLevelToggleTarget,
} from "./types.ts";

const globalPath = "/agent/settings.json";
const projectPath = "/repo/.pi/settings.json";
const validSettings = '{"extensions":["./extensions"]}\n';
const twoScopeWriteAndReleaseEventCount = 4;
const oneScopeWriteAndReleaseEventCount = 3;
const conflictMessage =
  "Relevant settings changed; close and reopen /extensions";
const prevalidationMessage =
  "Not written because another scope failed prevalidation";

/**
 * Builds an inert target for coordination tests; no resource is created.
 * @example topTarget("global").id // "global-top"
 */
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

/**
 * Stages both scopes with a selectable project snapshot and disabling mutations.
 * @example request().mutations.length // 2
 */
function request(projectContent = validSettings): CommitRequest {
  const documents: SettingsDocument[] = [
    parseSettingsDocument("global", globalPath, validSettings),
    parseSettingsDocument("project", projectPath, projectContent),
  ];
  const mutations: SettingsMutation[] = [
    { scope: "global", target: topTarget("global"), enabled: false },
    { scope: "project", target: topTarget("project"), enabled: false },
  ];
  return {
    documents: new Map(documents.map((document) => [document.scope, document])),
    mutations,
  };
}

interface IoOptions {
  readonly projectContent?: string | undefined;
  readonly failLock?: string;
  readonly failRead?: string;
  readonly failValidation?: string | undefined;
  readonly failWrite?: string;
  readonly failRelease?: string;
}

/**
 * Records persistence effects with deterministic read, failure, and release outcomes.
 * No filesystem state or pure settings policy is mocked.
 * @example fakeIo({ failWrite: projectPath }) // only the project write rejects
 */
function fakeIo(options: IoOptions = {}): {
  readonly io: PersistenceIo;
  readonly events: string[];
} {
  const events: string[] = [];
  return {
    events,
    io: {
      lock(path) {
        events.push(`lock:${path}`);
        if (path === options.failLock) {
          return Promise.reject(new Error("settings lock is held"));
        }
        return Promise.resolve(() => {
          events.push(`release:${path}`);
          return path === options.failRelease
            ? Promise.reject(new Error("release failed"))
            : Promise.resolve();
        });
      },
      read(path) {
        events.push(`read:${path}`);
        if (path === options.failRead) {
          return Promise.reject("read failed");
        }
        return Promise.resolve(
          path === projectPath
            ? (options.projectContent ?? validSettings)
            : validSettings,
        );
      },
      validateTarget(target) {
        events.push(`validate:${target.id}`);
        return target.id === options.failValidation
          ? Promise.reject(new Error("resource target changed"))
          : Promise.resolve();
      },
      writeAtomic(path, _content) {
        events.push(`write:${path}`);
        return path === options.failWrite
          ? Promise.reject(new Error("disk full"))
          : Promise.resolve();
      },
    },
  };
}

interface BlockedProject {
  readonly snapshot?: string;
  readonly content?: string;
  readonly validationFailure?: string;
  readonly work: readonly string[];
  readonly status: ScopeCommitResult["status"];
  readonly message: string;
}

const blockedProjects: [string, BlockedProject][] = [
  [
    "the snapshot is unparsable before a target failure",
    {
      snapshot: "{oops",
      validationFailure: "project-top",
      work: [],
      status: "failed",
      message: "Snapshot is invalid:",
    },
  ],
  [
    "the locked settings are unparsable before a target failure",
    {
      content: "{oops",
      validationFailure: "project-top",
      work: [`read:${projectPath}`],
      status: "failed",
      message: "Current settings are invalid:",
    },
  ],
  [
    "the owner conflicts before a target failure",
    {
      content: '{"extensions":["changed"]}\n',
      validationFailure: "project-top",
      work: [`read:${projectPath}`],
      status: "conflict",
      message: conflictMessage,
    },
  ],
  [
    "the target fails validation before a malformed filter can be mutated",
    {
      snapshot: '{"extensions":"bad"}\n',
      content: '{"extensions":"bad"}\n',
      validationFailure: "project-top",
      work: [`read:${projectPath}`, "validate:project-top"],
      status: "failed",
      message: "resource target changed",
    },
  ],
  [
    "mutation rejects a malformed filter after target validation",
    {
      snapshot: '{"extensions":"bad"}\n',
      content: '{"extensions":"bad"}\n',
      work: [`read:${projectPath}`, "validate:project-top"],
      status: "failed",
      message: "extensions must be an array of strings",
    },
  ],
];

const failedWrites: [string, string, CommitResult][] = [
  [
    "the global write fails",
    globalPath,
    {
      scopes: [
        { scope: "global", status: "failed", message: "disk full" },
        { scope: "project", status: "committed" },
      ],
      committedScopes: ["project"],
    },
  ],
  [
    "the project write fails",
    projectPath,
    {
      scopes: [
        { scope: "global", status: "committed" },
        { scope: "project", status: "failed", message: "disk full" },
      ],
      committedScopes: ["global"],
    },
  ],
];

const committedResult: CommitResult = {
  scopes: [
    { scope: "global", status: "committed" },
    { scope: "project", status: "committed" },
  ],
  committedScopes: ["global", "project"],
};

describe("commitSettings", () => {
  test("should lock and prepare every scope before writing when mutations arrive in reverse scope order", async () => {
    const input = request();
    const { io, events } = fakeIo();

    expect(
      await commitSettings(
        { ...input, mutations: [...input.mutations].reverse() },
        io,
      ),
    ).toEqual(committedResult);
    expect(events).toEqual([
      `lock:${globalPath}`,
      `lock:${projectPath}`,
      `read:${globalPath}`,
      "validate:global-top",
      `read:${projectPath}`,
      "validate:project-top",
      `write:${globalPath}`,
      `write:${projectPath}`,
      `release:${projectPath}`,
      `release:${globalPath}`,
    ]);
  });

  test("should release the earlier lock without reading when a later snapshot is missing", async () => {
    const input = request();
    const { io, events } = fakeIo();
    const documents = new Map(input.documents);
    documents.delete("project");

    expect(await commitSettings({ ...input, documents }, io)).toEqual({
      scopes: [
        {
          scope: "global",
          status: "failed",
          message: "Missing global settings snapshot",
        },
        {
          scope: "project",
          status: "failed",
          message: "Missing project settings snapshot",
        },
      ],
      committedScopes: [],
    });
    expect(events).toEqual([`lock:${globalPath}`, `release:${globalPath}`]);
  });

  test("should skip all preparation and release the earlier lock when the project lock fails", async () => {
    const { io, events } = fakeIo({ failLock: projectPath });

    expect(await commitSettings(request(), io)).toEqual({
      scopes: [
        {
          scope: "global",
          status: "failed",
          message: "Not written because another settings lock failed",
        },
        {
          scope: "project",
          status: "failed",
          message: "settings lock is held",
        },
      ],
      committedScopes: [],
    });
    expect(events).toEqual([
      `lock:${globalPath}`,
      `lock:${projectPath}`,
      `release:${globalPath}`,
    ]);
  });

  test("should perform no effects when no mutations are staged", async () => {
    const { io, events } = fakeIo();

    expect(
      await commitSettings({ documents: new Map(), mutations: [] }, io),
    ).toEqual({ scopes: [], committedScopes: [] });
    expect(events).toEqual([]);
  });

  test.each(blockedProjects)(
    "should block every write when %s",
    async (_label: string, scenario: BlockedProject) => {
      const { io, events } = fakeIo({
        projectContent: scenario.content,
        failValidation: scenario.validationFailure,
      });

      const result = await commitSettings(request(scenario.snapshot), io);

      expect(result.committedScopes).toEqual([]);
      expect(result.scopes[0]).toEqual({
        scope: "global",
        status: "failed",
        message: prevalidationMessage,
      });
      expect(result.scopes[1]?.scope).toBe("project");
      expect(result.scopes[1]?.status).toBe(scenario.status);
      expect(result.scopes[1]?.message).toContain(scenario.message);
      expect(events).toEqual([
        `lock:${globalPath}`,
        `lock:${projectPath}`,
        `read:${globalPath}`,
        "validate:global-top",
        ...scenario.work,
        `release:${projectPath}`,
        `release:${globalPath}`,
      ]);
    },
  );

  test("should continue prevalidation and release both locks when a locked read rejects a non-Error value", async () => {
    const { io, events } = fakeIo({ failRead: globalPath });

    expect(await commitSettings(request(), io)).toEqual({
      scopes: [
        { scope: "global", status: "failed", message: "read failed" },
        { scope: "project", status: "failed", message: prevalidationMessage },
      ],
      committedScopes: [],
    });
    expect(events).toEqual([
      `lock:${globalPath}`,
      `lock:${projectPath}`,
      `read:${globalPath}`,
      `read:${projectPath}`,
      "validate:project-top",
      `release:${projectPath}`,
      `release:${globalPath}`,
    ]);
  });

  test.each(failedWrites)(
    "should report only successful writes and attempt both scopes when %s",
    async (_label, failedPath, expected) => {
      const { io, events } = fakeIo({ failWrite: failedPath });

      expect(await commitSettings(request(), io)).toEqual(expected);
      expect(events.slice(-twoScopeWriteAndReleaseEventCount)).toEqual([
        `write:${globalPath}`,
        `write:${projectPath}`,
        `release:${projectPath}`,
        `release:${globalPath}`,
      ]);
    },
  );

  test("should exclude a scope from writes and committed scopes when its mutation changes nothing", async () => {
    const content = '{"extensions":["./extensions","-extensions/alpha.ts"]}\n';
    const { io, events } = fakeIo({ projectContent: content });

    expect(await commitSettings(request(content), io)).toEqual({
      scopes: [
        { scope: "global", status: "committed" },
        { scope: "project", status: "unchanged" },
      ],
      committedScopes: ["global"],
    });
    expect(events).toContain("validate:project-top");
    expect(events).not.toContain(`write:${projectPath}`);
    expect(events.slice(-oneScopeWriteAndReleaseEventCount)).toEqual([
      `write:${globalPath}`,
      `release:${projectPath}`,
      `release:${globalPath}`,
    ]);
  });

  test("should attempt the remaining releases without changing results when one lock release fails", async () => {
    const { io, events } = fakeIo({ failRelease: projectPath });

    expect(await commitSettings(request(), io)).toEqual(committedResult);
    expect(events.slice(-2)).toEqual([
      `release:${projectPath}`,
      `release:${globalPath}`,
    ]);
  });
});
