import { create } from "@bufbuild/protobuf";
import {
  ImportProviderProfilesResponseSchema,
  type ProviderProfile,
  type ProviderProfileResponse,
  ProviderProfileResponseSchema,
  ProviderProfileSchema,
  type ProviderResponse,
  ProviderResponseSchema,
  SandboxPolicySchema,
} from "@nvidia/openshell-sdk/raw";
import type {
  ProviderConfiguration,
  SandboxEnvironment,
} from "../../configuration/index.ts";
import type { ManagedGateway } from "../../gateway/index.ts";
import type { OwnedResource } from "../../host/index.ts";

/** Select a second declared provider for collision and concurrent-creation cases. */
export const OTHER_PROVIDER: ProviderConfiguration = {
  name: "other",
  profile: "other",
  credentialMode: "explicit",
  credentialsFromEnv: { ["OTHER"]: "OTHER_SOURCE" },
};

/** Creates selected declarations without introducing a settings or credential mock.
 * @example The registry profile maps TOKEN to only EXPLICIT_TOKEN.
 */
export function environment(): SandboxEnvironment {
  return {
    projectRoot: "/project",
    policy: {
      sourcePath: "/policy.yaml",
      sdkPolicy: create(SandboxPolicySchema, { version: 1 }),
    },
    providers: [
      {
        name: "registry",
        profile: "registry",
        credentialMode: "explicit",
        credentialsFromEnv: { ["TOKEN"]: "EXPLICIT_TOKEN" },
      },
    ],
    profiles: [
      { sourcePath: "/profiles/registry.yaml", sdkProfiles: [profile()] },
    ],
  };
}

/** Supplies native profile data; credential declaration validation remains production behavior.
 * @example profile("second", "SECOND_TOKEN") declares only SECOND_TOKEN for second.
 */
export function profile(id = "registry", key = "TOKEN"): ProviderProfile {
  return create(ProviderProfileSchema, {
    id,
    credentials: [{ name: "token", envVars: [key], required: true }],
    endpoints: [
      {
        host: "npm.example",
        port: 443,
        path: "/**",
        protocol: "rest",
      },
    ],
  });
}

interface GatewayOptions {
  imported?: boolean;
  selected?: ProviderProfile;
  failCreate?: (name: string) => boolean;
  lookup?: (id: string) => Promise<ProviderProfileResponse>;
  query?: (name: string) => Promise<ProviderResponse>;
}

/** Returns the same acknowledged native identity for create and query fixtures.
 * @returns A response with the requested name and a stable native ID.
 * @example providerResponse("po-a", "registry").provider?.metadata?.id === "native-po-a".
 */
function providerResponse(name: string, type: string): ProviderResponse {
  return create(ProviderResponseSchema, {
    provider: {
      metadata: { name, id: `native-${name}`, workspace: "default" },
      type,
    },
  });
}

/** Replaces native RPC effects and retains every captured provider for test-owned cleanup.
 * @example imported=false prevents both creation and credential access.
 */
export function gateway(options: GatewayOptions = {}) {
  const calls: string[] = [];
  const created = new Map<string, string>();
  const owned: OwnedResource[] = [];
  // biome-ignore lint/plugin/biome-rules/use-undefined: Object.create requires null for a prototype-free native gateway fixture.
  const handle: ManagedGateway = Object.assign(Object.create(null), {
    instanceId: "00000000-0000-4000-8000-000000000001",
    signal: new AbortController().signal,
    client: {
      raw: {
        importProviderProfiles: () => {
          calls.push("import");
          return Promise.resolve(
            create(ImportProviderProfilesResponseSchema, {
              imported: options.imported ?? true,
              profiles: [profile()],
            }),
          );
        },
        getProviderProfile: (request: { id: string }) =>
          options.lookup?.(request.id) ??
          Promise.resolve(
            create(ProviderProfileResponseSchema, {
              profile: options.selected ?? profile(),
            }),
          ),
        createProvider: (request: {
          provider: { metadata: { name: string }; type: string };
        }) => {
          calls.push("create");
          const { name } = request.provider.metadata;
          if (options.failCreate?.(name)) {
            return Promise.reject(new Error("RAW-SECRET-IN-NATIVE-ERROR"));
          }
          created.set(name, request.provider.type);
          return Promise.resolve(providerResponse(name, request.provider.type));
        },
        getProvider: (request: { name: string }) => {
          calls.push("get");
          return (
            options.query?.(request.name) ??
            Promise.resolve(
              providerResponse(
                request.name,
                created.get(request.name) ?? "registry",
              ),
            )
          );
        },
        deleteProvider: () => {
          calls.push("delete");
          return Promise.resolve({});
        },
      },
    },
  });
  return {
    handle,
    calls,
    owned,
    capture: (resource: OwnedResource) => {
      owned.push(resource);
    },
  };
}
