import type { AcquisitionCapture, OwnedResource } from "../host/index.ts";
import { dockerCommand } from "../host/index.ts";
import type { GatewayHostContext as HostContext } from "./types.ts";

const DAEMON_ID = /^[A-Za-z0-9:-]{8,128}$/;
const NATIVE_ID = /^[a-f0-9]{64}$/;
type NetworkInspection = Readonly<
  Record<"Id" | "Name", string> &
    Partial<Record<"Labels", Readonly<Record<string, string>>>> &
    Partial<Record<"Containers", Readonly<Record<string, unknown>>>>
>;

/** Creates one labelled bridge and captures an unresolved intent before submission.
 * @returns The acknowledged ID even if cancellation arrived at completion; the caller records it before checking cancellation.
 * @throws Ownership mismatches and uncertain creation retain recovery capabilities.
 * @example const id = await createGatewayNetwork(host, { name: namespace, labels }, signal, capture)
 */
export async function createGatewayNetwork(
  host: HostContext,
  network: {
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
  },
  signal: AbortSignal,
  capture: AcquisitionCapture,
): Promise<string> {
  const { name, labels } = network;
  const daemonId = (
    await dockerCommand(host, ["info", "--format", "{{.ID}}"], signal)
  ).stdout.trim();
  if (!DAEMON_ID.test(daemonId)) {
    throw new Error("Docker daemon identity is invalid.");
  }
  const existing = await dockerCommand(
    host,
    ["network", "ls", "--filter", `name=^${name}$`, "--format", "{{.ID}}"],
    signal,
  );
  if (existing.stdout.trim().length > 0) {
    throw new Error("Private network name already exists.");
  }
  const owner = ownNetwork(host, { name, labels, daemonId }, capture);
  const args = Object.entries(labels).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
  const result = await dockerCommand(
    host,
    ["network", "create", "--driver", "bridge", ...args, name],
    signal,
  );
  const created = result.stdout.trim();
  if (!NATIVE_ID.test(created)) {
    throw new Error("Private network creation identity is unresolved.");
  }
  owner.acknowledge(created);
  return created;
}

interface NetworkIdentity {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly daemonId: string;
}

/** Resolve an unacknowledged creation only from its exact labelled network.
 * @example await recoverNetworkId(host, { name, labels, daemonId }) returns a verified native ID.
 * @throws When a uniquely labelled native network cannot be identified.
 */
async function recoverNetworkId(
  host: HostContext,
  input: NetworkIdentity,
): Promise<string> {
  const filters = Object.entries(input.labels).flatMap(([key, value]) => [
    "--filter",
    `label=${key}=${value}`,
  ]);
  const candidate = (
    await dockerCommand(host, [
      "network",
      "ls",
      "--no-trunc",
      "--filter",
      `name=^${input.name}$`,
      ...filters,
      "--format",
      "{{.ID}}",
    ])
  ).stdout.trim();
  if (!NATIVE_ID.test(candidate)) {
    throw new Error("Private network creation outcome is unresolved.");
  }
  return candidate;
}

/** Retain unresolved create intent and reconcile only the inspected immutable network ID.
 * @param host - Private gateway host and local daemon.
 * @param input - Expected native network name, labels and daemon identity.
 * @param capture - Receives the release capability before native creation.
 * @returns An acknowledgment operation binding the immutable ID to that release.
 * @throws During release if the native network cannot be proven owned.
 * @example ownNetwork(host, input, capture).acknowledge(id) binds the confirmed ID for cleanup.
 */
function ownNetwork(
  host: HostContext,
  input: NetworkIdentity,
  capture: AcquisitionCapture,
) {
  const { daemonId } = input;
  let id: string | undefined;
  let removed = false;
  const release = async () => {
    if (removed) {
      return;
    }
    const currentDaemon = (
      await dockerCommand(host, ["info", "--format", "{{.ID}}"])
    ).stdout.trim();
    if (currentDaemon !== daemonId) {
      throw new Error("Docker daemon identity changed.");
    }
    if (!id) {
      id = await recoverNetworkId(host, input);
    }
    await inspectNetwork(host, id, input);
    await dockerCommand(host, ["network", "rm", id]);
    removed = true;
  };
  const intent: OwnedResource = {
    kind: "network",
    release,
  };
  capture(intent);
  return {
    acknowledge(nativeId: string) {
      id = nativeId;
    },
  };
}

/** Reject replacement, foreign or still-attached bridges before exact-ID removal.
 * @example await inspectNetwork(host, id, input) permits only an empty matching bridge.
 */
async function inspectNetwork(
  host: HostContext,
  id: string,
  input: NetworkIdentity,
): Promise<void> {
  const parsed: unknown = JSON.parse(
    (await dockerCommand(host, ["network", "inspect", id])).stdout,
  );
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Private network identity changed.");
  }
  // biome-ignore lint/plugin/biome-rules/use-undefined: Docker network inspect JSON can contain a null entry, which must fail identity validation.
  const current = parsed[0] as Partial<NetworkInspection> | null;
  const observedLabels = current?.Labels;
  if (
    !current ||
    current.Id !== id ||
    current.Name !== input.name ||
    !observedLabels ||
    !Object.entries(input.labels).every(
      ([key, value]) => observedLabels[key] === value,
    )
  ) {
    throw new Error("Private network identity changed.");
  }
  if (
    !current.Containers ||
    typeof current.Containers !== "object" ||
    Array.isArray(current.Containers) ||
    Object.keys(current.Containers).length > 0
  ) {
    throw new Error("Private network still contains workloads.");
  }
}
