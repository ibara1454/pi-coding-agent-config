import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverCatalog } from "./discovery.ts";

const MODULE = "export default () => {};\n";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly agentDir: string;
  readonly cwd: string;
  readonly root: string;
}

function fixture(): Fixture {
  const created = mkdtempSync(join(tmpdir(), "extension-manager-"));
  roots.push(created);
  const root = realpathSync.native(created);
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

function manifest(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function sideEffect(marker: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(marker)}, "executed");`,
    "export default () => {};",
    "",
  ].join("\n");
}

interface ExecutionCase {
  readonly label: string;
  readonly declare: (agentDir: string, marker: string) => string;
}

const executionCases: readonly ExecutionCase[] = [
  {
    label: "a top-level settings entry",
    declare: (agentDir, marker) => {
      const path = join(agentDir, "extensions", "alpha.ts");
      put(path, sideEffect(marker));
      settings(join(agentDir, "settings.json"), {
        extensions: ["./extensions/alpha.ts"],
      });
      return path;
    },
  },
  {
    label: "a package manifest entry",
    declare: (agentDir, marker) => {
      const packageRoot = join(agentDir, "pkg");
      const path = join(packageRoot, "extensions", "alpha.ts");
      const content = manifest({
        name: "fixture-package",
        pi: { extensions: ["./extensions/alpha.ts"] },
      });
      put(join(packageRoot, "package.json"), content);
      put(path, sideEffect(marker));
      settings(join(agentDir, "settings.json"), { packages: ["./pkg"] });
      return path;
    },
  },
];

interface SymlinkDeclaration {
  readonly actual: string;
  readonly linked: string;
  readonly target: Record<string, string>;
}

interface SymlinkCase {
  readonly label: string;
  readonly declare: (agentDir: string, root: string) => SymlinkDeclaration;
}

const symlinkCases: readonly SymlinkCase[] = [
  {
    label: "a top-level settings entry",
    declare: (agentDir, root) => {
      const actual = join(root, "shared", "alpha.ts");
      const linked = join(agentDir, "extensions", "linked.ts");
      put(actual, MODULE);
      mkdirSync(dirname(linked), { recursive: true });
      symlinkSync(actual, linked);
      settings(join(agentDir, "settings.json"), {
        extensions: ["./extensions/linked.ts"],
      });
      return {
        actual,
        linked,
        target: {
          filterPath: "extensions/linked.ts",
          resolvedPath: linked,
        },
      };
    },
  },
  {
    label: "a package manifest entry",
    declare: (agentDir) => {
      const packageRoot = join(agentDir, "pkg");
      const actual = join(packageRoot, "extensions", "actual.ts");
      const linked = join(packageRoot, "extensions", "linked.ts");
      const content = manifest({
        name: "fixture-package",
        pi: { extensions: ["./extensions/linked.ts"] },
      });
      put(join(packageRoot, "package.json"), content);
      put(actual, MODULE);
      symlinkSync(actual, linked);
      settings(join(agentDir, "settings.json"), { packages: ["./pkg"] });
      return {
        actual,
        linked,
        target: {
          canonicalPackageRoot: packageRoot,
          filterPath: "extensions/linked.ts",
          packageRoot,
          resolvedPath: linked,
        },
      };
    },
  },
];

interface DeltaCase {
  readonly label: string;
  readonly filters: readonly string[];
  readonly configured: boolean;
}

const deltaCases: readonly DeltaCase[] = [
  {
    label: "the Project delta selects the child",
    filters: ["+extensions/alpha.ts"],
    configured: true,
  },
  {
    label: "the Project delta leaves the child unselected",
    filters: [],
    configured: false,
  },
];

describe("discoverCatalog", () => {
  test.each([false, true])(
    "should expose project resources only when trusted (%s)",
    async (projectTrusted) => {
      const { agentDir, cwd } = fixture();
      put(join(agentDir, "extensions", "global.ts"), MODULE);
      settings(join(agentDir, "settings.json"), {});
      put(join(cwd, ".pi", "settings.json"), "{");
      put(join(cwd, ".pi", "extensions", "hidden.ts"), MODULE);

      const catalog = await discoverCatalog({
        agentDir,
        cwd,
        projectTrusted,
        reloadPending: false,
      });
      const projectRows = catalog.rows.filter((r) => r.scope === "project");
      const projectDiagnostics = catalog.diagnostics.filter(
        (diagnostic) => diagnostic.scope === "project",
      );

      expect(catalog.projectTrusted).toBe(projectTrusted);
      expect(catalog.rows.some((row) => row.scope === "global")).toBe(true);
      expect(catalog.settings.has("project")).toBe(projectTrusted);
      expect(projectRows.length > 0).toBe(projectTrusted);
      expect(projectDiagnostics.length > 0).toBe(projectTrusted);
    },
  );
  test.each(executionCases.map((entry) => [entry.label, entry] as const))(
    "should never execute an extension declared by %s",
    async (_label, scenario) => {
      const { agentDir, cwd, root } = fixture();
      const marker = join(root, "executed");
      const path = scenario.declare(agentDir, marker);

      const catalog = await discoverCatalog({
        agentDir,
        cwd,
        projectTrusted: false,
        reloadPending: false,
      });

      expect(catalog.rows.some((row) => row.path === path)).toBe(true);
      expect(existsSync(marker)).toBe(false);
    },
  );
  test.each(symlinkCases.map((entry) => [entry.label, entry] as const))(
    "should persist the raw symlink path declared by %s",
    async (_label, scenario) => {
      const { agentDir, cwd, root } = fixture();
      const declared = scenario.declare(agentDir, root);

      const catalog = await discoverCatalog({
        agentDir,
        cwd,
        projectTrusted: false,
        reloadPending: false,
      });
      const row = catalog.rows.find(
        (candidate) => candidate.path === declared.linked,
      );
      const target =
        row === undefined ? undefined : catalog.targets.get(row.id);

      expect(row?.canonicalPath).toBe(declared.actual);
      expect(target).toMatchObject(declared.target);
    },
  );

  test("should keep both raw aliases of one canonical file addressable", async () => {
    const { agentDir, cwd } = fixture();
    const packageRoot = join(agentDir, "pkg");
    const actual = join(packageRoot, "extensions", "actual.ts");
    const linked = join(packageRoot, "extensions", "linked.ts");
    const content = manifest({
      name: "fixture-package",
      pi: { extensions: ["./extensions"] },
    });
    put(join(packageRoot, "package.json"), content);
    put(actual, MODULE);
    symlinkSync(actual, linked);
    settings(join(agentDir, "settings.json"), {
      packages: [{ source: "./pkg", extensions: ["extensions/actual.ts"] }],
    });

    const catalog = await discoverCatalog({
      agentDir,
      cwd,
      projectTrusted: false,
      reloadPending: false,
    });
    const rows = catalog.rows.filter(
      (row) => row.source === "./pkg" && row.canonicalPath === actual,
    );
    const filterPaths = rows.map(
      (row) => catalog.targets.get(row.id)?.filterPath,
    );

    expect(rows.map((row) => row.configured).toSorted()).toEqual([false, true]);
    expect(filterPaths.toSorted()).toEqual([
      "extensions/actual.ts",
      "extensions/linked.ts",
    ]);
    expect(new Set(rows.map((row) => row.resolvedAfterReload))).toHaveLength(1);
  });
  test.each(deltaCases.map((entry) => [entry.label, entry] as const))(
    "should resolve a Project delta against the Global install when %s",
    async (_label, scenario) => {
      const { agentDir, cwd } = fixture();
      const packageRoot = join(agentDir, "npm", "node_modules", "kit");
      const content = manifest({
        name: "kit",
        version: "1.0.0",
        pi: { extensions: ["./extensions/alpha.ts"] },
      });
      put(join(packageRoot, "package.json"), content);
      put(join(packageRoot, "extensions", "alpha.ts"), MODULE);
      settings(join(agentDir, "settings.json"), { packages: ["npm:kit"] });
      settings(join(cwd, ".pi", "settings.json"), {
        packages: [
          {
            source: "npm:kit",
            autoload: false,
            extensions: [...scenario.filters],
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
      const projectInstall = join(cwd, ".pi", "npm", "node_modules", "kit");

      expect(rows).toHaveLength(2);
      expect(projectRow?.configured).toBe(scenario.configured);
      expect(projectTarget).toMatchObject({
        type: "package",
        packageRoot,
        packageSourcePath: packageRoot,
        autoloadDelta: true,
      });
      expect(existsSync(projectInstall)).toBe(false);
    },
  );
});
