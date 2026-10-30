import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import filesystem from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import process from "node:process";
import { defaultProcessEffects, runHostProcess } from "./process.ts";
import type { HostContext } from "./types.ts";

export interface HostCaptureEffects {
  readonly homedir: () => string;
  readonly ["randomUUID"]: () => string;
  readonly process: Pick<typeof process, "env" | "platform" | "arch"> & {
    readonly getuid?: (() => number) | undefined;
  };
  readonly filesystem: HostContext["filesystem"];
  readonly processEffects: HostContext["processEffects"];
}

/** Captures operational host facts without copying credential-bearing variables.
 * This performs no resource discovery, creation, or previous-runtime inspection.
 * @param effects Host fact readers and adapters retained by the returned context.
 * @returns An immutable activation snapshot; no resources are acquired.
 * @example captureHostContext() assigns a new unpredictable activation identity.
 */
export function captureHostContext(
  effects: HostCaptureEffects = {
    homedir,
    ["randomUUID"]: randomUUID,
    process,
    filesystem,
    processEffects: defaultProcessEffects,
  },
): HostContext {
  const hostProcess = effects.process;
  const home = effects.homedir();
  const stateRoot =
    hostProcess.platform === "darwin"
      ? join(home, "Library", "Application Support", "pi-openshell-sandbox")
      : join(home, ".local", "state", "pi-openshell-sandbox");
  const environment: Record<string, string> = {};
  environment["HOME"] = home;
  environment["PATH"] =
    hostProcess.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin";
  for (const name of [
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ]) {
    const value = hostProcess.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  const dockerEndpoint =
    hostProcess.env["DOCKER_HOST"] ?? "unix:///var/run/docker.sock";
  return Object.freeze({
    instanceId: effects["randomUUID"](),
    platform: hostProcess.platform,
    architecture: hostProcess.arch,
    uid: hostProcess.getuid?.() ?? -1,
    paths: Object.freeze({
      home,
      sshDirectory: join(home, ".ssh"),
      dockerSocket: dockerEndpoint.startsWith("unix://")
        ? dockerEndpoint.slice("unix://".length)
        : "/var/run/docker.sock",
      stateRoot,
    }),
    dockerEndpoint,
    dockerExecutable: "docker",
    gatewayExecutable: "openshell-gateway",
    environment: Object.freeze(environment),
    filesystem: effects.filesystem,
    processEffects: effects.processEffects,
  });
}

/** Resolves the active Docker context without allowing remote daemon access.
 * @throws An actionable prerequisite error when context discovery is unavailable.
 * @example A desktop-linux context resolves to its local Unix socket, not a default guess.
 */
export async function resolveDockerHost(
  host: HostContext,
  signal: AbortSignal,
): Promise<HostContext> {
  const dockerContext = host.environment["DOCKER_CONTEXT"];
  if (host.environment["DOCKER_HOST"] && !dockerContext) {
    if (!host.dockerEndpoint.startsWith("unix:///")) {
      throw new Error("OpenShell requires a local Unix Docker socket.");
    }
    return host;
  }
  const result = await runHostProcess(
    host.dockerExecutable,
    [
      "context",
      "inspect",
      ...(dockerContext ? [dockerContext] : []),
      "--format",
      "{{json .Endpoints.docker.Host}}",
    ],
    {
      environment: host.environment,
      mode: "finite",
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      signal,
    },
    host.processEffects,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      "OpenShell requires a working local Docker context; start Docker and check WSL integration.",
    );
  }
  const endpoint: unknown = JSON.parse(result.stdout);
  if (typeof endpoint !== "string" || !endpoint.startsWith("unix:///")) {
    throw new Error(
      "OpenShell supports a local Unix Docker socket, not a remote Docker context.",
    );
  }
  return Object.freeze({
    ...host,
    dockerEndpoint: endpoint,
    paths: Object.freeze({
      ...host.paths,
      dockerSocket: endpoint.slice("unix://".length),
    }),
  });
}

/** Resolves the canonical executable before launching an owned private gateway.
 * @param host - Captured host with the selected PATH and filesystem.
 * @returns A host with an executable proven to be a canonical file.
 * @throws If no executable can be verified on PATH.
 * @example await withGatewayExecutable(host) returns a host whose gatewayExecutable is absolute.
 */
export async function withGatewayExecutable(
  host: HostContext,
): Promise<HostContext> {
  const { PATH: path = "" } = host.environment;
  const directories = Object.hasOwn(host.environment, "PATH")
    ? path.split(delimiter)
    : [];
  const executable = await findGatewayExecutable(host, directories, 0);
  if (executable) {
    return Object.freeze({ ...host, gatewayExecutable: executable });
  }
  const safeMessage =
    "OpenShell preparation requires the native openshell-gateway 0.0.116 executable on PATH. Install it using the official native installation guide, then /reload.";
  throw Object.assign(new Error(safeMessage), { safeMessage });
}

/** Preserves PATH precedence without parallel races or inherited executable names in ownership. */
async function findGatewayExecutable(
  host: HostContext,
  directories: readonly string[],
  index: number,
): Promise<string | undefined> {
  const directory = directories[index];
  if (directory === undefined) {
    return undefined;
  }
  try {
    const candidate = await host.filesystem.realpath(
      resolve(directory || ".", "openshell-gateway"),
    );
    await host.filesystem.access(candidate, constants.X_OK);
    if ((await host.filesystem.stat(candidate)).isFile()) {
      return candidate;
    }
  } catch {
    /* Missing and inaccessible PATH entries are not executable candidates. */
  }
  return findGatewayExecutable(host, directories, index + 1);
}
