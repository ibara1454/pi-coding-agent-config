import { describe, expect, test } from "bun:test";
import {
  applyPatterns,
  explainFilterState,
  type FilterEvaluationMode,
  isEnabledByAutoloadDisabledPatterns,
  matchesAutoloadDisabledPattern,
  mutateExactPattern,
  mutatePackagePatterns,
} from "./resource-filters.ts";

const base = "/repo/.pi";
const alpha = "/repo/.pi/extensions/alpha.ts";
const beta = "/repo/.pi/extensions/beta.ts";
const skill = "/repo/.pi/skills/review/SKILL.md";
const allPaths = [alpha, beta, skill];

const DEFAULT_ENABLED = "Enabled by default: no include filter is configured";
const NO_INCLUDE_MATCH = "Disabled: no include filter matches";
const AUTOLOAD_UNMATCHED = "Disabled: autoload is false and no filter matches";

function include(pattern: string): string {
  return `Enabled by include filter \`${pattern}\``;
}

function exclusion(pattern: string): string {
  return `Disabled by exclusion \`${pattern}\``;
}

function forceInclude(pattern: string): string {
  return `Enabled by exact force-include \`${pattern}\``;
}

function forceExclude(pattern: string): string {
  return `Disabled by exact force-exclude \`${pattern}\``;
}

function autoloadFilter(enabled: boolean, pattern: string): string {
  const state = enabled ? "Enabled" : "Disabled";
  return `${state} by last matching autoload:false filter \`${pattern}\``;
}

interface ApplyCase {
  readonly label: string;
  readonly patterns: readonly string[];
  readonly expected: readonly string[];
}

const applyCases: readonly ApplyCase[] = [
  {
    label: "an empty pattern list enables every path",
    patterns: [],
    expected: [alpha, beta, skill],
  },
  {
    label: "a relative include limits the enabled set",
    patterns: ["extensions/**"],
    expected: [alpha, beta],
  },
  {
    label: "a bare file name include matches by base name",
    patterns: ["alpha.ts"],
    expected: [alpha],
  },
  {
    label: "an absolute include matches the absolute path",
    patterns: ["/repo/.pi/extensions/beta.ts"],
    expected: [beta],
  },
  {
    label: "an exclusion removes an already included path",
    patterns: ["extensions/**", "!**/alpha.ts"],
    expected: [beta],
  },
  {
    label: "an exclusion cannot remove a path that was never included",
    patterns: ["extensions/alpha.ts", "!extensions/beta.ts"],
    expected: [alpha],
  },
  {
    label: "a force-include restores a path removed by an exclusion",
    patterns: ["extensions/**", "!**/alpha.ts", "+extensions/alpha.ts"],
    expected: [alpha, beta],
  },
  {
    label: "a force-include adds a path outside the include set",
    patterns: ["extensions/alpha.ts", "+extensions/beta.ts"],
    expected: [alpha, beta],
  },
  {
    label: "a force-exclude wins over an include and a force-include",
    patterns: ["extensions/**", "+extensions/beta.ts", "-extensions/beta.ts"],
    expected: [alpha],
  },
  {
    label: "a dot-prefixed force-exclude is normalized before matching",
    patterns: ["extensions/**", "-./extensions/alpha.ts"],
    expected: [beta],
  },
  {
    label: "a skill include matches through its skill directory",
    patterns: ["skills/review"],
    expected: [skill],
  },
  {
    label: "a skill force-exclude matches through its skill directory",
    patterns: ["skills/**", "-skills/review"],
    expected: [],
  },
];

interface ExplainCase {
  readonly label: string;
  readonly mode: FilterEvaluationMode;
  readonly filePath: string;
  readonly patterns: readonly string[];
  readonly enabled: boolean;
  readonly reason: string;
}

const explainCases: readonly ExplainCase[] = [
  {
    label: "normal mode enables when no include filter is configured",
    mode: "normal",
    filePath: alpha,
    patterns: ["!skills/**"],
    enabled: true,
    reason: DEFAULT_ENABLED,
  },
  {
    label: "normal mode names the include filter that matched",
    mode: "normal",
    filePath: alpha,
    patterns: ["extensions/**"],
    enabled: true,
    reason: include("extensions/**"),
  },
  {
    label: "normal mode reports an include set that matches nothing",
    mode: "normal",
    filePath: skill,
    patterns: ["extensions/**"],
    enabled: false,
    reason: NO_INCLUDE_MATCH,
  },
  {
    label: "normal mode names the exclusion that matched",
    mode: "normal",
    filePath: alpha,
    patterns: ["extensions/**", "!**/alpha.ts"],
    enabled: false,
    reason: exclusion("!**/alpha.ts"),
  },
  {
    label: "normal mode prefers an exact force-include over an exclusion",
    mode: "normal",
    filePath: alpha,
    patterns: ["extensions/**", "!**/alpha.ts", "+extensions/alpha.ts"],
    enabled: true,
    reason: forceInclude("+extensions/alpha.ts"),
  },
  {
    label: "normal mode prefers an exact force-exclude over everything",
    mode: "normal",
    filePath: alpha,
    patterns: ["+extensions/alpha.ts", "-extensions/alpha.ts"],
    enabled: false,
    reason: forceExclude("-extensions/alpha.ts"),
  },
  {
    label: "normal mode resolves a skill through its directory",
    mode: "normal",
    filePath: skill,
    patterns: ["+skills/review"],
    enabled: true,
    reason: forceInclude("+skills/review"),
  },
  {
    label: "normal mode accepts an absolute skill directory",
    mode: "normal",
    filePath: skill,
    patterns: ["+/repo/.pi/skills/review"],
    enabled: true,
    reason: forceInclude("+/repo/.pi/skills/review"),
  },
  {
    label: "top-level mode ignores a plain directory source root",
    mode: "top-level",
    filePath: alpha,
    patterns: ["extensions"],
    enabled: true,
    reason: DEFAULT_ENABLED,
  },
  {
    label: "top-level mode still applies a glob include",
    mode: "top-level",
    filePath: alpha,
    patterns: ["extensions", "extensions/*.ts"],
    enabled: true,
    reason: include("extensions/*.ts"),
  },
  {
    label: "overrides mode ignores plain include filters",
    mode: "overrides",
    filePath: alpha,
    patterns: ["extensions/**"],
    enabled: true,
    reason: DEFAULT_ENABLED,
  },
  {
    label: "overrides mode applies an exclusion to a source root",
    mode: "overrides",
    filePath: alpha,
    patterns: ["extensions", "!extensions/**"],
    enabled: false,
    reason: exclusion("!extensions/**"),
  },
  {
    label: "overrides mode applies a force-include over an exclusion",
    mode: "overrides",
    filePath: alpha,
    patterns: ["extensions", "!extensions/**", "+extensions/alpha.ts"],
    enabled: true,
    reason: forceInclude("+extensions/alpha.ts"),
  },
  {
    label: "autoload-disabled mode disables an unmatched child",
    mode: "autoload-disabled",
    filePath: alpha,
    patterns: ["skills/**"],
    enabled: false,
    reason: AUTOLOAD_UNMATCHED,
  },
  {
    label: "autoload-disabled mode honours the last matching filter",
    mode: "autoload-disabled",
    filePath: alpha,
    patterns: ["extensions/**", "!extensions/alpha.ts"],
    enabled: false,
    reason: autoloadFilter(false, "!extensions/alpha.ts"),
  },
  {
    label: "autoload-disabled mode enables by a trailing force-include",
    mode: "autoload-disabled",
    filePath: alpha,
    patterns: ["!extensions/**", "+extensions/alpha.ts"],
    enabled: true,
    reason: autoloadFilter(true, "+extensions/alpha.ts"),
  },
  {
    label: "autoload-disabled mode ignores a glob force-exclude",
    mode: "autoload-disabled",
    filePath: alpha,
    patterns: ["extensions/**", "-extensions/*.ts"],
    enabled: true,
    reason: autoloadFilter(true, "extensions/**"),
  },
];

interface MatchCase {
  readonly label: string;
  readonly filePath: string;
  readonly patterns: readonly string[];
  readonly expected: boolean;
}

const enabledCases: readonly MatchCase[] = [
  {
    label: "no pattern leaves an autoload:false child disabled",
    filePath: alpha,
    patterns: [],
    expected: false,
  },
  {
    label: "a matching include enables an autoload:false child",
    filePath: alpha,
    patterns: ["extensions/**"],
    expected: true,
  },
  {
    label: "a later exclusion disables a previously included child",
    filePath: alpha,
    patterns: ["extensions/**", "!extensions/alpha.ts"],
    expected: false,
  },
  {
    label: "a later force-include re-enables an excluded child",
    filePath: alpha,
    patterns: ["!extensions/**", "+extensions/alpha.ts"],
    expected: true,
  },
  {
    label: "a later plain include re-enables a force-excluded child",
    filePath: alpha,
    patterns: ["-extensions/alpha.ts", "extensions/**"],
    expected: true,
  },
  {
    label: "a skill directory pattern enables its SKILL.md child",
    filePath: skill,
    patterns: ["skills/review"],
    expected: true,
  },
  {
    label: "a pattern for another kind leaves the child disabled",
    filePath: skill,
    patterns: ["extensions/**"],
    expected: false,
  },
];

const matchCases: readonly MatchCase[] = [
  {
    label: "an empty autoload:false filter list matches nothing",
    filePath: alpha,
    patterns: [],
    expected: false,
  },
  {
    label: "a pattern for another kind reports no match",
    filePath: alpha,
    patterns: ["skills/**"],
    expected: false,
  },
  {
    label: "a plain glob pattern reports a match",
    filePath: alpha,
    patterns: ["extensions/**"],
    expected: true,
  },
  {
    label: "an exclusion pattern is matched by glob semantics",
    filePath: alpha,
    patterns: ["!**/alpha.ts"],
    expected: true,
  },
  {
    label: "a force-exclude pattern is matched exactly",
    filePath: alpha,
    patterns: ["-extensions/alpha.ts"],
    expected: true,
  },
  {
    label: "a force-exclude glob is never matched exactly",
    filePath: alpha,
    patterns: ["-extensions/*.ts"],
    expected: false,
  },
  {
    label: "a force-include matches a skill through its directory",
    filePath: skill,
    patterns: ["+skills/review"],
    expected: true,
  },
];

interface ExactCase {
  readonly label: string;
  readonly desired: boolean;
  readonly filePath: string;
  readonly filterPath: string;
  readonly patterns: readonly string[];
  readonly expected: readonly string[];
}

const exactCases: readonly ExactCase[] = [
  {
    label: "adds an exact exclusion when disabling a default-enabled path",
    desired: false,
    filePath: alpha,
    filterPath: "extensions/alpha.ts",
    patterns: ["extensions"],
    expected: ["extensions", "-extensions/alpha.ts"],
  },
  {
    label: "removes the exact exclusion when the default restores enabled",
    desired: true,
    filePath: alpha,
    filterPath: "extensions/alpha.ts",
    patterns: ["extensions", "-extensions/alpha.ts"],
    expected: ["extensions"],
  },
  {
    label: "adds a force-include while a broad exclusion remains",
    desired: true,
    filePath: alpha,
    filterPath: "extensions/alpha.ts",
    patterns: ["!extensions/**", "-extensions/alpha.ts"],
    expected: ["!extensions/**", "+extensions/alpha.ts"],
  },
  {
    label: "drops the force-include when the broad exclusion suffices",
    desired: false,
    filePath: alpha,
    filterPath: "extensions/alpha.ts",
    patterns: ["!extensions/**", "+extensions/alpha.ts"],
    expected: ["!extensions/**"],
  },
  {
    label: "leaves an empty pattern list untouched when enabling",
    desired: true,
    filePath: alpha,
    filterPath: "extensions/alpha.ts",
    patterns: [],
    expected: [],
  },
  {
    label: "writes one exclusion into an empty pattern list",
    desired: false,
    filePath: alpha,
    filterPath: "extensions/alpha.ts",
    patterns: [],
    expected: ["-extensions/alpha.ts"],
  },
  {
    label: "serializes a skill exclusion through its skill directory",
    desired: false,
    filePath: skill,
    filterPath: "skills/review",
    patterns: ["skills"],
    expected: ["skills", "-skills/review"],
  },
  {
    label: "removes a dot-prefixed exclusion for the same file",
    desired: true,
    filePath: alpha,
    filterPath: "extensions/alpha.ts",
    patterns: ["extensions", "-./extensions/alpha.ts"],
    expected: ["extensions"],
  },
];

interface PackageCase {
  readonly label: string;
  readonly autoloadDisabled: boolean;
  readonly desired: boolean;
  readonly hadField: boolean;
  readonly patterns: readonly string[];
  readonly keepField: boolean;
  readonly expected: readonly string[];
}

const packageCases: readonly PackageCase[] = [
  {
    label: "writes an exclusion when no filter field exists yet",
    autoloadDisabled: false,
    desired: false,
    hadField: false,
    patterns: [],
    keepField: true,
    expected: ["-extensions/alpha.ts"],
  },
  {
    label: "keeps an explicit empty filter after dropping a plain include",
    autoloadDisabled: false,
    desired: false,
    hadField: true,
    patterns: ["extensions/alpha.ts"],
    keepField: true,
    expected: [],
  },
  {
    label: "replaces a stale force-include with an exclusion",
    autoloadDisabled: false,
    desired: false,
    hadField: true,
    patterns: ["+extensions/alpha.ts"],
    keepField: true,
    expected: ["-extensions/alpha.ts"],
  },
  {
    label: "drops the filter field when its last exclusion is removed",
    autoloadDisabled: false,
    desired: true,
    hadField: true,
    patterns: ["-extensions/alpha.ts"],
    keepField: false,
    expected: [],
  },
  {
    label: "leaves a matching include untouched when already enabled",
    autoloadDisabled: false,
    desired: true,
    hadField: true,
    patterns: ["extensions/alpha.ts"],
    keepField: true,
    expected: ["extensions/alpha.ts"],
  },
  {
    label: "appends a plain include when it enables the file on its own",
    autoloadDisabled: false,
    desired: true,
    hadField: true,
    patterns: ["extensions/beta.ts"],
    keepField: true,
    expected: ["extensions/beta.ts", "extensions/alpha.ts"],
  },
  {
    label: "falls back to a force-include under a broad exclusion",
    autoloadDisabled: false,
    desired: true,
    hadField: true,
    patterns: ["!extensions/**"],
    keepField: true,
    expected: ["!extensions/**", "+extensions/alpha.ts"],
  },
  {
    label: "adds a force-include when package autoload is disabled",
    autoloadDisabled: true,
    desired: true,
    hadField: true,
    patterns: [],
    keepField: true,
    expected: ["+extensions/alpha.ts"],
  },
  {
    label: "drops the field when the only autoload force-include goes",
    autoloadDisabled: true,
    desired: false,
    hadField: true,
    patterns: ["+extensions/alpha.ts"],
    keepField: false,
    expected: [],
  },
  {
    label: "keeps an autoload include that already enables the file",
    autoloadDisabled: true,
    desired: true,
    hadField: true,
    patterns: ["extensions/**"],
    keepField: true,
    expected: ["extensions/**"],
  },
];

describe("applyPatterns", () => {
  test.each(applyCases.map((entry) => [entry.label, entry] as const))(
    "should return the expected enabled paths for: %s",
    (_label, scenario) => {
      const enabled = applyPatterns(allPaths, scenario.patterns, base);
      const expected = [...scenario.expected].toSorted();
      expect([...enabled].toSorted()).toEqual(expected);
    },
  );
});

describe("explainFilterState", () => {
  test.each(explainCases.map((entry) => [entry.label, entry] as const))(
    "should return the expected filter explanation for: %s",
    (_label, scenario) => {
      const explanation = explainFilterState(
        scenario.filePath,
        scenario.patterns,
        base,
        scenario.mode,
      );
      expect(explanation).toEqual({
        enabled: scenario.enabled,
        reason: scenario.reason,
      });
    },
  );
});

describe("isEnabledByAutoloadDisabledPatterns", () => {
  test.each(enabledCases.map((entry) => [entry.label, entry] as const))(
    "should return the expected enabled state for: %s",
    (_label, scenario) => {
      const enabled = isEnabledByAutoloadDisabledPatterns(
        scenario.filePath,
        scenario.patterns,
        base,
      );
      expect(enabled).toBe(scenario.expected);
    },
  );
});

describe("matchesAutoloadDisabledPattern", () => {
  test.each(matchCases.map((entry) => [entry.label, entry] as const))(
    "should return the expected match state for: %s",
    (_label, scenario) => {
      const matched = matchesAutoloadDisabledPattern(
        scenario.filePath,
        scenario.patterns,
        base,
      );
      expect(matched).toBe(scenario.expected);
    },
  );
});

describe("mutateExactPattern", () => {
  test.each(exactCases.map((entry) => [entry.label, entry] as const))(
    "should return the expected patterns for: %s",
    (_label, scenario) => {
      const patterns = mutateExactPattern({
        baseDir: base,
        desired: scenario.desired,
        filePath: scenario.filePath,
        filterPath: scenario.filterPath,
        patterns: scenario.patterns,
      });
      expect(patterns).toEqual([...scenario.expected]);
    },
  );
});

describe("mutatePackagePatterns", () => {
  test.each(packageCases.map((entry) => [entry.label, entry] as const))(
    "should return the expected mutation result for: %s",
    (_label, scenario) => {
      const result = mutatePackagePatterns({
        allPaths: [alpha, beta],
        autoloadDisabled: scenario.autoloadDisabled,
        baseDir: base,
        desired: scenario.desired,
        filePath: alpha,
        filterPath: "extensions/alpha.ts",
        hadField: scenario.hadField,
        patterns: scenario.patterns,
      });
      expect(result).toEqual({
        keepField: scenario.keepField,
        patterns: [...scenario.expected],
      });
    },
  );
});
