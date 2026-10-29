import { describe, expect, test as it } from "bun:test";
import { DEFAULT_SANDBOX_IMAGE } from "../../image/index.ts";
import { runtimeFixture, unitRuntimeFixture } from "../test/index.helper.ts";
import { deadline } from "../work/index.ts";
import { awaitGenerationReadiness, runGenerationSetup } from "./setup.ts";
import { gateway, generation, work } from "./test/generation.helper.ts";
import type { GenerationEvent } from "./types.ts";

const PREPARATION_DEADLINE_MS = 100;

describe("runGenerationSetup", () => {
  it("should choose the release-matched base image and return only locale without a custom build", async () => {
    const fixture = unitRuntimeFixture();
    try {
      const prepared = gateway(fixture);
      fixture.native.sandboxId = "sandbox-1";
      fixture.native.sandboxName = "test-sandbox";
      fixture.native.labels = { ...prepared.handle.labels };
      const { image: _selected, ...environment } = fixture.environment;
      const current = work(fixture, prepared);
      const events: GenerationEvent[] = [];
      let requestedImage: string | undefined;
      try {
        const ready = await runGenerationSetup({
          ...current,
          input: { ...current.input, environment },
          createSandbox: (_gateway, _workspace, image) => {
            requestedImage = image;
            return Promise.resolve("sandbox-1");
          },
          report: (event) => events.push(event),
        });
        expect(requestedImage).toBe(DEFAULT_SANDBOX_IMAGE);
        expect(ready.environment).toEqual({
          ["LANG"]: "C.UTF-8",
          ["LC_ALL"]: "C.UTF-8",
        });
        expect(fixture.sdk.commands).toEqual([]);
        expect(events).toContainEqual({
          generation: current.generation,
          kind: "image",
          image: DEFAULT_SANDBOX_IMAGE,
        });
      } finally {
        current.preparation.close();
      }
    } finally {
      fixture.clock.restore();
    }
  });
});

describe("awaitGenerationReadiness", () => {
  it("should publish SDK readiness and close its preparation timer", async () => {
    const fixture = unitRuntimeFixture();
    try {
      const handle = generation(fixture);
      const expected = await handle.readiness;
      const events: GenerationEvent[] = [];
      expect(
        await awaitGenerationReadiness({
          setup: handle.readiness,
          preparation: deadline(fixture.effects, PREPARATION_DEADLINE_MS),
          generation: handle,
          report: (event) => events.push(event),
          invalidate: () => Promise.reject(new Error("Unexpected cleanup")),
        }),
      ).toBe(expected);
      expect(events).toEqual([
        { kind: "ready", generation: handle, resources: expected },
      ]);
      expect(fixture.clock.pending()).toBe(0);
    } finally {
      fixture.clock.restore();
    }
  });
  it("should surface cleanup failure before preparation failure when SDK readiness fails", async () => {
    const fixture = runtimeFixture();
    const current = work(fixture);
    const events: GenerationEvent[] = [];
    const failure = new Error("cleanup blocked");
    await expect(
      awaitGenerationReadiness({
        setup: Promise.reject(new Error("SDK readiness failed")),
        preparation: current.preparation,
        generation: current.generation,
        report: (event) => events.push(event),
        invalidate: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
    expect(events.some((event) => event.kind === "ready")).toBe(false);
  });
});
