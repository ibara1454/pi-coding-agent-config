import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  collectWelcomeExtensions,
  discoverExtensionFiles,
  effectiveQuietStartup,
  formatSessionAge,
  sessionLabel,
  welcomeSessions,
  type WelcomeExtension,
} from "./data.ts";

const temporaryRoots: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-welcome-"));
  temporaryRoots.push(directory);
  return directory;
}

function write(filePath: string, content = "export default () => {};\n"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writePackage(root: string, extensions: readonly string[]): void {
  write(path.join(root, "package.json"), JSON.stringify({ pi: { extensions } }));
  for (const extension of extensions) write(path.join(root, extension));
}

function rowsByScope(rows: readonly WelcomeExtension[], scope: "project" | "user"): string[] {
  return rows.filter(row => row.scope === scope).map(row => row.name);
}
afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Pi extension discovery", () => {
  test("honors root entries, ignored files, and symlink targets exactly once", () => {
    const root = temporaryDirectory();
    const extensions = path.join(root, "extensions");
    write(path.join(extensions, "first.ts"));
    write(path.join(extensions, ".hidden.ts"));
    write(path.join(extensions, "node_modules", "ignored.ts"));
    write(path.join(extensions, "ignored-by-rule.ts"));
    write(path.join(extensions, ".gitignore"), "ignored-by-rule.ts\n");
    const linked = path.join(root, "linked");
    write(path.join(linked, "index.js"));
    fs.symlinkSync(linked, path.join(extensions, "linked"), "dir");

    expect(discoverExtensionFiles(extensions).map(file => path.relative(extensions, file)).sort()).toEqual(["first.ts", "linked/index.js"]);

    write(path.join(extensions, "index.ts"));
    expect(discoverExtensionFiles(extensions).map(file => path.relative(extensions, file))).toEqual(["index.ts"]);
  });
});

describe("welcome extension snapshot", () => {
  test("uses Pi scope precedence, filters, package deltas, and base directories", () => {
    const root = temporaryDirectory();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    const projectDir = path.join(cwd, ".pi");

    write(path.join(agentDir, "extensions", "user.ts"));
    write(path.join(agentDir, "extensions", "disabled.ts"));
    write(path.join(agentDir, "extensions", "user-dir", "index.ts"));
    write(path.join(agentDir, "configured.ts"));
    write(path.join(projectDir, "extensions", "project.ts"));
    write(path.join(projectDir, "extensions", "project-dir", "index.js"));
    write(path.join(projectDir, "configured.ts"));

    writePackage(path.join(agentDir, "npm", "node_modules", "@scope", "pkg"), ["extensions/one.ts"]);
    writePackage(path.join(projectDir, "npm", "node_modules", "@scope", "pkg"), ["extensions/one.ts"]);
    writePackage(path.join(agentDir, "npm", "node_modules", "@scope", "delta"), ["extensions/one.ts", "extensions/two.ts"]);
    writePackage(path.join(agentDir, "npm", "node_modules", "@scope", "filtered"), ["extensions/hidden.ts"]);

    write(path.join(agentDir, "settings.json"), JSON.stringify({
      extensions: ["configured.ts", "!extensions/disabled.ts"],
      packages: [
        "npm:@scope/pkg",
        "npm:@scope/delta",
        { source: "npm:@scope/filtered", extensions: [] },
      ],
    }));
    write(path.join(projectDir, "settings.json"), JSON.stringify({
      extensions: ["configured.ts"],
      packages: [
        "npm:@scope/pkg",
        { source: "npm:@scope/delta", autoload: false, extensions: ["extensions/one.ts"] },
      ],
    }));

    const rows = collectWelcomeExtensions({
      cwd,
      agentDir,
      projectTrusted: true,
      welcomePath: path.join(agentDir, "extensions", "welcome", "index.ts"),
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
    expect(user).toContain("welcome");
    expect(user).toContain("configured");
    expect(rows.some(row => row.name.includes("filtered"))).toBe(false);
    expect(rows.some(row => row.name.includes("disabled"))).toBe(false);
    expect(rows.filter(row => row.name === "npm:@scope/pkg:one")).toEqual([{ name: "npm:@scope/pkg:one", scope: "project", path: path.join(projectDir, "npm", "node_modules", "@scope", "pkg", "extensions", "one.ts"), packageSource: "npm:@scope/pkg" }]);
  });

  test("uses convention files for a filtered empty manifest and normalizes glob entries", () => {
    const root = temporaryDirectory();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    const packageRoot = path.join(agentDir, "pkg");

    write(path.join(packageRoot, "package.json"), JSON.stringify({ pi: { extensions: [] } }));
    write(path.join(packageRoot, "extensions", "enabled.ts"));
    write(path.join(agentDir, "settings.json"), JSON.stringify({
      packages: [{ source: " ./pkg ", extensions: ["./extensions/*.ts"] }],
    }));

    expect(collectWelcomeExtensions({ cwd, agentDir, projectTrusted: true })).toEqual([
      {
        name: "enabled",
        scope: "user",
        path: path.join(packageRoot, "extensions", "enabled.ts"),
        packageSource: " ./pkg ",
      },
    ]);
  });

  test("omits all project-local settings, packages, and files when untrusted", () => {
    const root = temporaryDirectory();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    write(path.join(agentDir, "extensions", "user.ts"));
    write(path.join(cwd, ".pi", "extensions", "project.ts"));
    write(path.join(cwd, ".pi", "configured.ts"));
    write(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: ["configured.ts"], packages: ["npm:@scope/project"] }));

    const rows = collectWelcomeExtensions({ cwd, agentDir, projectTrusted: false });
    expect(rows.map(row => `${row.name}:${row.scope}`)).toEqual(["user:user"]);
  });

  test("honors effective quiet startup and its verbose command-line override", () => {
    const root = temporaryDirectory();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    write(path.join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true }));
    write(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ quietStartup: false }));

    expect(effectiveQuietStartup(cwd, agentDir, false, ["pi"])).toBe(true);
    expect(effectiveQuietStartup(cwd, agentDir, true, ["pi"])).toBe(false);
    expect(effectiveQuietStartup(cwd, agentDir, false, ["pi", "--verbose"])).toBe(false);
  });
});

describe("recent session labels", () => {
  test("uses explicit names, then sanitized prompts, then OMP untitled labels and ages", () => {
    const now = new Date("2026-08-12T12:00:00.000Z").getTime();
    const named = { name: "  Named\nignored", firstMessage: "prompt", created: new Date(now), modified: new Date(now - 10 * 60_000) };
    const prompted = { firstMessage: "  first prompt\nsecond line", created: new Date(now), modified: new Date(now - 2 * 60 * 60_000) };
    const untitled = { firstMessage: "(no messages)", created: new Date("2026-08-01T10:30:00.000Z"), modified: new Date(now - 9 * 86_400_000) };

    expect(sessionLabel(named)).toBe("Named");
    expect(sessionLabel(prompted)).toBe("first prompt");
    expect(sessionLabel(untitled)).toBe("Untitled · 10:30 AM");
    expect(formatSessionAge(new Date(now + 10_000), now)).toBe("just now");
    expect(formatSessionAge(new Date(now - 59 * 60_000), now)).toBe("59m ago");
    expect(formatSessionAge(new Date(now - 23 * 3_600_000), now)).toBe("23h ago");
    expect(formatSessionAge(new Date(now - 6 * 86_400_000), now)).toBe("6d ago");
    expect(welcomeSessions([named, prompted, untitled], now).map(session => session.name)).toEqual(["Named", "first prompt", "Untitled · 10:30 AM"]);
  });
});
