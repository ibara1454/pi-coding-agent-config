import { describe, expect, test as it } from "bun:test";
import {
  plannedRealpath,
  runtimeFixture,
} from "../runtime/test/index.helper.ts";
import {
  captureHostContext,
  resolveDockerHost,
  withGatewayExecutable,
} from "./context.ts";
import { processScenario } from "./test/process.helper.ts";

const REQUIRED_GATEWAY = /requires the native openshell-gateway/u;
const TEST_UID = 42;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("captureHostContext", () => {
  it.each([
    ["linux", "/home/person/.local/state/pi-openshell-sandbox"],
    ["darwin", "/home/person/Library/Application Support/pi-openshell-sandbox"],
  ] as const)(
    "should select the platform state root and retain only operational facts when platform is %s",
    (platform, stateRoot) => {
      const fixture = runtimeFixture();
      const context = captureHostContext({
        homedir: () => "/home/person",
        ["randomUUID"]: () => "activation-id",
        process: {
          platform,
          arch: "arm64",
          env: {
            ["HOME"]: "/untrusted",
            ["DOCKER_HOST"]: "unix:///run/private.sock",
            ["LANG"]: "C",
            ["SECRET_TOKEN"]: "hidden",
          },
          getuid: () => TEST_UID,
        },
        filesystem: fixture.effects.host.filesystem,
        processEffects: fixture.effects.host.processEffects,
      });
      expect(context).toMatchObject({
        instanceId: "activation-id",
        platform,
        architecture: "arm64",
        uid: TEST_UID,
        paths: {
          home: "/home/person",
          stateRoot,
          dockerSocket: "/run/private.sock",
        },
        environment: {
          ["HOME"]: "/home/person",
          ["PATH"]: "/usr/local/bin:/usr/bin:/bin",
          ["DOCKER_HOST"]: "unix:///run/private.sock",
          ["LANG"]: "C",
        },
      });
      expect(context.environment).not.toHaveProperty("SECRET_TOKEN");
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.paths)).toBe(true);
      expect(Object.isFrozen(context.environment)).toBe(true);
    },
  );
  it("should preserve selected operational variables and absent identity when uid readers are unavailable", () => {
    const fixture = runtimeFixture();
    const context = captureHostContext({
      homedir: () => "/home/person",
      ["randomUUID"]: () => "activation",
      process: {
        platform: "linux",
        arch: "x64",
        env: {
          ["PATH"]: "/tools",
          ["DOCKER_CONFIG"]: "/docker-config",
          ["DOCKER_CONTEXT"]: "desktop",
          ["TMPDIR"]: "/temporary",
          ["LC_ALL"]: "C",
        },
        getuid: undefined,
      },
      filesystem: fixture.effects.host.filesystem,
      processEffects: fixture.effects.host.processEffects,
    });
    expect(context.uid).toBe(-1);
    expect(context.dockerEndpoint).toBe("unix:///var/run/docker.sock");
    expect(context.environment).toEqual({
      ["HOME"]: "/home/person",
      ["PATH"]: "/tools",
      ["DOCKER_CONFIG"]: "/docker-config",
      ["DOCKER_CONTEXT"]: "desktop",
      ["TMPDIR"]: "/temporary",
      ["LC_ALL"]: "C",
    });
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("withGatewayExecutable", () => {
  it("should use the first valid PATH executable after skipping inaccessible candidates", async () => {
    const fixture = runtimeFixture();
    const seen: string[] = [];
    fixture.filesystem.files.set("/first/openshell-gateway", "fixture");
    const filesystem = {
      ...fixture.effects.filesystem,
      access: (
        path: Parameters<typeof fixture.effects.filesystem.access>[0],
      ) => {
        seen.push(String(path));
        if (String(path) === "/missing/openshell-gateway") {
          return Promise.reject(new Error("inaccessible"));
        }
        return Promise.resolve();
      },
    };
    const host = {
      ...fixture.effects.host,
      filesystem,
      environment: { ["PATH"]: "/missing:/first:/later" },
    };
    const result = await withGatewayExecutable(host);
    expect(result.gatewayExecutable).toBe("/first/openshell-gateway");
    expect(seen).toEqual([
      "/missing/openshell-gateway",
      "/first/openshell-gateway",
    ]);
  });
  it("should fail required preparation when the native executable is unavailable", async () => {
    const fixture = runtimeFixture();
    const host = {
      ...fixture.effects.host,
      environment: { ["PATH"]: "" },
      filesystem: {
        ...fixture.effects.filesystem,
        access: () => Promise.reject(new Error("absent")),
      },
    };
    await expect(withGatewayExecutable(host)).rejects.toThrow(REQUIRED_GATEWAY);
    await expect(
      withGatewayExecutable({ ...host, environment: {} }),
    ).rejects.toThrow(REQUIRED_GATEWAY);
  });
  it("should skip a directory candidate and preserve canonical executable identity when a later PATH entry is a file", async () => {
    const fixture = runtimeFixture();
    const checked: string[] = [];
    const host = {
      ...fixture.effects.host,
      environment: { ["PATH"]: "/directory:/alias" },
      filesystem: {
        ...fixture.effects.host.filesystem,
        realpath: plannedRealpath((path) =>
          Promise.resolve(
            String(path) === "/alias/openshell-gateway"
              ? "/canonical/gateway"
              : String(path),
          ),
        ),
        access: () => Promise.resolve(),
        stat: ((path: unknown) => {
          checked.push(String(path));
          return Promise.resolve({
            isFile: () => String(path) === "/canonical/gateway",
          });
        }) as typeof fixture.effects.host.filesystem.stat,
      },
    };
    const result = await withGatewayExecutable(host);
    expect(result.gatewayExecutable).toBe("/canonical/gateway");
    expect(checked).toEqual([
      "/directory/openshell-gateway",
      "/canonical/gateway",
    ]);
    expect(host.gatewayExecutable).not.toBe("/canonical/gateway");
    expect(Object.isFrozen(result)).toBe(true);
  });
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("resolveDockerHost", () => {
  it("should retain an explicit local endpoint without inspecting a context when DOCKER_HOST is selected", async () => {
    const fixture = runtimeFixture();
    const host = {
      ...fixture.effects.host,
      dockerEndpoint: "unix:///run/selected.sock",
      environment: { ["DOCKER_HOST"]: "unix:///run/selected.sock" },
    };
    expect(await resolveDockerHost(host, new AbortController().signal)).toBe(
      host,
    );
    expect(fixture.native.calls).toHaveLength(0);
  });

  it("should reject an explicit remote endpoint before spawning when DOCKER_HOST is selected", async () => {
    const fixture = runtimeFixture();
    await expect(
      resolveDockerHost(
        {
          ...fixture.effects.host,
          dockerEndpoint: "tcp://remote:2375",
          environment: { ["DOCKER_HOST"]: "tcp://remote:2375" },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("local Unix");
    expect(fixture.native.calls).toHaveLength(0);
  });
  it.each([
    ["active context", {}],
    [
      "named context",
      { ["DOCKER_CONTEXT"]: "desktop", ["DOCKER_HOST"]: "tcp://ignored" },
    ],
  ] as [string, Record<string, string>][])(
    "should select the inspected local socket when resolving the %s",
    async (_condition, environment) => {
      const fixture = runtimeFixture();
      const scenario = processScenario((child) => {
        child.stdout?.emit("data", Buffer.from('"unix:///run/desktop.sock"'));
        child.emit("close", 0, child.signalCode);
      });
      const calls: unknown[][] = [];
      const host = {
        ...fixture.effects.host,
        environment,
        processEffects: {
          ...scenario.effects,
          spawn: ((...args: Parameters<typeof scenario.effects.spawn>) => {
            calls.push(args);
            return scenario.effects.spawn(...args);
          }) as typeof scenario.effects.spawn,
        },
      };
      const selected = await resolveDockerHost(
        host,
        new AbortController().signal,
      );
      expect(selected.dockerEndpoint).toBe("unix:///run/desktop.sock");
      expect(selected.paths.dockerSocket).toBe("/run/desktop.sock");
      expect(host.paths.dockerSocket).not.toBe("/run/desktop.sock");
      expect(calls[0]?.[1]).toEqual([
        "context",
        "inspect",
        ...("DOCKER_CONTEXT" in environment ? ["desktop"] : []),
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ]);
      expect(calls[0]?.[2]).toMatchObject({ shell: false, env: environment });
    },
  );
  it.each([
    [
      "nonzero status",
      '"unix:///run/docker.sock"',
      1,
      "working local Docker context",
    ],
    ["remote context", '"tcp://remote:2375"', 0, "remote Docker context"],
    ["non-string endpoint", "42", 0, "remote Docker context"],
    ["malformed context JSON", "{", 0, undefined],
  ] as const)(
    "should reject discovery when the result has %s",
    async (_condition, stdout, status, message) => {
      const fixture = runtimeFixture();
      const scenario = processScenario((child) => {
        child.stdout?.emit("data", Buffer.from(stdout));
        child.emit("close", status, child.signalCode);
      });
      await expect(
        resolveDockerHost(
          {
            ...fixture.effects.host,
            environment: {},
            processEffects: scenario.effects,
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(message);
    },
  );
});
