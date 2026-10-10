import { describe, expect, spyOn, test } from "bun:test";
import type { Dirent, PathLike, PathOrFileDescriptor, Stats } from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: Bun spies must intercept the live named ESM filesystem imports used by discovery.
import * as fs from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: Bun spies must intercept the live named ESM home-directory import, not its CommonJS default object.
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectWelcomeExtensions,
  effectiveQuietStartup,
  getAgentDir,
  welcomeSessions,
} from "./data.ts";

const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_HOUR = 3_600_000;
const MILLISECONDS_PER_DAY = 86_400_000;
const NEAR_FUTURE_OFFSET_MS = -10_000;
const MINUTES_BEFORE_HOUR = 59;
const HOURS_BEFORE_DAY = 23;
const DAYS_BEFORE_WEEK = 6;
const STALE_SESSION_DAYS = 9;

/**
 * Plans discovery I/O without touching the host filesystem; directories are
 * inferred from file parents and optional links model their target kinds.
 * @example mockDiscovery({ "/unit/agent/settings.json": "{}" });
 */
function mockDiscovery(
  files: Record<string, string>,
  options: {
    links?: Record<string, string>;
    directories?: string[];
    unreadableDirectories?: string[];
    statFailures?: string[];
  } = {},
): void {
  const links = options.links ?? {};
  const directories = new Set(options.directories ?? []);
  for (const path of [...Object.keys(files), ...Object.keys(links)]) {
    for (
      let parent = dirname(path);
      !directories.has(parent);
      parent = dirname(parent)
    ) {
      directories.add(parent);
      if (parent === dirname(parent)) {
        break;
      }
    }
  }
  const exists = (path: string) =>
    path in files || directories.has(path) || path in links;
  spyOn(os, "homedir").mockReturnValue("/unit/home");
  spyOn(fs, "existsSync").mockImplementation((path) => exists(String(path)));
  spyOn(fs, "readFileSync").mockImplementation(((
    path: PathOrFileDescriptor,
  ) => {
    const content = files[String(path)];
    if (content === undefined) {
      throw new Error("metadata unavailable");
    }
    return content;
  }) as typeof fs.readFileSync);
  spyOn(fs, "statSync").mockImplementation(((path: PathLike) => {
    const source = String(path);
    const target = links[source] ?? source;
    if (!exists(target) || options.statFailures?.includes(source)) {
      throw new Error("stat unavailable");
    }
    return {
      isFile: () => target in files,
      isDirectory: () => directories.has(target),
    } as Stats;
  }) as typeof fs.statSync);
  const discoveryFs: {
    readdirSync: (path: PathLike, options: { withFileTypes: true }) => Dirent[];
  } = fs;
  spyOn(discoveryFs, "readdirSync").mockImplementation((path) => {
    const directory = String(path);
    if (
      !directories.has(directory) ||
      options.unreadableDirectories?.includes(directory)
    ) {
      throw new Error("directory unavailable");
    }
    const children = new Set(
      [...Object.keys(files), ...directories, ...Object.keys(links)].filter(
        (candidate) =>
          candidate !== directory && dirname(candidate) === directory,
      ),
    );
    return [...children].map(
      (child) =>
        ({
          name: child.slice(directory.length + 1),
          isFile: () => child in files,
          isDirectory: () => directories.has(child),
          isSymbolicLink: () => child in links,
        }) as Dirent,
    );
  });
  spyOn(fs.realpathSync, "native").mockImplementation(((path: PathLike) => {
    const source = String(path);
    const target = links[source] ?? source;
    if (!exists(target)) {
      throw new Error("canonical path unavailable");
    }
    return resolve(target);
  }) as typeof fs.realpathSync.native);
}

const AGENT_DIR = "/unit/agent";
const PROJECT_DIR = "/unit/project";

describe("getAgentDir", () => {
  test.each([
    ["absent", undefined, "/unit/home/.pi/agent"],
    ["empty", "", "/unit/home/.pi/agent"],
    ["home only", "~", "/unit/home"],
    ["home relative", "~/agent", "/unit/home/agent"],
    ["file URL", "file:///unit/agent", "/unit/agent"],
    [
      "invalid file URL",
      "file://remote-host/agent",
      "file://remote-host/agent",
    ],
    ["relative", "./agent", "./agent"],
  ])(
    "should resolve the agent directory when the configured path is %s",
    (_condition, configured, expected) => {
      spyOn(os, "homedir").mockReturnValue("/unit/home");
      const env = Object.fromEntries([["PI_CODING_AGENT_DIR", configured]]);
      expect(getAgentDir(env)).toBe(expected);
    },
  );
});

describe("effectiveQuietStartup", () => {
  test.each([
    ["malformed JSON", "{"],
    ["array JSON", "[]"],
    ["null JSON", "null"],
    ["a nonboolean quiet setting", '{"quietStartup":"yes"}'],
  ])(
    "should retain user quiet startup when trusted project metadata contains %s",
    (_condition, metadata) => {
      mockDiscovery({
        [join(AGENT_DIR, "settings.json")]: '{"quietStartup":true}',
        [join(PROJECT_DIR, ".pi", "settings.json")]: metadata,
      });
      expect(effectiveQuietStartup(PROJECT_DIR, AGENT_DIR, true, ["pi"])).toBe(
        true,
      );
    },
  );

  test("should avoid reading project metadata when the project is untrusted", () => {
    mockDiscovery({
      [join(AGENT_DIR, "settings.json")]: '{"quietStartup":true}',
      [join(PROJECT_DIR, ".pi", "settings.json")]: '{"quietStartup":false}',
    });
    const read = spyOn(fs, "readFileSync");
    expect(effectiveQuietStartup(PROJECT_DIR, AGENT_DIR, false, ["pi"])).toBe(
      true,
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(join(AGENT_DIR, "settings.json"), "utf8");
  });
});

describe("collectWelcomeExtensions", () => {
  test.each([
    [
      "git:github:team/tool@main",
      "github.com/team/tool",
      "git:team/tool:feature",
    ],
    [
      "git:gitlab:team/tool.git",
      "gitlab.com/team/tool",
      "git:team/tool:feature",
    ],
    [
      "git:bitbucket:team/tool",
      "bitbucket.org/team/tool",
      "git:team/tool:feature",
    ],
    [
      "git:git@example.org:team/tool.git@main",
      "example.org/team/tool",
      "git:team/tool:feature",
    ],
    [
      "git:https://example.org/team/tool.git@main",
      "example.org/team/tool",
      "git:team/tool:feature",
    ],
    [
      "git:example.org/team/tool",
      "example.org/team/tool",
      "git:team/tool:feature",
    ],
    ["git:localhost/team/tool", "localhost/team/tool", "git:team/tool:feature"],
    ["git:team/tool", "github.com/team/tool", "git:tool:feature"],
    ["https://example.org/team/tool", "example.org/team/tool", "feature"],
  ])(
    "should discover cached git extensions and compact their labels when the source is %s",
    (source, cachePath, name) => {
      const root = join(AGENT_DIR, "git", cachePath);
      const extension = join(root, "extensions", "feature.ts");
      mockDiscovery({
        [join(AGENT_DIR, "settings.json")]: JSON.stringify({
          packages: [source],
        }),
        [join(root, "package.json")]:
          '{"pi":{"extensions":["extensions/feature.ts"]}}',
        [extension]: "",
      });
      expect(
        collectWelcomeExtensions({
          cwd: PROJECT_DIR,
          agentDir: AGENT_DIR,
          projectTrusted: false,
        }),
      ).toEqual([
        { name, scope: "user", path: extension, packageSource: source },
      ]);
    },
  );

  test.each([
    "git:invalid",
    "git:example.org/",
    "git:https://example.org/",
    "git:git@example.org:",
    "npm:",
  ])(
    "should skip unavailable package roots when the source is %s",
    (source) => {
      mockDiscovery({
        [join(AGENT_DIR, "settings.json")]: JSON.stringify({
          packages: [source],
        }),
      });
      expect(
        collectWelcomeExtensions({
          cwd: PROJECT_DIR,
          agentDir: AGENT_DIR,
          projectTrusted: false,
        }),
      ).toEqual([]);
    },
  );

  test("should traverse manifest globs once and apply exact forced overrides when paths include nested and cyclic links", () => {
    const root = join(AGENT_DIR, "npm", "node_modules", "tool");
    const keep = join(root, "extensions", "nested", "a.ts");
    const forced = join(root, "extensions", "forced.ts");
    mockDiscovery(
      {
        [join(AGENT_DIR, "settings.json")]: JSON.stringify({
          packages: [
            {
              source: "npm:tool",
              extensions: [
                "extensions/***",
                "!**/*.ts",
                "+extensions/forced.ts",
                "+extensions/nested/a.ts",
                "-extensions/blocked.ts",
              ],
            },
          ],
        }),
        [join(root, "package.json")]: JSON.stringify({
          pi: {
            extensions: [
              "extensions/**/?.ts",
              "extensions/*.ts",
              "extensions/missing/*.ts",
              "missing.ts",
            ],
          },
        }),
        [keep]: "",
        [forced]: "",
        [join(root, "extensions", "blocked.ts")]: "",
        [join(root, "extensions", ".hidden.ts")]: "",
      },
      {
        links: {
          [join(root, "extensions", "cycle")]: join(root, "extensions"),
          [join(root, "extensions", "broken")]: join(root, "missing"),
        },
      },
    );
    const rows = collectWelcomeExtensions({
      cwd: PROJECT_DIR,
      agentDir: AGENT_DIR,
      projectTrusted: false,
    });
    expect(rows.map(({ name, path }) => ({ name, path }))).toEqual([
      { name: "npm:tool:forced", path: forced },
      { name: "npm:tool:nested/a", path: keep },
    ]);
    expect(fs.readdirSync).not.toHaveBeenCalledWith(
      join(root, "extensions", "cycle"),
      { withFileTypes: true },
    );
  });

  test("should use absolute manifest globs and directory entries while applying manifest-level exclusions", () => {
    const root = join(AGENT_DIR, "npm", "node_modules", "tool");
    mockDiscovery({
      [join(AGENT_DIR, "settings.json")]: '{"packages":["npm:tool"]}',
      [join(root, "package.json")]: JSON.stringify({
        pi: {
          extensions: [
            join(root, "entries", "*.js"),
            "nested",
            "root/index.ts",
            "!**/hidden.js",
          ],
        },
      }),
      [join(root, "entries", "visible.js")]: "",
      [join(root, "entries", "hidden.js")]: "",
      [join(root, "nested", "package.json")]:
        '{"pi":{"extensions":["start.ts",42,"unavailable.ts"]}}',
      [join(root, "nested", "start.ts")]: "",
      [join(root, "root", "index.ts")]: "",
    });
    const rows = collectWelcomeExtensions({
      cwd: PROJECT_DIR,
      agentDir: AGENT_DIR,
      projectTrusted: false,
    });
    expect(rows.map((row) => row.name)).toEqual([
      "npm:tool:entries/visible",
      "npm:tool:nested/start",
      "npm:tool:root",
    ]);
  });

  test("should honor ordered exact filters when autoload is disabled", () => {
    const root = join(AGENT_DIR, "npm", "node_modules", "tool");
    mockDiscovery({
      [join(AGENT_DIR, "settings.json")]: JSON.stringify({
        packages: [
          {
            source: "npm:tool",
            autoload: false,
            extensions: [
              "**/*.ts",
              "-extensions/blocked.ts",
              "!**/excluded.ts",
              "+extensions/forced.ts",
            ],
          },
        ],
      }),
      [join(root, "package.json")]: '{"pi":{"extensions":["extensions/*.ts"]}}',
      [join(root, "extensions", "blocked.ts")]: "",
      [join(root, "extensions", "excluded.ts")]: "",
      [join(root, "extensions", "forced.ts")]: "",
      [join(root, "extensions", "normal.ts")]: "",
    });
    expect(
      collectWelcomeExtensions({
        cwd: PROJECT_DIR,
        agentDir: AGENT_DIR,
        projectTrusted: false,
      }).map((row) => row.name),
    ).toEqual(["npm:tool:forced", "npm:tool:normal"]);
  });

  test("should distinguish authoritative package metadata from default convention discovery", () => {
    const first = join(AGENT_DIR, "npm", "node_modules", "authoritative");
    const second = join(AGENT_DIR, "npm", "node_modules", "default");
    const third = join(AGENT_DIR, "npm", "node_modules", "convention");
    mockDiscovery({
      [join(AGENT_DIR, "settings.json")]: JSON.stringify({
        packages: [
          "npm:authoritative",
          { source: "npm:default" },
          "npm:convention",
        ],
      }),
      [join(first, "package.json")]: '{"pi":{"skills":["skills"]}}',
      [join(first, "extensions", "hidden.ts")]: "",
      [join(second, "package.json")]: '{"pi":{"skills":["skills"]}}',
      [join(second, "extensions", "visible.ts")]: "",
      [join(third, "extensions", "visible.ts")]: "",
    });
    expect(
      collectWelcomeExtensions({
        cwd: PROJECT_DIR,
        agentDir: AGENT_DIR,
        projectTrusted: false,
      }).map((row) => row.name),
    ).toEqual(["npm:convention:visible", "npm:default:visible"]);
  });

  test("should retain standalone file and directory packages while discarding malformed settings entries", () => {
    const standalone = join(AGENT_DIR, "standalone.ts");
    const directory = join(AGENT_DIR, "empty-package");
    mockDiscovery(
      {
        [join(AGENT_DIR, "settings.json")]: JSON.stringify({
          packages: [
            null,
            [],
            false,
            {},
            { source: 42 },
            standalone,
            directory,
          ],
          extensions: [false, null, { invalid: true }],
        }),
        [standalone]: "",
      },
      { directories: [directory] },
    );
    expect(
      collectWelcomeExtensions({
        cwd: PROJECT_DIR,
        agentDir: AGENT_DIR,
        projectTrusted: false,
      }),
    ).toEqual([
      {
        name: "empty-package",
        scope: "user",
        path: directory,
        packageSource: directory,
      },
      {
        name: "standalone",
        scope: "user",
        path: standalone,
        packageSource: standalone,
      },
    ]);
  });

  test("should use the last project package filter when duplicate package identities have different versions", () => {
    const root = join(PROJECT_DIR, ".pi", "npm", "node_modules", "tool");
    mockDiscovery({
      [join(PROJECT_DIR, ".pi", "settings.json")]: JSON.stringify({
        packages: [
          { source: "npm:tool@1", extensions: ["first.ts"] },
          { source: "npm:tool@2", extensions: ["last.ts"] },
        ],
      }),
      [join(root, "package.json")]:
        '{"pi":{"extensions":["first.ts","last.ts"]}}',
      [join(root, "first.ts")]: "",
      [join(root, "last.ts")]: "",
    });
    expect(
      collectWelcomeExtensions({
        cwd: PROJECT_DIR,
        agentDir: AGENT_DIR,
        projectTrusted: true,
      }),
    ).toEqual([
      {
        name: "npm:tool@2:last",
        scope: "project",
        path: join(root, "last.ts"),
        packageSource: "npm:tool@2",
      },
    ]);
  });

  test("should configure directory and file-URL entries while restoring exact auto-discovery exceptions", () => {
    const extensions = join(AGENT_DIR, "extensions");
    const configured = join(AGENT_DIR, "configured");
    mockDiscovery({
      [join(AGENT_DIR, "settings.json")]: JSON.stringify({
        extensions: [
          pathToFileURL(configured).href,
          "missing.ts",
          "!extensions/*.ts",
          "+extensions/kept.ts",
          "+extensions/blocked.ts",
          "-extensions/blocked.ts",
        ],
      }),
      [join(configured, "index.js")]: "",
      [join(extensions, "kept.ts")]: "",
      [join(extensions, "blocked.ts")]: "",
      [join(extensions, "excluded.ts")]: "",
      [join(extensions, "bad.txt")]: "",
    });
    expect(
      collectWelcomeExtensions({
        cwd: PROJECT_DIR,
        agentDir: AGENT_DIR,
        projectTrusted: false,
      }).map((row) => row.name),
    ).toEqual(["configured", "kept"]);
  });

  test("should honor ignore-rule precedence and tolerate inaccessible discovery paths", () => {
    const extensions = join(AGENT_DIR, "extensions");
    mockDiscovery(
      {
        [join(AGENT_DIR, "settings.json")]: JSON.stringify({
          extensions: ["unreadable"],
        }),
        [join(extensions, ".gitignore")]:
          "\n# comment\n*.ts\n!kept.ts\n\\#hash.ts\n\\!bang.ts\n",
        [join(extensions, ".ignore")]: "!also-kept.ts\n",
        [join(extensions, ".fdignore")]: "/ignored-dir/\n",
        [join(extensions, "kept.ts")]: "",
        [join(extensions, "also-kept.ts")]: "",
        [join(extensions, "#hash.ts")]: "",
        [join(extensions, "!bang.ts")]: "",
        [join(extensions, "other.ts")]: "",
        [join(extensions, "ignored-dir", "index.js")]: "",
        [join(AGENT_DIR, "target.js")]: "",
      },
      {
        directories: [join(AGENT_DIR, "unreadable")],
        unreadableDirectories: [join(AGENT_DIR, "unreadable")],
        links: {
          [join(extensions, "linked.js")]: join(AGENT_DIR, "target.js"),
          [join(extensions, "broken.ts")]: join(AGENT_DIR, "missing.ts"),
        },
      },
    );
    expect(
      collectWelcomeExtensions({
        cwd: PROJECT_DIR,
        agentDir: AGENT_DIR,
        projectTrusted: false,
      }).map((row) => row.name),
    ).toEqual(["also-kept", "kept", "linked"]);
  });

  test("should disambiguate equal local basenames within a scope", () => {
    mockDiscovery({
      [join(AGENT_DIR, "settings.json")]:
        '{"extensions":["first/same.ts","second/same.ts"]}',
      [join(AGENT_DIR, "first", "same.ts")]: "",
      [join(AGENT_DIR, "second", "same.ts")]: "",
    });
    expect(
      collectWelcomeExtensions({
        cwd: PROJECT_DIR,
        agentDir: AGENT_DIR,
        projectTrusted: false,
      }).map((row) => row.name),
    ).toEqual(["first/same", "second/same"]);
  });

  test("should skip a package when its previously available root cannot be inspected", () => {
    const root = join(AGENT_DIR, "package");
    mockDiscovery(
      {
        [join(AGENT_DIR, "settings.json")]: '{"packages":["./package"]}',
        [join(root, "package.json")]: "{}",
      },
      { statFailures: [root] },
    );
    expect(
      collectWelcomeExtensions({
        cwd: PROJECT_DIR,
        agentDir: AGENT_DIR,
        projectTrusted: false,
      }),
    ).toEqual([]);
  });
});

describe("welcomeSessions", () => {
  test("should use explicit names, then sanitized prompts, then OMP untitled labels and ages", () => {
    const now = new Date("2026-08-12T12:00:00.000Z").getTime();
    const named = {
      name: "  Named\nignored",
      firstMessage: "prompt",
      created: new Date(now),
      modified: new Date(now - 10 * MILLISECONDS_PER_MINUTE),
    };
    const prompted = {
      firstMessage: "  first prompt\nsecond line",
      created: new Date(now),
      modified: new Date(now - 2 * 60 * MILLISECONDS_PER_MINUTE),
    };
    const untitled = {
      firstMessage: "(no messages)",
      created: new Date("2026-08-01T10:30:00.000Z"),
      modified: new Date(now - STALE_SESSION_DAYS * MILLISECONDS_PER_DAY),
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
    ["just now", "from near future", NEAR_FUTURE_OFFSET_MS],
    [
      "59m ago",
      "59 minutes old",
      MINUTES_BEFORE_HOUR * MILLISECONDS_PER_MINUTE,
    ],
    ["23h ago", "23 hours old", HOURS_BEFORE_DAY * MILLISECONDS_PER_HOUR],
    ["6d ago", "6 days old", DAYS_BEFORE_WEEK * MILLISECONDS_PER_DAY],
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
