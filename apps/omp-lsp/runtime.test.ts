import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
// biome-ignore lint/performance/noNamespaceImport: Bun spies must intercept and restore the runtime's live filesystem imports.
import * as fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type {
  Diagnostic,
  ServerCapabilities,
} from "vscode-languageserver-protocol";

// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace to intercept and restore consumers.
import * as processes from "./process.ts";
import { LanguageServerPool } from "./runtime.ts";
import type { ServerConfig } from "./types.ts";

const resources: Array<{
  pool: LanguageServerPool;
  peer: MessageConnection;
  release: () => void;
}> = [];

/**
 * Creates a controllable in-memory server with restorable process spies.
 * Options control initialization and capabilities; afterEach owns disposal.
 * @example fixture({ holdInitialize: true }).release() // Allows initialization to finish.
 */
function fixture(
  options: { holdInitialize?: boolean; capabilities?: ServerCapabilities } = {},
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child: Pick<
    ChildProcessWithoutNullStreams,
    "stdin" | "stdout" | "stderr" | "pid" | "signalCode"
  > &
    EventEmitter & { exitCode: number | null } = Object.assign(
    new EventEmitter(),
    {
      stdin,
      stdout,
      stderr,
      pid: 12345,
      exitCode: null as number | null,
      signalCode: null,
    },
  );
  const peer = createMessageConnection(
    new StreamMessageReader(stdin),
    new StreamMessageWriter(stdout),
  );
  const { promise: initializing, resolve: started } =
    Promise.withResolvers<void>();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const capabilities: ServerCapabilities = options.capabilities ?? {
    textDocumentSync: { openClose: true, change: 2, save: true },
  };
  peer.onRequest("initialize", async () => {
    started();
    if (options.holdInitialize) {
      await gate;
    }
    return { capabilities };
  });
  peer.onRequest("shutdown", () => null);
  peer.onRequest("test/echo", (value: unknown) => value);
  peer.onNotification("exit", () => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  peer.listen();
  const spawn = spyOn(processes, "spawnProcess").mockReturnValue(
    child as ChildProcessWithoutNullStreams,
  );
  const stop = spyOn(processes, "stopProcess").mockImplementation(() => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    return Promise.resolve();
  });
  const pool = new LanguageServerPool({
    cwd: "/project",
    onApplyEdit: async () => ({ applied: false }),
  });
  const config: ServerConfig = {
    name: "test-server",
    command: "test-server",
    args: [],
    root: "/project",
    fileTypes: [".ts"],
    rootMarkers: [],
  };
  resources.push({ pool, peer, release });
  return {
    pool,
    peer,
    config,
    spawn,
    stop,
    initializing,
    release,
    output: stdout,
  };
}

afterEach(async () => {
  try {
    for (const resource of resources.splice(0)) {
      resource.release();
      await resource.pool.dispose();
      resource.peer.dispose();
    }
  } finally {
    mock.restore();
  }
});

describe("LanguageServerPool.get", () => {
  test("should keep shared startup usable when one waiting caller cancels", async () => {
    const server = fixture({ holdInitialize: true });
    const controller = new AbortController();
    const first = server.pool.get(server.config, controller.signal);
    const reason = new Error("caller canceled");
    const canceled = first.catch((error: unknown) => error);
    const second = server.pool.get(server.config);
    await server.initializing;
    controller.abort(reason);
    server.release();
    expect(await canceled).toBe(reason);
    const client = await second;
    expect(
      await client.request<{ value: number }>("test/echo", { value: 42 }),
    ).toEqual({ value: 42 });
    expect(server.spawn).toHaveBeenCalledTimes(1);
    expect(server.stop).not.toHaveBeenCalled();
  });

  test.each([
    ["an oversized header", "x".repeat(16 * 1024 + 1), "header"],
    ["an oversized message", "Content-Length: 999999999\r\n\r\n", "message"],
  ])(
    "should reject %s before buffering its body",
    async (_label, bytes, error) => {
      const server = fixture({ holdInitialize: true });
      const pending = server.pool.get(server.config, AbortSignal.timeout(200));
      const rejected = pending.catch((failure: unknown) => failure);
      await server.initializing;
      server.output.write(bytes);
      expect(await rejected).toMatchObject({
        message: expect.stringContaining(error),
      });
    },
  );
});

describe("LanguageServerPool.dispose", () => {
  test("should reject pending startup and release the process when disposed before initialization responds", async () => {
    const server = fixture({ holdInitialize: true });
    const pending = server.pool.get(server.config);
    const rejected = pending.catch((error: unknown) => error);
    await server.initializing;
    await server.pool.dispose();
    expect(await rejected).toMatchObject({
      message: expect.stringContaining("stopped"),
    });
    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(server.pool.clients()).toEqual([]);
    await expect(server.pool.get(server.config)).rejects.toThrow("disposed");
  });
});

describe("LanguageServer.diagnostics", () => {
  test("should reject unverified clean state when no diagnostic publication arrives", async () => {
    const server = fixture();
    spyOn(fs, "readFile").mockResolvedValue("const value = 1;\n");
    const client = await server.pool.get(server.config);
    await expect(
      client.diagnostics("/project/example.ts", undefined, 100),
    ).rejects.toThrow("unverified");
  });

  test("should discard a completed pull when the document changes while the request is in flight", async () => {
    const server = fixture({
      capabilities: {
        textDocumentSync: { openClose: true, change: 2 },
        diagnosticProvider: {
          interFileDependencies: false,
          workspaceDiagnostics: false,
        },
      },
    });
    spyOn(fs, "readFile").mockResolvedValue("const value = 1;\n");
    const { promise: pulling, resolve: started } =
      Promise.withResolvers<void>();
    const { promise: response, resolve: finish } = Promise.withResolvers<{
      kind: "full";
      items: Diagnostic[];
    }>();
    server.peer.onRequest("textDocument/diagnostic", () => {
      started();
      return response;
    });
    const client = await server.pool.get(server.config);
    const diagnostics = client.diagnostics("/project/example.ts");
    const rejected = diagnostics.catch((error: unknown) => error);
    await pulling;
    await client.syncFile("/project/example.ts", "const value: string = 1;\n");
    finish({ kind: "full", items: [] });
    expect(await rejected).toMatchObject({
      message: expect.stringContaining("superseded"),
    });
  });

  test("should ignore an old version publication rather than replace the current document report", async () => {
    const server = fixture();
    const text = "const value: string = 1;\n";
    spyOn(fs, "readFile").mockResolvedValue(text);
    const client = await server.pool.get(server.config);
    const file = "/project/example.ts";
    await client.syncFile(file, "const value = 1;\n");
    const oldVersion = client.document(file)?.version;
    await client.syncFile(file, text);
    const diagnostic: Diagnostic = {
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 11 },
      },
      message: "Number cannot be assigned to string",
      severity: 1,
    };
    await server.peer.sendNotification("textDocument/publishDiagnostics", {
      uri: pathToFileURL(file).href,
      version: client.document(file)?.version,
      diagnostics: [diagnostic],
    });
    await server.peer.sendNotification("textDocument/publishDiagnostics", {
      uri: pathToFileURL(file).href,
      version: oldVersion,
      diagnostics: [],
    });
    // A request on the same transport is an ordering barrier, not a clock delay.
    await server.peer.sendRequest("workspace/workspaceFolders");
    expect(await client.diagnostics(file)).toEqual({
      items: [diagnostic],
      freshness: "versioned",
    });
  });

  test("should mark a late unversioned empty report as unverified after the document changes", async () => {
    const server = fixture();
    const current = "const value: string = 1;\n";
    spyOn(fs, "readFile").mockResolvedValue(current);
    const client = await server.pool.get(server.config);
    const file = "/project/example.ts";
    await client.syncFile(file, "const value = 1;\n");
    await client.syncFile(file, current);
    await server.peer.sendNotification("textDocument/publishDiagnostics", {
      uri: pathToFileURL(file).href,
      diagnostics: [],
    });
    await server.peer.sendRequest("workspace/workspaceFolders");
    expect(await client.diagnostics(file)).toEqual({
      items: [],
      freshness: "unversioned",
    });
  });
});
