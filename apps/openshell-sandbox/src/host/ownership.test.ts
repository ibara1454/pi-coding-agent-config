import { describe, expect, test as it } from "bun:test";
import { withDockerOutput } from "../gateway/test/index.helper.ts";
import { runtimeFixture } from "../runtime/test/index.helper.ts";
import { dockerCommand } from "./ownership.ts";
import { HostProcessError } from "./process-types.ts";
import { processScenario } from "./test/process.helper.ts";

const DOCKER_TIMEOUT_MS = 15_000;

const DOCKER_FAILED_EXIT_CODE = 1;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("dockerCommand", () => {
  it("should reject a newline in the Docker endpoint before spawning", async () => {
    const fixture = runtimeFixture();
    await expect(
      dockerCommand(
        {
          ...fixture.effects.host,
          dockerEndpoint: "unix:///run/docker.sock\n--host=tcp://remote:2375",
        },
        ["info"],
      ),
    ).rejects.toThrow();
    expect(fixture.native.calls).toHaveLength(0);
  });

  it("should redact a failed Docker command and avoid treating its output as success", async () => {
    const fixture = runtimeFixture();
    const host = withDockerOutput(
      fixture.effects.host,
      "info --format",
      "private details",
      DOCKER_FAILED_EXIT_CODE,
    );
    const failure: unknown = await dockerCommand(host, [
      "info",
      "--format",
      "{{.ID}}",
    ]).then(
      () => {
        throw new Error("Expected Docker failure.");
      },
      (error: unknown) => error,
    );
    if (!(failure instanceof Error)) {
      throw new Error("Docker failure was not an Error.");
    }
    expect(failure.message).toContain(
      "Required private Docker operation failed",
    );
    expect(failure.message).not.toContain("private details");
  });
  it.each([
    ["creation", ["network", "create", "owned"]],
    ["inspection", ["network", "inspect", "id"]],
    ["removal", ["network", "rm", "id"]],
  ] as const)(
    "should bind the selected local daemon and deadline when performing %s",
    async (_condition, argv) => {
      const fixture = runtimeFixture();
      const scenario = processScenario((child) => {
        child.stdout?.emit("data", Buffer.from("result"));
        child.emit("close", 0, child.signalCode);
      });
      const timers: number[] = [];
      const launches: unknown[][] = [];
      const controller = new AbortController();
      const host = {
        ...fixture.effects.host,
        processEffects: {
          ...scenario.effects,
          spawn: ((...args: Parameters<typeof scenario.effects.spawn>) => {
            launches.push(args);
            return scenario.effects.spawn(...args);
          }) as typeof scenario.effects.spawn,
          setTimer: (callback: () => void, milliseconds: number) => {
            timers.push(milliseconds);
            return scenario.effects.setTimer(callback, milliseconds);
          },
        },
      };
      expect(await dockerCommand(host, argv, controller.signal)).toEqual({
        exitCode: 0,
        stdout: "result",
        stderr: "",
      });
      expect(launches[0]?.[1]).toEqual([
        "--host",
        host.dockerEndpoint,
        ...argv,
      ]);
      expect(launches[0]?.[2]).toMatchObject({
        env: host.environment,
        shell: false,
      });
      expect(timers).toEqual([DOCKER_TIMEOUT_MS]);
    },
  );
  it("should retain a safe process failure when subprocess launch fails", async () => {
    const fixture = runtimeFixture();
    const safe = new HostProcessError("Safe launch failure");
    const host = {
      ...fixture.effects.host,
      processEffects: {
        ...fixture.effects.host.processEffects,
        spawn: (() => {
          throw safe;
        }) as typeof fixture.effects.host.processEffects.spawn,
      },
    };
    const error = await dockerCommand(host, ["info"]).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(HostProcessError);
    expect((error as Error).cause).toBe(safe);
  });
});
