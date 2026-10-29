import { describe, expect, test as it } from "bun:test";
import { settleRuntimeDisposal } from "./disposal.ts";
import { gateway, generation } from "./generation/test/index.helper.ts";
import { runtimeFixture } from "./test/runtime.helper.ts";

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("settleRuntimeDisposal", () => {
  it("should defer SDK provider deletion and gateway close until raw requests settle", async () => {
    const fixture = runtimeFixture();
    const pending = Promise.withResolvers<void>();
    const events: string[] = [];
    const prepared = gateway(fixture);
    const task = settleRuntimeDisposal({
      effects: fixture.effects,
      generation: undefined,
      rawRequests: new Set([pending.promise]),
      prepared: () => ({
        ...prepared,
        providerResources: [
          {
            kind: "provider",
            release: () => {
              events.push("provider");
              return Promise.resolve();
            },
          },
        ],
        handle: {
          ...prepared.handle,
          close: () => {
            events.push("gateway");
            return Promise.resolve();
          },
        },
      }),
      generationStopped: () => true,
    });
    await Promise.resolve();
    expect(events).toEqual([]);
    pending.resolve();
    await task;
    expect(events).toEqual(["provider", "gateway"]);
  });
  it("should retain providers and gateway when generation cleanup is unconfirmed", async () => {
    const fixture = runtimeFixture();
    const prepared = gateway(fixture);
    const events: string[] = [];
    await expect(
      settleRuntimeDisposal({
        effects: fixture.effects,
        generation: generation(fixture),
        rawRequests: new Set(),
        prepared: () => ({
          ...prepared,
          providerResources: [
            {
              kind: "provider",
              release: () => {
                events.push("provider");
                return Promise.resolve();
              },
            },
          ],
          handle: {
            ...prepared.handle,
            close: () => {
              events.push("gateway");
              return Promise.resolve();
            },
          },
        }),
        generationStopped: () => false,
      }),
    ).rejects.toThrow("unconfirmed");
    expect(events).toEqual([]);
  });
  it("should retain a private gateway when SDK provider deletion fails", async () => {
    const fixture = runtimeFixture();
    const prepared = gateway(fixture);
    let closed = false;
    await expect(
      settleRuntimeDisposal({
        effects: fixture.effects,
        generation: undefined,
        rawRequests: new Set(),
        prepared: () => ({
          ...prepared,
          providerResources: [
            {
              kind: "provider",
              release: () => Promise.reject(new Error("provider uncertain")),
            },
          ],
          handle: {
            ...prepared.handle,
            close: () => {
              closed = true;
              return Promise.resolve();
            },
          },
        }),
        generationStopped: () => true,
      }),
    ).rejects.toThrow("provider uncertain");
    expect(closed).toBe(false);
  });
});
