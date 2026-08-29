import { describe, expect, test } from "bun:test";
import {
  applySettingsMutations,
  captureOwner,
  currentOwner,
} from "./settings.ts";
import type {
  PackageToggleTarget,
  SettingsMutation,
  TopLevelToggleTarget,
} from "./types.ts";

const extensionPath = "/repo/.pi/extensions/alpha.ts";

function topTarget(): TopLevelToggleTarget {
  return {
    id: "top",
    type: "top-level",
    scope: "project",
    kind: "extension",
    field: "extensions",
    canonicalPath: extensionPath,
    resolvedPath: extensionPath,
    filterPath: "extensions/alpha.ts",
    allPaths: [extensionPath],
    baseDir: "/repo/.pi",
    occurrencePaths: [extensionPath],
  };
}

function packageTarget(occurrence = 0): PackageToggleTarget {
  return {
    id: `package-${occurrence}`,
    type: "package",
    scope: "global",
    kind: "extension",
    field: "extensions",
    canonicalPath: "/agent/pkg/extensions/alpha.ts",
    resolvedPath: "/agent/pkg/extensions/alpha.ts",
    filterPath: "extensions/alpha.ts",
    allPaths: [
      "/agent/pkg/extensions/alpha.ts",
      "/agent/pkg/extensions/beta.ts",
    ],
    packageRoot: "/agent/pkg",
    canonicalPackageRoot: "/agent/pkg",
    packageSourcePath: "/agent/pkg",
    package: { source: "npm:kit", occurrence },
    autoloadDelta: false,
    participates: true,
    participatesWhenEnabled: true,
    participatesWhenDisabled: true,
    packageIdentity: "npm:kit",
    hadFilterField: false,
  };
}

function mutation(
  target: TopLevelToggleTarget | PackageToggleTarget,
  enabled: boolean,
): SettingsMutation {
  return { scope: target.scope, target, enabled };
}

describe("top-level settings mutation", () => {
  test("preserves roots and unrelated patterns while adding one exact exclusion", () => {
    const next = applySettingsMutations(
      { extensions: ["./extensions", "!extensions/legacy/**"] },
      [mutation(topTarget(), false)],
    );

    expect(next).toEqual({
      extensions: [
        "./extensions",
        "!extensions/legacy/**",
        "-extensions/alpha.ts",
      ],
    });
  });

  test("restores the declaration state without leaving a redundant force-include", () => {
    const next = applySettingsMutations(
      { extensions: ["./extensions", "-extensions/alpha.ts"] },
      [mutation(topTarget(), true)],
    );

    expect(next).toEqual({ extensions: ["./extensions"] });
  });

  test("preserves a broad exclusion and adds only the required force-include", () => {
    const next = applySettingsMutations(
      { extensions: ["./extensions", "!extensions/**"] },
      [mutation(topTarget(), true)],
    );

    expect(next).toEqual({
      extensions: ["./extensions", "!extensions/**", "+extensions/alpha.ts"],
    });
  });

  test("updates only the Pi-winning path of a collapsed canonical target", () => {
    const target: TopLevelToggleTarget = {
      ...topTarget(),
      resolvedPath: "/repo/.pi/extensions/alpha-link.ts",
      filterPath: "extensions/alpha-link.ts",
      allPaths: [
        "/repo/.pi/extensions/alpha-link.ts",
        "/repo/.pi/extensions/alpha.ts",
      ],
      occurrencePaths: [
        "/repo/.pi/extensions/alpha-link.ts",
        "/repo/.pi/extensions/alpha.ts",
      ],
    };

    const next = applySettingsMutations({ extensions: ["./extensions"] }, [
      mutation(target, false),
    ]);

    expect(next).toEqual({
      extensions: ["./extensions", "-extensions/alpha-link.ts"],
    });
  });
});

describe("package child mutation", () => {
  test("converts a package string to an object when disabling one child", () => {
    const next = applySettingsMutations({ packages: ["npm:kit"] }, [
      mutation(packageTarget(), false),
    ]);

    expect(next).toEqual({
      packages: [{ source: "npm:kit", extensions: ["-extensions/alpha.ts"] }],
    });
  });

  test("compacts an object back to its equivalent source string", () => {
    const next = applySettingsMutations(
      {
        packages: [{ source: "npm:kit", extensions: ["-extensions/alpha.ts"] }],
      },
      [mutation(packageTarget(), true)],
    );

    expect(next).toEqual({ packages: ["npm:kit"] });
  });

  test("keeps explicit load-none semantics when enabling one child", () => {
    const next = applySettingsMutations(
      { packages: [{ source: "npm:kit", extensions: [] }] },
      [mutation(packageTarget(), true)],
    );

    expect(next).toEqual({
      packages: [{ source: "npm:kit", extensions: ["extensions/alpha.ts"] }],
    });
  });

  test("reopens one-child selection without enabling package siblings", () => {
    const enabled = applySettingsMutations(
      { packages: [{ source: "npm:kit", extensions: [] }] },
      [mutation(packageTarget(), true)],
    );
    const reopened = applySettingsMutations(enabled, [
      mutation(packageTarget(), false),
    ]);

    expect(reopened).toEqual({
      packages: [{ source: "npm:kit", extensions: [] }],
    });
  });

  test("reopens two-child selection and removes only the toggled child", () => {
    const betaTarget: PackageToggleTarget = {
      ...packageTarget(),
      id: "package-beta",
      canonicalPath: "/agent/pkg/extensions/beta.ts",
      resolvedPath: "/agent/pkg/extensions/beta.ts",
      filterPath: "extensions/beta.ts",
    };
    const alphaEnabled = applySettingsMutations(
      { packages: [{ source: "npm:kit", extensions: [] }] },
      [mutation(packageTarget(), true)],
    );
    const bothEnabled = applySettingsMutations(alphaEnabled, [
      mutation(betaTarget, true),
    ]);
    const reopened = applySettingsMutations(bothEnabled, [
      mutation(packageTarget(), false),
    ]);

    expect(bothEnabled).toEqual({
      packages: [
        {
          source: "npm:kit",
          extensions: ["extensions/alpha.ts", "extensions/beta.ts"],
        },
      ],
    });
    expect(reopened).toEqual({
      packages: [{ source: "npm:kit", extensions: ["extensions/beta.ts"] }],
    });
  });

  test("preserves autoload false and unrelated fields", () => {
    const next = applySettingsMutations(
      {
        packages: [
          {
            source: "npm:kit",
            autoload: false,
            skills: ["skills/review"],
            themes: ["themes/dark.json"],
          },
        ],
      },
      [mutation(packageTarget(), true)],
    );

    expect(next).toEqual({
      packages: [
        {
          source: "npm:kit",
          autoload: false,
          extensions: ["+extensions/alpha.ts"],
          skills: ["skills/review"],
          themes: ["themes/dark.json"],
        },
      ],
    });
  });

  test("targets the requested duplicate package occurrence only", () => {
    const next = applySettingsMutations(
      { packages: ["npm:kit", "npm:other", "npm:kit"] },
      [mutation(packageTarget(1), false)],
    );

    expect(next).toEqual({
      packages: [
        "npm:kit",
        "npm:other",
        { source: "npm:kit", extensions: ["-extensions/alpha.ts"] },
      ],
    });
  });

  test("rejects malformed touched package filters", () => {
    expect(() =>
      applySettingsMutations(
        { packages: [{ source: "npm:kit", extensions: "bad" }] },
        [mutation(packageTarget(), false)],
      ),
    ).toThrow("extensions must be an array of strings");
  });
});

test("package owner snapshots track all same-source occurrences", () => {
  const target = packageTarget(1);
  const snapshot = captureOwner({ packages: ["npm:kit", "npm:kit"] }, target);
  const current = currentOwner(
    { packages: ["npm:other", "npm:kit", "npm:kit"] },
    snapshot,
  );

  expect(current).toEqual(["npm:kit", "npm:kit"]);
});
