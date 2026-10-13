import { describe, expect, test } from "bun:test";
import {
  applySettingsMutations,
  hasSettingsConflict,
  parseSettingsDocument,
} from "./settings.ts";
import type {
  JsonObject,
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

const emptyDocuments: [string, string | undefined][] = [
  ["missing content", undefined],
  ["an empty string", ""],
  ["whitespace only", "  \n\t "],
];

const nonObjectRoots: [string, string][] = [
  ["an array root", "[]\n"],
  ["a string root", '"nope"'],
  ["a number root", "12"],
  ["a null root", "null"],
];

describe("parseSettingsDocument", () => {
  test.each(emptyDocuments)(
    "should return an empty value when input is %s",
    (_label: string, content: string | undefined) => {
      expect(
        parseSettingsDocument("global", "/agent/settings.json", content),
      ).toEqual({
        path: "/agent/settings.json",
        scope: "global",
        content,
        value: {},
      });
    },
  );

  test.each(nonObjectRoots)(
    "should report an invalid root when input is %s",
    (_label: string, content: string) => {
      expect(
        parseSettingsDocument("project", "/repo/.pi/settings.json", content),
      ).toEqual({
        path: "/repo/.pi/settings.json",
        scope: "project",
        content,
        value: {},
        error: "Settings root must be a JSON object",
      });
    },
  );

  test("should report a parser message when settings are unparsable", () => {
    const parsed = parseSettingsDocument(
      "global",
      "/agent/settings.json",
      "{oops",
    );

    expect(parsed.value).toEqual({});
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error).not.toBe("");
  });

  test("should keep the parsed object beside its original content", () => {
    const content = '{\n  "extensions": ["./extensions"]\n}\n';

    expect(
      parseSettingsDocument("global", "/agent/settings.json", content),
    ).toEqual({
      path: "/agent/settings.json",
      scope: "global",
      content,
      value: { extensions: ["./extensions"] },
    });
  });
});

const topLevelMutations: [string, JsonObject, boolean, JsonObject][] = [
  [
    "adds one exact force-exclude beside unrelated patterns",
    { extensions: ["./extensions", "!extensions/legacy/**"] },
    false,
    {
      extensions: [
        "./extensions",
        "!extensions/legacy/**",
        "-extensions/alpha.ts",
      ],
    },
  ],
  [
    "drops a redundant force-exclude when re-enabling",
    { extensions: ["./extensions", "-extensions/alpha.ts"] },
    true,
    { extensions: ["./extensions"] },
  ],
  [
    "adds only a force-include under a broad exclusion",
    { extensions: ["./extensions", "!extensions/**"] },
    true,
    { extensions: ["./extensions", "!extensions/**", "+extensions/alpha.ts"] },
  ],
  [
    "leaves an already enabled declaration untouched",
    { extensions: ["./extensions"] },
    true,
    { extensions: ["./extensions"] },
  ],
  [
    "leaves an already disabled declaration untouched",
    { extensions: ["./extensions", "-extensions/alpha.ts"] },
    false,
    { extensions: ["./extensions", "-extensions/alpha.ts"] },
  ],
  [
    "creates the field when disabling an undeclared resource",
    {},
    false,
    { extensions: ["-extensions/alpha.ts"] },
  ],
  ["keeps the field absent when enabling an undeclared resource", {}, true, {}],
];

describe("applySettingsMutations", () => {
  test.each(topLevelMutations)(
    "should produce the expected top-level filters for: %s",
    (_label: string, current: JsonObject, enabled: boolean, expected: JsonObject) => {
      expect(
        applySettingsMutations(current, [mutation(topTarget(), enabled)]),
      ).toEqual(expected);
    },
  );

  test("should update only the Pi-winning path when a canonical target is collapsed", () => {
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

  const packageMutations: [string, JsonObject, boolean, JsonObject][] = [
    [
      "converts a package string to an object when disabling one child",
      { packages: ["npm:kit"] },
      false,
      {
        packages: [{ source: "npm:kit", extensions: ["-extensions/alpha.ts"] }],
      },
    ],
    [
      "compacts an object back to its equivalent source string",
      {
        packages: [{ source: "npm:kit", extensions: ["-extensions/alpha.ts"] }],
      },
      true,
      { packages: ["npm:kit"] },
    ],
    [
      "keeps explicit load-none semantics when enabling one child",
      { packages: [{ source: "npm:kit", extensions: [] }] },
      true,
      {
        packages: [{ source: "npm:kit", extensions: ["extensions/alpha.ts"] }],
      },
    ],
    [
      "narrows a one-child selection back to load-none",
      {
        packages: [{ source: "npm:kit", extensions: ["extensions/alpha.ts"] }],
      },
      false,
      { packages: [{ source: "npm:kit", extensions: [] }] },
    ],
    [
      "removes only the toggled child from a two-child selection",
      {
        packages: [
          {
            source: "npm:kit",
            extensions: ["extensions/alpha.ts", "extensions/beta.ts"],
          },
        ],
      },
      false,
      { packages: [{ source: "npm:kit", extensions: ["extensions/beta.ts"] }] },
    ],
    [
      "preserves autoload false and unrelated fields",
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
      true,
      {
        packages: [
          {
            source: "npm:kit",
            autoload: false,
            extensions: ["+extensions/alpha.ts"],
            skills: ["skills/review"],
            themes: ["themes/dark.json"],
          },
        ],
      },
    ],
  ];

  const rejectedPackageMutations: [string, JsonObject, string][] = [
    [
      "a malformed filter list on the touched package",
      { packages: [{ source: "npm:kit", extensions: "bad" }] },
      "extensions must be an array of strings",
    ],
    [
      "a packages field that is not an array",
      { packages: "npm:kit" },
      "packages must be an array",
    ],
    [
      "a package occurrence that is no longer present",
      { packages: ["npm:other"] },
      "Package occurrence disappeared: npm:kit",
    ],
  ];

  test.each(packageMutations)(
    "should produce the expected package filters for: %s",
    (_label: string, current: JsonObject, enabled: boolean, expected: JsonObject) => {
      expect(
        applySettingsMutations(current, [mutation(packageTarget(), enabled)]),
      ).toEqual(expected);
    },
  );

  test("should target only the requested duplicate package occurrence", () => {
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

  test.each(rejectedPackageMutations)(
    "should reject %s",
    (_label: string, current: JsonObject, message: string) => {
      expect(() =>
        applySettingsMutations(current, [mutation(packageTarget(), false)]),
      ).toThrow(message);
    },
  );

  test("should leave caller settings untouched", () => {
    const current: JsonObject = { extensions: ["./extensions"] };

    applySettingsMutations(current, [mutation(topTarget(), false)]);

    expect(current).toEqual({ extensions: ["./extensions"] });
  });

  test("should preserve unrelated package settings when disabling a selected package child", () => {
    expect(
      applySettingsMutations(
        {
          packages: ["npm:kit", { source: "npm:other", skills: [] }],
          theme: "light",
        },
        [mutation(packageTarget(), false)],
      ),
    ).toEqual({
      packages: [
        { source: "npm:kit", extensions: ["-extensions/alpha.ts"] },
        { source: "npm:other", skills: [] },
      ],
      theme: "light",
    });
  });
});

const changedOwners: [
  string,
  JsonObject,
  JsonObject,
  TopLevelToggleTarget | PackageToggleTarget,
][] = [
  [
    "the touched top-level field changes",
    { extensions: ["./extensions"] },
    { extensions: ["changed"] },
    topTarget(),
  ],
  [
    "an absent field becomes an empty list",
    {},
    { extensions: [] },
    topTarget(),
  ],
  ["an empty field is removed", { extensions: [] }, {}, topTarget()],
  [
    "a filter field appears on the touched package",
    { packages: ["npm:kit"] },
    { packages: [{ source: "npm:kit", extensions: [] }] },
    packageTarget(),
  ],
  [
    "an identical same-source occurrence is inserted first",
    { packages: ["npm:kit"] },
    { packages: ["npm:kit", "npm:kit"] },
    packageTarget(),
  ],
  [
    "the touched package is removed",
    { packages: ["npm:kit"] },
    { packages: ["npm:other"] },
    packageTarget(),
  ],
  [
    "another occurrence of the touched package source changes",
    { packages: ["npm:kit", "npm:kit"] },
    { packages: [{ source: "npm:kit", skills: [] }, "npm:kit"] },
    packageTarget(1),
  ],
  [
    "a missing package source appears",
    { packages: ["npm:other"] },
    { packages: ["npm:other", "npm:kit"] },
    packageTarget(),
  ],
];

const unchangedOwners: [
  string,
  JsonObject,
  JsonObject,
  TopLevelToggleTarget | PackageToggleTarget,
][] = [
  [
    "only an unrelated top-level setting changes",
    { extensions: ["./extensions"], theme: "dark" },
    { extensions: ["./extensions"], theme: "light" },
    topTarget(),
  ],
  [
    "only an unrelated package occurrence changes",
    { packages: ["npm:kit", "npm:other"] },
    { packages: ["npm:kit", { source: "npm:other", skills: [] }] },
    packageTarget(),
  ],
  [
    "another package source is inserted before the touched occurrences",
    { packages: ["npm:kit", "npm:kit"] },
    { packages: ["npm:other", "npm:kit", "npm:kit"] },
    packageTarget(1),
  ],
  ["the selected field remains absent", {}, {}, topTarget()],
  [
    "the selected package source remains absent",
    {},
    { packages: ["npm:other"] },
    packageTarget(),
  ],
];

describe("hasSettingsConflict", () => {
  test.each(changedOwners)(
    "should report a conflict when %s",
    (_label, snapshot, current, target) => {
      expect(
        hasSettingsConflict(snapshot, current, [mutation(target, false)]),
      ).toBe(true);
    },
  );

  test.each(unchangedOwners)(
    "should report no conflict when %s",
    (_label, snapshot, current, target) => {
      expect(
        hasSettingsConflict(snapshot, current, [mutation(target, false)]),
      ).toBe(false);
    },
  );

  test("should ignore all settings changes when no mutations select owners", () => {
    expect(
      hasSettingsConflict(
        { extensions: ["before"], packages: ["npm:kit"] },
        { extensions: ["after"], packages: [] },
        [],
      ),
    ).toBe(false);
  });

  test("should leave caller inputs untouched when multiple mutations share unchanged owners", () => {
    const snapshot: JsonObject = {
      extensions: ["./extensions"],
      packages: [{ source: "npm:kit", extensions: ["./extensions"] }],
    };
    const current = structuredClone(snapshot);
    const mutations = [
      mutation(topTarget(), false),
      mutation(topTarget(), true),
      mutation(packageTarget(), false),
      mutation(packageTarget(), true),
    ];
    const before = structuredClone({ snapshot, current, mutations });

    expect(hasSettingsConflict(snapshot, current, mutations)).toBe(false);
    expect({ snapshot, current, mutations }).toEqual(before);
  });

  test("should report a conflict when one of several selected owners changes", () => {
    expect(
      hasSettingsConflict(
        { extensions: ["./extensions"], packages: ["npm:kit"] },
        { extensions: ["./extensions"], packages: [] },
        [
          mutation(topTarget(), false),
          mutation(topTarget(), true),
          mutation(packageTarget(), false),
        ],
      ),
    ).toBe(true);
  });
});
