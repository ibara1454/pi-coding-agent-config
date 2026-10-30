import process from "node:process";
import type { AcquisitionCapture } from "../host/index.ts";
import {
  HostProcessError,
  nativeFailure,
  runHostProcess,
} from "../host/index.ts";
import { connectGateway, reserveGatewayPort } from "./client.ts";
import { prepareGatewayTls, writeGatewayConfig } from "./config.ts";
import { createGatewayNetwork } from "./network.ts";
import { launchGateway } from "./process.ts";
import { createGatewayState, type GatewayState } from "./state.ts";
import type {
  GatewayRecoveryCoordinates,
  GatewayHostContext as HostContext,
  ManagedGateway,
} from "./types.ts";

const MIN_NODE_MAJOR = 22;
const NATIVE_VERSION = /\b0\.0\.116\b/;

/** Capture an uncertain child before bounded cleanup and redact native errors at the gateway boundary.
 * @param state - Owned gateway state if allocation succeeded.
 * @param capture - Receives an uncertain pre-state child when no state exists.
 * @param error - Native error to sanitize after retryable resources are retained.
 * @throws Always rejects with an observable sanitized preparation failure.
 * @example await recoverGatewayPreparation(undefined, capture, new Error("secret")) rejects with a safe message.
 */
async function recoverGatewayPreparation(
  state: GatewayState | undefined,
  capture: AcquisitionCapture,
  error: unknown,
): Promise<never> {
  if (error instanceof HostProcessError && error.process) {
    const retained = error.process;
    (state?.capture ?? capture)({
      kind: "process",
      release: retained.terminate,
    });
  }
  if (state) {
    try {
      await state.close();
    } catch (cleanupError) {
      throw nativeFailure(
        "Private OpenShell gateway preparation failed; owned recovery resources were retained.",
        cleanupError,
      );
    }
  }
  throw nativeFailure(
    "Private OpenShell gateway preparation failed. Check the pinned native prerequisite, Docker endpoint, and private state permissions.",
    error,
  );
}

/** Creates one private pinned native gateway; never discovers or adopts a default gateway.
 * Callers transfer the complete captured gateway group only after provider preparation.
 * close must only be called after independently proving sandbox termination.
 * @param host - Pinned host identity and private acquisition effects.
 * @param signal - Cancels startup without transferring incomplete resources.
 * @param capture - Retains release capabilities before later acquisition stages can fail.
 * @param reportCoordinates - Receives frozen snapshots of known recovery facts, without ownership transfer.
 * @returns A complete authenticated handle; coordinate publication alone transfers no ownership.
 * @throws A sanitized required-operation failure; uncertain resources remain captured.
 * @example const gateway = await startPrivateGateway(host, signal, capture, reportCoordinates)
 */
export async function startPrivateGateway(
  host: HostContext,
  signal: AbortSignal,
  capture: AcquisitionCapture,
  reportCoordinates: (coordinates: GatewayRecoveryCoordinates) => void,
): Promise<ManagedGateway> {
  let state: GatewayState | undefined;
  try {
    signal.throwIfAborted();
    if (
      !(
        ["linux", "darwin"].includes(host.platform) &&
        ["x64", "arm64"].includes(host.architecture)
      )
    ) {
      throw new Error("Unsupported host platform.");
    }
    if (Number(process.versions.node.split(".")[0]) < MIN_NODE_MAJOR) {
      throw new Error("OpenShell requires Node 22 or newer.");
    }
    const version = await runHostProcess(
      host.gatewayExecutable,
      ["--version"],
      {
        environment: host.environment,
        mode: "finite",
        timeoutMs: 5000,
        signal,
      },
      host.processEffects,
    );
    if (version.exitCode !== 0 || !NATIVE_VERSION.test(version.stdout)) {
      throw new Error("OpenShell native release must be 0.0.116.");
    }
    state = await createGatewayState(host, capture, reportCoordinates);
    return await prepareGateway(host, state, signal, reportCoordinates);
  } catch (error) {
    return recoverGatewayPreparation(state, capture, error);
  }
}

/** Allocate the exact private labelled network; native OpenShell owns supervisor resolution.
 * @param host - Private host identity and local Docker effects.
 * @param state - Captures network ownership before creation for retryable cleanup.
 * @param signal - Cancels native network acquisition.
 * @returns Private namespace, immutable labels, and exact network identity.
 * @throws On failed or unprovable network acquisition, retaining captured resources.
 * @example await prepareGatewayInfrastructure(host, state, signal) returns isolated IDs.
 */
async function prepareGatewayInfrastructure(
  host: HostContext,
  state: GatewayState,
  signal: AbortSignal,
) {
  const namespace = `pi-openshell-${host.instanceId}`;
  const labels = Object.freeze({
    "io.pi.openshell-sandbox.managed-by": "pi-openshell-sandbox",
    "io.pi.openshell-sandbox.owner-uid": String(host.uid),
    "io.pi.openshell-sandbox.instance-id": host.instanceId,
  });
  const networkId = await createGatewayNetwork(
    host,
    { name: namespace, labels },
    signal,
    state.capture,
  );
  return { namespace, labels, networkId };
}

/** Configure, launch and authenticate one owned gateway after its state is captured.
 * @param host - Native gateway, Docker, filesystem, and readiness effects.
 * @param state - Owns network, process, and private configuration cleanup.
 * @param signal - Cancels preparation without shortening a transferred gateway's lifetime.
 * @param reportCoordinates - Publishes known coordinates before later startup stages can fail.
 * @returns An authenticated gateway using native supervisor defaults.
 * @throws On required configuration, startup, or readiness failure; the caller owns recovery.
 * @example await prepareGateway(host, state, signal, reportCoordinates) returns a complete transferable handle.
 */
async function prepareGateway(
  host: HostContext,
  state: GatewayState,
  signal: AbortSignal,
  reportCoordinates: (coordinates: GatewayRecoveryCoordinates) => void,
): Promise<ManagedGateway> {
  const scopedHost: HostContext = { ...host, environment: state.environment };
  const { namespace, labels, networkId } = await prepareGatewayInfrastructure(
    scopedHost,
    state,
    signal,
  );
  const coordinates = Object.freeze({
    tlsDirectory: state.tlsDirectory,
    networkId,
  });
  reportCoordinates(coordinates);
  signal.throwIfAborted();
  const tls = await prepareGatewayTls(scopedHost, state, signal);
  const port = await (host.gatewayEffects?.reservePort ?? reserveGatewayPort)();
  const endpoint = `https://127.0.0.1:${port}`;
  reportCoordinates(
    Object.freeze({ ...coordinates, gatewayEndpoint: endpoint }),
  );
  const configPath = await writeGatewayConfig(scopedHost, state, {
    namespace,
    port,
  });
  const processHandle = await launchGateway(
    scopedHost,
    state,
    configPath,
    signal,
  );
  const client = await connectGateway(
    scopedHost,
    { endpoint, tls },
    processHandle,
    signal,
  );
  signal.throwIfAborted();
  return Object.freeze({
    client,
    endpoint,
    instanceId: host.instanceId,
    networkId,
    tlsDirectory: state.tlsDirectory,
    labels,
    signal,
    close: state.close,
  });
}
