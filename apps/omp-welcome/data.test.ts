import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  collectWelcomeExtensions,
  effectiveQuietStartup,
  type WelcomeExtension,
  welcomeSessions,
} from "./data.ts";

const temporaryRoots: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-welcome-"));
  temporaryRoots.push(directory);
  return directory;
}

function write(filePath: string, content = "export default () => {};\n"): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function writePackage(root: string, extensions: readonly string[]): void {
  write(join(root, "package.json"), JSON.stringify({ pi: { extensions } }));
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
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("collectWelcomeExtensions", () => {
  test("should honor root entries, ignored files, and symlink targets exactly once", () => {
    const root = temporaryDirectory();
    const extensions = join(root, "extensions");
    write(join(extensions, "first.ts"));
    write(join(extensions, ".hidden.ts"));
    write(join(extensions, "node_modules", "ignored.ts"));
    write(join(extensions, "ignored-by-rule.ts"));
    write(join(extensions, ".gitignore"), "ignored-by-rule.ts\n");
    const linked = join(root, "linked");
    write(join(linked, "index.js"));
    symlinkSync(linked, join(extensions, "linked"), "dir");

    const discovered = () =>
      collectWelcomeExtensions({
        cwd: join(root, "project"),
        agentDir: root,
        projectTrusted: false,
      })
        .flatMap((row) => (row.path ? [relative(extensions, row.path)] : []))
        .sort();

    expect(discovered()).toEqual(["first.ts", "linked/index.js"]);

    write(join(extensions, "index.ts"));
    expect(discovered()).toEqual(["index.ts"]);
  });
});

describe("welcome extension snapshot", () => {
  test("should use Pi scope precedence, filters, package deltas, and base directories", () => {
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

    const rows = collectWelcomeExtensions({
      cwd,
      agentDir,
      projectTrusted: true,
      welcomePath: join(agentDir, "extensions", "welcome", "index.ts"),
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

  test("should use convention files for a filtered empty manifest and normalize glob entries", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const packageRoot = join(agentDir, "pkg");

    write(
      join(packageRoot, "package.json"),
      JSON.stringify({ pi: { extensions: [] } }),
    );
    write(join(packageRoot, "extensions", "enabled.ts"));
    write(
      join(agentDir, "settings.json"),
      JSON.stringify({
        packages: [{ source: " ./pkg ", extensions: ["./extensions/*.ts"] }],
      }),
    );

    expect(
      collectWelcomeExtensions({ cwd, agentDir, projectTrusted: true }),
    ).toEqual([
      {
        name: "enabled",
        scope: "user",
        path: join(packageRoot, "extensions", "enabled.ts"),
        packageSource: " ./pkg ",
      },
    ]);
  });

  test("should omit all project-local settings, packages, and files when untrusted", () => {
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

    const rows = collectWelcomeExtensions({
      cwd,
      agentDir,
      projectTrusted: false,
    });
    expect(rows.map((row) => `${row.name}:${row.scope}`)).toEqual([
      "user:user",
    ]);
  });

  test("should honor effective quiet startup and its verbose command-line override", () => {
    const root = temporaryDirectory();
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    write(
      join(agentDir, "settings.json"),
      JSON.stringify({ quietStartup: true }),
    );
    write(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ quietStartup: false }),
    );

    expect(effectiveQuietStartup(cwd, agentDir, false, ["pi"])).toBe(true);
    expect(effectiveQuietStartup(cwd, agentDir, true, ["pi"])).toBe(false);
    expect(
      effectiveQuietStartup(cwd, agentDir, false, ["pi", "--verbose"]),
    ).toBe(false);
  });
});

describe("welcomeSessions", () => {
  test("should use explicit names, then sanitized prompts, then OMP untitled labels and ages", () => {
    const now = new Date("2026-08-12T12:00:00.000Z").getTime();
    const named = {
      name: "  Named\nignored",
      firstMessage: "prompt",
      created: new Date(now),
      modified: new Date(now - 10 * 60_000),
    };
    const prompted = {
      firstMessage: "  first prompt\nsecond line",
      created: new Date(now),
      modified: new Date(now - 2 * 60 * 60_000),
    };
    const untitled = {
      firstMessage: "(no messages)",
      created: new Date("2026-08-01T10:30:00.000Z"),
      modified: new Date(now - 9 * 86_400_000),
    };

    expect(welcomeSessions([named, prompted, untitled], now)).toEqual([
      { name: "Named", timeAgo: "10m ago" },
      { name: "first prompt", timeAgo: "2h ago" },
      {
        name: "Untitled · 10:30 AM",
        timeAgo: untitled.modified.toLocaleDateString(),
      },
    ]);
  });

  test.each([
    ["just now", "from the near future", -10_000],
    ["59m ago", "59 minutes old", 59 * 60_000],
    ["23h ago", "23 hours old", 23 * 3_600_000],
    ["6d ago", "6 days old", 6 * 86_400_000],
  ] as const)(
    "should format age %s when session is %s",
    (expected, _condition, age) => {
      const now = new Date("2026-08-12T12:00:00.000Z").getTime();
      const modified = new Date(now - age);
      const sessions = welcomeSessions(
        [{ firstMessage: "Session", created: modified, modified }],
        now,
      );

      expect(sessions[0]?.timeAgo).toBe(expected);
    },
  );
});
