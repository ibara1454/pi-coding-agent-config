import { describe, expect, spyOn, test } from "bun:test";
import type { PathLike, PathOrFileDescriptor } from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: Bun spies must intercept live named filesystem imports without replacing pure discovery policy.
import * as fs from "node:fs";
import type {
  LoadSkillsResult,
  ResolvedPaths,
  ResolvedResource,
} from "@earendil-works/pi-coding-agent";
// biome-ignore lint/performance/noNamespaceImport: Restore only host effect spies; frontmatter parsing and other host exports must remain real.
import * as host from "@earendil-works/pi-coding-agent";
import { discoverCatalog } from "./discovery.ts";

const agentDir = "/unit/agent";
const cwd = "/unit/project";
const settingsPath = `${agentDir}/settings.json`;
const skillPath = `${agentDir}/skills/review/SKILL.md`;
const canonicalSkillPath = "/unit/canonical/review/SKILL.md";
const descriptor = 42;
const previewByteLimit = 4096;
const previewCharacterLimit = 2000;
const options = {
  cwd,
  agentDir,
  projectTrusted: false,
  reloadPending: false,
};

/**
 * Replaces discovery's host and filesystem effects with one in-memory skill.
 * @param preview - UTF-8 file contents served by the bounded descriptor read.
 * @returns Restorable spies for planning loader or preview failures; no real handles are opened.
 * @example mockSkillDiscovery("# Review") lets discoverCatalog(options) preview "# Review".
 */
function mockSkillDiscovery(preview: string) {
  const resource: ResolvedResource = {
    path: skillPath,
    enabled: true,
    metadata: {
      scope: "user",
      source: "auto",
      origin: "top-level",
      baseDir: agentDir,
    },
  };
  const resolved: ResolvedPaths = {
    extensions: [],
    skills: [resource],
    prompts: [],
    themes: [],
  };
  const loaded: LoadSkillsResult = {
    skills: [
      {
        name: "review-code",
        description: "Review changes for correctness",
        filePath: skillPath,
        baseDir: `${agentDir}/skills/review`,
        sourceInfo: { path: skillPath, ...resource.metadata },
        disableModelInvocation: false,
      },
    ],
    diagnostics: [],
  };
  const resolve = spyOn(
    host.DefaultPackageManager.prototype,
    "resolve",
  ).mockResolvedValue(resolved);
  const loadSkills = spyOn(host, "loadSkills").mockReturnValue(loaded);
  spyOn(fs, "existsSync").mockImplementation(
    (path) => String(path) === settingsPath,
  );
  const readSettings = spyOn(fs, "readFileSync").mockImplementation(((
    path: PathOrFileDescriptor,
  ) => {
    if (String(path) !== settingsPath) {
      throw new Error(`Unexpected settings path: ${String(path)}`);
    }
    return "{}";
  }) as typeof fs.readFileSync);
  spyOn(fs.realpathSync, "native").mockImplementation(((path: PathLike) =>
    String(path) === skillPath
      ? canonicalSkillPath
      : String(path)) as typeof fs.realpathSync.native);

  const open = spyOn(fs, "openSync").mockImplementation((path) => {
    if (String(path) !== canonicalSkillPath) {
      throw new Error(`Unknown skill: ${String(path)}`);
    }
    return descriptor;
  });
  const bytes = Buffer.from(preview, "utf8");
  const read = spyOn(fs, "readSync").mockImplementation(((
    _file: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
  ) =>
    bytes.copy(
      Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      offset,
      0,
      length,
    )) as typeof fs.readSync);
  const close = spyOn(fs, "closeSync").mockReturnValue(undefined);
  return { resource, resolve, readSettings, loadSkills, open, read, close };
}

describe("discoverCatalog", () => {
  test("should retain separate settings origins without duplicate occurrence paths when a skill is declared twice", async () => {
    const { resource, resolve, readSettings } = mockSkillDiscovery("# Review");
    resolve.mockResolvedValue({
      extensions: [],
      skills: [
        {
          ...resource,
          metadata: { ...resource.metadata, source: "local" },
        },
      ],
      prompts: [],
      themes: [],
    });
    readSettings.mockReturnValue(
      JSON.stringify({
        skills: ["./skills/review/SKILL.md", "./skills/review/SKILL.md"],
      }),
    );

    const catalog = await discoverCatalog(options);

    expect(catalog.rows).toHaveLength(1);
    expect(catalog.rows[0]).toMatchObject({
      name: "review-code",
      source: "Settings",
      origins: [
        { label: `${settingsPath}#skills[0]`, source: "settings" },
        { label: `${settingsPath}#skills[1]`, source: "settings" },
      ],
    });
    expect([...catalog.targets.values()]).toMatchObject([
      {
        occurrencePaths: [skillPath],
        allPaths: [skillPath],
      },
    ]);
  });

  test("should mark the global package as shadowed when a regular project entry has the same package identity", async () => {
    const { resolve, readSettings } = mockSkillDiscovery("");
    const globalRoot = `${agentDir}/npm/node_modules/kit`;
    const projectRoot = `${cwd}/.pi/npm/node_modules/kit`;
    const projectSettingsPath = `${cwd}/.pi/settings.json`;
    const empty: ResolvedPaths = {
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    };
    const globalResource: ResolvedResource = {
      path: `${globalRoot}/alpha.ts`,
      enabled: true,
      metadata: {
        source: "npm:kit",
        scope: "user",
        origin: "package",
        baseDir: globalRoot,
      },
    };
    const projectResource: ResolvedResource = {
      ...globalResource,
      path: `${projectRoot}/alpha.ts`,
      metadata: {
        ...globalResource.metadata,
        scope: "project",
        baseDir: projectRoot,
      },
    };
    resolve.mockResolvedValue({ ...empty, extensions: [projectResource] });
    const topLevelResolutionCount = 6;
    for (let index = 0; index < topLevelResolutionCount; index++) {
      resolve.mockResolvedValueOnce(empty);
    }
    spyOn(host.DefaultPackageManager.prototype, "getInstalledPath")
      .mockReturnValueOnce(globalRoot)
      .mockReturnValueOnce(projectRoot);
    spyOn(host.DefaultPackageManager.prototype, "resolveExtensionSources")
      .mockResolvedValueOnce({ ...empty, extensions: [globalResource] })
      .mockResolvedValueOnce({ ...empty, extensions: [projectResource] });
    spyOn(fs, "existsSync").mockImplementation(
      (path) =>
        String(path) === settingsPath || String(path) === projectSettingsPath,
    );
    readSettings.mockImplementation(((path: PathOrFileDescriptor) => {
      const value = String(path);
      if (value === settingsPath || value === projectSettingsPath) {
        return JSON.stringify({ packages: ["npm:kit"] });
      }
      if (
        value === `${globalRoot}/package.json` ||
        value === `${projectRoot}/package.json`
      ) {
        return JSON.stringify({
          pi: { extensions: ["./alpha.ts"], skills: [] },
        });
      }
      throw new Error(`Unexpected read: ${value}`);
    }) as typeof fs.readFileSync);
    spyOn(fs, "statSync").mockImplementation(((path: PathLike) => ({
      isFile: () => String(path).endsWith("/alpha.ts"),
      isDirectory: () =>
        String(path) === globalRoot || String(path) === projectRoot,
    })) as typeof fs.statSync);

    const catalog = await discoverCatalog({
      ...options,
      projectTrusted: true,
    });

    expect(catalog.rows).toHaveLength(2);
    expect(catalog.rows.find((row) => row.scope === "global")).toMatchObject({
      source: "npm:kit",
      configured: true,
      resolvedAfterReload: false,
      resolutionParticipant: false,
      resolutionCandidate: false,
      shadowedBy: "Project package npm:kit",
    });
    expect(catalog.rows.find((row) => row.scope === "project")).toMatchObject({
      source: "npm:kit",
      configured: true,
      resolvedAfterReload: true,
      resolutionParticipant: true,
      resolutionCandidate: true,
    });
  });

  test("should use loaded skill metadata and a safe body preview when the file contains frontmatter and terminal controls", async () => {
    const { close } = mockSkillDiscovery(
      [
        "---",
        "name: hidden-frontmatter-name",
        "description: hidden frontmatter description",
        "---",
        "  \u001b[31m# Review café\u001b[0m\r",
        "\tKeep\u0000 text\u0007\u007f",
        "\u001b]8;;https://example.test\u0007docs\u001b]8;;\u0007  ",
      ].join("\n"),
    );

    const catalog = await discoverCatalog(options);

    expect(catalog.rows).toHaveLength(1);
    expect(catalog.rows[0]).toMatchObject({
      kind: "skill",
      name: "review-code",
      description: "Review changes for correctness",
      path: skillPath,
      canonicalPath: canonicalSkillPath,
      preview: "# Review café\n\tKeep text\ndocs",
    });
    expect(catalog.diagnostics).toEqual([]);
    expect(close).toHaveBeenCalledWith(descriptor);
  });

  test("should bound file reads and preview characters when a UTF-8 skill exceeds both budgets", async () => {
    const { read, close } = mockSkillDiscovery(
      `${"é".repeat(previewByteLimit)}not part of the preview`,
    );

    const catalog = await discoverCatalog(options);

    expect(catalog.rows[0]?.preview).toBe("é".repeat(previewCharacterLimit));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(
      descriptor,
      expect.any(Buffer),
      0,
      previewByteLimit,
      0,
    );
    expect(close).toHaveBeenCalledWith(descriptor);
  });

  test("should retain skill metadata without a preview when the file cannot be opened", async () => {
    const { open, close } = mockSkillDiscovery("unreadable");
    open.mockImplementation(() => {
      throw new Error("permission denied");
    });

    const catalog = await discoverCatalog(options);

    expect(catalog.rows[0]).toMatchObject({
      name: "review-code",
      description: "Review changes for correctness",
    });
    expect(catalog.rows[0]).not.toHaveProperty("preview");
    expect(catalog.diagnostics).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });

  test("should retain skill metadata and close the descriptor when reading the preview fails", async () => {
    const { read, close } = mockSkillDiscovery("unreadable");
    read.mockImplementation(() => {
      throw new Error("read failed");
    });

    const catalog = await discoverCatalog(options);

    expect(catalog.rows[0]).toMatchObject({
      name: "review-code",
      description: "Review changes for correctness",
    });
    expect(catalog.rows[0]).not.toHaveProperty("preview");
    expect(catalog.diagnostics).toEqual([]);
    expect(close).toHaveBeenCalledWith(descriptor);
  });

  test.each([
    ["no text", ""],
    [
      "only frontmatter, whitespace, and controls",
      "---\nname: review\n---\n \t\n\u001b[31m\u001b[0m\u0000\u0007\u007f",
    ],
  ])(
    "should omit the preview when the file contains %s",
    async (_label, body) => {
      const { close } = mockSkillDiscovery(body);

      const catalog = await discoverCatalog(options);

      expect(catalog.rows[0]).toMatchObject({ name: "review-code" });
      expect(catalog.rows[0]).not.toHaveProperty("preview");
      expect(close).toHaveBeenCalledWith(descriptor);
    },
  );

  test("should forward diagnostics and use the directory name when skill loading returns no metadata", async () => {
    const { loadSkills } = mockSkillDiscovery("# Still available");
    loadSkills.mockReturnValue({
      skills: [],
      diagnostics: [
        {
          type: "warning",
          message: "Missing skill description",
          path: skillPath,
        },
        { type: "error", message: "Skill metadata is unavailable" },
      ],
    });

    const catalog = await discoverCatalog(options);

    expect(catalog.rows[0]).toMatchObject({
      kind: "skill",
      name: "review",
      preview: "# Still available",
    });
    expect(catalog.rows[0]).not.toHaveProperty("description");
    expect(catalog.diagnostics).toEqual([
      { message: "Missing skill description", path: skillPath },
      { message: "Skill metadata is unavailable" },
    ]);
  });
});
