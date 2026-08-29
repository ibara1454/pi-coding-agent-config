import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverCatalog, packageIdentity } from "./discovery.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): {
  readonly agentDir: string;
  readonly cwd: string;
  readonly root: string;
} {
  const root = mkdtempSync(join(tmpdir(), "extension-manager-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { agentDir, cwd, root };
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function settings(path: string, value: Record<string, unknown>): void {
  put(path, `${JSON.stringify(value, null, 2)}\n`);
}

function skillDocument(
  name: string,
  description: string,
  body: string,
): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

describe("top-level and automatic discovery", () => {
  test("finds both scopes, collapses duplicate declarations, parses skills, and never executes extensions", async () => {
    const { agentDir, cwd, root } = fixture();
    const marker = join(root, "executed");
    const declaredExtension = join(agentDir, "declared", "alpha.ts");
    put(
      declaredExtension,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\n`,
    );
    put(join(agentDir, "extensions", "auto.ts"), "export default () => {};\n");
    put(
      join(agentDir, "skills", "review", "SKILL.md"),
      skillDocument(
        "review",
        "Review changes",
        `Safe preview\u001b[31m${"x".repeat(2500)}`,
      ),
    );
    put(
      join(cwd, ".pi", "extensions", "project.ts"),
      "export default () => {};\n",
    );
    settings(join(agentDir, "settings.json"), {
      tuiMode: "fullscreen",
      extensions: ["./declared", "./declared/alpha.ts", "-declared/alpha.ts"],
    });
    settings(join(cwd, ".pi", "settings.json"), {});

    const catalog = await discoverCatalog({
      agentDir,
      cwd,
      projectTrusted: true,
      reloadPending: false,
    });

    const declared = catalog.rows.find((row) => row.path === declaredExtension);
    expect(declared?.configured).toBe(false);
    expect(declared?.shadowedBy).toBeUndefined();
    expect(declared?.origins).toHaveLength(2);
    expect(catalog.rows.some((row) => row.name === "auto")).toBe(true);
    expect(
      catalog.rows.some(
        (row) => row.name === "project" && row.scope === "project",
      ),
    ).toBe(true);
    const skill = catalog.rows.find(
      (row) => row.kind === "skill" && row.name === "review",
    );
    expect(skill?.description).toBe("Review changes");
    const preview = skill?.preview ?? "";
    expect(preview.startsWith("Safe preview")).toBe(true);
    expect(preview).not.toContain("\u001b");
    expect(preview.length).toBeLessThanOrEqual(2000);
    expect(catalog.tuiMode).toBe("fullscreen");
    expect(existsSync(marker)).toBe(false);
  });

  test("does not read or expose project resources while untrusted", async () => {
    const { agentDir, cwd } = fixture();
    put(
      join(agentDir, "extensions", "global.ts"),
      "export default () => {};\n",
    );
    settings(join(agentDir, "settings.json"), {});
    put(join(cwd, ".pi", "settings.json"), "{");
    put(
      join(cwd, ".pi", "extensions", "hidden.ts"),
      "export default () => {};\n",
    );

    const catalog = await discoverCatalog({
      agentDir,
      cwd,
      projectTrusted: false,
      reloadPending: false,
    });

    expect(catalog.projectTrusted).toBe(false);
    expect(catalog.rows.every((row) => row.scope === "global")).toBe(true);
    expect(
      catalog.diagnostics.some((diagnostic) => diagnostic.scope === "project"),
    ).toBe(false);
    expect(catalog.settings.has("project")).toBe(false);
  });

  test("expands persistent top-level source globs", async () => {
    const { agentDir, cwd } = fixture();
    put(
      join(agentDir, "packages", "one", "index.ts"),
      "export default () => {};\n",
    );
    settings(join(agentDir, "settings.json"), {
      extensions: ["./packages/*"],
    });

    const catalog = await discoverCatalog({
      agentDir,
      cwd,
      projectTrusted: false,
      reloadPending: false,
    });

    expect(catalog.rows.some((row) => row.name === "one")).toBe(true);
  });
});

describe("configured package children", () => {
  test("discovers extension and skill children, applies object filters, and omits missing packages silently", async () => {
    const { agentDir, cwd } = fixture();
    put(
      join(agentDir, "pkg", "package.json"),
      `${JSON.stringify({
        name: "fixture-package",
        pi: {
          extensions: ["./extensions/alpha.ts"],
          skills: ["./skills/review"],
        },
      })}\n`,
    );
    put(
      join(agentDir, "pkg", "extensions", "alpha.ts"),
      "export default () => {};\n",
    );
    put(
      join(agentDir, "pkg", "skills", "review", "SKILL.md"),
      skillDocument("package-review", "Package review", "Package body"),
    );
    settings(join(agentDir, "settings.json"), {
      packages: [{ source: "./pkg", extensions: [] }, "./missing"],
    });

    const catalog = await discoverCatalog({
      agentDir,
      cwd,
      projectTrusted: false,
      reloadPending: false,
    });

    const packageRows = catalog.rows.filter((row) => row.source === "./pkg");
    expect(packageRows.map((row) => [row.kind, row.configured])).toEqual([
      ["extension", false],
      ["skill", true],
    ]);
    expect(
      packageRows.every((row) => row.id.startsWith("package:global:")),
    ).toBe(true);
    expect(
      catalog.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("./missing"),
      ),
    ).toBe(false);
  });

  test("keeps top-level and package occurrences separate for the same canonical file", async () => {
    const { agentDir, cwd } = fixture();
    const extensionPath = join(agentDir, "pkg", "index.ts");
    put(
      join(agentDir, "pkg", "package.json"),
      `${JSON.stringify({ name: "fixture-package", pi: { extensions: ["./index.ts"] } })}\n`,
    );
    put(extensionPath, "export default () => {};\n");
    settings(join(agentDir, "settings.json"), {
      extensions: ["./pkg/index.ts"],
      packages: ["./pkg"],
    });

    const catalog = await discoverCatalog({
      agentDir,
      cwd,
      projectTrusted: false,
      reloadPending: true,
    });

    const samePath = catalog.rows.filter((row) => row.path === extensionPath);
    expect(samePath).toHaveLength(2);
    expect(new Set(samePath.map((row) => row.id.split(":")[0]))).toEqual(
      new Set(["top", "package"]),
    );
    expect(catalog.reloadPending).toBe(true);
  });

  test("treats autoload false as disabled except for explicitly selected children", async () => {
    const { agentDir, cwd } = fixture();
    put(
      join(agentDir, "pkg", "package.json"),
      `${JSON.stringify({
        name: "fixture-package",
        pi: {
          extensions: ["./extensions/alpha.ts"],
          skills: ["./skills/review"],
        },
      })}\n`,
    );
    put(
      join(agentDir, "pkg", "extensions", "alpha.ts"),
      "export default () => {};\n",
    );
    put(
      join(agentDir, "pkg", "skills", "review", "SKILL.md"),
      skillDocument("package-review", "Package review", "Package body"),
    );
    settings(join(agentDir, "settings.json"), {
      packages: [
        {
          source: "./pkg",
          autoload: false,
          skills: ["+skills/review"],
        },
      ],
    });

    const catalog = await discoverCatalog({
      agentDir,
      cwd,
      projectTrusted: false,
      reloadPending: false,
    });
    const packageRows = catalog.rows.filter((row) => row.source === "./pkg");

    expect(
      packageRows.find((row) => row.kind === "extension")?.configured,
    ).toBe(false);
    expect(packageRows.find((row) => row.kind === "skill")?.configured).toBe(
      true,
    );
  });
});

describe("package precedence discovery", () => {
  test("normalizes historical git shorthand to Pi host/path identity", () => {
    const shorthand = packageIdentity(
      "git:github.com/org/repo@main",
      "global",
      "/repo",
      "/agent",
    );
    const https = packageIdentity(
      "https://github.com/org/repo.git",
      "project",
      "/repo",
      "/agent",
    );
    const scp = packageIdentity(
      "git:git@github.com:org/repo.git@feature",
      "project",
      "/repo",
      "/agent",
    );

    expect(shorthand).toBe("git:github.com/org/repo");
    expect(https).toBe(shorthand);
    expect(scp).toBe(shorthand);
  });
  for (const scenario of [
    {
      label: "selected",
      filters: ["+extensions/alpha.ts"],
      projectConfigured: true,
    },
    { label: "absent", filters: [], projectConfigured: false },
  ] as const) {
    test(`uses the Global install for a Project autoload delta when the child is ${scenario.label}`, async () => {
      const { agentDir, cwd } = fixture();
      const packageRoot = join(agentDir, "npm", "node_modules", "kit");
      put(
        join(packageRoot, "package.json"),
        `${JSON.stringify({
          name: "kit",
          version: "1.0.0",
          pi: { extensions: ["./extensions/alpha.ts"] },
        })}\n`,
      );
      put(
        join(packageRoot, "extensions", "alpha.ts"),
        "export default () => {};\n",
      );
      settings(join(agentDir, "settings.json"), {
        packages: ["npm:kit"],
      });
      settings(join(cwd, ".pi", "settings.json"), {
        packages: [
          {
            source: "npm:kit",
            autoload: false,
            extensions: scenario.filters,
          },
        ],
      });

      const catalog = await discoverCatalog({
        agentDir,
        cwd,
        projectTrusted: true,
        reloadPending: false,
      });
      const rows = catalog.rows.filter(
        (row) => row.source === "npm:kit" && row.kind === "extension",
      );
      const projectRow = rows.find((row) => row.scope === "project");
      const projectTarget =
        projectRow === undefined
          ? undefined
          : catalog.targets.get(projectRow.id);

      expect(rows).toHaveLength(2);
      expect(projectRow?.configured).toBe(scenario.projectConfigured);
      expect(projectTarget).toMatchObject({
        type: "package",
        packageRoot,
        packageSourcePath: packageRoot,
        autoloadDelta: true,
      });
      expect(existsSync(join(cwd, ".pi", "npm", "node_modules", "kit"))).toBe(
        false,
      );
    });
  }

  test("marks a Global managed package shadowed by the same regular Project identity", async () => {
    const { agentDir, cwd } = fixture();
    const globalRoot = join(agentDir, "npm", "node_modules", "kit");
    const projectRoot = join(cwd, ".pi", "npm", "node_modules", "kit");
    for (const packageRoot of [globalRoot, projectRoot]) {
      put(
        join(packageRoot, "package.json"),
        `${JSON.stringify({
          name: "kit",
          version: "1.0.0",
          pi: { extensions: ["./extensions/alpha.ts"] },
        })}\n`,
      );
      put(
        join(packageRoot, "extensions", "alpha.ts"),
        "export default () => {};\n",
      );
    }
    settings(join(agentDir, "settings.json"), { packages: ["npm:kit"] });
    settings(join(cwd, ".pi", "settings.json"), {
      packages: ["npm:kit"],
    });

    const catalog = await discoverCatalog({
      agentDir,
      cwd,
      projectTrusted: true,
      reloadPending: false,
    });
    const globalRow = catalog.rows.find(
      (row) => row.scope === "global" && row.source === "npm:kit",
    );

    expect(globalRow).toMatchObject({
      path: join(globalRoot, "extensions", "alpha.ts"),
      resolvedAfterReload: false,
      resolutionParticipant: false,
      resolutionCandidate: false,
      shadowedBy: "Project package npm:kit",
    });
  });
});
describe("resolved occurrence identity", () => {
  test("serializes a top-level symlink from its configured occurrence path", async () => {
    const { agentDir, cwd, root } = fixture();
    const actualPath = join(root, "shared", "alpha.ts");
    const linkedPath = join(agentDir, "extensions", "linked.ts");
    put(actualPath, "export default () => {};\n");
    mkdirSync(dirname(linkedPath), { recursive: true });
    symlinkSync(actualPath, linkedPath);
    settings(join(agentDir, "settings.json"), {
      extensions: ["./extensions/linked.ts"],
    });

    const catalog = await discoverCatalog({
      agentDir,
      cwd,
      projectTrusted: false,
      reloadPending: false,
    });

    const row = catalog.rows.find((candidate) => candidate.path === linkedPath);
    const target = row === undefined ? undefined : catalog.targets.get(row.id);
    expect(row?.canonicalPath).toBe(actualPath);
    expect(target).toMatchObject({
      resolvedPath: linkedPath,
      filterPath: "extensions/linked.ts",
    });
  });

  test("serializes a package symlink from its manifest occurrence path", async () => {
    const { agentDir, cwd } = fixture();
    const packageRoot = join(agentDir, "pkg");
    const actualPath = join(packageRoot, "extensions", "actual.ts");
    const linkedPath = join(packageRoot, "extensions", "linked.ts");
    put(
      join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: "fixture-package",
        pi: { extensions: ["./extensions/linked.ts"] },
      })}\n`,
    );
    put(actualPath, "export default () => {};\n");
    symlinkSync(actualPath, linkedPath);
    settings(join(agentDir, "settings.json"), { packages: ["./pkg"] });

    const catalog = await discoverCatalog({
      agentDir,
      cwd,
      projectTrusted: false,
      reloadPending: false,
    });

    const row = catalog.rows.find(
      (candidate) =>
        candidate.source === "./pkg" && candidate.path === linkedPath,
    );
    const target = row === undefined ? undefined : catalog.targets.get(row.id);
    expect(row?.canonicalPath).toBe(actualPath);
    expect(target).toMatchObject({
      resolvedPath: linkedPath,
      filterPath: "extensions/linked.ts",
      packageRoot,
      canonicalPackageRoot: packageRoot,
    });
  });

  test("keeps canonical resolution enabled when a later manifest symlink is filtered out", async () => {
    const { agentDir, cwd } = fixture();
    const packageRoot = join(agentDir, "pkg");
    const actualPath = join(packageRoot, "extensions", "actual.ts");
    const linkedPath = join(packageRoot, "extensions", "linked.ts");
    put(
      join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: "fixture-package",
        pi: {
          extensions: ["./extensions"],
        },
      })}\n`,
    );
    put(actualPath, "export default () => {};\n");
    symlinkSync(actualPath, linkedPath);
    settings(join(agentDir, "settings.json"), {
      packages: [
        {
          source: "./pkg",
          extensions: ["extensions/actual.ts"],
        },
      ],
    });

    const catalog = await discoverCatalog({
      agentDir,
      cwd,
      projectTrusted: false,
      reloadPending: false,
    });
    const rows = catalog.rows.filter(
      (row) => row.source === "./pkg" && row.canonicalPath === actualPath,
    );

    expect(rows.map((row) => row.configured).sort()).toEqual([false, true]);
    expect(new Set(rows.map((row) => row.resolvedAfterReload))).toHaveLength(1);
    expect(
      rows.map((row) => catalog.targets.get(row.id)?.filterPath).sort(),
    ).toEqual(["extensions/actual.ts", "extensions/linked.ts"]);
  });
  test("marks later same-source package occurrences shadowed by Pi order", async () => {
    const { agentDir, cwd } = fixture();
    const packageRoot = join(agentDir, "pkg");
    put(
      join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: "fixture-package",
        pi: { extensions: ["./index.ts"] },
      })}\n`,
    );
    put(join(packageRoot, "index.ts"), "export default () => {};\n");
    settings(join(agentDir, "settings.json"), {
      packages: [{ source: "./pkg", extensions: [] }, { source: "./pkg" }],
    });

    const catalog = await discoverCatalog({
      agentDir,
      cwd,
      projectTrusted: false,
      reloadPending: false,
    });

    const rows = catalog.rows.filter(
      (row) => row.source === "./pkg" && row.kind === "extension",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      configured: false,
      resolvedAfterReload: false,
    });
    expect(rows[0]?.shadowedBy).toBeUndefined();
    expect(rows[1]).toMatchObject({
      configured: true,
      resolvedAfterReload: false,
      shadowedBy: "Global package ./pkg occurrence 1",
    });
  });

  test("applies canonical precedence between package and top-level symlink occurrences", async () => {
    const { agentDir, cwd } = fixture();
    const packageRoot = join(agentDir, "pkg");
    const actualPath = join(packageRoot, "actual.ts");
    const linkedPath = join(agentDir, "extensions", "manager.ts");
    put(
      join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: "fixture-package",
        pi: { extensions: ["./actual.ts"] },
      })}\n`,
    );
    put(actualPath, "export default () => {};\n");
    mkdirSync(dirname(linkedPath), { recursive: true });
    symlinkSync(actualPath, linkedPath);
    settings(join(agentDir, "settings.json"), { packages: ["./pkg"] });

    const catalog = await discoverCatalog({
      agentDir,
      cwd,
      projectTrusted: false,
      reloadPending: false,
    });
    const rows = catalog.rows.filter((row) => row.canonicalPath === actualPath);

    expect(rows).toHaveLength(2);
    expect(
      rows.map((row) => [
        row.id.startsWith("package:") ? "package" : "top",
        row.resolutionParticipant,
        row.resolvedAfterReload,
      ]),
    ).toEqual([
      ["package", false, true],
      ["top", true, true],
    ]);
    expect(rows.find((row) => row.id.startsWith("package:"))?.shadowedBy).toBe(
      "Global auto-discovery",
    );
    expect(
      rows.find((row) => row.id.startsWith("top:"))?.shadowedBy,
    ).toBeUndefined();
  });
});
