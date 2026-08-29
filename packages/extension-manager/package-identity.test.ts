import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { packageIdentity } from "./package-identity.ts";
import type { ResourceScope } from "./types.ts";

const cwd = "/repo";
const agentDir = "/agent";

interface IdentityCase {
  readonly label: string;
  readonly source: string;
  readonly scope: ResourceScope;
  readonly expected: string;
}

const identityCases: readonly IdentityCase[] = [
  {
    label: "keeps a bare npm specifier as its package name",
    source: "npm:kit",
    scope: "global",
    expected: "npm:kit",
  },
  {
    label: "strips a version range from an npm specifier",
    source: "npm:kit@^1.0.0",
    scope: "global",
    expected: "npm:kit",
  },
  {
    label: "keeps the scope of a scoped npm specifier",
    source: "npm:@scope/kit",
    scope: "global",
    expected: "npm:@scope/kit",
  },
  {
    label: "strips a version from a scoped npm specifier",
    source: "npm:@scope/kit@1.2.3",
    scope: "project",
    expected: "npm:@scope/kit",
  },
  {
    label: "trims surrounding whitespace from an npm specifier",
    source: "npm: kit@1.2.3 ",
    scope: "global",
    expected: "npm:kit",
  },
  {
    label: "normalizes a git shorthand host path carrying a ref",
    source: "git:github.com/org/repo@main",
    scope: "global",
    expected: "git:github.com/org/repo",
  },
  {
    label: "normalizes an https clone url",
    source: "https://github.com/org/repo.git",
    scope: "project",
    expected: "git:github.com/org/repo",
  },
  {
    label: "normalizes an scp style git remote",
    source: "git:git@github.com:org/repo.git@feature",
    scope: "project",
    expected: "git:github.com/org/repo",
  },
  {
    label: "expands the github provider shorthand",
    source: "git:github:org/repo",
    scope: "global",
    expected: "git:github.com/org/repo",
  },
  {
    label: "expands the gitlab provider shorthand",
    source: "git:gitlab:org/repo",
    scope: "global",
    expected: "git:gitlab.com/org/repo",
  },
  {
    label: "expands the bitbucket provider shorthand",
    source: "git:bitbucket:org/repo",
    scope: "global",
    expected: "git:bitbucket.org/org/repo",
  },
  {
    label: "normalizes an ssh clone url",
    source: "ssh://git@github.com/org/repo.git",
    scope: "global",
    expected: "git:github.com/org/repo",
  },
  {
    label: "lowercases the host and path of a git identity",
    source: "https://GitHub.com/Org/Repo.git",
    scope: "global",
    expected: "git:github.com/org/repo",
  },
  {
    label: "resolves a relative Global package against the agent directory",
    source: "./pkg",
    scope: "global",
    expected: "local:/agent/pkg",
  },
  {
    label: "resolves a relative Project package against the project config",
    source: "./pkg",
    scope: "project",
    expected: "local:/repo/.pi/pkg",
  },
  {
    label: "keeps an absolute local package path",
    source: "/opt/pkg",
    scope: "global",
    expected: "local:/opt/pkg",
  },
  {
    label: "resolves a parent relative Project package path",
    source: "../shared",
    scope: "project",
    expected: "local:/repo/shared",
  },
  {
    label: "expands a home relative local package path",
    source: "~/pkg",
    scope: "global",
    expected: `local:${join(homedir(), "pkg")}`,
  },
  {
    label: "treats a bare host path as a local package",
    source: "github.com/org/repo",
    scope: "global",
    expected: "local:/agent/github.com/org/repo",
  },
  {
    label: "falls back to a local path for a hostless git source",
    source: "git:nohost",
    scope: "global",
    expected: "local:/agent/git:nohost",
  },
];

describe("packageIdentity", () => {
  test.each(identityCases.map((entry) => [entry.label, entry] as const))(
    "should return the expected identity for: %s",
    (_label, scenario) => {
      const identity = packageIdentity(
        scenario.source,
        scenario.scope,
        cwd,
        agentDir,
      );
      expect(identity).toBe(scenario.expected);
    },
  );

  test("should keep a managed package identity stable across scopes", () => {
    const npmGlobal = packageIdentity("npm:kit", "global", cwd, agentDir);
    const npmProject = packageIdentity("npm:kit", "project", cwd, agentDir);
    const gitSource = "https://github.com/org/repo.git";
    const gitProject = packageIdentity(gitSource, "project", cwd, agentDir);
    const gitGlobal = packageIdentity(
      "git:github:org/repo",
      "global",
      cwd,
      "/x",
    );

    expect(npmProject).toBe(npmGlobal);
    expect(gitProject).toBe(gitGlobal);
  });

  test("should scope a local package identity to its settings base directory", () => {
    const globalIdentity = packageIdentity("./pkg", "global", cwd, agentDir);
    const projectIdentity = packageIdentity("./pkg", "project", cwd, agentDir);

    expect(projectIdentity).not.toBe(globalIdentity);
  });
});
