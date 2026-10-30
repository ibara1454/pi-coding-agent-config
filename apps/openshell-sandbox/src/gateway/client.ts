import type { Server } from "node:net";
import { createServer } from "node:net";
import type { OpenShellClient } from "@nvidia/openshell-sdk";
import { type ManagedProcess, nativeFailure } from "../host/index.ts";
import type { GatewayTls } from "./config.ts";
import type { GatewayHostContext as HostContext } from "./types.ts";

const GATEWAY_STARTUP_MS = 30_000;
const HEALTH_POLL_MS = 100;
const GATEWAY_VERSION = /^v?0\.0\.116$/;

interface GatewayPortListener {
  readonly once: (event: "error", listener: (error: Error) => void) => void;
  readonly listen: (port: number, host: string, ready: () => void) => void;
  readonly address: () => ReturnType<Server["address"]>;
  readonly close: (callback: (error?: Error) => void) => void;
}

/** Allocate and release one loopback listener to obtain a candidate port.
 * Native bind and authenticated readiness remain authoritative after release.
 * @param createListener - Socket acquisition capability; this operation owns closing it.
 * @returns The candidate TCP port after its listener closes.
 * @throws If listening, address discovery, or listener release fails.
 * @example await reserveGatewayPort() returns an unreserved candidate such as 43123.
 */
export async function reserveGatewayPort(
  createListener: () => GatewayPortListener = createServer,
): Promise<number> {
  const server = createListener();
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  try {
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Private gateway port allocation failed.");
    }
    return address.port;
  } finally {
    const closed = Promise.withResolvers<void>();
    server.close((error) => {
      if (error) {
        closed.reject(new Error("Private gateway port release failed."));
      } else {
        closed.resolve();
      }
    });
    await closed.promise;
  }
}

/** Connects only with the freshly generated mTLS bundle and pins native policy controls.
 * @throws Safe failure if child exits, health/version fails, or control readback differs.
 * @example await connectGateway(host, { endpoint, tls }, process, signal)
 */
export async function connectGateway(
  host: HostContext,
  connection: { readonly endpoint: string; readonly tls: GatewayTls },
  child: ManagedProcess,
  signal: AbortSignal,
): Promise<OpenShellClient> {
  const { endpoint, tls } = connection;
  // Required dynamic import keeps missing SDK failures behind the fail-closed model route.
  const connect =
    host.gatewayEffects?.connect ??
    (await import("@nvidia/openshell-sdk")).OpenShellClient.connect;
  const client = await connect({ gateway: endpoint, ...tls });
  const deadline = performance.now() + GATEWAY_STARTUP_MS;
  const lifetime = new AbortController();
  const abortLifetime = () => lifetime.abort();
  child.closed.then(abortLifetime, abortLifetime);
  const preparation = AbortSignal.any([signal, lifetime.signal]);
  await waitHealthy(client, host, deadline, preparation);
  await configureGateway(client, preparation);
  preparation.throwIfAborted();
  return client;
}

/** Polls transient startup connection failures under one bounded preparation deadline. */
async function waitHealthy(
  client: OpenShellClient,
  host: HostContext,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  try {
    const health = await client.raw.health({}, { signal, timeoutMs: 1000 });
    if (health.status === 1 && GATEWAY_VERSION.test(health.version)) {
      return;
    }
    throw new Error("Private gateway version or health is unsupported.");
  } catch (error) {
    if (signal.aborted || performance.now() >= deadline) {
      throw nativeFailure(
        "Private gateway authenticated readiness failed.",
        error,
      );
    }
    const pause = Promise.withResolvers<void>();
    const timer = host.processEffects.setTimer(pause.resolve, HEALTH_POLL_MS);
    try {
      await pause.promise;
    } finally {
      host.processEffects.clearTimer(timer);
    }
    return waitHealthy(client, host, deadline, signal);
  }
}

/** Pins independent registered settings; never supplies an invented settings map or global policy. */
async function configureGateway(
  client: OpenShellClient,
  signal: AbortSignal,
): Promise<void> {
  const booleans = ["providers_v2_enabled", "agent_policy_proposals_enabled"];
  await booleans.reduce<Promise<unknown>>(async (previous, settingKey) => {
    await previous;
    return client.raw.updateConfig(
      {
        global: true,
        settingKey,
        settingValue: { value: { case: "boolValue", value: false } },
      },
      { signal, timeoutMs: 5000 },
    );
  }, Promise.resolve());
  await client.raw.updateConfig(
    {
      global: true,
      settingKey: "proposal_approval_mode",
      settingValue: { value: { case: "stringValue", value: "manual" } },
    },
    { signal, timeoutMs: 5000 },
  );
  const { settings } = await client.raw.getGatewayConfig(
    {},
    { signal, timeoutMs: 5000 },
  );
  if (
    !booleans.every(
      (key) =>
        settings[key]?.value.case === "boolValue" &&
        settings[key]?.value.value === false,
    )
  ) {
    throw new Error(
      "Private gateway credential policy controls did not apply.",
    );
  }
  const approval = settings["proposal_approval_mode"]?.value;
  if (approval?.case !== "stringValue" || approval.value !== "manual") {
    throw new Error("Private gateway proposal controls did not apply.");
  }
}
