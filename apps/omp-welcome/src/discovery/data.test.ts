import { describe, expect, it, spyOn } from "bun:test";
import type { PathLike, PathOrFileDescriptor } from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: Bun spies must intercept the live named ESM filesystem imports used by discovery.
import * as fs from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: Bun spies must intercept the live named ESM home-directory import, not its CommonJS default object.
import * as os from "node:os";
import { join, resolve } from "node:path";
import {
  DefaultPackageManager,
  type PathMetadata,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
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
 * Plans settings reads and canonical paths without touching host state.
 * @param files Planned JSON contents; unlisted reads fail as missing metadata.
 * @returns Nothing; shared setup restores the scoped filesystem and home spies.
 * @example mockSettings({ "/unit/agent/settings.json": "{}" });
 */
function mockSettings(files: Record<string, string>): void {
  spyOn(os, "homedir").mockReturnValue("/unit/home");
  spyOn(fs, "readFileSync").mockImplementation(((
    path: PathOrFileDescriptor,
  ) => {
    const content = files[String(path)];
    if (content === undefined) {
      throw new Error("metadata unavailable");
    }
    return content;
  }) as typeof fs.readFileSync);
  spyOn(fs.realpathSync, "native").mockImplementation(((path: PathLike) =>
    resolve(String(path))) as typeof fs.realpathSync.native);
}

/**
 * Supplies native candidates while keeping display-policy tests independent of Pi discovery.
 * @param extensions Planned native candidates, including disabled entries.
 * @returns The resolver spy for planned native failures.
 * @example mockInventory([]); // A welcome entrypoint is displayed through its self-entry fallback.
 */
function mockInventory(extensions: ResolvedResource[]) {
  mockSettings({});
  return spyOn(DefaultPackageManager.prototype, "resolve").mockResolvedValue({
    extensions,
    skills: [],
    prompts: [],
    themes: [],
  });
}

const AGENT_DIR = "/unit/agent";
const PROJECT_DIR = "/unit/project";
const USER_METADATA: PathMetadata = {
  source: "auto",
  scope: "user",
  origin: "top-level",
};

describe("getAgentDir", () => {
  it.each([
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
  it.each([
    ["malformed JSON", "{"],
    ["array JSON", "[]"],
    ["null JSON", "null"],
    ["an invalid quiet setting", '{"quietStartup":"yes"}'],
  ])(
    "should retain user quiet startup when trusted project metadata contains %s",
    (_condition, metadata) => {
      mockSettings({
        [join(AGENT_DIR, "settings.json")]: '{"quietStartup":true}',
        [join(PROJECT_DIR, ".pi", "settings.json")]: metadata,
      });
      expect(effectiveQuietStartup(PROJECT_DIR, AGENT_DIR, true, ["pi"])).toBe(
        true,
      );
    },
  );

  it.each<{
    condition: string;
    user: string;
    project: string;
    argv: string[];
    expected: boolean | "header";
  }>([
    {
      condition: "the user selects header-only startup",
      user: '{"quietStartup":"header"}',
      project: "{}",
      argv: ["pi"],
      expected: "header",
    },
    {
      condition: "the trusted project selects header-only startup",
      user: '{"quietStartup":true}',
      project: '{"quietStartup":"header"}',
      argv: ["pi"],
      expected: "header",
    },
    {
      condition: "the trusted project disables header-only startup",
      user: '{"quietStartup":"header"}',
      project: '{"quietStartup":false}',
      argv: ["pi"],
      expected: false,
    },
    {
      condition: "verbose startup overrides header-only startup",
      user: '{"quietStartup":"header"}',
      project: "{}",
      argv: ["pi", "--verbose"],
      expected: false,
    },
  ])(
    "should honor the effective quiet mode when $condition",
    ({ user, project, argv, expected }) => {
      mockSettings({
        [join(AGENT_DIR, "settings.json")]: user,
        [join(PROJECT_DIR, ".pi", "settings.json")]: project,
      });
      expect(effectiveQuietStartup(PROJECT_DIR, AGENT_DIR, true, argv)).toBe(
        expected,
      );
    },
  );

  it("should avoid reading project metadata when the project is untrusted", () => {
    mockSettings({
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
  it("should omit disabled native candidates while preserving enabled resource identity", async () => {
    const enabled = {
      path: "/unit/agent/extensions/kept.ts",
      enabled: true,
      metadata: USER_METADATA,
    };
    mockInventory([
      enabled,
      {
        path: "/unit/agent/extensions/disabled.ts",
        enabled: false,
        metadata: USER_METADATA,
      },
    ]);

    expect(
      await collectWelcomeExtensions({
        cwd: PROJECT_DIR,
        agentDir: AGENT_DIR,
        projectTrusted: false,
      }),
    ).toEqual([{ name: "kept", scope: "user", path: enabled.path }]);
  });

  it("should sort project entries before user entries without displaying temporary resources", async () => {
    mockInventory([
      {
        path: "/unit/agent/extensions/a.ts",
        enabled: true,
        metadata: USER_METADATA,
      },
      {
        path: "/unit/project/.pi/extensions/z.ts",
        enabled: true,
        metadata: { ...USER_METADATA, scope: "project" },
      },
      {
        path: "/unit/temporary/hidden.ts",
        enabled: true,
        metadata: { ...USER_METADATA, scope: "temporary" },
      },
    ]);
    const rows = await collectWelcomeExtensions({
      cwd: PROJECT_DIR,
      agentDir: AGENT_DIR,
      projectTrusted: true,
    });
    expect(rows.map(({ name, scope }) => ({ name, scope }))).toEqual([
      { name: "z", scope: "project" },
      { name: "a", scope: "user" },
    ]);
  });

  it.each([
    ["git:github:team/tool@main", "git:team/tool:feature"],
    ["git:gitlab:team/tool.git", "git:team/tool:feature"],
    ["git:bitbucket:team/tool", "git:team/tool:feature"],
    ["git:git@example.org:team/tool.git@main", "git:team/tool:feature"],
    ["git:https://example.org/team/tool.git@main", "git:team/tool:feature"],
    ["git:example.org/team/tool", "git:team/tool:feature"],
    ["git:localhost/team/tool", "git:team/tool:feature"],
    ["git:team/tool", "git:tool:feature"],
    ["https://example.org/team/tool", "feature"],
  ])(
    "should compact the package label when the native source is %s",
    async (source, name) => {
      const baseDir = "/unit/cache/package";
      const path = join(baseDir, "extensions/feature.ts");
      mockInventory([
        {
          path,
          enabled: true,
          metadata: {
            source,
            scope: "user",
            origin: "package",
            baseDir,
          },
        },
      ]);
      expect(
        await collectWelcomeExtensions({
          cwd: PROJECT_DIR,
          agentDir: AGENT_DIR,
          projectTrusted: false,
        }),
      ).toEqual([{ name, scope: "user", path, packageSource: source }]);
    },
  );

  it.each([
    ["extensions/index.ts", "npm:tools"],
    ["extensions/nested/index.ts", "npm:tools:nested"],
    ["custom/main.ts", "npm:tools:custom/main"],
  ])(
    "should preserve the package-relative display name when the entry is %s",
    async (entry, name) => {
      const baseDir = "/unit/cache/tools";
      const path = join(baseDir, entry);
      mockInventory([
        {
          path,
          enabled: true,
          metadata: {
            source: "npm:tools",
            scope: "user",
            origin: "package",
            baseDir,
          },
        },
      ]);
      expect(
        await collectWelcomeExtensions({
          cwd: PROJECT_DIR,
          agentDir: AGENT_DIR,
          projectTrusted: false,
        }),
      ).toEqual([{ name, scope: "user", path, packageSource: "npm:tools" }]);
    },
  );

  it("should disambiguate equal local basenames within a scope", async () => {
    mockInventory([
      {
        path: "/unit/agent/first/same.ts",
        enabled: true,
        metadata: USER_METADATA,
      },
      {
        path: "/unit/agent/second/same.ts",
        enabled: true,
        metadata: USER_METADATA,
      },
      {
        path: "/unit/project/.pi/same.ts",
        enabled: true,
        metadata: { ...USER_METADATA, scope: "project" },
      },
    ]);
    const rows = await collectWelcomeExtensions({
      cwd: PROJECT_DIR,
      agentDir: AGENT_DIR,
      projectTrusted: true,
    });
    expect(rows.map((row) => row.name)).toEqual([
      "same",
      "first/same",
      "second/same",
    ]);
  });

  it("should retain the welcome package identity when its entrypoint is undiscovered", async () => {
    mockInventory([]);
    const welcomePath = "/standalone/omp-welcome/src/index.ts";
    expect(
      await collectWelcomeExtensions({
        cwd: PROJECT_DIR,
        agentDir: AGENT_DIR,
        projectTrusted: false,
        welcomePath,
      }),
    ).toEqual([{ name: "omp-welcome", scope: "user", path: welcomePath }]);
  });

  it.each([true, false])(
    "should avoid adding a duplicate welcome entry when a canonical candidate is enabled=%s",
    async (enabled) => {
      const path = "/unit/agent/extensions/welcome/index.ts";
      const welcomePath = "/standalone/omp-welcome/src/index.ts";
      mockInventory([{ path, enabled, metadata: USER_METADATA }]);
      spyOn(fs.realpathSync, "native").mockReturnValue(welcomePath);
      expect(
        await collectWelcomeExtensions({
          cwd: PROJECT_DIR,
          agentDir: AGENT_DIR,
          projectTrusted: false,
          welcomePath,
        }),
      ).toEqual(enabled ? [{ name: "welcome", scope: "user", path }] : []);
    },
  );

  it("should propagate native resolution errors instead of displaying an empty inventory", async () => {
    const error = new Error("resolution failed");
    mockInventory([]).mockRejectedValue(error);
    await expect(
      collectWelcomeExtensions({
        cwd: PROJECT_DIR,
        agentDir: AGENT_DIR,
        projectTrusted: false,
      }),
    ).rejects.toBe(error);
  });
});

describe("welcomeSessions", () => {
  it("should use explicit names, then sanitized prompts, then OMP untitled labels and ages", () => {
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

  it.each([
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
