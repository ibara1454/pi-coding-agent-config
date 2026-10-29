import type { ProjectWorkspace } from "../../../workspace/index.ts";
import { type RuntimeFixture, TEST_NETWORK } from "../../test/index.helper.ts";
import { deadline, SETUP_TIMEOUT_MS } from "../../work/index.ts";
import type { GenerationWork } from "../setup.ts";
import type {
  GenerationInput,
  GenerationResources,
  PreparedGateway,
  ReadySandbox,
  SandboxGeneration,
} from "../types.ts";

export const workspace: ProjectWorkspace = {
  projectRoot: "/project",
  mounts: [
    { type: "bind", source: "/project", target: "/project", readOnly: false },
  ],
  requiredNativeReadWritePaths: ["/project"],
};

/** Supplies an SDK gateway boundary without starting a native gateway.
 * @example gateway(runtimeFixture()).providerResources is empty until providers are created.
 */
export function gateway(fixture: RuntimeFixture): PreparedGateway {
  return {
    handle: {
      client: fixture.sdk.client,
      endpoint: "http://127.0.0.1:43123",
      instanceId: fixture.effects.host.instanceId,
      networkId: TEST_NETWORK,
      tlsDirectory: "/state/test/tls",
      labels: { "openshell.ai/instance-id": fixture.effects.host.instanceId },
      signal: fixture.activation.signal,
      close: async () => undefined,
    },
    providerNames: {},
    providerResources: [],
  };
}

/** Selects a fixture environment and optional preprepared private gateway.
 * @example input(fixture, gateway(fixture)) tests generation reuse.
 */
export function input(
  fixture: RuntimeFixture,
  preparedGateway?: PreparedGateway,
): GenerationInput {
  return {
    environment: fixture.environment,
    preparedGateway,
    signal: fixture.activation.signal,
  };
}

/** Supplies one already-ready SDK sandbox for cleanup and readiness tests.
 * @example generation(fixture).readiness resolves to the fixture workspace.
 */
export function generation(
  fixture: RuntimeFixture,
  prepared = gateway(fixture),
): SandboxGeneration {
  const ready: ReadySandbox = {
    gateway: prepared,
    sandboxId: "sandbox-1",
    workspace,
    environment: {},
  };
  return {
    sandboxName: "test-sandbox",
    signal: fixture.activation.signal,
    readiness: Promise.resolve(ready),
    invalidate: async () => ({ kind: "confirmed" }),
  };
}

/** Supplies generation acquisition operations while preserving the real SDK boundary.
 * @example work(fixture).createSandbox() returns a matching fixture acknowledgment ID.
 */
export function work(
  fixture: RuntimeFixture,
  prepared = gateway(fixture),
): GenerationWork {
  return {
    input: input(fixture, prepared),
    effects: fixture.effects,
    generation: generation(fixture, prepared),
    preparation: deadline(fixture.effects, SETUP_TIMEOUT_MS),
    capture: () => undefined,
    report: () => undefined,
    step: async (operation) => await operation(),
    gitProcess: fixture.effects.gitProcess,
    prepareGateway: async () => prepared,
    createSandbox: async () => "sandbox-1",
  };
}

/** Supplies a resource snapshot with explicit creation provenance.
 * @example resources(gateway(fixture), { createOutcome: "unknown" }) cannot be deleted.
 */
export function resources(
  preparedGateway: PreparedGateway,
  overrides: Partial<GenerationResources> = {},
): GenerationResources {
  return {
    sandboxName: "test-sandbox",
    sandboxId: undefined,
    createOutcome: "rejected",
    preparedGateway,
    ownedResources: [],
    ...overrides,
  };
}
