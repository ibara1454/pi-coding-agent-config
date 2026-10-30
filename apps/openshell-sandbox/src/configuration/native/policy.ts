import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import type { SandboxPolicy } from "@nvidia/openshell-sdk/raw";
import {
  invalid,
  object,
  SandboxConfigurationError,
} from "../validation/index.ts";
import { binary, endpoint } from "./network.ts";
import {
  boolean,
  dictionary,
  fields,
  integer,
  list,
  mapEntries,
  optional,
  parseNativeYaml,
  string,
  uint32,
} from "./schema.ts";

const MAX_JSON_DEPTH = 64;
const MIN_MIDDLEWARE_ORDER = -2_147_483_648n;
const MAX_MIDDLEWARE_ORDER = 2_147_483_647n;

/** Preserve middleware-owned JSON configuration, rejecting values protobuf Struct cannot represent exactly.
 * @throws A field-only configuration error for unsupported map keys or unrepresentable values.
 * @example jsonValue({limit:3n}, "config") maps an exact safe JSON integer.
 */
function jsonValue(value: unknown, field: string, depth = 0): JsonValue {
  if (depth > MAX_JSON_DEPTH) {
    invalid(`${field} (nesting)`);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      invalid(field);
    }
    return number;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      invalid(field);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonValue(item, field, depth + 1));
  }
  return Object.fromEntries(
    mapEntries(value, field).map(([key, item]) => [
      key,
      jsonValue(item, field, depth + 1),
    ]),
  );
}

/** Decode reusable middleware bindings, preserving endpoint scope and failure behavior.
 * @example middleware({middleware:"example",endpoints:{include:["example.com"]}}, "middleware") retains its selector.
 */
function middleware(value: unknown, field: string): JsonObject {
  const result = fields(
    value,
    field,
    {
      name: ["name", string],
      middleware: ["middleware", string],
      order: ["order", integer(MIN_MIDDLEWARE_ORDER, MAX_MIDDLEWARE_ORDER)],
      config: ["config", (input, path) => jsonValue(object(input, path), path)],
      ["on_error"]: ["onError", string],
      endpoints: [
        "endpoints",
        optional((input, path) =>
          fields(input, path, {
            include: ["include", list(string)],
            exclude: ["exclude", list(string)],
          }),
        ),
      ],
    },
    ["middleware"],
  );
  return { config: {}, ...result };
}

/** Map the pinned canonical policy schema; absent sections stay absent and empty lists stay empty.
 * @example policy({version:1n}, "policy") does not invent filesystem or network grants.
 */
function policy(value: unknown, field: string): JsonObject {
  const result = fields(
    value,
    field,
    {
      version: ["version", uint32],
      ["filesystem_policy"]: [
        "filesystem",
        optional((input, path) =>
          fields(input, path, {
            ["include_workdir"]: ["includeWorkdir", boolean],
            ["read_only"]: ["readOnly", list(string)],
            ["read_write"]: ["readWrite", list(string)],
          }),
        ),
      ],
      landlock: [
        "landlock",
        optional((input, path) =>
          fields(input, path, { compatibility: ["compatibility", string] }),
        ),
      ],
      process: [
        "process",
        optional((input, path) =>
          fields(input, path, {
            ["run_as_user"]: ["runAsUser", string],
            ["run_as_group"]: ["runAsGroup", string],
          }),
        ),
      ],
      ["network_policies"]: [
        "networkPolicies",
        dictionary((input, path) =>
          fields(input, path, {
            name: ["name", string],
            endpoints: ["endpoints", list(endpoint(false))],
            binaries: ["binaries", list(binary(false))],
          }),
        ),
      ],
      ["network_middlewares"]: ["networkMiddlewares", dictionary(middleware)],
    },
    ["version"],
  );
  for (const map of [result["networkPolicies"], result["networkMiddlewares"]]) {
    if (map && typeof map === "object" && !Array.isArray(map)) {
      for (const [name, entry] of Object.entries(map)) {
        const rule = object(entry, field);
        if (!rule["name"]) {
          rule["name"] = name;
        }
      }
    }
  }
  return result;
}

/** Convert a captured native v0.0.116 policy to a complete SDK message without retaining YAML.
 * Runtime SDK imports occur only on invocation, after fail-closed route registration and mode validation.
 * @throws Safe source-path diagnostics for unknown, malformed, or unrepresentable native fields.
 * @example decodeNativePolicy("version: 1", "/policy.yaml") grants no implicit project access.
 */
export async function decodeNativePolicy(
  source: string,
  sourcePath: string,
): Promise<SandboxPolicy> {
  let detail = "";
  try {
    const converted = policy(parseNativeYaml(source, sourcePath), "policy");
    // Defer SDK loading until the fail-closed model route is installed.
    const [{ fromJson }, { SandboxPolicySchema }] = await Promise.all([
      import("@bufbuild/protobuf"),
      import("@nvidia/openshell-sdk/raw"),
    ]);
    return fromJson(SandboxPolicySchema, converted);
  } catch (error) {
    if (error instanceof SandboxConfigurationError) {
      detail = ` (${error.safeMessage})`;
    }
  }
  throw new SandboxConfigurationError(
    `Invalid OpenShell native policy: ${sourcePath}${detail}`,
  );
}
