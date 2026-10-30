import { createPrivateKey, X509Certificate } from "node:crypto";
import { join } from "node:path";
import { runHostProcess } from "../host/index.ts";
import type { GatewayState } from "./state.ts";
import type { GatewayHostContext as HostContext } from "./types.ts";

const OWNER_DIR_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const MAX_TLS_BYTES = 65_536;

const GATEWAY_SANS = [
  "localhost",
  "127.0.0.1",
  "host.openshell.internal",
] as const;
export interface GatewayTls {
  readonly caCert: Buffer;
  readonly clientCert: Buffer;
  readonly clientKey: Buffer;
}

/** Generate native credentials, verify mTLS, and enforce owner-only credential files.
 * Native OpenShell validates JWT keys when it starts; this operation only checks their files.
 * @param host - Owner identity, filesystem, and native process effects.
 * @param state - Private output directory and isolated native environment.
 * @param signal - Cancels certificate generation.
 * @returns Verified mTLS client credentials, not JWT key contents.
 * @throws On native generation failure, invalid mTLS, or incomplete or unowned files.
 * @example const tls = await prepareGatewayTls(host, state, signal); // tls.clientCert is a Buffer
 */
export async function prepareGatewayTls(
  host: HostContext,
  state: GatewayState,
  signal: AbortSignal,
): Promise<GatewayTls> {
  const result = await runHostProcess(
    host.gatewayExecutable,
    [
      "generate-certs",
      "--output-dir",
      state.tlsDirectory,
      ...GATEWAY_SANS.flatMap((san) => ["--server-san", san]),
    ],
    {
      environment: state.environment,
      mode: "finite",
      timeoutMs: 15_000,
      signal,
    },
    host.processEffects,
  );
  if (result.exitCode !== 0) {
    throw new Error("Private gateway certificate generation failed.");
  }
  return verifyTlsMaterial(await readTlsMaterial(host, state));
}

/** Enforce ownership, type, size, and owner-only modes for all eight native files.
 * @param host - Owner identity and filesystem.
 * @param state - Private native credential directory.
 * @returns Buffers for only the five mTLS files, in verification order.
 * @throws On missing, unowned, incorrectly typed, or oversized material.
 * @example await readTlsMaterial(host, state) // [ca, server cert/key, client cert/key]
 */
async function readTlsMaterial(
  host: HostContext,
  state: GatewayState,
): Promise<Buffer[]> {
  const files = [
    "ca.crt",
    "server/tls.crt",
    "server/tls.key",
    "client/tls.crt",
    "client/tls.key",
    "jwt/signing.pem",
    "jwt/public.pem",
    "jwt/kid",
  ];
  await ["", "server", "client", "jwt"].reduce<Promise<void>>(
    async (previous, leaf) => {
      await previous;
      const path = join(state.tlsDirectory, leaf);
      const info = await host.filesystem.lstat(path);
      if (!info.isDirectory() || info.uid !== host.uid) {
        throw new Error("Private TLS directory is invalid.");
      }
      await host.filesystem.chmod(path, OWNER_DIR_MODE);
    },
    Promise.resolve(),
  );
  const material: Buffer[] = [];
  await files.reduce<Promise<void>>(async (previous, leaf) => {
    await previous;
    const path = join(state.tlsDirectory, leaf);
    const info = await host.filesystem.lstat(path);
    if (
      !info.isFile() ||
      info.uid !== host.uid ||
      info.size <= 0 ||
      info.size > MAX_TLS_BYTES
    ) {
      throw new Error("Private TLS material is incomplete.");
    }
    await host.filesystem.chmod(path, OWNER_FILE_MODE);
    if (!leaf.startsWith("jwt/")) {
      material.push(await host.filesystem.readFile(path));
    }
  }, Promise.resolve());
  return material;
}

/** Verify native mTLS CA, leaf key pairs, and callback SANs.
 * @param material - Five mTLS buffers in native file order; never JWT key data.
 * @returns CA certificate and client certificate/private key for SDK mTLS.
 * @throws On invalid certificates, chains, key pairs, or required SANs.
 * @example verifyTlsMaterial(material).clientCert // verified client certificate
 */
function verifyTlsMaterial(material: Buffer[]): GatewayTls {
  const [caCert, serverCert, serverKey, clientCert, clientKey] = material;
  if (!(caCert && serverCert && serverKey && clientCert && clientKey)) {
    throw new Error("Private TLS bundle is incomplete.");
  }
  const ca = new X509Certificate(caCert);
  const server = new X509Certificate(serverCert);
  const client = new X509Certificate(clientCert);
  if (
    !(
      ca.ca &&
      server.verify(ca.publicKey) &&
      client.verify(ca.publicKey) &&
      server.checkPrivateKey(createPrivateKey(serverKey)) &&
      client.checkPrivateKey(createPrivateKey(clientKey))
    )
  ) {
    throw new Error("Private TLS certificate chain or keys are invalid.");
  }
  if (
    !(
      server.checkIP("127.0.0.1") &&
      server.checkHost("localhost") &&
      server.checkHost("host.openshell.internal")
    )
  ) {
    throw new Error("Private TLS certificate SANs are incomplete.");
  }
  return { caCert, clientCert, clientKey };
}

/** Writes native operational configuration, never provider secrets or a second user policy.
 * Supervisor resolution uses native defaults; no binary or image override is emitted.
 * @param host - Validated local Docker endpoint and filesystem owning the configuration write.
 * @param state - Private gateway state and verified TLS directory.
 * @param config - Private namespace and reserved loopback port.
 * @returns Path to the newly written owner-only native configuration.
 * @throws On a failed exclusive configuration write.
 * @example await writeGatewayConfig(host, state, { namespace, port })
 */
export async function writeGatewayConfig(
  host: HostContext,
  state: GatewayState,
  config: {
    readonly namespace: string;
    readonly port: number;
  },
): Promise<string> {
  const { namespace, port } = config;
  const q = JSON.stringify;
  const tls = state.tlsDirectory;
  const content = `[openshell]\nversion = 1
[openshell.gateway]
name = ${q(namespace)}
bind_address = ${q(`127.0.0.1:${port}`)}
compute_drivers = ["docker"]
log_level = "warn"
enable_loopback_service_http = false
server_sans = ${q(GATEWAY_SANS)}
[openshell.gateway.tls]
cert_path = ${q(join(tls, "server/tls.crt"))}
key_path = ${q(join(tls, "server/tls.key"))}
client_ca_path = ${q(join(tls, "ca.crt"))}
[openshell.gateway.mtls_auth]
enabled = true
[openshell.gateway.auth]
allow_unauthenticated_users = false
[openshell.gateway.gateway_jwt]
signing_key_path = ${q(join(tls, "jwt/signing.pem"))}
public_key_path = ${q(join(tls, "jwt/public.pem"))}
kid_path = ${q(join(tls, "jwt/kid"))}
gateway_id = ${q(namespace)}
[openshell.drivers.docker]
socket_path = ${q(host.dockerEndpoint.slice("unix://".length))}
sandbox_namespace = ${q(namespace)}
network_name = ${q(namespace)}
grpc_endpoint = ${q(`https://host.openshell.internal:${port}`)}
enable_bind_mounts = true
guest_tls_ca = ${q(join(tls, "ca.crt"))}
guest_tls_cert = ${q(join(tls, "client/tls.crt"))}
guest_tls_key = ${q(join(tls, "client/tls.key"))}
`;
  const path = join(state.directory, "gateway.toml");
  await host.filesystem.writeFile(path, content, { mode: 0o600, flag: "wx" });
  return path;
}
