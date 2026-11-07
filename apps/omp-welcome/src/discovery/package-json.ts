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
 * Deep-merges caller-provided defaults with validated metadata without changing either input.
 * Declared resource arrays replace defaults, including explicit empty declarations.
 * Filesystem discovery and source-mode policy remain the caller's responsibility.
 * @param packageJson Validated metadata, which may omit pi entirely.
 * @param defaultPackageJson Configuration built from conventional resource discovery.
 * @returns Independent metadata with required extensions and preserved sibling declarations.
 * @example mergeWithDefaultPackageJson({}, { pi: { extensions: ["extensions/tool.ts"] } }) // { pi: { extensions: ["extensions/tool.ts"] } }
 */
export function mergeWithDefaultPackageJson(
  packageJson: PackageJson,
  defaultPackageJson: ResolvedPackageJson,
): ResolvedPackageJson {
  return deepmerge<ResolvedPackageJson, PackageJson>(
    defaultPackageJson,
    packageJson,
    PACKAGE_JSON_MERGE_OPTIONS,
  );
}
