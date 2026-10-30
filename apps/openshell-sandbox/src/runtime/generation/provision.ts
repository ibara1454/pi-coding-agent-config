import type { SandboxPolicy } from "@nvidia/openshell-sdk/raw";
import { freeze } from "../../configuration/index.ts";
import type { ManagedGateway } from "../../gateway/index.ts";
import type { ProjectWorkspace } from "../../workspace/index.ts";
import { RPC_TIMEOUT_MS } from "../work/index.ts";
import type { GenerationInput } from "./types.ts";

/** Sends one typed create request with ownership labels and a separate immutable policy snapshot.
 * Local validation and request assembly remain known-unsent; onCreateAttempt transfers the caller's
 * ownership state to uncertain immediately before the native RPC. Matching acknowledgment returns its ID.
 * @param request Selected inputs and required ownership callback, invoked once only for a native attempt.
 * @returns The immutable sandbox ID from an identity-matching acknowledgment.
 * @throws If local binding validation, native creation, or acknowledgment identity validation fails.
 * @example An unknown "registry" binding rejects without invoking onCreateAttempt or sending an RPC.
 */
export async function createNativeSandbox(
  request: Readonly<{
    input: GenerationInput;
    gateway: ManagedGateway;
    sandboxName: string;
    workspace: ProjectWorkspace;
    image: string;
    providerNames: Readonly<Record<string, string>>;
    signal: AbortSignal;
    onCreateAttempt: () => void;
  }>,
): Promise<string> {
  const {
    input,
    gateway,
    sandboxName,
    workspace,
    image,
    providerNames,
    signal,
    onCreateAttempt,
  } = request;
  const policy = resolveCredentialBindings(
    input.environment.policy.sdkPolicy,
    providerNames,
  );
  const nativeRequest = {
    name: sandboxName,
    workspace: "default",
    labels: { ...gateway.labels },
    spec: {
      policy,
      providers: Object.values(providerNames),
      command: [],
      tty: true,
      template: {
        image,
        labels: { ...gateway.labels },
        driverConfig: {
          docker: {
            mounts: workspace.mounts.map((mount) => ({
              type: mount.type,
              source: mount.source,
              target: mount.target,
              ["read_only"]: mount.readOnly,
            })),
          },
        },
      },
    },
  };
  const options = { signal, timeoutMs: RPC_TIMEOUT_MS };
  onCreateAttempt();
  const response = await gateway.client.raw.createSandbox(
    nativeRequest,
    options,
  );
  const metadata = response.sandbox?.metadata;
  if (
    !metadata?.id ||
    metadata.name !== sandboxName ||
    Object.entries(gateway.labels).some(
      ([key, value]) => metadata.labels[key] !== value,
    )
  ) {
    throw new Error(
      "Sandbox create acknowledgment does not match its preassigned identity.",
    );
  }
  return metadata.id;
}

/** Copies the selected grants and resolves only explicit credential-binding identities.
 * @param selected Source policy; neither it nor its descendants are mutated.
 * @param providerNames Configured provider names mapped to attached native identities.
 * @returns A deeply frozen create-policy snapshot with unchanged grants.
 * @throws If any explicit binding names an unconfigured provider.
 * @example A "registry" binding becomes "po-activation-0" when that is its attached name.
 */
function resolveCredentialBindings(
  selected: SandboxPolicy,
  providerNames: Readonly<Record<string, string>>,
): SandboxPolicy {
  const policy = structuredClone(selected);
  for (const rule of Object.values(policy.networkPolicies)) {
    for (const endpoint of rule.endpoints) {
      const binding = endpoint.credentialBinding;
      if (binding) {
        if (!Object.hasOwn(providerNames, binding.provider)) {
          throw new Error(
            "Credential binding references an unconfigured provider.",
          );
        }
        binding.provider = providerNames[binding.provider] as string;
      }
    }
  }
  return freeze(policy);
}

/** Only a real received Connect INVALID_ARGUMENT proves pre-acquisition rejection on the pinned API.
 * SDK/transport errors and local lookalike objects never prove rejection.
 * @example {code:3} is not a ConnectError and remains unknown.
 */
export async function isRejectedCreate(error: unknown): Promise<boolean> {
  // Loaded only during fail-closed runtime preparation, never before the model route is registered.
  const { ConnectError, Code } = await import("@connectrpc/connect");
  return error instanceof ConnectError && error.code === Code.InvalidArgument;
}
