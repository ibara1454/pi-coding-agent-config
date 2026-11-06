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

/** Resolved extension declarations and their convention-discovery policy. */
export interface ResolvedPackageJson {
  pi: PiPackageResources & { extensions: string[] };
  /** Whether to discover extensions/ instead of using the resolved declaration. */
  useConvention: boolean;
}

export type PackageCollectionMode = "package" | "default" | "filter";

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
 * Resolves welcome-inventory defaults without changing the supplied record.
 * Only extensions is defaulted because packageFiles inventories extensions only;
 * skills, prompts, and themes remain declaration markers. This is not Pi's complete
 * default schema: Pi applies the manifest-vs-convention rule uniformly to all resources.
 * @see https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/package-manager.ts#L2382-L2410
 * @param packageJson Validated metadata, which may omit pi entirely.
 * @param mode Package source's existing discovery policy.
 * @returns Required pi.extensions and an explicit convention policy, preserving absent-vs-empty semantics.
 * @example mergeWithDefaultPackageJson({}, "package") // { pi: { extensions: [] }, useConvention: true }
 */
export function mergeWithDefaultPackageJson(
  packageJson: PackageJson,
  mode: PackageCollectionMode,
): ResolvedPackageJson {
  const declarations = packageJson.pi;
  const extensions = declarations?.extensions;
  const pi = { ...declarations, extensions: extensions ?? [] };
  if (mode === "filter") {
    return { pi, useConvention: pi.extensions.length === 0 };
  }
  if (extensions !== undefined) {
    return { pi, useConvention: false };
  }
  const hasResourceManifest =
    mode === "package" &&
    declarations !== undefined &&
    PACKAGE_RESOURCE_FIELDS.some((field) => declarations[field] !== undefined);
  return { pi, useConvention: !hasResourceManifest };
}
