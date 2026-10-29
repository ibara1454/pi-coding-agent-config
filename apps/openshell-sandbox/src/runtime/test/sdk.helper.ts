import {
  type ExecStreamEvent,
  type OpenShellClient,
  type SandboxClient,
  SdkError,
} from "@nvidia/openshell-sdk";
import type { RuntimeNativeState } from "./process.helper.ts";

const MODEL_COMMAND_ARGUMENT_COUNT = 3;

export interface RuntimeSdkControl {
  client: OpenShellClient;
  createCount: number;
  deleteCount: number;
  stopCount: number;
  commands: string[];
  beforeCreate: () => Promise<void>;
  beforeReady: () => Promise<void>;
  beforeDelete: () => Promise<void>;
  execute: (signal: AbortSignal) => AsyncIterable<ExecStreamEvent>;
}

/** Replaces only native RPC and exec responses while real runtime ownership executes.
 * @param native - External SDK resource facts shared with the host fixture.
 * @returns Controllable native operations and their observed call counts.
 * @example beforeCreate can lose the transport response while the native sandbox remains present.
 */
export function runtimeTestSdk(native: RuntimeNativeState): RuntimeSdkControl {
  const control: RuntimeSdkControl = {
    client: {} as OpenShellClient,
    createCount: 0,
    deleteCount: 0,
    stopCount: 0,
    commands: [],
    beforeCreate: async () => undefined,
    beforeReady: async () => undefined,
    beforeDelete: async () => undefined,
    async *execute() {
      await Promise.resolve();
      yield { stream: "stdout", data: Buffer.from("output") };
      yield { type: "exit", exitCode: 7 };
    },
  };
  control.client = {
    raw: rawResponses(control, native),
    sandbox: sandboxResponses(control, native),
  } as OpenShellClient;
  return control;
}

/** Models typed control-plane acknowledgments with independently controllable settlement.
 * @param control - SDK call counts and pending native gates for this fixture.
 * @param native - Current native presence and identity used in responses.
 * @returns A test-owned raw client with streamed workload responses.
 * @example deleting a sandbox updates native presence before waitDeleted checks it.
 */
function rawResponses(
  control: RuntimeSdkControl,
  native: RuntimeNativeState,
): OpenShellClient["raw"] {
  return Object.assign({} as OpenShellClient["raw"], {
    ...providerResponses(),
    health: async () => ({ status: 1, version: "0.0.116" }),
    updateConfig: async () => ({}),
    getGatewayConfig: async () => ({
      settings: {
        ["providers_v2_enabled"]: {
          value: { case: "boolValue", value: false },
        },
        ["agent_policy_proposals_enabled"]: {
          value: { case: "boolValue", value: false },
        },
        ["proposal_approval_mode"]: {
          value: { case: "stringValue", value: "manual" },
        },
      },
    }),
    importProviderProfiles: async (request: {
      profiles: { profile: { id: string } }[];
    }) => ({
      imported: true,
      profiles: request.profiles.map(({ profile }) => ({ id: profile.id })),
    }),
    getProviderProfile: async (request: { id: string }) => ({
      profile: { id: request.id, providerType: "test", credentialKeys: [] },
    }),
    createSandbox: async (request: {
      name: string;
      labels: Record<string, string>;
    }) => {
      control.createCount += 1;
      native.sandboxName = request.name;
      native.sandboxId = `sandbox-${control.createCount}`;
      native.sandboxPresent = true;
      native.phase = "ready";
      await control.beforeCreate();
      return {
        sandbox: {
          metadata: {
            name: request.name,
            id: native.sandboxId,
            labels: request.labels,
          },
        },
      };
    },
    stopSandbox: () => {
      control.stopCount += 1;
      native.phase = "stopped";
      return Promise.resolve({});
    },
    deleteSandbox: async () => {
      control.deleteCount += 1;
      await control.beforeDelete();
      native.sandboxPresent = false;
      return { deleted: true };
    },
    execSandbox: (
      request: { sandboxId: string; command: string[] },
      options: { signal: AbortSignal },
    ) => executionResponses(control, request, options),
  });
}

/** Streams controlled model workload bytes without decoding them or executing guest setup.
 * @param control - Fixture handler for workload events and recorded commands.
 * @param request - The SDK model Bash command and immutable sandbox target.
 * @param options - Caller-owned cancellation signal forwarded to workload events.
 * @returns Raw SDK payloads in their original event order.
 * @throws Rejects non-model execution and propagates errors from the supplied workload handler.
 * @example executionResponses(control, { sandboxId: "owned", command: ["/bin/bash", "-c", "true"] }, { signal });
 */
async function* executionResponses(
  control: RuntimeSdkControl,
  request: { sandboxId: string; command: string[] },
  options: { signal: AbortSignal },
) {
  await Promise.resolve();
  if (
    request.command[0] !== "/bin/bash" ||
    request.command[1] !== "-c" ||
    request.command.length !== MODEL_COMMAND_ARGUMENT_COUNT
  ) {
    throw new Error("Only model Bash execution is supported.");
  }
  control.commands.push(request.command[2] ?? "");
  for await (const event of control.execute(options.signal)) {
    yield "type" in event
      ? { payload: { case: "exit", value: { exitCode: event.exitCode } } }
      : { payload: { case: event.stream, value: { data: event.data } } };
  }
}

/** Owns in-memory native provider IDs independently of SDK sandbox responses.
 * @returns Create, lookup, and delete RPC fakes that retain provider identity until deletion.
 * @throws Lookup rejects with not_found when no provider of that name exists.
 * @example createProvider followed by getProvider returns the same native ID.
 */
function providerResponses() {
  const providers = new Map<string, { id: string; type: string }>();
  return {
    createProvider: (request: {
      provider: { metadata: { name: string }; type: string };
    }) => {
      const { name } = request.provider.metadata;
      const id = `provider-${providers.size + 1}`;
      providers.set(name, { id, type: request.provider.type });
      return Promise.resolve({
        provider: {
          metadata: { name, id, workspace: "default" },
          type: request.provider.type,
        },
      });
    },
    getProvider: (request: { name: string }) => {
      const provider = providers.get(request.name);
      if (!provider) {
        return Promise.reject(new SdkError("not_found", "Provider missing"));
      }
      return Promise.resolve({
        provider: {
          metadata: {
            name: request.name,
            id: provider.id,
            workspace: "default",
          },
          type: provider.type,
        },
      });
    },
    deleteProvider: (request: { name: string }) => {
      providers.delete(request.name);
      return Promise.resolve({});
    },
  };
}

/** Models SDK readiness independently of raw workload execution responses.
 * @example waitReady can settle after a caller's preparation timeout.
 */
function sandboxResponses(
  control: RuntimeSdkControl,
  native: RuntimeNativeState,
): SandboxClient {
  return Object.assign({} as SandboxClient, {
    get: () => {
      if (!native.sandboxPresent) {
        return Promise.reject(new SdkError("not_found", "Sandbox missing"));
      }
      return Promise.resolve({
        id: native.sandboxId,
        name: native.sandboxName,
        labels: native.labels,
        phase: native.phase ?? "ready",
      });
    },
    waitReady: async () => {
      await control.beforeReady();
      return {
        id: native.sandboxId,
        name: native.sandboxName,
        labels: native.labels,
        phase: "ready",
      };
    },
    waitDeleted: () =>
      native.sandboxPresent
        ? Promise.reject(new Error("Sandbox deletion was not confirmed."))
        : Promise.resolve(),
  });
}
