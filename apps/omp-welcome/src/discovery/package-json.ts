import { readFileSync } from "node:fs";
import Ajv from "ajv";
import deepmerge from "deepmerge";

const PACKAGE_RESOURCE_FIELDS = [
  "extensions",
  "skills",
  "prompts",
  "themes",
] as const;

interface PiPackageResources {
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

/** Validated package metadata; a missing pi object remains absent. */
export interface PackageJson {
  pi?: PiPackageResources;
}

/** Package metadata after applying the extension inventory's defaults. */
export interface ResolvedPackageJson {
  pi: PiPackageResources & { extensions: string[] };
}

const DEFAULT_PACKAGE_JSON: ResolvedPackageJson = {
  pi: { extensions: ["extensions/"] },
};

const PACKAGE_JSON_MERGE_OPTIONS: deepmerge.Options = {
  /**
   * Replaces defaults, including explicit empty declarations, without sharing arrays.
   * @param _defaultPaths Resource paths being overridden.
   * @param configuredPaths Resource paths declared by the package.
   * @returns An independent copy of the declared paths.
   * @example PACKAGE_JSON_MERGE_OPTIONS.arrayMerge?.(["default.ts"], []) // []
   */
  arrayMerge(_defaultPaths: string[], configuredPaths: string[]) {
    return configuredPaths.slice();
  },
};

const ajv = new Ajv();
const validatePackageRecord = ajv.compile<{
  pi?: Record<string, unknown>;
}>({
  type: "object",
  properties: { pi: { type: "object" } },
});
const validateResourcePaths = ajv.compile<string[]>({
  type: "array",
  items: { type: "string" },
});

/**
 * Reads the Pi resource fields used by package discovery without importing code.
 * Missing/non-object pi and unreadable/malformed JSON yield {}.
 * Resource fields are validated independently, preserving valid siblings.
 * @param filePath Package metadata file to read.
 * @returns Validated string-array declarations; missing fields stay absent.
 * @example For {"name":"tool"}, returns {}; for {"pi":{"skills":[]}}, returns { pi: { skills: [] } }.
 */
export function readPackageJson(filePath: string): PackageJson {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
  if (!validatePackageRecord(packageJson) || packageJson.pi === undefined) {
    return {};
  }
  const pi: PiPackageResources = {};
  for (const field of PACKAGE_RESOURCE_FIELDS) {
    const entries = packageJson.pi[field];
    if (validateResourcePaths(entries)) {
      pi[field] = entries;
    }
  }
  return { pi };
}

/**
 * Reports whether validated metadata explicitly declares a Pi resource field.
 * Empty arrays are declarations; missing fields do not count.
 * @param packageJson Validated package metadata before defaults are applied.
 * @param resource Resource key in the package's pi object.
 * @returns Whether the resource field is present, including an empty array.
 * @example hasPackageResourceDeclaration({ pi: { extensions: [] } }, "extensions") // true
 */
export function hasPackageResourceDeclaration(
  packageJson: PackageJson,
  resource: keyof PiPackageResources,
): boolean {
  return packageJson.pi?.[resource] !== undefined;
}

/**
 * Deep-merges conventional directory defaults with validated metadata without changing the input.
 * Only extensions is defaulted because this inventory loads extensions; the other
 * resource fields remain declaration markers for Pi's manifest-selection policy.
 * Declared arrays replace defaults, including explicit empty declarations.
 * Filesystem discovery and source-mode policy remain the caller's responsibility.
 * @see https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/package-manager.ts#L2382-L2410
 * @param packageJson Validated metadata, which may omit pi entirely.
 * @returns Independent configuration with required extension entries and preserved sibling declarations.
 * @example mergeWithDefaultPackageJson({}) // { pi: { extensions: ["extensions/"] } }
 */
export function mergeWithDefaultPackageJson(
  packageJson: PackageJson,
): ResolvedPackageJson {
  return deepmerge<ResolvedPackageJson, PackageJson>(
    DEFAULT_PACKAGE_JSON,
    packageJson,
    PACKAGE_JSON_MERGE_OPTIONS,
  );
}
