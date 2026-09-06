import { basename, dirname, relative } from "node:path";
import { minimatch } from "minimatch";
import { toPosixPath } from "./package-resource-paths.ts";

function normalizedExactPattern(pattern: string): string {
  const withoutDot =
    pattern.startsWith("./") || pattern.startsWith(".\\")
      ? pattern.slice(2)
      : pattern;
  return toPosixPath(withoutDot);
}

function matchesExactPattern(
  filePath: string,
  pattern: string,
  baseDir: string,
): boolean {
  const normalized = normalizedExactPattern(pattern);
  const relativePath = toPosixPath(relative(baseDir, filePath));
  const absolutePath = toPosixPath(filePath);
  if (normalized === relativePath || normalized === absolutePath) {
    return true;
  }

  if (basename(filePath) !== "SKILL.md") {
    return false;
  }

  const parent = dirname(filePath);
  return (
    normalized === toPosixPath(relative(baseDir, parent)) ||
    normalized === toPosixPath(parent)
  );
}

function matchesPattern(
  filePath: string,
  pattern: string,
  baseDir: string,
): boolean {
  const normalized = toPosixPath(pattern);
  const relativePath = toPosixPath(relative(baseDir, filePath));
  const name = basename(filePath);
  const absolutePath = toPosixPath(filePath);
  if (
    minimatch(relativePath, normalized) ||
    minimatch(name, normalized) ||
    minimatch(absolutePath, normalized)
  ) {
    return true;
  }

  if (name !== "SKILL.md") {
    return false;
  }

  const parent = dirname(filePath);
  return (
    minimatch(toPosixPath(relative(baseDir, parent)), normalized) ||
    minimatch(basename(parent), normalized) ||
    minimatch(toPosixPath(parent), normalized)
  );
}

function matchesAnyPattern(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
): boolean {
  return patterns.some((pattern) => matchesPattern(filePath, pattern, baseDir));
}

function matchesAnyExactPattern(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
): boolean {
  return patterns.some((pattern) =>
    matchesExactPattern(filePath, pattern, baseDir),
  );
}

export function applyPatterns(
  allPaths: readonly string[],
  patterns: readonly string[],
  baseDir: string,
): ReadonlySet<string> {
  const includes: string[] = [];
  const excludes: string[] = [];
  const forceIncludes: string[] = [];
  const forceExcludes: string[] = [];

  for (const pattern of patterns) {
    if (pattern.startsWith("+")) {
      forceIncludes.push(pattern.slice(1));
    } else if (pattern.startsWith("-")) {
      forceExcludes.push(pattern.slice(1));
    } else if (pattern.startsWith("!")) {
      excludes.push(pattern.slice(1));
    } else {
      includes.push(pattern);
    }
  }

  const enabled = new Set(
    includes.length === 0
      ? allPaths
      : allPaths.filter((path) => matchesAnyPattern(path, includes, baseDir)),
  );

  for (const path of allPaths) {
    if (enabled.has(path) && matchesAnyPattern(path, excludes, baseDir)) {
      enabled.delete(path);
    }
  }
  for (const path of allPaths) {
    if (matchesAnyExactPattern(path, forceIncludes, baseDir)) {
      enabled.add(path);
    }
  }
  for (const path of allPaths) {
    if (matchesAnyExactPattern(path, forceExcludes, baseDir)) {
      enabled.delete(path);
    }
  }

  return enabled;
}

export type FilterEvaluationMode =
  | "normal"
  | "overrides"
  | "top-level"
  | "autoload-disabled";

export interface FilterExplanation {
  readonly enabled: boolean;
  readonly reason: string;
}

function lastMatchingPattern(
  patterns: readonly string[],
  matches: (pattern: string) => boolean,
): string | undefined {
  for (let index = patterns.length - 1; index >= 0; index -= 1) {
    const pattern = patterns[index];
    if (pattern !== undefined && matches(pattern)) {
      return pattern;
    }
  }
  return undefined;
}

export function explainFilterState(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
  mode: FilterEvaluationMode,
): FilterExplanation {
  if (mode === "autoload-disabled") {
    const match = lastMatchingPattern(patterns, (pattern) => {
      const prefix = pattern[0];
      const target =
        prefix === "+" || prefix === "-" || prefix === "!"
          ? pattern.slice(1)
          : pattern;
      return prefix === "+" || prefix === "-"
        ? matchesExactPattern(filePath, target, baseDir)
        : matchesPattern(filePath, target, baseDir);
    });
    if (match === undefined) {
      return {
        enabled: false,
        reason: "Disabled: autoload is false and no filter matches",
      };
    }
    const enabled = !match.startsWith("-") && !match.startsWith("!");
    return {
      enabled,
      reason: `${enabled ? "Enabled" : "Disabled"} by last matching autoload:false filter \`${match}\``,
    };
  }

  const applicable =
    mode === "overrides"
      ? patterns.filter(
          (pattern) =>
            pattern.startsWith("!") ||
            pattern.startsWith("+") ||
            pattern.startsWith("-"),
        )
      : mode === "top-level"
        ? patterns.filter(
            (pattern) =>
              pattern.startsWith("!") ||
              pattern.startsWith("+") ||
              pattern.startsWith("-") ||
              pattern.includes("*") ||
              pattern.includes("?"),
          )
        : patterns;
  const forceExclude = lastMatchingPattern(
    applicable,
    (pattern) =>
      pattern.startsWith("-") &&
      matchesExactPattern(filePath, pattern.slice(1), baseDir),
  );
  if (forceExclude !== undefined) {
    return {
      enabled: false,
      reason: `Disabled by exact force-exclude \`${forceExclude}\``,
    };
  }
  const forceInclude = lastMatchingPattern(
    applicable,
    (pattern) =>
      pattern.startsWith("+") &&
      matchesExactPattern(filePath, pattern.slice(1), baseDir),
  );
  if (forceInclude !== undefined) {
    return {
      enabled: true,
      reason: `Enabled by exact force-include \`${forceInclude}\``,
    };
  }
  const exclude = lastMatchingPattern(
    applicable,
    (pattern) =>
      pattern.startsWith("!") &&
      matchesPattern(filePath, pattern.slice(1), baseDir),
  );
  if (exclude !== undefined) {
    return {
      enabled: false,
      reason: `Disabled by exclusion \`${exclude}\``,
    };
  }
  const includes = applicable.filter(
    (pattern) =>
      !pattern.startsWith("!") &&
      !pattern.startsWith("+") &&
      !pattern.startsWith("-"),
  );
  if (includes.length === 0) {
    return {
      enabled: true,
      reason: "Enabled by default: no include filter is configured",
    };
  }
  const include = lastMatchingPattern(includes, (pattern) =>
    matchesPattern(filePath, pattern, baseDir),
  );
  return include === undefined
    ? {
        enabled: false,
        reason: "Disabled: no include filter matches",
      }
    : {
        enabled: true,
        reason: `Enabled by include filter \`${include}\``,
      };
}

function isEnabledByOverrides(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
): boolean {
  const overrides = patterns.filter(
    (pattern) =>
      pattern.startsWith("!") ||
      pattern.startsWith("+") ||
      pattern.startsWith("-"),
  );
  return applyPatterns([filePath], overrides, baseDir).has(filePath);
}

export function isEnabledByAutoloadDisabledPatterns(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
): boolean {
  let enabled = false;
  for (const pattern of patterns) {
    const prefix = pattern[0];
    const target =
      prefix === "+" || prefix === "-" || prefix === "!"
        ? pattern.slice(1)
        : pattern;
    const exact = prefix === "+" || prefix === "-";
    const matches = exact
      ? matchesExactPattern(filePath, target, baseDir)
      : matchesPattern(filePath, target, baseDir);
    if (matches) {
      enabled = prefix !== "-" && prefix !== "!";
    }
  }
  return enabled;
}

export function matchesAutoloadDisabledPattern(
  filePath: string,
  patterns: readonly string[],
  baseDir: string,
): boolean {
  return patterns.some((pattern) => {
    const prefix = pattern[0];
    const target =
      prefix === "+" || prefix === "-" || prefix === "!"
        ? pattern.slice(1)
        : pattern;
    return prefix === "+" || prefix === "-"
      ? matchesExactPattern(filePath, target, baseDir)
      : matchesPattern(filePath, target, baseDir);
  });
}

export interface PatternMutation {
  readonly baseDir: string;
  readonly desired: boolean;
  readonly filePath: string;
  readonly filterPath: string;
  readonly patterns: readonly string[];
}

export function mutateExactPattern(input: PatternMutation): string[] {
  const withoutExactToggle = input.patterns.filter((pattern) => {
    if (!pattern.startsWith("+") && !pattern.startsWith("-")) {
      return true;
    }
    return !matchesExactPattern(
      input.filePath,
      pattern.slice(1),
      input.baseDir,
    );
  });
  const enabledWithoutToggle = isEnabledByOverrides(
    input.filePath,
    withoutExactToggle,
    input.baseDir,
  );
  if (enabledWithoutToggle === input.desired) {
    return withoutExactToggle;
  }
  return [
    ...withoutExactToggle,
    `${input.desired ? "+" : "-"}${input.filterPath}`,
  ];
}

export interface PackagePatternMutation {
  readonly allPaths: readonly string[];
  readonly autoloadDisabled: boolean;
  readonly baseDir: string;
  readonly desired: boolean;
  readonly filePath: string;
  readonly filterPath: string;
  readonly hadField: boolean;
  readonly patterns: readonly string[];
}

export interface PackagePatternMutationResult {
  readonly keepField: boolean;
  readonly patterns: readonly string[];
}

export function mutatePackagePatterns(
  input: PackagePatternMutation,
): PackagePatternMutationResult {
  let removedPlainExact = false;
  let removedSignedExact = false;
  const remaining = input.patterns.filter((pattern) => {
    const prefix = pattern[0];
    if (prefix === "+" || prefix === "-") {
      const matches = matchesExactPattern(
        input.filePath,
        pattern.slice(1),
        input.baseDir,
      );
      removedSignedExact ||= matches;
      return !matches;
    }
    if (
      !input.desired &&
      prefix !== "!" &&
      matchesExactPattern(input.filePath, pattern, input.baseDir)
    ) {
      removedPlainExact = true;
      return false;
    }
    return true;
  });

  let keepField = input.hadField;
  if (
    input.hadField &&
    input.patterns.length > 0 &&
    remaining.length === 0 &&
    removedSignedExact &&
    !removedPlainExact
  ) {
    keepField = false;
  }
  if (removedPlainExact) {
    keepField = true;
  }

  const enabled = input.autoloadDisabled
    ? isEnabledByAutoloadDisabledPatterns(
        input.filePath,
        remaining,
        input.baseDir,
      )
    : keepField
      ? remaining.length > 0 &&
        applyPatterns(input.allPaths, remaining, input.baseDir).has(
          input.filePath,
        )
      : true;
  if (enabled === input.desired) {
    return { keepField, patterns: remaining };
  }

  if (!input.desired) {
    return {
      keepField: true,
      patterns: [...remaining, `-${input.filterPath}`],
    };
  }
  if (input.autoloadDisabled) {
    return {
      keepField: true,
      patterns: [...remaining, `+${input.filterPath}`],
    };
  }

  const withPlainInclude = [...remaining, input.filterPath];
  if (
    applyPatterns(input.allPaths, withPlainInclude, input.baseDir).has(
      input.filePath,
    )
  ) {
    return { keepField: true, patterns: withPlainInclude };
  }
  return {
    keepField: true,
    patterns: [...remaining, `+${input.filterPath}`],
  };
}
