import type { JsonObject } from "@bufbuild/protobuf";
import type { ProviderProfile } from "@nvidia/openshell-sdk/raw";
import {
  invalid,
  object,
  SandboxConfigurationError,
} from "../validation/index.ts";
import { credential } from "./credentials.ts";
import { binary, endpoint } from "./network.ts";
import {
  boolean,
  dictionary,
  enumeration,
  fields,
  list,
  parseNativeYaml,
  string,
  uint64,
} from "./schema.ts";

const CATEGORIES = {
  "": 1,
  other: 1,
  inference: 2,
  agent: 3,
  ["source_control"]: 4,
  messaging: 5,
  data: 6,
  knowledge: 7,
};

/** Map every pinned native profile field; missing category means other, not protobuf unspecified.
 * @example profile({id:"work",display_name:"Work"}, "profile") creates category other without invented credentials.
 */
function profile(value: unknown, field: string): JsonObject {
  const result = fields(
    value,
    field,
    {
      id: ["id", string],
      ["resource_version"]: ["resourceVersion", uint64],
      annotations: ["annotations", dictionary(string)],
      ["display_name"]: ["displayName", string],
      description: ["description", string],
      category: ["category", enumeration(CATEGORIES)],
      credentials: ["credentials", list(credential)],
      endpoints: ["endpoints", list(endpoint(true))],
      binaries: ["binaries", list(binary(true))],
      ["inference_capable"]: ["inferenceCapable", boolean],
      source: ["source", string],
      scope: ["scope", string],
      discovery: [
        "discovery",
        (input, path) =>
          fields(input, path, { credentials: ["credentials", list(string)] }),
      ],
    },
    ["id", "display_name"],
  );
  if (result["discovery"] !== undefined) {
    const discovery = object(result["discovery"], field);
    if (
      !Array.isArray(discovery["credentials"]) ||
      discovery["credentials"].length === 0
    ) {
      // biome-ignore lint/plugin/biome-rules/use-undefined: Protobuf JSON null leaves discovery unset after native empty-reference normalization.
      result["discovery"] = null;
    }
  }
  return { category: 1, ...result };
}

/** Decode native profile documents into SDK messages; metadata never activates credential renewal.
 * Single-profile and exported profile-list forms retain all credential references and exact integer versions.
 * @throws Safe source-only diagnostics for malformed, unknown, or lossy native configuration.
 * @example decodeNativeProfiles("id: work\ndisplay_name: Work", "/profile.yaml") returns one typed profile.
 */
export async function decodeNativeProfiles(
  source: string,
  sourcePath: string,
): Promise<ProviderProfile[]> {
  let detail = "";
  try {
    const parsed = parseNativeYaml(source, sourcePath);
    const converted = (Array.isArray(parsed) ? parsed : [parsed]).map((item) =>
      profile(item, "profile"),
    );
    // Defer SDK loading until the fail-closed model route is installed.
    const [{ fromJson }, { ProviderProfileSchema }] = await Promise.all([
      import("@bufbuild/protobuf"),
      import("@nvidia/openshell-sdk/raw"),
    ]);
    const profiles = converted.map((item) =>
      fromJson(ProviderProfileSchema, item),
    );
    const ids = new Set<string>();
    for (const item of profiles) {
      if (!item.id || ids.has(item.id)) {
        invalid("profile.id");
      }
      ids.add(item.id);
    }
    return profiles;
  } catch (error) {
    if (error instanceof SandboxConfigurationError) {
      detail = ` (${error.safeMessage})`;
    }
  }
  throw new SandboxConfigurationError(
    `Invalid OpenShell native profiles: ${sourcePath}${detail}`,
  );
}
