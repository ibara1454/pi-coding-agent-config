import { afterEach, describe, expect, it, spyOn } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: The install guard intercepts Pi's live Node process-launch imports.
import * as childProcess from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { collectWelcomeExtensions, type WelcomeExtension } from "./data.ts";

const temporaryRoots: string[] = [];
const originalHome = process.env["HOME"];
const originalOffline = process.env["PI_OFFLINE"];

/**
 * Creates fixtures and isolates native Pi's home-directory discovery.
 * @returns A test-owned root; afterEach restores HOME and removes the tree.
 * @example temporaryDirectory(); // Native discovery cannot read the real ~/.agents/skills.
 */
function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-welcome-")));
  temporaryRoots.push(directory);
  process.env["HOME"] = join(directory, "home");
  return directory;
}

function write(filePath: string, content = "export default () => {};\n"): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

/**
 * Writes an installed-package fixture with version metadata accepted by native Pi.
 * @param root Test-owned package cache directory.
 * @param extensions Relative extension paths to create and declare.
 * @example writePackage("/tmp/probe/pkg", ["extensions/one.ts"]);
 */
function writePackage(root: string, extensions: readonly string[]): void {
  write(
    join(root, "package.json"),
    JSON.stringify({ version: "1.0.0", pi: { extensions } }),
  );
  for (const extension of extensions) {
    write(join(root, extension));
  }
}

function rowsByScope(
  rows: readonly WelcomeExtension[],
  scope: "project" | "user",
): string[] {
  return rows.filter((row) => row.scope === scope).map((row) => row.name);
}
afterEach(() => {
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
  if (originalOffline === undefined) {
    delete process.env["PI_OFFLINE"];
  } else {
    process.env["PI_OFFLINE"] = originalOffline;
  }
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("collectWelcomeExtensions", () => {
  it("should use Pi scope precedence, filters, package deltas, and base directories", async () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const projectDir = join(cwd, ".pi");

    write(join(agentDir, "extensions", "user.ts"));
    write(join(agentDir, "extensions", "disabled.ts"));
    write(join(agentDir, "extensions", "user-dir", "index.ts"));
    write(join(agentDir, "configured.ts"));
    write(join(projectDir, "extensions", "project.ts"));
    write(join(projectDir, "extensions", "project-dir", "index.js"));
    write(join(projectDir, "configured.ts"));

    writePackage(join(agentDir, "npm", "node_modules", "@scope", "pkg"), [
      "extensions/one.ts",
    ]);
    writePackage(join(projectDir, "npm", "node_modules", "@scope", "pkg"), [
      "extensions/one.ts",
    ]);
    writePackage(join(agentDir, "npm", "node_modules", "@scope", "delta"), [
      "extensions/one.ts",
      "extensions/two.ts",
    ]);
    writePackage(join(agentDir, "npm", "node_modules", "@scope", "filtered"), [
      "extensions/hidden.ts",
    ]);

    write(
      join(agentDir, "settings.json"),
      JSON.stringify({
        extensions: ["configured.ts", "!extensions/disabled.ts"],
        packages: [
          "npm:@scope/pkg",
          "npm:@scope/delta",
          { source: "npm:@scope/filtered", extensions: [] },
        ],
      }),
    );
    write(
      join(projectDir, "settings.json"),
      JSON.stringify({
        extensions: ["configured.ts"],
        packages: [
          "npm:@scope/pkg",
          {
            source: "npm:@scope/delta",
            autoload: false,
            extensions: ["extensions/one.ts"],
          },
        ],
      }),
    );

    const rows = await collectWelcomeExtensions({
      cwd,
      agentDir,
      projectTrusted: true,
    });
    const project = rowsByScope(rows, "project");
    const user = rowsByScope(rows, "user");

    expect(project).toContain("npm:@scope/delta:one");
    expect(project).toContain("npm:@scope/pkg:one");
    expect(project).toContain("project-dir");
    expect(project).toContain("project");
    expect(project).toContain("configured");
    expect(user).toContain("npm:@scope/delta:two");
    expect(user).toContain("user-dir");
    expect(user).toContain("user");
    expect(user).toContain("configured");
    expect(rows.some((row) => row.name.includes("filtered"))).toBe(false);
    expect(rows.some((row) => row.name.includes("disabled"))).toBe(false);
    expect(rows.filter((row) => row.name === "npm:@scope/pkg:one")).toEqual([
      {
        name: "npm:@scope/pkg:one",
        scope: "project",
        path: join(
          projectDir,
          "npm",
          "node_modules",
          "@scope",
          "pkg",
          "extensions",
          "one.ts",
        ),
        packageSource: "npm:@scope/pkg",
      },
    ]);
  });

  it("should omit all project-local settings, packages, and files when untrusted", async () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    write(join(agentDir, "extensions", "user.ts"));
    write(join(cwd, ".pi", "extensions", "project.ts"));
    write(join(cwd, ".pi", "configured.ts"));
    write(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        extensions: ["configured.ts"],
        packages: ["npm:@scope/project"],
      }),
    );

    const rows = await collectWelcomeExtensions({
      cwd,
      agentDir,
      projectTrusted: false,
    });
    expect(rows.map((row) => `${row.name}:${row.scope}`)).toEqual([
      "user:user",
    ]);
  });

  it("should retain valid resource entries when settings contain malformed sources and paths", async () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const configured = join(agentDir, "configured.ts");
    const packaged = join(agentDir, "pkg", "extensions", "packaged.ts");
    write(configured);
    writePackage(join(agentDir, "pkg"), ["extensions/packaged.ts"]);
    write(
      join(agentDir, "settings.json"),
      '{"packages":[null,[],false,{},{"source":42},"./pkg"],"extensions":[false,null,{},"configured.ts"]}',
    );
    expect(
      await collectWelcomeExtensions({
        cwd,
        agentDir,
        projectTrusted: false,
      }),
    ).toEqual([
      { name: "configured", scope: "user", path: configured },
      {
        name: "packaged",
        scope: "user",
        path: packaged,
        packageSource: "./pkg",
      },
    ]);
  });

  it("should skip missing packages without installing resources or executing extension modules", async () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const projectDir = join(cwd, ".pi");
    const marker = join(root, "extension-executed");
    const extension = join(agentDir, "extensions", "visible.ts");
    write(
      extension,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); export default () => {};`,
    );
    write(
      join(agentDir, "settings.json"),
      '{"packages":["git:github.com/pi-welcome-probe/missing"]}',
    );
    write(
      join(projectDir, "settings.json"),
      '{"packages":["npm:@pi-welcome-probe/missing@1.0.0"]}',
    );
    const originalUser = readFileSync(join(agentDir, "settings.json"), "utf8");
    const originalProject = readFileSync(
      join(projectDir, "settings.json"),
      "utf8",
    );
    delete process.env["PI_OFFLINE"];
    const spawn = spyOn(childProcess, "spawn").mockImplementation(() => {
      throw new Error("Inventory must not launch installers");
    });
    const spawnSync = spyOn(childProcess, "spawnSync").mockImplementation(
      () => {
        throw new Error("Inventory must not launch installers");
      },
    );

    expect(
      await collectWelcomeExtensions({
        cwd,
        agentDir,
        projectTrusted: true,
      }),
    ).toEqual([{ name: "visible", scope: "user", path: extension }]);
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(agentDir, "git"))).toBe(false);
    expect(existsSync(join(projectDir, "npm"))).toBe(false);
    expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(
      originalUser,
    );
    expect(readFileSync(join(projectDir, "settings.json"), "utf8")).toBe(
      originalProject,
    );
  });
});
