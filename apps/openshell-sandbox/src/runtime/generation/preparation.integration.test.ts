import { describe, expect, test as it } from "bun:test";
import { unitRuntimeFixture } from "../test/index.helper.ts";
import { prepareGeneration } from "./preparation.ts";
import { gateway, input } from "./test/generation.helper.ts";
import type { GenerationEvent } from "./types.ts";

describe("prepareGeneration", () => {
  it("should share SDK readiness and delete an acknowledged sandbox once", async () => {
    const fixture = unitRuntimeFixture();
    try {
      const prepared = gateway(fixture);
      fixture.native.labels = { ...prepared.handle.labels };
      const events: GenerationEvent[] = [];
      const generation = prepareGeneration(
        input(fixture, prepared),
        fixture.effects,
        (event) => events.push(event),
      );
      try {
        expect((await generation.readiness).gateway).toBe(prepared);
        expect(
          events.some(
            (event) =>
              event.kind === "creation" && event.outcome === "acknowledged",
          ),
        ).toBe(true);
        const stopped = generation.invalidate();
        expect(generation.invalidate()).toBe(stopped);
        expect(await stopped).toEqual({ kind: "confirmed" });
        expect(fixture.sdk.deleteCount).toBe(1);
        expect(events.filter((event) => event.kind === "stopped")).toHaveLength(
          1,
        );
      } finally {
        await generation.invalidate().catch(() => undefined);
      }
    } finally {
      fixture.clock.restore();
    }
  });
});
