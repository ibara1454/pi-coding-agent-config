import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { ProviderProfileResponseSchema } from "@nvidia/openshell-sdk/raw";
import type { SandboxEnvironment } from "../../configuration/index.ts";
import type { SafeFailure } from "../../diagnostics/index.ts";
import type { GatewayHostContext } from "../../gateway/index.ts";
import { environment } from "../../providers/test/index.helper.ts";
import { createSandboxRuntime } from "../runtime.ts";
import type {
  RuntimeEffects,
  RuntimeObserver,
  SanitizedRuntimeStatus,
} from "../types.ts";
import type { RuntimeTestFilesystem } from "./filesystem.helper.ts";
import { runtimeTestFilesystem } from "./filesystem.helper.ts";
import type { RuntimeNativeState } from "./process.helper.ts";
import { runtimeTestProcesses } from "./process.helper.ts";
import type { RuntimeSdkControl } from "./sdk.helper.ts";
import { runtimeTestSdk } from "./sdk.helper.ts";

const TEST_GATEWAY_PORT = 43_123;

export type RuntimeFixture = Readonly<{
  environment: SandboxEnvironment;
  effects: RuntimeEffects;
  observer: RuntimeObserver;
  filesystem: RuntimeTestFilesystem;
  native: RuntimeNativeState;
  sdk: RuntimeSdkControl;
  failures: SafeFailure[];
  statuses: SanitizedRuntimeStatus[];
  activation: AbortController;
}>;

/** Replaces external filesystem/process/RPC/clock effects while exercising real runtime ownership.
 * @returns An isolated sandbox fixture with controllable SDK settlement.
 * @example fixture.sdk.beforeCreate = () => deferred.promise holds the raw create boundary.
 */
export function runtimeFixture(): RuntimeFixture {
  const native: RuntimeNativeState = {
    labels: {},
    sandboxId: undefined,
    sandboxName: undefined,
    sandboxPresent: false,
    networkPresent: false,
    namespace: "",
    calls: [],
    launches: 0,
  };
  const filesystem = runtimeTestFilesystem();
  const sdk = runtimeTestSdk(native);
  const activation = new AbortController();
  const host = testHost(native, filesystem, sdk);
  const failures: SafeFailure[] = [];
  const statuses: SanitizedRuntimeStatus[] = [];
  const observer: RuntimeObserver = {
    failure: (failure) => {
      failures.push(failure);
    },
    progress: (status) => {
      statuses.push(status);
    },
  };
  return {
    environment: testEnvironment(),
    effects: testEffects(host, activation),
    observer,
    filesystem,
    native,
    sdk,
    failures,
    statuses,
    activation,
  };
}

/** Configures acknowledged provider RPCs and fake credentials for runtime ownership tests.
 * @returns An isolated runtime fixture selecting the registry provider and its native profile.
 * @throws If the selected test profile is missing.
 * @example providerRuntimeFixture().effects.credentialSource("EXPLICIT_TOKEN") returns a fake secret.
 */
export function providerRuntimeFixture(): RuntimeFixture {
  const selected = environment();
  const profile = selected.profiles[0]?.sdkProfiles[0];
  if (!profile) {
    throw new Error("Missing selected test profile.");
  }
  const fixture = runtimeFixture();
  fixture.sdk.client.raw.getProviderProfile = async () =>
    create(ProviderProfileResponseSchema, { profile });
  return {
    ...fixture,
    environment: selected,
    effects: {
      ...fixture.effects,
      credentialSource: () => "private-provider-secret",
    },
  };
}

/** Supplies an isolated private-gateway host from test-owned effects.
 * @example testHost(native, filesystem, sdk) has a local Docker socket.
 */
function testHost(
  native: RuntimeNativeState,
  filesystem: RuntimeTestFilesystem,
  sdk: RuntimeSdkControl,
): GatewayHostContext {
  return {
    instanceId: "abcdefghijklmnop",
    platform: "linux",
    architecture: "x64",
    uid: 1000,
    dockerEndpoint: "unix:///run/docker.sock",
    dockerExecutable: "/usr/bin/docker",
    gatewayExecutable: "/usr/bin/openshell-gateway",
    paths: {
      home: "/home/person",
      sshDirectory: "/home/person/.ssh",
      dockerSocket: "/run/docker.sock",
      stateRoot: "/state",
    },
    environment: { ["PATH"]: "/usr/local/bin:/usr/bin:/bin" },
    filesystem: filesystem.filesystem,
    processEffects: runtimeTestProcesses(native),
    gatewayEffects: {
      connect: () => Promise.resolve(sdk.client),
      reservePort: () => Promise.resolve(TEST_GATEWAY_PORT),
    },
  };
}

/** Composes real generation capabilities from fake host effects without replacing runtime policy.
 * @example testEffects(host, activation) gives preparation the same abort signal as execution.
 */
function testEffects(
  host: GatewayHostContext,
  activation: AbortController,
): RuntimeEffects {
  return {
    host,
    activationSignal: activation.signal,
    filesystem: host.filesystem,
    gitProcess: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    credentialSource: () => undefined,
    randomBytes,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };
}

/** Provides immutable settings inputs without replacing parsing or native policy.
 * @example testEnvironment().projectRoot is mapped into the SDK sandbox mount.
 */
function testEnvironment(): SandboxEnvironment {
  return {
    projectRoot: "/project",
    profiles: [],
    providers: [],
    image: "selected:tag",
    policy: {
      sourcePath: "/policy.yaml",
      sdkPolicy: {
        $typeName: "openshell.sandbox.v1.SandboxPolicy",
        version: 1,
        networkPolicies: {},
        networkMiddlewares: {},
      },
    },
  };
}

/** Counts actual gateway termination signals without changing production lifetime ownership.
 * @example a pending raw stream keeps the gateway alive before any signal is sent.
 */
function observedEffects(effects: RuntimeEffects) {
  const counts = { gatewaySignals: 0 };
  const { signal: signalProcess } = effects.host.processEffects;
  return {
    counts,
    effects: {
      ...effects,
      host: {
        ...effects.host,
        processEffects: {
          ...effects.host.processEffects,
          signal: (...args: Parameters<typeof signalProcess>) => {
            counts.gatewaySignals += 1;
            signalProcess(...args);
          },
        },
      },
    },
  };
}

/** Holds an SDK stream until an external gate settles, then observes raw completion.
 * @returns A runtime whose gateway remains owned until release is resolved.
 * @example caller.abort() cancels the public request while release.resolve() settles native work.
 */
export async function heldExecutionFixture() {
  const fixture = runtimeFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const rawSettled = Promise.withResolvers<void>();
  const observed = observedEffects(fixture.effects);
  fixture.sdk.execute = async function* () {
    entered.resolve();
    try {
      await release.promise;
      yield { type: "exit", exitCode: 0 };
    } finally {
      rawSettled.resolve();
    }
  };
  const runtime = await createSandboxRuntime(
    fixture.environment,
    observed.effects,
    fixture.observer,
  );
  return {
    runtime,
    native: fixture.native,
    counts: observed.counts,
    entered,
    release,
    rawSettled,
  };
}
