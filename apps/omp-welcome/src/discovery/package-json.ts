import { readFileSync } from "node:fs";
import Ajv from "ajv";

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
 * Merges validated metadata with extension-inventory defaults without changing the input.
 * Only extensions is defaulted because packageFiles inventories extensions only;
 * skills, prompts, and themes remain declaration markers. This is not Pi's complete
 * default schema: Pi applies the manifest-vs-convention rule uniformly to all resources.
 * @see https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/package-manager.ts#L2382-L2410
 * @param packageJson Validated metadata, which may omit pi entirely.
 * @returns A new pi object with required extensions and otherwise unchanged declarations.
 * @example mergeWithDefaultPackageJson({}) // { pi: { extensions: [] } }
 */
export function mergeWithDefaultPackageJson(
  packageJson: PackageJson,
): ResolvedPackageJson {
  return {
    pi: {
      ...packageJson.pi,
      extensions: packageJson.pi?.extensions ?? [],
    },
  };
}
