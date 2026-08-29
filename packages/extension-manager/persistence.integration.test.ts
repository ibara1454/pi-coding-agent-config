import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { commitSettings, type PersistenceIo } from "./persistence.ts";
import { parseSettingsDocument } from "./settings.ts";
import { validateTargetIdentity } from "./target-identity.ts";
import {
  basePackageTarget,
  manifestPackage,
  packageDrifts,
  withTemporaryRoot,
} from "./target-identity-test-fixtures.ts";
import type {
  CommitRequest,
  JsonObject,
  PackageToggleTarget,
  ResourceScope,
  ScopeCommitResult,
  SettingsDocument,
  SettingsMutation,
  TopLevelToggleTarget,
} from "./types.ts";

const globalPath = "/agent/settings.json";
const projectPath = "/repo/.pi/settings.json";

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

function document(
  scope: ResourceScope,
  path: string,
  value: JsonObject,
): SettingsDocument {
  return parseSettingsDocument(
    scope,
    path,
    `${JSON.stringify(value, null, 2)}\n`,
  );
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

interface IoOptions {
  readonly failLock?: string | undefined;
  readonly failValidation?: string | undefined;
  readonly failWrite?: string | undefined;
  readonly validateTarget?: PersistenceIo["validateTarget"] | undefined;
}

function fakeIo(
  contents: Map<string, string | undefined>,
  options: IoOptions = {},
): { readonly io: PersistenceIo; readonly events: string[] } {
  const events: string[] = [];
  return {
    events,
    io: {
      async lock(path) {
        events.push(`lock:${path}`);
        if (path === options.failLock) {
          throw new Error("settings lock is held");
        }
        return async () => {
          events.push(`release:${path}`);
        };
      },
      async read(path) {
        events.push(`read:${path}`);
        return contents.get(path);
      },
      async validateTarget(target) {
        events.push(`validate:${target.id}`);
        if (target.id === options.failValidation) {
          throw new Error("resource target changed");
        }
        await options.validateTarget?.(target);
      },
      async writeAtomic(path, content) {
        events.push(`write:${path}`);
        if (path === options.failWrite) {
          throw new Error("disk full");
        }
        contents.set(path, content);
      },
    },
  };
}

function bothScopes(): SettingsMutation[] {
  return [
    { scope: "global", target: topTarget("global"), enabled: false },
    { scope: "project", target: topTarget("project"), enabled: false },
  ];
}

function wrote(events: readonly string[]): boolean {
  return events.some((event) => event.startsWith("write:"));
}

interface BlockedProject {
  readonly snapshot?: string | undefined;
  readonly disk?: string | undefined;
  readonly failValidation?: string | undefined;
}

const validProject = '{"extensions":["./extensions"]}\n';

const blockedProjects: [
  string,
  BlockedProject,
  ScopeCommitResult["status"],
  string,
][] = [
  [
    "an unparsable snapshot",
    { snapshot: "{oops" },
    "failed",
    "Snapshot is invalid",
  ],
  [
    "unparsable settings under the lock",
    { disk: "{oops" },
    "failed",
    "Current settings are invalid",
  ],
  [
    "a filter list that is not an array of strings",
    { snapshot: '{"extensions":"bad"}\n', disk: '{"extensions":"bad"}\n' },
    "failed",
    "extensions must be an array of strings",
  ],
  [
    "an owner that changed under the lock",
    { disk: '{"extensions":["changed"]}\n' },
    "conflict",
    "Relevant settings changed; close and reopen /extensions",
  ],
  [
    "a target that lost its filesystem identity",
    { failValidation: "project-top" },
    "failed",
    "resource target changed",
  ],
];

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  await withTemporaryRoot("extension-manager-commit-", run);
}

const packageConflicts: [string, string][] = [
  [
    "a filter field appears on the touched package",
    '{"packages":[{"source":"npm:kit","extensions":[]}]}\n',
  ],
  [
    "an identical same-source occurrence is inserted first",
    '{"packages":["npm:kit","npm:kit"]}\n',
  ],
  ["the touched package is removed", '{"packages":["npm:other"]}\n'],
];

describe("commitSettings", () => {
  test("should plan every scope inside its lock before the first write when committing multiple scopes", async () => {
    const global = document("global", globalPath, {
      extensions: ["./extensions"],
    });
    const project = document("project", projectPath, {
      extensions: ["./extensions"],
    });
    const contents = new Map([
      [globalPath, global.content],
      [projectPath, project.content],
    ]);
    const { io, events } = fakeIo(contents);

    const result = await commitSettings(
      request([global, project], bothScopes()),
      io,
    );

    expect(result).toEqual({
      scopes: [
        { scope: "global", status: "committed" },
        { scope: "project", status: "committed" },
      ],
      committedScopes: ["global", "project"],
    });
    for (const scope of result.committedScopes) {
      expect(events).toContain(
        `write:${scope === "global" ? globalPath : projectPath}`,
      );
    }

    const lockedScopeWork: [string, string][] = [
      [globalPath, "validate:global-top"],
      [projectPath, "validate:project-top"],
    ];

    for (const [path, validation] of lockedScopeWork) {
      const lockIndex = events.indexOf(`lock:${path}`);

      expect(lockIndex).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(`read:${path}`)).toBeGreaterThan(lockIndex);
      expect(events.indexOf(validation)).toBeGreaterThan(lockIndex);
    }

    const firstWrite = events.findIndex((event) => event.startsWith("write:"));
    const lastWrite = events.findLastIndex((event) =>
      event.startsWith("write:"),
    );

    for (const event of [
      `lock:${globalPath}`,
      `lock:${projectPath}`,
      `read:${globalPath}`,
      `read:${projectPath}`,
      "validate:global-top",
      "validate:project-top",
    ]) {
      expect(events).toContain(event);
      expect(events.lastIndexOf(event)).toBeLessThan(firstWrite);
    }

    for (const event of [`release:${globalPath}`, `release:${projectPath}`]) {
      expect(events).toContain(event);
      expect(events.indexOf(event)).toBeGreaterThan(lastWrite);
    }
  });

  test("should write the locked read rather than the staged snapshot when settings changed after staging", async () => {
    const global = document("global", globalPath, {
      extensions: ["./extensions"],
      theme: "dark",
    });
    const contents = new Map<string, string | undefined>([
      [globalPath, '{"extensions":["./extensions"],"theme":"light"}\n'],
    ]);
    const { io } = fakeIo(contents);

    const result = await commitSettings(
      request(
        [global],
        [{ scope: "global", target: topTarget("global"), enabled: false }],
      ),
      io,
    );

    expect(result.committedScopes).toEqual(["global"]);
    expect(JSON.parse(contents.get(globalPath) ?? "{}")).toEqual({
      extensions: ["./extensions", "-extensions/alpha.ts"],
      theme: "light",
    });
  });

  test("should release an acquired lock when a later snapshot is missing", async () => {
    const global = document("global", globalPath, {
      extensions: ["./extensions"],
    });
    const { io, events } = fakeIo(new Map([[globalPath, global.content]]));

    const result = await commitSettings(
      {
        documents: new Map([["global", global]]),
        mutations: bothScopes(),
      },
      io,
    );

    expect(result).toEqual({
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

  test("should skip every scope when one settings lock cannot be taken", async () => {
    const global = document("global", globalPath, {
      extensions: ["./extensions"],
    });
    const project = document("project", projectPath, {
      extensions: ["./extensions"],
    });
    const contents = new Map([
      [globalPath, global.content],
      [projectPath, project.content],
    ]);
    const { io, events } = fakeIo(contents, { failLock: projectPath });

    const result = await commitSettings(
      request([global, project], bothScopes()),
      io,
    );

    expect(result).toEqual({
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

  test("should have no locking side effects when the commit is empty", async () => {
    const { io, events } = fakeIo(new Map<string, string | undefined>());

    expect(
      await commitSettings({ documents: new Map(), mutations: [] }, io),
    ).toEqual({ scopes: [], committedScopes: [] });
    expect(events).toEqual([]);
  });

  test.each(blockedProjects)(
    "should block every write when the project scope has %s",
    async (_label: string, scenario: BlockedProject, status: ScopeCommitResult["status"], message: string) => {
      const global = parseSettingsDocument(
        "global",
        globalPath,
        '{"extensions":["./extensions"]}\n',
      );
      const project = parseSettingsDocument(
        "project",
        projectPath,
        scenario.snapshot ?? validProject,
      );
      const contents = new Map<string, string | undefined>([
        [globalPath, '{"extensions":["./extensions"]}\n'],
        [projectPath, scenario.disk ?? validProject],
      ]);
      const { io, events } = fakeIo(contents, {
        failValidation: scenario.failValidation,
      });

      const result = await commitSettings(
        request([global, project], bothScopes()),
        io,
      );

      expect(result.committedScopes).toEqual([]);
      expect(result.scopes.map((entry) => entry.scope)).toEqual([
        "global",
        "project",
      ]);
      expect(result.scopes[0]).toEqual({
        scope: "global",
        status: "failed",
        message: "Not written because another scope failed prevalidation",
      });
      expect(result.scopes[1]?.status).toBe(status);
      expect(result.scopes[1]?.message).toContain(message);
      expect(wrote(events)).toBe(false);
    },
  );

  test("should report only written scopes when a later scope write fails", async () => {
    const global = document("global", globalPath, {
      extensions: ["./extensions"],
    });
    const project = document("project", projectPath, {
      extensions: ["./extensions"],
    });
    const contents = new Map([
      [globalPath, global.content],
      [projectPath, project.content],
    ]);
    const { io } = fakeIo(contents, { failWrite: projectPath });

    const result = await commitSettings(
      request([global, project], bothScopes()),
      io,
    );

    expect(result).toEqual({
      scopes: [
        { scope: "global", status: "committed" },
        { scope: "project", status: "failed", message: "disk full" },
      ],
      committedScopes: ["global"],
    });
    expect(JSON.parse(contents.get(globalPath) ?? "{}")).toEqual({
      extensions: ["./extensions", "-extensions/alpha.ts"],
    });
  });

  test("should exclude an unchanged scope from committed scopes when its mutation is already applied", async () => {
    const global = document("global", globalPath, {
      extensions: ["./extensions"],
    });
    const project = document("project", projectPath, {
      extensions: ["./extensions", "-extensions/alpha.ts"],
    });
    const contents = new Map([
      [globalPath, global.content],
      [projectPath, project.content],
    ]);
    const { io, events } = fakeIo(contents);

    const result = await commitSettings(
      request([global, project], bothScopes()),
      io,
    );

    expect(result).toEqual({
      scopes: [
        { scope: "global", status: "committed" },
        { scope: "project", status: "unchanged" },
      ],
      committedScopes: ["global"],
    });
    expect(events).not.toContain(`write:${projectPath}`);
    expect(contents.get(projectPath)).toBe(project.content);
  });

  test.each(packageDrifts)(
    "should leave settings untouched when filesystem identity changes for: %s",
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
        const { io, events } = fakeIo(contents, {
          validateTarget: validateTargetIdentity,
        });

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
      const { io } = fakeIo(contents, {
        validateTarget: validateTargetIdentity,
      });

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

  test.each(packageConflicts)(
    "should report a conflict without writing when %s",
    async (_label: string, disk: string) => {
      const global = document("global", globalPath, {
        packages: ["npm:kit"],
      });
      const { io, events } = fakeIo(
        new Map<string, string | undefined>([[globalPath, disk]]),
      );

      const result = await commitSettings(
        request(
          [global],
          [{ scope: "global", target: basePackageTarget(), enabled: false }],
        ),
        io,
      );

      expect(result).toEqual({
        scopes: [
          {
            scope: "global",
            status: "conflict",
            message: "Relevant settings changed; close and reopen /extensions",
          },
        ],
        committedScopes: [],
      });
      expect(wrote(events)).toBe(false);
    },
  );

  test("should commit when an unrelated package occurrence changes", async () => {
    const global = document("global", globalPath, {
      packages: ["npm:kit", "npm:other"],
    });
    const contents = new Map<string, string | undefined>([
      [
        globalPath,
        '{"packages":["npm:kit",{"source":"npm:other","skills":[]}]}\n',
      ],
    ]);
    const { io } = fakeIo(contents);

    const result = await commitSettings(
      request(
        [global],
        [{ scope: "global", target: basePackageTarget(), enabled: false }],
      ),
      io,
    );

    expect(result.committedScopes).toEqual(["global"]);
    expect(JSON.parse(contents.get(globalPath) ?? "{}")).toEqual({
      packages: [
        { source: "npm:kit", extensions: ["-extensions/alpha.ts"] },
        { source: "npm:other", skills: [] },
      ],
    });
  });
});
