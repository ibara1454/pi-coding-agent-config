import { describe, expect, test as it } from "bun:test";
import type { SpawnOptions, spawn } from "node:child_process";
import type { OwnedResource } from "../host/index.ts";
import {
  type RuntimeFixture,
  unitRuntimeFixture as runtimeFixture,
  TEST_NETWORK,
} from "../runtime/test/index.helper.ts";
import { createGatewayNetwork } from "./network.ts";
import {
  network,
  unacknowledgedNetwork,
  withDockerOutput,
} from "./test/acquisition-effects.helper.ts";

const NATIVE_ID_LENGTH = 64;
const TRUNCATED_ID_LENGTH = 12;
const FOREIGN_ID = "a".repeat(NATIVE_ID_LENGTH);
const observed = {
  ["Id"]: TEST_NETWORK,
  ["Name"]: network.name,
  ["Labels"]: network.labels,
  ["Containers"]: {},
};
const INSPECTION_CASES = [
  ["ambiguous inspections", []],
  // biome-ignore lint/plugin/biome-rules/use-undefined: Docker network inspect JSON may contain a null entry, which must not authorize removal.
  ["null network entry", [null]],
  ["foreign native ID", [{ ...observed, ["Id"]: FOREIGN_ID }]],
  [
    "foreign ownership labels",
    [
      {
        ...observed,
        ["Labels"]: { "io.pi.openshell-sandbox.instance-id": "foreign" },
      },
    ],
  ],
  [
    "missing attachment map",
    [
      {
        ["Id"]: TEST_NETWORK,
        ["Name"]: network.name,
        ["Labels"]: network.labels,
      },
    ],
  ],
  ["array attachment map", [{ ...observed, ["Containers"]: [] }]],
] as const;
const CREATE_ARGS = [
  "network",
  "create",
  "--driver",
  "bridge",
  "--label",
  "io.pi.openshell-sandbox.instance-id=abcdefghijklmnop",
  network.name,
];

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("createGatewayNetwork", () => {
  it("should capture labelled intent before submission and acknowledge only the exact native network ID", async () => {
    const fixture = runtimeFixture();
    try {
      const captured: OwnedResource[] = [];
      const submissions: Array<{
        args: readonly string[];
        captured: string[];
      }> = [];
      const original = fixture.effects.host.processEffects.spawn;
      const host = {
        ...fixture.effects.host,
        processEffects: {
          ...fixture.effects.host.processEffects,
          spawn: ((
            executable: string,
            args: readonly string[],
            options: SpawnOptions,
          ) => {
            if (args?.[2] === "network" && args[3] === "create") {
              submissions.push({
                args: [...args],
                captured: captured.map((item) => item.kind),
              });
            }
            return original(executable, args, options);
          }) as typeof spawn,
        },
      };
      expect(
        await createGatewayNetwork(
          host,
          network,
          fixture.activation.signal,
          (item) => captured.push(item),
        ),
      ).toBe(TEST_NETWORK);
      expect(submissions).toEqual([
        {
          args: ["--host", host.dockerEndpoint, ...CREATE_ARGS],
          captured: ["network"],
        },
      ]);
      expect(captured.map((item) => item.kind)).toEqual(["network"]);
      await captured[0]?.release();
      expect(
        fixture.native.calls.filter(
          (args) => args[2] === "network" && args[3] === "rm",
        ),
      ).toEqual([
        ["--host", host.dockerEndpoint, "network", "rm", TEST_NETWORK],
      ]);
    } finally {
      fixture.clock.restore();
    }
  });
  it.each([
    ["no candidate", ""],
    ["multiple candidates", `${TEST_NETWORK}\n${FOREIGN_ID}`],
    ["truncated candidate", TEST_NETWORK.slice(0, TRUNCATED_ID_LENGTH)],
  ])(
    "should retain unacknowledged intent when exact-name recovery reports %s",
    async (_condition, candidate) => {
      const fixture = runtimeFixture();
      try {
        const { host, inspections } = unacknowledgedNetwork(
          fixture.effects.host,
          candidate,
        );
        const captured: OwnedResource[] = [];
        await expect(
          createGatewayNetwork(
            host,
            network,
            fixture.activation.signal,
            (item) => captured.push(item),
          ),
        ).rejects.toThrow("creation identity is unresolved");
        await expect(captured[0]?.release()).rejects.toThrow(
          "creation outcome is unresolved",
        );
        expect(inspections).toEqual([
          [
            "--host",
            host.dockerEndpoint,
            "network",
            "ls",
            "--no-trunc",
            "--filter",
            `name=^${network.name}$`,
            "--filter",
            "label=io.pi.openshell-sandbox.instance-id=abcdefghijklmnop",
            "--format",
            "{{.ID}}",
          ],
        ]);
        expect(captured.map((item) => item.kind)).toEqual(["network"]);
        expect(
          fixture.native.calls.some(
            (args) => args[2] === "network" && args[3] === "rm",
          ),
        ).toBe(false);
      } finally {
        fixture.clock.restore();
      }
    },
  );
  it.each(INSPECTION_CASES)(
    "should avoid removal when release inspection returns %s",
    async (_condition, rows) => {
      const fixture = runtimeFixture();
      try {
        const host = withDockerOutput(
          fixture.effects.host,
          "network inspect",
          JSON.stringify(rows),
        );
        const captured: OwnedResource[] = [];
        await createGatewayNetwork(
          host,
          network,
          fixture.activation.signal,
          (item) => captured.push(item),
        );
        await expect(captured[0]?.release()).rejects.toBeInstanceOf(Error);
        expect(fixture.native.networkPresent).toBe(true);
        expect(
          fixture.native.calls.some(
            (args) => args[2] === "network" && args[3] === "rm",
          ),
        ).toBe(false);
      } finally {
        fixture.clock.restore();
      }
    },
  );
  it("should refuse an existing private name without submitting another create", async () => {
    const fixture = runtimeFixture();
    try {
      fixture.native.networkPresent = true;
      await expect(
        createGatewayNetwork(
          fixture.effects.host,
          network,
          fixture.activation.signal,
          () => undefined,
        ),
      ).rejects.toThrow("already exists");
      expect(
        fixture.native.calls.some(
          (args) => args[2] === "network" && args[3] === "create",
        ),
      ).toBe(false);
    } finally {
      fixture.clock.restore();
    }
  });

  it("should refuse an unverified daemon identity before acquiring a network", async () => {
    const fixture = runtimeFixture();
    try {
      const host = withDockerOutput(
        fixture.effects.host,
        "info --format",
        "bad",
      );
      const captured: OwnedResource[] = [];
      await expect(
        createGatewayNetwork(host, network, fixture.activation.signal, (item) =>
          captured.push(item),
        ),
      ).rejects.toThrow("daemon identity");
      expect(captured).toHaveLength(0);
      expect(fixture.native.networkPresent).toBe(false);
    } finally {
      fixture.clock.restore();
    }
  });
  it("should remove only the acknowledged empty labelled network and release idempotently", async () => {
    const fixture = runtimeFixture();
    try {
      const resources: OwnedResource[] = [];
      expect(
        await createGatewayNetwork(
          fixture.effects.host,
          network,
          fixture.activation.signal,
          (item) => resources.push(item),
        ),
      ).toBe(TEST_NETWORK);
      expect(resources.map((item) => item.kind)).toEqual(["network"]);
      const [owned] = resources;
      if (!owned) {
        throw new Error("Network ownership was not captured.");
      }
      await owned.release();
      await owned.release();
      expect(fixture.native.networkPresent).toBe(false);
    } finally {
      fixture.clock.restore();
    }
  });
  it.each([
    [
      "foreign labels",
      (fixture: RuntimeFixture) => {
        fixture.native.labels["io.pi.openshell-sandbox.instance-id"] =
          "foreign";
      },
    ],
    [
      "attached workload",
      (fixture: RuntimeFixture) => {
        fixture.native.sandboxPresent = true;
      },
    ],
    [
      "different immutable id",
      (fixture: RuntimeFixture) => {
        fixture.native.networkId = "e".repeat(NATIVE_ID_LENGTH);
      },
    ],
  ] as [string, (fixture: RuntimeFixture) => void][])(
    "should preserve network when inspection reveals %s",
    async (_condition, change) => {
      const fixture = runtimeFixture();
      try {
        const resources: OwnedResource[] = [];
        await createGatewayNetwork(
          fixture.effects.host,
          network,
          fixture.activation.signal,
          (item) => resources.push(item),
        );
        change(fixture);
        const [owned] = resources;
        if (!owned) {
          throw new Error("Network ownership was not captured.");
        }
        await expect(owned.release()).rejects.toBeInstanceOf(Error);
        expect(fixture.native.networkPresent).toBe(true);
        expect(
          fixture.native.calls.some(
            (args) => args[2] === "network" && args[3] === "rm",
          ),
        ).toBe(false);
      } finally {
        fixture.clock.restore();
      }
    },
  );
  it("should recover and remove an exact owned network when creation succeeds without an acknowledged ID", async () => {
    const fixture = runtimeFixture();
    try {
      const host = withDockerOutput(
        fixture.effects.host,
        "network create",
        "unacknowledged",
      );
      const recoveredHost = {
        ...host,
        processEffects: {
          ...host.processEffects,
          spawn: ((
            executable: string,
            argv: readonly string[],
            options: SpawnOptions,
          ) => {
            if (argv[2] === "network" && argv[3] === "create") {
              fixture.native.networkPresent = true;
              fixture.native.namespace = network.name;
              fixture.native.labels = { ...network.labels };
            }
            return host.processEffects.spawn(executable, argv, options);
          }) as typeof spawn,
        },
      };
      const captured: OwnedResource[] = [];
      await expect(
        createGatewayNetwork(
          recoveredHost,
          network,
          fixture.activation.signal,
          (item) => captured.push(item),
        ),
      ).rejects.toThrow("creation identity is unresolved");
      const intent = captured.find((item) => item.kind === "network");
      if (!intent) {
        throw new Error("Network creation intent was not captured.");
      }
      expect(fixture.native.networkPresent).toBe(true);
      await intent.release();
      expect(captured).toHaveLength(1);
      for (const operation of ["inspect", "rm"]) {
        expect(fixture.native.calls).toContainEqual([
          "--host",
          fixture.effects.host.dockerEndpoint,
          "network",
          operation,
          TEST_NETWORK,
        ]);
      }
      expect(fixture.native.networkPresent).toBe(false);
    } finally {
      fixture.clock.restore();
    }
  });
});
