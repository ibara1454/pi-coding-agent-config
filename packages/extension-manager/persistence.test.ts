import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitSettings,
  type PersistenceIo,
  serializeSettings,
  validateTargetIdentity,
} from "./persistence.ts";
import { parseSettingsDocument } from "./settings.ts";
import type {
  CommitRequest,
  PackageToggleTarget,
  ResourceScope,
  SettingsDocument,
  SettingsMutation,
  TopLevelToggleTarget,
} from "./types.ts";

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

function packageTarget(): PackageToggleTarget {
  return {
    id: "global-package",
    type: "package",
    scope: "global",
    kind: "extension",
    field: "extensions",
    canonicalPath: "/agent/pkg/extensions/alpha.ts",
    resolvedPath: "/agent/pkg/extensions/alpha.ts",
    filterPath: "extensions/alpha.ts",
    allPaths: ["/agent/pkg/extensions/alpha.ts"],
    packageRoot: "/agent/pkg",
    canonicalPackageRoot: "/agent/pkg",
    packageSourcePath: "/agent/pkg",
    package: { source: "npm:kit", occurrence: 0 },
    autoloadDelta: false,
    participates: true,
    participatesWhenEnabled: true,
    participatesWhenDisabled: true,
    packageIdentity: "npm:kit",
    hadFilterField: false,
  };
}

function document(
  scope: ResourceScope,
  path: string,
  value: Record<string, unknown>,
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

function fakeIo(
  contents: Map<string, string | undefined>,
  options: {
    readonly failValidation?: string;
    readonly failWrite?: string;
  } = {},
): { readonly io: PersistenceIo; readonly events: string[] } {
  const events: string[] = [];
  return {
    events,
    io: {
      async lock(path) {
        events.push(`lock:${path}`);
        return async () => {
          events.push(`release:${path}`);
        };
      },
      async read(path) {
        events.push(`read:${path}`);
        return contents.get(path);
      },
      validateTarget(target) {
        events.push(`validate:${target.id}`);
        if (target.id === options.failValidation) {
          throw new Error("resource target changed");
        }
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

describe("locked multi-scope commit", () => {
  test("locks Global then Project and releases in reverse after both writes", async () => {
    const globalPath = "/agent/settings.json";
    const projectPath = "/repo/.pi/settings.json";
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
      request(
        [global, project],
        [
          { scope: "global", target: topTarget("global"), enabled: false },
          { scope: "project", target: topTarget("project"), enabled: false },
        ],
      ),
      io,
    );

    expect(result.committedScopes).toEqual(["global", "project"]);
    expect(events.filter((event) => event.startsWith("lock"))).toEqual([
      `lock:${globalPath}`,
      `lock:${projectPath}`,
    ]);
    expect(events.slice(-2)).toEqual([
      `release:${projectPath}`,
      `release:${globalPath}`,
    ]);
  });

  test("aborts every write when one touched field conflicts", async () => {
    const global = document("global", "/agent/settings.json", {
      extensions: ["./extensions"],
    });
    const project = document("project", "/repo/.pi/settings.json", {
      extensions: ["./extensions"],
    });
    const contents = new Map([
      [global.path, '{"extensions":["changed"]}\n'],
      [project.path, project.content],
    ]);
    const { io, events } = fakeIo(contents);

    const result = await commitSettings(
      request(
        [global, project],
        [
          { scope: "global", target: topTarget("global"), enabled: false },
          { scope: "project", target: topTarget("project"), enabled: false },
        ],
      ),
      io,
    );

    expect(result.scopes).toContainEqual(
      expect.objectContaining({ scope: "global", status: "conflict" }),
    );
    expect(events.some((event) => event.startsWith("write"))).toBe(false);
  });

  test("precomputes every scope before the first write", async () => {
    const global = document("global", "/agent/settings.json", {
      extensions: ["./extensions"],
    });
    const project = document("project", "/repo/.pi/settings.json", {
      extensions: "bad",
    });
    const contents = new Map([
      [global.path, global.content],
      [project.path, project.content],
    ]);
    const { io, events } = fakeIo(contents);

    const result = await commitSettings(
      request(
        [global, project],
        [
          { scope: "global", target: topTarget("global"), enabled: false },
          { scope: "project", target: topTarget("project"), enabled: false },
        ],
      ),
      io,
    );

    expect(result.committedScopes).toEqual([]);
    expect(result.scopes).toContainEqual(
      expect.objectContaining({ scope: "project", status: "failed" }),
    );
    expect(events.some((event) => event.startsWith("write"))).toBe(false);
  });

  test("aborts both scopes when a locked target changes identity", async () => {
    const global = document("global", "/agent/settings.json", {
      extensions: ["./extensions"],
    });
    const project = document("project", "/repo/.pi/settings.json", {
      extensions: ["./extensions"],
    });
    const contents = new Map([
      [global.path, global.content],
      [project.path, project.content],
    ]);
    const { io, events } = fakeIo(contents, {
      failValidation: "project-top",
    });

    const result = await commitSettings(
      request(
        [global, project],
        [
          { scope: "global", target: topTarget("global"), enabled: false },
          { scope: "project", target: topTarget("project"), enabled: false },
        ],
      ),
      io,
    );

    expect(result.committedScopes).toEqual([]);
    expect(result.scopes).toContainEqual({
      scope: "project",
      status: "failed",
      message: "resource target changed",
    });
    expect(events.some((event) => event.startsWith("write"))).toBe(false);
  });

  test("merges an unrelated concurrent field change", async () => {
    const global = document("global", "/agent/settings.json", {
      extensions: ["./extensions"],
      theme: "dark",
    });
    const contents = new Map([
      [global.path, '{"extensions":["./extensions"],"theme":"light"}\n'],
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
    expect(JSON.parse(contents.get(global.path) ?? "{}")).toEqual({
      extensions: ["./extensions", "-extensions/alpha.ts"],
      theme: "light",
    });
  });

  test("reports a partial commit without rolling Global back", async () => {
    const global = document("global", "/agent/settings.json", {
      extensions: ["./extensions"],
    });
    const project = document("project", "/repo/.pi/settings.json", {
      extensions: ["./extensions"],
    });
    const contents = new Map([
      [global.path, global.content],
      [project.path, project.content],
    ]);
    const { io } = fakeIo(contents, { failWrite: project.path });

    const result = await commitSettings(
      request(
        [global, project],
        [
          { scope: "global", target: topTarget("global"), enabled: false },
          { scope: "project", target: topTarget("project"), enabled: false },
        ],
      ),
      io,
    );

    expect(result.committedScopes).toEqual(["global"]);
    expect(result.scopes).toContainEqual({
      scope: "project",
      status: "failed",
      message: "disk full",
    });
    expect(JSON.parse(contents.get(global.path) ?? "{}").extensions).toContain(
      "-extensions/alpha.ts",
    );
  });
});

describe("owner compare-and-swap", () => {
  test("allows changes to another package occurrence", async () => {
    const global = document("global", "/agent/settings.json", {
      packages: ["npm:kit", "npm:other"],
    });
    const contents = new Map([
      [
        global.path,
        '{"packages":["npm:kit",{"source":"npm:other","skills":[]}]}\n',
      ],
    ]);
    const { io } = fakeIo(contents);

    const result = await commitSettings(
      request(
        [global],
        [{ scope: "global", target: packageTarget(), enabled: false }],
      ),
      io,
    );

    expect(result.committedScopes).toEqual(["global"]);
    expect(JSON.parse(contents.get(global.path) ?? "{}").packages[1]).toEqual({
      source: "npm:other",
      skills: [],
    });
  });

  test("conflicts when the touched package owner changes", async () => {
    const global = document("global", "/agent/settings.json", {
      packages: ["npm:kit"],
    });
    const contents = new Map([
      [global.path, '{"packages":[{"source":"npm:kit","extensions":[]}]}\n'],
    ]);
    const { io, events } = fakeIo(contents);

    const result = await commitSettings(
      request(
        [global],
        [{ scope: "global", target: packageTarget(), enabled: false }],
      ),
      io,
    );

    expect(result.scopes[0]?.status).toBe("conflict");
    expect(events.some((event) => event.startsWith("write"))).toBe(false);
  });

  test("conflicts when an identical same-source occurrence is inserted first", async () => {
    const global = document("global", "/agent/settings.json", {
      packages: ["npm:kit"],
    });
    const contents = new Map([
      [global.path, '{"packages":["npm:kit","npm:kit"]}\n'],
    ]);
    const { io, events } = fakeIo(contents);

    const result = await commitSettings(
      request(
        [global],
        [{ scope: "global", target: packageTarget(), enabled: false }],
      ),
      io,
    );

    expect(result.scopes[0]?.status).toBe("conflict");
    expect(events.some((event) => event.startsWith("write"))).toBe(false);
  });
});

test("empty commits have no locking side effects", async () => {
  const { io, events } = fakeIo(new Map());
  expect(
    await commitSettings({ documents: new Map(), mutations: [] }, io),
  ).toEqual({
    scopes: [],
    committedScopes: [],
  });
  expect(events).toEqual([]);
});

test("serialization preserves indentation and final-newline convention", () => {
  expect(
    serializeSettings({ extensions: [] }, '{\n\t"extensions": []\n}'),
  ).toBe('{\n\t"extensions": []\n}');
});

describe("locked resource identity validation", () => {
  test("rejects a disappeared package child", async () => {
    const root = mkdtempSync(join(tmpdir(), "extension-manager-target-"));
    try {
      const packageRoot = join(root, "package");
      const resourcePath = join(packageRoot, "extensions", "alpha.ts");
      mkdirSync(join(packageRoot, "extensions"), { recursive: true });
      writeFileSync(resourcePath, "export default () => {};\n");
      const target: PackageToggleTarget = {
        ...packageTarget(),
        canonicalPath: resourcePath,
        resolvedPath: resourcePath,
        filterPath: "extensions/alpha.ts",
        allPaths: [resourcePath],
        packageRoot,
        canonicalPackageRoot: packageRoot,
        packageSourcePath: packageRoot,
      };
      unlinkSync(resourcePath);

      await expect(validateTargetIdentity(target)).rejects.toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects a symlinked child retargeted after discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "extension-manager-target-"));
    try {
      const packageRoot = join(root, "package");
      const extensions = join(packageRoot, "extensions");
      const first = join(extensions, "first.ts");
      const second = join(extensions, "second.ts");
      const resourcePath = join(extensions, "alpha.ts");
      mkdirSync(extensions, { recursive: true });
      writeFileSync(first, "export default () => 'first';\n");
      writeFileSync(second, "export default () => 'second';\n");
      symlinkSync(first, resourcePath);
      const target: PackageToggleTarget = {
        ...packageTarget(),
        canonicalPath: first,
        resolvedPath: resourcePath,
        filterPath: "extensions/alpha.ts",
        allPaths: [resourcePath],
        packageRoot,
        canonicalPackageRoot: packageRoot,
        packageSourcePath: packageRoot,
      };
      await validateTargetIdentity(target);

      unlinkSync(resourcePath);
      symlinkSync(second, resourcePath);

      await expect(validateTargetIdentity(target)).rejects.toThrow(
        "Resource target changed",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects a child removed from the package manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "extension-manager-target-"));
    try {
      const packageRoot = join(root, "package");
      const alpha = join(packageRoot, "alpha.ts");
      const beta = join(packageRoot, "beta.ts");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(alpha, "export default () => 'alpha';\n");
      writeFileSync(beta, "export default () => 'beta';\n");
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ pi: { extensions: ["./alpha.ts"] } }),
      );
      const target: PackageToggleTarget = {
        ...packageTarget(),
        canonicalPath: alpha,
        resolvedPath: alpha,
        filterPath: "alpha.ts",
        allPaths: [alpha],
        packageRoot,
        canonicalPackageRoot: packageRoot,
        packageSourcePath: packageRoot,
      };
      await validateTargetIdentity(target);

      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ pi: { extensions: ["./beta.ts"] } }),
      );

      await expect(validateTargetIdentity(target)).rejects.toThrow(
        "Resource no longer resolves from its package",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("accepts a shadowed raw child under a manifest directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "extension-manager-target-"));
    try {
      const packageRoot = join(root, "package");
      const extensions = join(packageRoot, "extensions");
      const actual = join(extensions, "actual.ts");
      const linked = join(extensions, "linked.ts");
      mkdirSync(extensions, { recursive: true });
      writeFileSync(actual, "export default () => {};\n");
      symlinkSync(actual, linked);
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ pi: { extensions: ["./extensions"] } }),
      );
      const target: PackageToggleTarget = {
        ...packageTarget(),
        canonicalPath: actual,
        resolvedPath: linked,
        filterPath: "extensions/linked.ts",
        allPaths: [actual, linked],
        packageRoot,
        canonicalPackageRoot: packageRoot,
        packageSourcePath: packageRoot,
      };

      await expect(validateTargetIdentity(target)).resolves.toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
