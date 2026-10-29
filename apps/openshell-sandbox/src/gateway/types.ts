import type { OpenShellClient } from "@nvidia/openshell-sdk";
import type { HostContext } from "../host/index.ts";

/** Host facts plus gateway-owned connection effects; captured facts remain unchanged.
 * Omitting effects uses native SDK connection and candidate-port reservation.
 * @example const gatewayHost: GatewayHostContext = { ...host, gatewayEffects: { connect, reservePort } };
 */
export interface GatewayHostContext extends HostContext {
  readonly gatewayEffects?: {
    readonly connect: typeof OpenShellClient.connect;
    readonly reservePort: () => Promise<number>;
  };
}

/** Non-owning recovery facts published as acquisition stages complete; absent facts remain unknown. */
export type GatewayRecoveryCoordinates = Readonly<{
  gatewayEndpoint?: string;
  tlsDirectory?: string;
  networkId?: string;
}>;

/** Gateway ownership transfers only as a complete group; close requires prior workload termination. */
export interface ManagedGateway {
  readonly client: OpenShellClient;
  readonly endpoint: string;
  readonly instanceId: string;
  readonly networkId: string;
  readonly tlsDirectory: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly close: () => Promise<void>;
}
