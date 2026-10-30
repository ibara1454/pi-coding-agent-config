import { describe, expect, test as it } from "bun:test";
import { EventEmitter } from "node:events";
import { Server } from "node:net";
import type { OpenShellClient } from "@nvidia/openshell-sdk";
import type { ManagedProcess, ProcessClose } from "../host/index.ts";
import { unitRuntimeFixture as runtimeFixture } from "../runtime/test/index.helper.ts";
import { connectGateway, reserveGatewayPort } from "./client.ts";
import type { GatewayHostContext as HostContext } from "./types.ts";

const STARTUP_DEADLINE_MS = 30_000;
const TRANSIENT_FAILURE_COUNT = 1;
const EXPECTED_HEALTH_CALLS = 2;
const POLICY_SETTING_COUNT = 3;

const tls = {
  caCert: Buffer.from("ca"),
  clientCert: Buffer.from("cert"),
  clientKey: Buffer.from("key"),
};
const child: ManagedProcess = {
  closed: Promise.withResolvers<ProcessClose>().promise,
  terminate: () => Promise.resolve(),
};
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("connectGateway", () => {
  it("should retry transient health failure and return only after matching authenticated control readback", async () => {
    const fixture = runtimeFixture();
    try {
      let healthCalls = 0;
      const { client } = fixture.sdk;
      const originalHealth = client.raw.health;
      client.raw.health = (...args) => {
        healthCalls += 1;
        return healthCalls === TRANSIENT_FAILURE_COUNT
          ? Promise.reject(new Error("transient"))
          : originalHealth(...args);
      };
      let updates = 0;
      const originalUpdate = client.raw.updateConfig;
      client.raw.updateConfig = (...args) => {
        updates += 1;
        return originalUpdate(...args);
      };
      const host: HostContext = {
        ...fixture.effects.host,
        processEffects: {
          ...fixture.effects.host.processEffects,
          setTimer: (callback) => {
            queueMicrotask(callback);
            return fixture.effects.host.processEffects.setTimer(
              () => undefined,
            );
          },
          clearTimer: fixture.effects.host.processEffects.clearTimer,
        },
      };
      expect(
        await connectGateway(
          host,
          { endpoint: "https://127.0.0.1:43123", tls },
          child,
          fixture.activation.signal,
        ),
      ).toBe(client);
      expect(healthCalls).toBe(EXPECTED_HEALTH_CALLS);
      expect(updates).toBe(POLICY_SETTING_COUNT);
    } finally {
      fixture.clock.restore();
    }
  });
  it.each([
    [
      "unsupported version",
      (client: OpenShellClient) => {
        const original = client.raw.health;
        client.raw.health = async (...args) => ({
          ...(await original(...args)),
          version: "0.0.999",
        });
      },
    ],
    [
      "unhealthy status",
      (client: OpenShellClient) => {
        const original = client.raw.health;
        client.raw.health = async (...args) => ({
          ...(await original(...args)),
          status: 0,
        });
      },
    ],
    [
      "transport failure",
      (client: OpenShellClient) => {
        client.raw.health = () => Promise.reject(new Error("secret transport"));
      },
    ],
  ] as [string, (client: OpenShellClient) => void][])(
    "should fail authenticated readiness when %s persists until deadline",
    async (_condition, change) => {
      const fixture = runtimeFixture();
      try {
        change(fixture.sdk.client);
        const { health } = fixture.sdk.client.raw;
        fixture.sdk.client.raw.health = (...args) => {
          fixture.clock.advance(STARTUP_DEADLINE_MS);
          return health(...args);
        };
        await expect(
          connectGateway(
            fixture.effects.host,
            { endpoint: "https://127.0.0.1:43123", tls },
            child,
            fixture.activation.signal,
          ),
        ).rejects.toThrow("authenticated readiness failed");
      } finally {
        fixture.clock.restore();
      }
    },
  );
  it("should reject readiness when the managed process closes during connection", async () => {
    const fixture = runtimeFixture();
    try {
      const closed = Promise.withResolvers<ProcessClose>();
      fixture.sdk.client.raw.health = () => {
        // biome-ignore lint/plugin/biome-rules/use-undefined: Node child close reports null when no termination signal was received.
        closed.resolve({ exitCode: 1, signal: null });
        return Promise.reject(new Error("not ready"));
      };
      await expect(
        connectGateway(
          fixture.effects.host,
          { endpoint: "https://127.0.0.1:43123", tls },
          { ...child, closed: closed.promise },
          fixture.activation.signal,
        ),
      ).rejects.toThrow("authenticated readiness failed");
    } finally {
      fixture.clock.restore();
    }
  });
  it("should reject unapplied credential policy controls", async () => {
    const fixture = runtimeFixture();
    try {
      const original = fixture.sdk.client.raw.getGatewayConfig;
      fixture.sdk.client.raw.getGatewayConfig = async (...args) => {
        const response = await original(...args);
        const setting = response.settings["providers_v2_enabled"];
        if (!setting) {
          throw new Error("Expected synthetic credential setting.");
        }
        setting.value = { case: "boolValue", value: true };
        return response;
      };
      await expect(
        connectGateway(
          fixture.effects.host,
          { endpoint: "https://127.0.0.1:43123", tls },
          child,
          fixture.activation.signal,
        ),
      ).rejects.toThrow("credential policy controls");
    } finally {
      fixture.clock.restore();
    }
  });
  it("should reject incorrect proposal readback instead of exposing the client", async () => {
    const fixture = runtimeFixture();
    try {
      const original = fixture.sdk.client.raw.getGatewayConfig;
      fixture.sdk.client.raw.getGatewayConfig = async (...args) => {
        const response = await original(...args);
        const setting = response.settings["proposal_approval_mode"];
        if (!setting) {
          throw new Error("Expected synthetic proposal setting.");
        }
        setting.value = { case: "stringValue", value: "automatic" };
        return response;
      };
      await expect(
        connectGateway(
          fixture.effects.host,
          { endpoint: "https://127.0.0.1:43123", tls },
          child,
          fixture.activation.signal,
        ),
      ).rejects.toThrow("proposal controls");
    } finally {
      fixture.clock.restore();
    }
  });
});
const RESERVED_PORT = 43_123;
// Server.address() reads initial in-memory state; this server is never listened on.
const EMPTY_ADDRESS = new Server().address();

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("reserveGatewayPort", () => {
  it("should return the candidate only after the owned loopback listener is released", async () => {
    const listener = new EventEmitter();
    const listening: Array<readonly [number, string]> = [];
    let release: ((error?: Error) => void) | undefined;
    const createListener = () =>
      Object.assign(listener, {
        listen: (port: number, host: string, ready: () => void) => {
          listening.push([port, host]);
          queueMicrotask(ready);
        },
        address: () => ({
          port: RESERVED_PORT,
          address: "127.0.0.1",
          family: "IPv4",
        }),
        close: (callback: (error?: Error) => void) => {
          release = callback;
        },
      });
    let settled = false;
    const reservation = reserveGatewayPort(createListener).then((port) => {
      settled = true;
      return port;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(listening).toEqual([[0, "127.0.0.1"]]);
    expect(settled).toBe(false);
    expect(release).toBeDefined();
    release?.();
    expect(await reservation).toBe(RESERVED_PORT);
    expect(settled).toBe(true);
  });
  it.each([
    ["an absent address", EMPTY_ADDRESS],
    ["a pipe address", "/private/socket"],
  ] as const)(
    "should close the listener and reject candidate discovery when it reports %s",
    async (_condition, address) => {
      let closed = 0;
      const listener = Object.assign(new EventEmitter(), {
        listen: (_port: number, _host: string, ready: () => void) =>
          queueMicrotask(ready),
        address: () => address,
        close: (callback: () => void) => {
          closed += 1;
          callback();
        },
      });
      await expect(reserveGatewayPort(() => listener)).rejects.toThrow(
        "port allocation failed",
      );
      expect(closed).toBe(1);
    },
  );
  it("should close the listener and expose allocation failure when listening fails", async () => {
    let closed = 0;
    const listener = Object.assign(new EventEmitter(), {
      listen: () =>
        queueMicrotask(() =>
          listener.emit("error", new Error("bind unavailable")),
        ),
      address: () => EMPTY_ADDRESS,
      close: (callback: () => void) => {
        closed += 1;
        callback();
      },
    });
    await expect(reserveGatewayPort(() => listener)).rejects.toThrow(
      "bind unavailable",
    );
    expect(closed).toBe(1);
  });
  it("should reject candidate release without disclosing listener diagnostics when close fails", async () => {
    const listener = Object.assign(new EventEmitter(), {
      listen: (_port: number, _host: string, ready: () => void) =>
        queueMicrotask(ready),
      address: () => ({
        port: RESERVED_PORT,
        address: "127.0.0.1",
        family: "IPv4",
      }),
      close: (callback: (error?: Error) => void) =>
        callback(new Error("secret socket detail")),
    });
    await expect(reserveGatewayPort(() => listener)).rejects.toThrow(
      "Private gateway port release failed.",
    );
  });
});
