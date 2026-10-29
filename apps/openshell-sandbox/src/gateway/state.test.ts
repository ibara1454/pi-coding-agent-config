import { describe, expect, test as it, mock } from "bun:test";
import type { Stats } from "node:fs";
import type { ManagedProcess, OwnedResource } from "../host/index.ts";
import { HostProcessError } from "../host/index.ts";
import { unitRuntimeFixture as runtimeFixture } from "../runtime/test/index.helper.ts";
import { createGatewayState } from "./state.ts";
import { directory, withStats } from "./test/acquisition-effects.helper.ts";

const FOREIGN_UID = 1001;
const PUBLIC_DIRECTORY_MODE = 0o4_0755;
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("createGatewayState", () => {
  it("should reject invalid instance identity before touching state root", async () => {
    const fixture = runtimeFixture();
    try {
      await expect(
        createGatewayState(
          { ...fixture.effects.host, instanceId: "../foreign" },
          () => undefined,
        ),
      ).rejects.toThrow("instance identity");
      expect(fixture.filesystem.files.size).toBe(0);
    } finally {
      fixture.clock.restore();
    }
  });

  it.each([
    ["foreign owner", { uid: FOREIGN_UID }],
    ["public access", { mode: PUBLIC_DIRECTORY_MODE }],
    ["non-directory", { isDirectory: () => false }],
    ["symbolic link", { isSymbolicLink: () => true }],
  ] as [string, Partial<Stats>][])(
    "should reject unsafe state root when it has %s",
    async (_condition, changed) => {
      const fixture = runtimeFixture();
      try {
        const host = withStats(fixture.effects.host, (path, stat) =>
          path === "/state" ? ({ ...stat, ...changed } as Stats) : stat,
        );
        await expect(createGatewayState(host, () => undefined)).rejects.toThrow(
          "owner-only",
        );
      } finally {
        fixture.clock.restore();
      }
    },
  );
  it("should retain provisional state when directory identity cannot be recorded", async () => {
    const fixture = runtimeFixture();
    try {
      const captured: OwnedResource[] = [];
      const host = withStats(fixture.effects.host, (path, stat) => {
        if (path === directory) {
          throw new Error("identity unavailable");
        }
        return stat;
      });
      await expect(
        createGatewayState(host, (item) => captured.push(item)),
      ).rejects.toThrow("identity unavailable");
      expect(captured.map((item) => item.kind)).toEqual(["state"]);
      const [provisional] = captured;
      if (!provisional) {
        throw new Error("Provisional state was not captured.");
      }
      await expect(provisional.release()).rejects.toThrow(
        "cleanup could not be confirmed",
      );
      expect(
        (await fixture.effects.host.filesystem.lstat(directory)).isDirectory(),
      ).toBe(true);
    } finally {
      fixture.clock.restore();
    }
  });
  it("should retain state until every captured resource is released and reject a replacement directory", async () => {
    const fixture = runtimeFixture();
    try {
      const captured: OwnedResource[] = [];
      const state = await createGatewayState(fixture.effects.host, (item) =>
        captured.push(item),
      );
      const release = mock(
        (): Promise<void> => Promise.reject(new Error("unresolved")),
      );
      state.capture({
        kind: "network",
        release,
      });
      await expect(state.close()).rejects.toThrow(
        "cleanup could not be confirmed",
      );
      expect(
        (await fixture.effects.host.filesystem.lstat(directory)).isDirectory(),
      ).toBe(true);
      release.mockResolvedValue(undefined);
      fixture.filesystem.replace(directory);
      await expect(state.close()).rejects.toThrow(
        "cleanup could not be confirmed",
      );
      expect(captured.filter((item) => item.kind === "state")).toHaveLength(1);
      expect(
        (await fixture.effects.host.filesystem.lstat(directory)).isDirectory(),
      ).toBe(true);
    } finally {
      fixture.clock.restore();
    }
  });
  it("should release captured process before network and remove state only after both", async () => {
    const fixture = runtimeFixture();
    try {
      const state = await createGatewayState(
        fixture.effects.host,
        () => undefined,
      );
      const order: string[] = [];
      state.capture({
        kind: "network",
        release: () => {
          order.push("network");
          return Promise.resolve();
        },
      });
      state.capture({
        kind: "process",
        release: () => {
          order.push("process");
          return Promise.resolve();
        },
      });
      await state.close();
      expect(order).toEqual(["process", "network"]);
      await expect(
        fixture.effects.host.filesystem.lstat(directory),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await state.close();
    } finally {
      fixture.clock.restore();
    }
  });
  it("should create only private environment paths and retain frozen release capabilities", async () => {
    const fixture = runtimeFixture();
    try {
      const captured: OwnedResource[] = [];
      const state = await createGatewayState(
        {
          ...fixture.effects.host,
          environment: { ["PATH"]: "", ["SECRET_TOKEN"]: "host-secret" },
        },
        (item) => captured.push(item),
      );
      expect(state.environment).toEqual({
        ["PATH"]: "/usr/local/bin:/usr/bin:/bin",
        ["LANG"]: "C.UTF-8",
        ["HOME"]: `${directory}/home`,
        ["XDG_CONFIG_HOME"]: `${directory}/config`,
        ["XDG_STATE_HOME"]: `${directory}/state`,
        ["XDG_DATA_HOME"]: `${directory}/data`,
        ["XDG_CACHE_HOME"]: `${directory}/cache`,
        ["XDG_RUNTIME_DIR"]: `${directory}/run`,
      });
      expect(Object.isFrozen(state.environment)).toBe(true);
      state.capture({
        kind: "network",
        release: async () => undefined,
      });
      expect(Object.isFrozen(captured.at(-1))).toBe(true);
      await state.close();
    } finally {
      fixture.clock.restore();
    }
  });
  it("should capture uncertain cleanup children and terminate them before retrying the original resource", async () => {
    const fixture = runtimeFixture();
    try {
      const captured: OwnedResource[] = [];
      const order: string[] = [];
      let retriable = false;
      const close = Promise.withResolvers<Awaited<ManagedProcess["closed"]>>();
      const uncertain = {
        closed: close.promise,
        terminate: () => {
          order.push("process");
          // biome-ignore lint/plugin/biome-rules/use-undefined: Node child close reports a null signal for a numeric exit.
          close.resolve({ exitCode: 0, signal: null });
          retriable = true;
          return Promise.resolve();
        },
      };
      const state = await createGatewayState(fixture.effects.host, (item) =>
        captured.push(item),
      );
      state.capture({
        kind: "network",
        release: () => {
          order.push("network");
          if (!retriable) {
            return Promise.reject(
              new HostProcessError("safe uncertain cleanup", uncertain),
            );
          }
          return Promise.resolve();
        },
      });
      await expect(state.close()).rejects.toThrow(
        "cleanup could not be confirmed",
      );
      expect(captured.at(-1)).toMatchObject({
        kind: "process",
      });
      expect(
        (await fixture.effects.host.filesystem.lstat(directory)).isDirectory(),
      ).toBe(true);
      await state.close();
      expect(order).toEqual(["network", "process", "network"]);
      await expect(
        fixture.effects.host.filesystem.lstat(directory),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      fixture.clock.restore();
    }
  });
});
