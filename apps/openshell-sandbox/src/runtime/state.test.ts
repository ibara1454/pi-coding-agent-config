import { describe, expect, test as it } from "bun:test";
import type { ProjectWorkspace } from "../workspace/index.ts";
import type { GenerationEvent, SandboxGeneration } from "./generation/index.ts";
import { gateway, workspace } from "./generation/test/index.helper.ts";
import {
  closingState,
  failedDisposalState,
  projectGenerationEvent,
  selectGeneration,
} from "./state.ts";
import { runtimeFixture } from "./test/runtime.helper.ts";
import type { RuntimeState } from "./types.ts";

const fixture = runtimeFixture();
const prepared = gateway(fixture);
const resources = {
  gateway: prepared,
  sandboxId: "owned-sandbox-id",
  workspace,
  environment: {},
};
const generation: SandboxGeneration = {
  sandboxName: "owned-sandbox",
  signal: new AbortController().signal,
  readiness: Promise.resolve(resources),
  invalidate: () => Promise.resolve({ kind: "confirmed" }),
};
const preparing: RuntimeState = {
  phase: "preparing",
  preparationStep: "starting",
  generation,
};

/** Projects a generation event without changing runtime ownership or emitting callbacks. */
function project(state: RuntimeState, event: GenerationEvent, live = true) {
  return projectGenerationEvent({
    state,
    event,
    live,
    requiredPaths: ["/old"],
    image: undefined,
  });
}

describe("selectGeneration", () => {
  it("should reuse active generation and refuse commands in recovery", () => {
    expect(selectGeneration({ phase: "idle" })).toBeUndefined();
    expect(selectGeneration(preparing)).toBe(generation);
    expect(() =>
      selectGeneration({
        phase: "recovery-required",
        scope: "generation",
        generation,
        failure: {
          code: "cleanup",
          operation: "delete",
          safeMessage: "Cleanup unconfirmed",
        },
        disposal: undefined,
      }),
    ).toThrow("refuses commands");
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("projectGenerationEvent", () => {
  it("should publish matching readiness and required workspace paths", () => {
    const progress = project(preparing, {
      kind: "progress",
      step: "gateway",
      generation,
    });
    expect(progress.state).toMatchObject({
      phase: "preparing",
      preparationStep: "gateway",
    });
    const ready = project(progress.state, {
      kind: "ready",
      resources,
      generation,
    });
    expect(ready.state.phase).toBe("ready");
    expect(ready.requiredPaths).toEqual(workspace.requiredNativeReadWritePaths);
  });

  it("should ignore stale or canceled readiness and keep the current workspace", () => {
    const stale = project(preparing, {
      kind: "ready",
      resources,
      generation: { ...generation },
    });
    expect(stale.state).toBe(preparing);
    const canceled = project(
      preparing,
      { kind: "ready", resources, generation },
      false,
    );
    expect(canceled.state).toBe(preparing);
    expect(canceled.requiredPaths).toEqual(["/old"]);
    const nextWorkspace: ProjectWorkspace = {
      ...workspace,
      requiredNativeReadWritePaths: ["/new"],
    };
    expect(
      project(preparing, {
        kind: "workspace",
        workspace: nextWorkspace,
        generation,
      }).requiredPaths,
    ).toEqual(["/new"]);
  });
  it("should retain the failure but release generation ownership when cleanup is later confirmed", () => {
    const failure = {
      code: "cleanup" as const,
      operation: "delete",
      safeMessage: "Cleanup not yet confirmed",
    };
    const disposal = Promise.resolve();
    const recovering = project(closingState(preparing, disposal), {
      kind: "cleanup-failed",
      generation,
      failure,
    }).state;
    expect(
      project(recovering, {
        kind: "stopped",
        generation: { ...generation },
      }).state,
    ).toBe(recovering);
    expect(project(recovering, { kind: "stopped", generation }).state).toEqual({
      phase: "recovery-required",
      scope: "session",
      failure,
      disposal,
    });
  });
});

describe("closingState", () => {
  it("should retain a generation until SDK cleanup is independently confirmed", () => {
    const disposal = Promise.resolve();
    expect(closingState(preparing, disposal)).toMatchObject({
      phase: "closing",
      stage: "generation",
      generation,
    });
    const failure = {
      code: "cleanup" as const,
      operation: "delete",
      safeMessage: "Unconfirmed",
    };
    expect(
      failedDisposalState(closingState(preparing, disposal), failure, disposal),
    ).toMatchObject({
      phase: "recovery-required",
      scope: "generation",
      generation,
      failure,
    });
  });
});
