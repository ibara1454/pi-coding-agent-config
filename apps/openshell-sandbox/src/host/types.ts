import type * as filesystem from "node:fs/promises";
import type { ProcessEffects } from "./process-types.ts";

export interface HostPaths {
  readonly home: string;
  readonly sshDirectory: string;
  readonly dockerSocket: string;
  readonly stateRoot: string;
}

/** Captured operational host facts; never spread the credential-bearing environment. */
export interface HostContext {
  readonly instanceId: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly uid: number;
  readonly paths: HostPaths;
  readonly dockerEndpoint: string;
  readonly dockerExecutable: string;
  readonly gatewayExecutable: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly filesystem: typeof filesystem;
  readonly processEffects: ProcessEffects;
}

/** A capability retained until its exact native acquisition is proved released. */
export interface OwnedResource {
  readonly kind: string;
  readonly release: () => Promise<void>;
}
export type AcquisitionCapture = (resource: OwnedResource) => void;
