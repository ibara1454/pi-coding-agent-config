import { describe, expect, test as it, spyOn } from "bun:test";
import process from "node:process";
import { processScenario } from "../host/test/index.helper.ts";
import { createRuntimeEffects } from "./effects.ts";
import { runtimeFixture } from "./test/index.helper.ts";

/** Uses only fake host effects; no real Docker context or gateway is touched. */
function hostFixture() {
  const fixture = runtimeFixture();
  return {
    ...fixture,
    host: {
      ...fixture.effects.host,
      environment: {
        ["PATH"]: "/usr/bin",
        ["DOCKER_HOST"]: "unix:///run/docker.sock",
      },
    },
  };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("createRuntimeEffects", () => {
  it("should resolve local prerequisites and retain captured host adapters", async () => {
    const fixture = hostFixture();
    const effects = await createRuntimeEffects(
      fixture.activation,
      fixture.host,
    );
    expect(effects.host.gatewayExecutable).toBe("/usr/bin/openshell-gateway");
    expect(effects.host.dockerEndpoint).toBe("unix:///run/docker.sock");
    expect(effects.filesystem).toBe(fixture.host.filesystem);
    expect(effects.activationSignal).toBe(fixture.activation.signal);
  });

  it("should reject an already canceled activation before Docker discovery", async () => {
    const fixture = hostFixture();
    fixture.activation.abort();
    await expect(
      createRuntimeEffects(fixture.activation, fixture.host),
    ).rejects.toThrow("activation was closed");
    expect(fixture.native.calls).toEqual([]);
  });
  it("should refuse effects when activation closes during Docker context discovery", async () => {
    const fixture = hostFixture();
    const scenario = processScenario((child) => {
      child.stdout?.emit("data", Buffer.from('"unix:///run/docker.sock"'));
      child.emit("close", 0, child.signalCode);
    });
    const host = {
      ...fixture.host,
      environment: { ["PATH"]: "/usr/bin" },
      processEffects: {
        ...scenario.effects,
        clearTimer: (timer: NodeJS.Timeout) => {
          scenario.effects.clearTimer(timer);
          fixture.activation.abort();
        },
      },
    };
    await expect(
      createRuntimeEffects(fixture.activation, host),
    ).rejects.toThrow("activation was closed");
    expect(fixture.native.launches).toBe(0);
  });

  it("should refuse a remote Docker endpoint instead of opening a native gateway", async () => {
    const fixture = hostFixture();
    await expect(
      createRuntimeEffects(fixture.activation, {
        ...fixture.host,
        dockerEndpoint: "tcp://foreign:2375",
        environment: {
          ...fixture.host.environment,
          ["DOCKER_HOST"]: "tcp://foreign:2375",
        },
      }),
    ).rejects.toThrow("local Unix Docker socket");
    expect(fixture.native.launches).toBe(0);
  });
  it("should launch Git without inherited credentials and read credentials at invocation time", async () => {
    const fixture = hostFixture();
    const effects = await createRuntimeEffects(
      fixture.activation,
      fixture.host,
    );
    const launch = spyOn(effects.host.processEffects, "spawn");
    const variable = "OPENSHELL_RUNTIME_UNIT_CREDENTIAL";
    const previous = process.env[variable];
    try {
      process.env[variable] = "first";
      expect(await effects.gitProcess(["status", "--porcelain"])).toMatchObject(
        { exitCode: 0 },
      );
      expect(launch.mock.calls[0]).toMatchObject([
        "git",
        ["status", "--porcelain"],
        {
          shell: false,
        },
      ]);
      expect(launch.mock.calls[0]?.[2]?.env).toEqual({
        ["PATH"]: "/usr/bin",
        ["HOME"]: "/home/person",
        ["GIT_CONFIG_NOSYSTEM"]: "1",
        ["GIT_CONFIG_GLOBAL"]: "/dev/null",
      });
      expect(effects.credentialSource(variable)).toBe("first");
      process.env[variable] = "second";
      expect(effects.credentialSource(variable)).toBe("second");
    } finally {
      launch.mockRestore();
      if (previous === undefined) {
        delete process.env[variable];
      } else {
        process.env[variable] = previous;
      }
    }
  });
});
