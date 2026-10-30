import type { Stats } from "node:fs";
import { join } from "node:path";
import type { AcquisitionCapture, OwnedResource } from "../host/index.ts";
import { HostProcessError, nativeFailure } from "../host/index.ts";
import type {
  GatewayRecoveryCoordinates,
  GatewayHostContext as HostContext,
} from "./types.ts";

const OWNER_DIR_MODE = 0o700;
const PUBLIC_MODE_BITS = 0o077;
const RELEASE_PRIORITY: Readonly<Record<string, number>> = {
  process: 4,
  network: 1,
  state: 0,
};

export interface GatewayState {
  readonly directory: string;
  readonly tlsDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly capture: AcquisitionCapture;
  readonly close: () => Promise<void>;
}

/** Allocates owner-only operational state; later acquisitions fence directory removal.
 * @param host - Captured randomUUID identity and owner-scoped filesystem capabilities.
 * @param reportCoordinates - Publishes non-owning recovery facts after capture, before identity readback.
 * @example const state = await createGatewayState(host, capture, reportCoordinates)
 * @throws On unsafe enclosing directories or failed allocation; never adopts old state.
 */
export async function createGatewayState(
  host: HostContext,
  capture: AcquisitionCapture,
  reportCoordinates: (coordinates: GatewayRecoveryCoordinates) => void,
): Promise<GatewayState> {
  const fs = host.filesystem;
  await fs.mkdir(host.paths.stateRoot, {
    recursive: true,
    mode: OWNER_DIR_MODE,
  });
  const root = await fs.lstat(host.paths.stateRoot);
  if (
    !root.isDirectory() ||
    root.uid !== host.uid ||
    (root.mode & PUBLIC_MODE_BITS) !== 0
  ) {
    throw new Error("Private state root must be owner-only.");
  }
  const directory = join(
    host.paths.stateRoot,
    `pi-openshell-${host.instanceId}`,
  );
  await fs.mkdir(directory, { mode: OWNER_DIR_MODE });
  const ownership = await ownGatewayState(
    host,
    directory,
    capture,
    reportCoordinates,
  );
  const environment: Record<string, string> = {
    ["PATH"]: host.environment["PATH"] || "/usr/local/bin:/usr/bin:/bin",
    ["LANG"]: "C.UTF-8",
  };
  try {
    await (
      [
        ["HOME", "home"],
        ["XDG_CONFIG_HOME", "config"],
        ["XDG_STATE_HOME", "state"],
        ["XDG_DATA_HOME", "data"],
        ["XDG_CACHE_HOME", "cache"],
        ["XDG_RUNTIME_DIR", "run"],
      ] as const
    ).reduce<Promise<void>>(async (previous, [key, leaf]) => {
      await previous;
      const path = join(directory, leaf);
      environment[key] = path;
      await fs.mkdir(path, { mode: OWNER_DIR_MODE });
    }, Promise.resolve());
  } catch (error) {
    throw nativeFailure("Private gateway directory preparation failed.", error);
  }
  return {
    directory,
    tlsDirectory: ownership.tlsDirectory,
    environment: Object.freeze(environment),
    capture: ownership.capture,
    close: ownership.close,
  };
}

/** Retain every release capability until its exact cleanup succeeds, including late failed children.
 * @param resource - Native release capability whose closure validates native identity.
 * @param pending - State-owned capabilities still awaiting confirmed release.
 * @param capture - Reports the frozen capability for partial-failure recovery.
 * @throws During release when cleanup is uncertain; the capability remains pending.
 * @example wrapResource(resource, pending, capture) keeps uncertain resources available for retry.
 */
function wrapResource(
  resource: OwnedResource,
  pending: Set<OwnedResource>,
  capture: AcquisitionCapture,
): void {
  const owned: OwnedResource = Object.freeze({
    ...resource,
    release: async () => {
      try {
        await resource.release();
        pending.delete(owned);
      } catch (error) {
        if (error instanceof HostProcessError && error.process) {
          const child = error.process;
          wrapResource(
            {
              kind: "process",
              release: child.terminate,
            },
            pending,
            capture,
          );
        }
        throw nativeFailure(
          "Private gateway resource cleanup could not be confirmed.",
          error,
        );
      }
    },
  });
  pending.add(owned);
  capture(owned);
}

/** Fence state deletion behind every captured gateway resource and exact file identity.
 * @param reportCoordinates - Receives the known TLS path even if initial identity readback fails.
 * @returns Captured ownership and its published TLS directory.
 * @throws On failed identity readback, retaining state without deletion authority.
 * @example await ownGatewayState(host, path, capture, reportCoordinates) publishes captured state.
 */
async function ownGatewayState(
  host: HostContext,
  directory: string,
  capture: AcquisitionCapture,
  reportCoordinates: (coordinates: GatewayRecoveryCoordinates) => void,
) {
  const pending = new Set<OwnedResource>();
  let identity: Stats | undefined;
  let removed = false;
  const release = async () => {
    if (removed) {
      return;
    }
    if (
      !identity ||
      [...pending].some((resource) => resource.kind !== "state")
    ) {
      throw new Error(
        "Private gateway state is retained for unresolved resources.",
      );
    }
    const current = await host.filesystem.lstat(directory);
    if (
      !current.isDirectory() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.uid !== host.uid
    ) {
      throw new Error("Private gateway state identity changed.");
    }
    await host.filesystem.rm(directory, { recursive: true });
    removed = true;
  };
  const own = (resource: OwnedResource) =>
    wrapResource(resource, pending, capture);
  own({
    kind: "state",
    release,
  });
  const tlsDirectory = join(directory, "tls");
  reportCoordinates(Object.freeze({ tlsDirectory }));
  identity = await host.filesystem.lstat(directory);
  return { tlsDirectory, capture: own, close: () => releasePending(pending) };
}

/** Release processes before the network, then state, including late captured cleanup children.
 * @param pending - State-owned release capabilities awaiting confirmed cleanup.
 * @throws When cleanup cannot be confirmed, retaining remaining resources for retry.
 * @example await releasePending(pending) removes state only after processes and network.
 */
async function releasePending(pending: Set<OwnedResource>): Promise<void> {
  let next: OwnedResource | undefined;
  let highest = Number.NEGATIVE_INFINITY;
  for (const resource of pending) {
    const priority = RELEASE_PRIORITY[resource.kind] ?? 2;
    if (priority > highest) {
      next = resource;
      highest = priority;
    }
  }
  if (!next) {
    return;
  }
  await next.release();
  return releasePending(pending);
}
