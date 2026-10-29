import { describe, expect, test as it, spyOn } from "bun:test";
import { join } from "node:path";
import type { OwnedResource } from "../host/index.ts";
import { processScenario } from "../host/test/index.helper.ts";
import { unitRuntimeFixture as runtimeFixture } from "../runtime/test/index.helper.ts";
import { launchGateway } from "./process.ts";
import { createGatewayState } from "./state.ts";
import { directory } from "./test/acquisition-effects.helper.ts";
import { failedGatewayLaunch } from "./test/process.helper.ts";

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("launchGateway", () => {
  it.each([
    ["a query delimiter", "home?demo"],
    ["a literal percent escape", "home%20demo"],
  ])(
    "should preserve the database pathname when the state directory contains %s",
    async (_label, component) => {
      const fixture = runtimeFixture();
      const scenario = processScenario(() => undefined);
      const spawn = spyOn(scenario.effects, "spawn");
      try {
        const host = {
          ...fixture.effects.host,
          processEffects: scenario.effects,
        };
        const state = await createGatewayState(host, () => undefined);
        try {
          const stateDirectory = join(state.directory, component);
          await launchGateway(
            host,
            { ...state, directory: stateDirectory },
            join(stateDirectory, "gateway.toml"),
            fixture.activation.signal,
          );
          const args = spawn.mock.calls[0]?.[1] ?? [];
          const url = new URL(args[args.indexOf("--db-url") + 1] ?? "");
          expect(url.protocol).toBe("sqlite:");
          expect(url.search).toBe("");
          expect(decodeURIComponent(url.pathname)).toBe(
            join(stateDirectory, "gateway.db"),
          );
        } finally {
          await state.close();
        }
      } finally {
        spawn.mockRestore();
        fixture.clock.restore();
      }
    },
  );
  it("should retain a captured failed launch when process termination cannot be confirmed", async () => {
    const setup = failedGatewayLaunch();
    try {
      let closed = false;
      setup.scenario.child.once("close", () => {
        closed = true;
      });
      const captured: OwnedResource[] = [];
      const state = await createGatewayState(setup.host, (item) =>
        captured.push(item),
      );
      try {
        await expect(
          launchGateway(
            setup.host,
            state,
            `${directory}/gateway.toml`,
            setup.fixture.activation.signal,
          ),
        ).rejects.toThrow("Private gateway process launch failed.");
        const processes = captured.filter((item) => item.kind === "process");
        expect(processes).toHaveLength(1);
        await expect(state.close()).rejects.toThrow(
          "cleanup could not be confirmed",
        );
        expect(
          (await setup.host.filesystem.lstat(state.directory)).isDirectory(),
        ).toBe(true);
        expect(closed).toBe(false);
        setup.allowTermination();
        await state.close();
        expect(closed).toBe(true);
        await expect(
          setup.host.filesystem.lstat(state.directory),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(setup.scenario.signals).toEqual(["SIGTERM"]);
        await state.close();
        expect(setup.scenario.signals).toHaveLength(1);
      } finally {
        setup.allowTermination();
        await state.close();
      }
    } finally {
      setup.fixture.clock.restore();
    }
  });
  it("should retain the owned direct-child handle until close and release it once", async () => {
    const fixture = runtimeFixture();
    try {
      const scenario = processScenario(() => undefined);
      const host = {
        ...fixture.effects.host,
        processEffects: scenario.effects,
      };
      const captured: OwnedResource[] = [];
      const state = await createGatewayState(host, (item) =>
        captured.push(item),
      );
      try {
        const child = await launchGateway(
          host,
          state,
          `${directory}/gateway.toml`,
          fixture.activation.signal,
        );
        const processes = captured.filter((item) => item.kind === "process");
        expect(processes).toHaveLength(1);
        expect(
          await Promise.race([
            child.closed.then(() => "closed"),
            Promise.resolve("open"),
          ]),
        ).toBe("open");
        fixture.activation.abort();
        expect(scenario.signals).toEqual([]);
        await state.close();
        const close = await child.closed;
        expect(close.exitCode).toBeNull();
        expect(close.signal).toBe("SIGTERM");
        expect(scenario.signals).toEqual(["SIGTERM"]);
        await state.close();
        expect(scenario.signals).toEqual(["SIGTERM"]);
      } finally {
        await state.close();
      }
    } finally {
      fixture.clock.restore();
    }
  });
});
