import { mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import type { ObjectEncodingOptions } from "node:fs";
import type * as fs from "node:fs/promises";
import type { Server } from "node:net";
import net from "node:net";
import type { HostCaptureEffects } from "../../host/index.ts";
import type { RuntimeFixture } from "../../runtime/test/index.helper.ts";
import { unitRuntimeFixture } from "../../runtime/test/index.helper.ts";
import type { PiNativeCapabilities } from "../native-capabilities.ts";

const fixtureUid = 1000;
const fixturePort = 43_123;
const sdkCapabilities = await import("@nvidia/openshell-sdk");
// Gateway port allocation stays real; only its native socket constructor is replaced.
const socketCapabilities = await import("node:net");

type ReadPath = Parameters<typeof fs.readFile>[0];
type ReadOptions = Parameters<typeof fs.readFile>[1];
type TextReadOptions =
  | BufferEncoding
  | (Extract<ReadOptions, object> & { encoding: BufferEncoding });
type BufferReadOptions =
  | Exclude<ReadOptions, string | object>
  | (Extract<ReadOptions, object> & {
      encoding?: Exclude<ObjectEncodingOptions["encoding"], BufferEncoding>;
    });

/** Supplies fixture bytes or decoded text with the native readFile overload contract.
 * Unknown paths use the supplied in-memory fallback, or reject without host I/O.
 * @example nativeTextReader(() => "hello")("/fixture", "utf8") resolves to "hello".
 */
export function nativeTextReader(
  selectText: (path: string) => string | undefined,
  fallback?: (
    path: ReadPath,
    options?: ReadOptions,
  ) => Promise<string | Buffer<ArrayBuffer>>,
) {
  /** Preserves encoding-dependent native results without accessing real host files.
   * @example readFile("/fixture", "utf8") resolves to fixture text rather than bytes.
   */
  function readFile(
    path: ReadPath,
    options?: BufferReadOptions,
  ): Promise<Buffer<ArrayBuffer>>;
  function readFile(path: ReadPath, options: TextReadOptions): Promise<string>;
  function readFile(
    path: ReadPath,
    options?: ReadOptions,
  ): Promise<string | Buffer<ArrayBuffer>>;
  function readFile(path: ReadPath, options?: ReadOptions) {
    const name = String(path);
    const text = selectText(name);
    if (text === undefined) {
      return fallback
        ? fallback(path, options)
        : Promise.reject(
            new Error(`Unexpected native filesystem read: ${name}`),
          );
    }
    const bytes = Buffer.from(text);
    const encoding = typeof options === "string" ? options : options?.encoding;
    return Promise.resolve(encoding ? bytes.toString(encoding) : bytes);
  }
  return readFile;
}

/** Intercepts executable access while keeping all operational reads in fixture storage.
 * @example An unexpected native path read still fails through runtime's in-memory filesystem.
 */
function nativeFilesystem(runtime: RuntimeFixture) {
  const access = mock(() => Promise.resolve());
  return {
    filesystem: { ...runtime.filesystem.filesystem, access },
    access,
  };
}

/** Fake native TCP listener; real gateway port allocation owns its close lifecycle.
 * @example reserveGatewayPort's real listener protocol receives fixturePort and closes once.
 */
function gatewayListener() {
  const listener = new EventEmitter() as Server;
  return Object.assign(listener, {
    listen: (_port: number, _host: string, callback: () => void) => {
      callback();
      return listener;
    },
    address: () => ({
      address: "127.0.0.1",
      family: "IPv4",
      port: fixturePort,
    }),
    close: (callback: (error?: Error) => void) => {
      callback();
      return listener;
    },
  });
}

/** Captures fresh fixture identity per host acquisition without replacing host policy.
 * @example two captureHostContext(capture) calls receive distinct instance ids.
 */
function captureCapabilities(runtime: RuntimeFixture) {
  let identity = 0;
  return {
    homedir: mock(() => "/home/person"),
    ["randomUUID"]: () => {
      identity += 1;
      return `fixture-instance-${identity}`;
    },
    process: {
      env: {
        ["PATH"]: "/fixture/bin",
        ["DOCKER_HOST"]: "unix:///run/docker.sock",
      },
      platform: "linux",
      arch: "x64",
      getuid: () => fixtureUid,
    },
    filesystem: runtime.filesystem.filesystem,
    processEffects: runtime.effects.host.processEffects,
  } satisfies HostCaptureEffects;
}

/** Supplies controlled host capture, runtime effects, SDK client, and gateway socket.
 * Restore spies after disposing any activation that uses this fixture.
 * @returns The native capabilities and test-owned effects used by Pi activation.
 * @example piNativeFixture().native.capture supplies a fresh identity per activation.
 */
export function piNativeFixture() {
  const runtime = unitRuntimeFixture();
  const capture = captureCapabilities(runtime);
  const files = nativeFilesystem(runtime);
  capture.filesystem = files.filesystem;
  runtime.filesystem.files.set(
    "/fixture/bin/openshell-gateway",
    "native executable",
  );
  const connect = spyOn(
    sdkCapabilities.OpenShellClient,
    "connect",
  ).mockImplementation(() => Promise.resolve(runtime.sdk.client));
  const listener = spyOn(socketCapabilities, "createServer").mockImplementation(
    gatewayListener,
  );
  const defaultListener =
    net.createServer === listener
      ? undefined
      : spyOn(net, "createServer").mockImplementation(gatewayListener);
  const native: PiNativeCapabilities = {
    capture,
    runtime: {
      execution: {
        credentialSource: runtime.effects.credentialSource,
        randomBytes: runtime.effects.randomBytes,
        setTimer: runtime.effects.setTimer,
        clearTimer: runtime.effects.clearTimer,
      },
    },
  };
  return {
    runtime,
    native,
    capture,
    filesystem: files.filesystem,
    nativeAccess: files.access,
    captureHome: capture.homedir,
    restore: () => {
      defaultListener?.mockRestore();
      listener.mockRestore();
      connect.mockRestore();
      runtime.clock.restore();
    },
  };
}
