import { describe, expect, test as it } from "bun:test";
import { HostProcessError, type ProcessClose } from "../../host/index.ts";
import { runtimeFixture } from "../test/index.helper.ts";
import { prepareGeneration } from "./preparation.ts";
import { input } from "./test/generation.helper.ts";
import type { GenerationEvent } from "./types.ts";

describe("prepareGeneration", () => {
  it("should wait for captured Git child closure before confirming canceled setup", async () => {
    const fixture = runtimeFixture();
    const closed = Promise.withResolvers<ProcessClose>();
    const entered = Promise.withResolvers<void>();
    const events: GenerationEvent[] = [];
    let queries = 0;
    const generation = prepareGeneration(
      input(fixture),
      {
        ...fixture.effects,
        filesystem: {
          ...fixture.effects.filesystem,
          lstat: ((path: string) =>
            fixture.effects.filesystem.lstat(
              path === "/project/.git" ? "/project" : path,
            )) as typeof fixture.effects.filesystem.lstat,
        },
        gitProcess: () => {
          queries += 1;
          if (queries === 2) {
            entered.resolve();
          }
          return Promise.reject(
            new HostProcessError("Git child failed", {
              closed: closed.promise,
              terminate: async () => undefined,
            }),
          );
        },
      },
      (event) => events.push(event),
    );
    try {
      await entered.promise;
      const stopping = generation.invalidate();
      let settled = false;
      const onSettled = () => {
        settled = true;
      };
      const observed = stopping.then(onSettled, onSettled);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(events.some((event) => event.kind === "stopped")).toBe(false);
      // biome-ignore lint/plugin/biome-rules/use-undefined: Node reports null for a normal numeric child exit.
      closed.resolve({ exitCode: 1, signal: null });
      expect(await stopping).toEqual({ kind: "confirmed" });
      await observed;
      await expect(generation.readiness).rejects.toThrow();
      expect(events.filter((event) => event.kind === "stopped")).toHaveLength(
        1,
      );
      expect(fixture.native.launches).toBe(0);
    } finally {
      // biome-ignore lint/plugin/biome-rules/use-undefined: Node reports null for a normal numeric child exit.
      closed.resolve({ exitCode: 1, signal: null });
      await generation.invalidate().catch(() => undefined);
    }
  });
});
