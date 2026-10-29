import { describe, expect, test as it } from "bun:test";
import type { SandboxEnvironment } from "../configuration/index.ts";
import type { ManagedGateway } from "../gateway/index.ts";
import type { SandboxGeneration } from "./generation/index.ts";
import { publishRuntimeObservation, runtimeStatus } from "./status.ts";
import { runtimeFixture } from "./test/runtime.helper.ts";
import type { RuntimeObserver, RuntimeState } from "./types.ts";

const OVERSIZE_STATUS_TEXT = 600;
const MAX_STATUS_TEXT_LENGTH = 512;
const gatewayFixture = runtimeFixture();
const handle: ManagedGateway = {
  client: gatewayFixture.sdk.client,
  endpoint: "unix:///gateway\u001b",
  instanceId: gatewayFixture.effects.host.instanceId,
  networkId: "net",
  tlsDirectory: "/tls\nsecret",
  labels: {},
  signal: new AbortController().signal,
  close: () => Promise.resolve(),
};
const generation: SandboxGeneration = {
  sandboxName: "sandbox-1",
  signal: new AbortController().signal,
  readiness: new Promise<never>(() => undefined),
  invalidate: () => Promise.resolve({ kind: "confirmed" }),
};

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("runtimeStatus", () => {
  it("should show bounded SDK recovery identity after an unknown create outcome", () => {
    const fixture = runtimeFixture();
    const status = runtimeStatus({
      environment: {
        ...fixture.environment,
        policy: {
          ...fixture.environment.policy,
          sourcePath: `/policy\u001b${"x".repeat(OVERSIZE_STATUS_TEXT)}`,
        },
      },
      state: { phase: "preparing", preparationStep: "sandbox", generation },
      prepared: {
        handle,
        providerNames: {},
        providerResources: [],
      },
      gatewayCoordinates: undefined,
      creationOutcome: "unknown",
      requiredPaths: ["/project\r/work"],
      image: "sha256:known",
      diagnostics: { lastFailure: undefined },
    });
    expect(status).toMatchObject({
      phase: "preparing",
      recovery: {
        sandboxName: "sandbox-1",
        createOutcome: "unknown",
        gatewayEndpoint: "unix:///gateway",
        tlsDirectory: "/tlssecret",
        networkId: "net",
      },
      requiredNativeReadWritePaths: ["/project\r/work"],
      image: "sha256:known",
    });
    expect(status.policyPath.length).toBe(MAX_STATUS_TEXT_LENGTH);
    expect(JSON.stringify(status)).not.toContain("\u001b");
  });
  it("should omit recovery and image before a create is sent", () => {
    const fixture = runtimeFixture();
    const { image: _image, ...environment }: SandboxEnvironment =
      fixture.environment;
    const idle = runtimeStatus({
      environment,
      state: { phase: "idle" },
      prepared: undefined,
      gatewayCoordinates: undefined,
      creationOutcome: undefined,
      requiredPaths: [],
      image: undefined,
      diagnostics: { lastFailure: undefined },
    });
    expect(idle.recovery).toBeUndefined();
    expect(idle.image).toBeUndefined();
    const preparing: RuntimeState = {
      phase: "preparing",
      preparationStep: "gateway",
      generation,
    };
    expect(
      runtimeStatus({
        environment,
        state: preparing,
        prepared: undefined,
        gatewayCoordinates: undefined,
        creationOutcome: undefined,
        requiredPaths: [],
        image: undefined,
        diagnostics: { lastFailure: undefined },
      }).recovery,
    ).toBeUndefined();
  });
  it("should retain gateway coordinates when a new generation has not begun creation", () => {
    const status = runtimeStatus({
      environment: gatewayFixture.environment,
      state: { phase: "preparing", preparationStep: "starting", generation },
      prepared: { handle, providerNames: {}, providerResources: [] },
      gatewayCoordinates: undefined,
      creationOutcome: undefined,
      requiredPaths: [],
      image: undefined,
      diagnostics: { lastFailure: undefined },
    });
    expect(status.recovery).toEqual({
      sandboxName: generation.sandboxName,
      gatewayEndpoint: "unix:///gateway",
      tlsDirectory: "/tlssecret",
      networkId: "net",
    });
  });
  it("should show bounded gateway coordinates before sandbox creation and omit them after cleanup", () => {
    const fixture = runtimeFixture();
    const input = {
      environment: fixture.environment,
      prepared: undefined,
      gatewayCoordinates: {
        gatewayEndpoint: "https://localhost:43123\u001b",
        tlsDirectory: `/tls\n/${"x".repeat(OVERSIZE_STATUS_TEXT)}`,
        networkId: "network\r",
      },
      creationOutcome: undefined,
      requiredPaths: [],
      image: undefined,
      diagnostics: { lastFailure: undefined },
    };
    const status = runtimeStatus({
      ...input,
      state: {
        phase: "preparing",
        preparationStep: "providers",
        generation,
      },
    });
    expect(status.recovery).toEqual({
      sandboxName: generation.sandboxName,
      gatewayEndpoint: "https://localhost:43123",
      tlsDirectory: `/tls/${"x".repeat(OVERSIZE_STATUS_TEXT)}`.slice(
        0,
        MAX_STATUS_TEXT_LENGTH,
      ),
      networkId: "network",
    });
    expect(status.recovery).not.toHaveProperty("createOutcome");
    expect(Object.isFrozen(status.recovery)).toBe(true);
    expect(
      runtimeStatus({ ...input, state: { phase: "idle" } }).recovery,
    ).toBeUndefined();
  });
  it("should preserve exact native grant paths when long, control, and Unicode text requires lossless projection", () => {
    const fixture = runtimeFixture();
    const paths = [
      `/project/${"x".repeat(OVERSIZE_STATUS_TEXT)}`,
      '/project/\u001b[31m\r\n\u202e日本語/"quoted"\\leaf',
    ];
    const expected = [...paths];
    const status = runtimeStatus({
      environment: fixture.environment,
      state: { phase: "idle" },
      prepared: undefined,
      gatewayCoordinates: undefined,
      creationOutcome: undefined,
      requiredPaths: paths,
      image: undefined,
      diagnostics: { lastFailure: undefined },
    });
    expect(status.requiredNativeReadWritePaths).toEqual(expected);
    expect(Object.isFrozen(status.requiredNativeReadWritePaths)).toBe(true);
    expect(Object.isFrozen(paths)).toBe(false);
    paths[0] = "/changed";
    expect(status.requiredNativeReadWritePaths).toEqual(expected);
  });

  it("should omit unknown recovery coordinates and create outcomes when only the TLS directory is known", () => {
    const fixture = runtimeFixture();
    const status = runtimeStatus({
      environment: fixture.environment,
      state: { phase: "preparing", preparationStep: "gateway", generation },
      prepared: undefined,
      gatewayCoordinates: { tlsDirectory: "/state/\u001b\n/tls" },
      creationOutcome: undefined,
      requiredPaths: [],
      image: undefined,
      diagnostics: { lastFailure: undefined },
    });
    expect(status.recovery).toEqual({
      sandboxName: generation.sandboxName,
      tlsDirectory: "/state//tls",
    });
    expect(status.recovery).not.toHaveProperty("networkId");
    expect(status.recovery).not.toHaveProperty("gatewayEndpoint");
    expect(status.recovery).not.toHaveProperty("createOutcome");
  });
});

describe("publishRuntimeObservation", () => {
  it("should isolate observer exceptions and ignore publication after detachment", () => {
    const called: string[] = [];
    const observer: RuntimeObserver = {
      failure: () => {
        called.push("failure");
        throw new Error("observer failed");
      },
      progress: () => {
        called.push("progress");
      },
    };
    const failure = {
      code: "cleanup" as const,
      operation: "cleanup",
      safeMessage: "Cleanup failed",
    };
    expect(() =>
      publishRuntimeObservation(observer, "failure", failure),
    ).not.toThrow();
    publishRuntimeObservation(observer, "progress", {} as never);
    publishRuntimeObservation(undefined, "failure", failure);
    expect(called).toEqual(["failure", "progress"]);
  });
});
