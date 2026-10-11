import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
// biome-ignore lint/performance/noNamespaceImport: Bun spies must intercept and restore the runtime's live filesystem imports.
import * as fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  type CancellationToken,
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
import { type LanguageServerPool, StdioLanguageServerPool } from "./runtime.ts";
import type { ServerConfig } from "./types.ts";

// 16 * 1024 + 1 bytes: one byte beyond the 16 KiB header limit.
const OVERSIZED_HEADER_BYTES = 16_385;
const STARTUP_ABORT_TIMEOUT_MS = 200;
const UNVERIFIED_DIAGNOSTIC_TIMEOUT_MS = 100;
const EXACT_TAB_SIZE = 8;
const OVERSIZED_STDERR_CHARACTERS = 20_000;
const FAILURE_EXIT_CODE = 3;
const BUSY_CLOCK_MS = 2000;
const EXPIRED_CLOCK_MS = 2011;
const DIAGNOSTIC_POLL_MS = 50;
const PROGRESS_DIAGNOSTIC_TIMEOUT_MS = 1000;
// Narrow host timer effects rather than inheriting Bun/Node's overloaded signatures.
const timers: {
  setTimeout: (callback: () => void, delay?: number) => NodeJS.Timeout;
  clearTimeout: (timer: NodeJS.Timeout | undefined) => void;
  setInterval: (callback: () => void, delay?: number) => NodeJS.Timeout;
} = globalThis;

const resources: Array<{
  pool: LanguageServerPool;
  peer: MessageConnection;
  release: () => void;
}> = [];

/**
 * Creates a controllable in-memory server with restorable process spies.
 * Options control initialization, capabilities, idle expiry, and edit handling; afterEach owns disposal.
 * @example fixture({ holdInitialize: true }).release() // Allows initialization to finish.
 */
function fixture(
  options: {
    holdInitialize?: boolean;
    capabilities?: ServerCapabilities;
    idleTimeoutMs?: number;
    onApplyEdit?: ConstructorParameters<
      typeof StdioLanguageServerPool
    >[0]["onApplyEdit"];
  } = {},
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
      pid: 12_345,
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
  const pool = new StdioLanguageServerPool({
    cwd: "/project",
    onApplyEdit: options.onApplyEdit ?? (async () => ({ applied: false })),
    ...(options.idleTimeoutMs === undefined
      ? {}
      : { idleTimeoutMs: options.idleTimeoutMs }),
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
    child,
    stderr,
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

describe("StdioLanguageServerPool.get", () => {
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
    ["an oversized header", "x".repeat(OVERSIZED_HEADER_BYTES), "header"],
    ["an oversized message", "Content-Length: 999999999\r\n\r\n", "message"],
  ])(
    "should reject %s before buffering its body",
    async (_label, bytes, error) => {
      const server = fixture({ holdInitialize: true });
      const pending = server.pool.get(
        server.config,
        AbortSignal.timeout(STARTUP_ABORT_TIMEOUT_MS),
      );
      const rejected = pending.catch((failure: unknown) => failure);
      await server.initializing;
      server.output.write(bytes);
      expect(await rejected).toMatchObject({
        message: expect.stringContaining(error),
      });
    },
  );
});

describe("StdioLanguageServerPool.dispose", () => {
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
      client.diagnostics(
        "/project/example.ts",
        undefined,
        UNVERIFIED_DIAGNOSTIC_TIMEOUT_MS,
      ),
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

describe("LanguageServer.capabilities", () => {
  test("should overlay dynamic registrations and restore initialization capabilities when unregistered", async () => {
    const base: ServerCapabilities = { hoverProvider: false };
    const server = fixture({ capabilities: base });
    const client = await server.pool.get(server.config);
    await server.peer.sendRequest("client/registerCapability", {
      registrations: [
        { id: "hover", method: "textDocument/hover" },
        {
          id: "diagnostic",
          method: "textDocument/diagnostic",
          registerOptions: {
            identifier: "semantic",
            interFileDependencies: true,
          },
        },
        {
          id: "rename",
          method: "workspace/willRenameFiles",
          registerOptions: { filters: [{ pattern: { glob: "**/*.ts" } }] },
        },
      ],
    });
    expect(client.capabilities).toMatchObject({
      hoverProvider: {},
      diagnosticProvider: {
        identifier: "semantic",
        interFileDependencies: true,
        workspaceDiagnostics: false,
      },
      workspace: {
        fileOperations: {
          willRenameFiles: { filters: [{ pattern: { glob: "**/*.ts" } }] },
        },
      },
    });
    expect(base).toEqual({ hoverProvider: false });
    await server.peer.sendRequest("client/unregisterCapability", {
      unregisterations: [
        { id: "hover" },
        { id: "diagnostic" },
        { id: "rename" },
      ],
    });
    expect(client.capabilities).toEqual(base);
  });

  test("should preserve registrations atomically when a registration or unregistration batch is invalid", async () => {
    const server = fixture();
    const client = await server.pool.get(server.config);
    await server.peer.sendRequest("client/registerCapability", {
      registrations: [{ id: "hover", method: "textDocument/hover" }],
    });
    await expect(
      server.peer.sendRequest("client/registerCapability", {
        registrations: [
          { id: "symbol", method: "workspace/symbol" },
          { id: "invalid", method: "textDocument/hover", registerOptions: [] },
        ],
      }),
    ).rejects.toMatchObject({ code: -32_602 });
    expect(client.capabilities.workspaceSymbolProvider).toBeUndefined();
    await expect(
      server.peer.sendRequest("client/unregisterCapability", {
        unregistrations: [{ id: "hover" }, null],
      }),
    ).rejects.toMatchObject({ code: -32_602 });
    expect(client.capabilities.hoverProvider).toEqual({});
    await server.peer.sendRequest("client/unregisterCapability", {
      unregistrations: [{ id: "hover" }],
    });
    expect(client.capabilities.hoverProvider).toBeUndefined();
  });
});

describe("LanguageServer.request", () => {
  test("should resolve exact and nested settings without exposing inherited configuration when the peer requests sections", async () => {
    const server = fixture();
    server.config.settings = {
      "editor.tabSize": EXACT_TAB_SIZE,
      editor: { tabSize: 4, enabled: false },
    };
    await server.pool.get(server.config);
    expect(
      await server.peer.sendRequest<unknown>("workspace/configuration", {
        items: [
          {},
          { section: "editor.tabSize" },
          { section: "editor.enabled" },
          { section: "editor.missing" },
          { section: "toString" },
        ],
      }),
    ).toEqual([server.config.settings, EXACT_TAB_SIZE, false, null, null]);
    await expect(
      server.peer.sendRequest("workspace/configuration", { items: [null] }),
    ).rejects.toMatchObject({ code: -32_602 });
    await expect(
      server.peer.sendRequest("workspace/configuration", {
        items: [{ section: 42 }],
      }),
    ).rejects.toMatchObject({ code: -32_602 });
  });

  test("should report invalid edits and handler failures without applying malformed peer requests", async () => {
    const apply = mock<
      ConstructorParameters<typeof StdioLanguageServerPool>[0]["onApplyEdit"]
    >().mockRejectedValue(new Error("edit transaction refused"));
    const server = fixture({ onApplyEdit: apply });
    const client = await server.pool.get(server.config);
    expect(
      await server.peer.sendRequest<unknown>("workspace/applyEdit", {
        edit: null,
      }),
    ).toEqual({ applied: false, failureReason: "Invalid workspace edit" });
    expect(apply).not.toHaveBeenCalled();
    const edit = { changes: {} };
    expect(
      await server.peer.sendRequest<unknown>("workspace/applyEdit", { edit }),
    ).toEqual({ applied: false, failureReason: "edit transaction refused" });
    expect(apply).toHaveBeenCalledWith(edit, client);
    await expect(
      server.peer.sendRequest("unrecognized/clientMethod"),
    ).rejects.toMatchObject({ code: -32_601 });
    expect(
      await server.peer.sendRequest<unknown>("window/showDocument", {}),
    ).toEqual({
      success: false,
    });
  });
});

describe("LanguageServer.saved", () => {
  test("should send current saved text and watched changes but stop saving a closed document", async () => {
    const server = fixture({
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: 2,
          save: { includeText: true },
        },
      },
    });
    const saves = mock();
    const changes = mock();
    const closes = mock();
    server.peer.onNotification("textDocument/didSave", saves);
    server.peer.onNotification("workspace/didChangeWatchedFiles", changes);
    server.peer.onNotification("textDocument/didClose", closes);
    const client = await server.pool.get(server.config);
    await server.peer.sendRequest("client/registerCapability", {
      registrations: [
        { id: "watch", method: "workspace/didChangeWatchedFiles" },
      ],
    });
    const file = "/project/example.ts";
    const uri = pathToFileURL(file).href;
    await client.syncFile(file, "let value = 1;\n");
    await client.syncFile(file, "let value = 2;\n");
    await client.saved(file);
    await client.closeFile(file);
    await client.closeFile(file);
    await client.saved(file);
    // The peer's reply follows all preceding client notifications.
    server.peer.onRequest("test/barrier", () => null);
    await client.request("test/barrier", null);
    expect(saves.mock.calls).toEqual([
      [{ textDocument: { uri }, text: "let value = 2;\n" }],
    ]);
    expect(changes.mock.calls).toEqual([
      [{ changes: [{ uri, type: 2 }] }],
      [{ changes: [{ uri, type: 2 }] }],
    ]);
    expect(closes.mock.calls).toEqual([[{ textDocument: { uri } }]]);
    expect(client.document(file)).toBeUndefined();
  });
});

describe("LanguageServer.shutdown", () => {
  test("should retain bounded stderr and release owned listeners when the server exits unexpectedly", async () => {
    const server = fixture();
    const client = await server.pool.get(server.config);
    server.stderr.write(
      `${"x".repeat(OVERSIZED_STDERR_CHARACTERS)}permission denied\n`,
    );
    server.child.exitCode = FAILURE_EXIT_CODE;
    server.child.emit("exit", FAILURE_EXIT_CODE, null);
    await expect(client.request("textDocument/hover", {})).rejects.toThrow(
      "exited (3)",
    );
    await expect(client.notify("textDocument/didOpen", {})).rejects.toThrow(
      "permission denied",
    );
    await client.shutdown();
    expect(client.isAlive).toBe(false);
    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(server.child.listenerCount("error")).toBe(0);
    expect(server.child.listenerCount("exit")).toBe(0);
    expect(server.stderr.listenerCount("data")).toBe(0);
    expect(server.pool.clients()).toEqual([]);
  });
});

describe("StdioLanguageServerPool.clients", () => {
  test("should keep active requests alive and stop idle clients when the owned idle sweep runs", async () => {
    const timerHandle: NodeJS.Timeout = Object.assign(Object.create(null), {
      unref: () => timerHandle,
    });
    let sweep: (() => void) | undefined;
    spyOn(timers, "setInterval").mockImplementation((callback) => {
      sweep = callback;
      return timerHandle;
    });
    const clear = spyOn(globalThis, "clearInterval").mockImplementation(
      () => undefined,
    );
    const server = fixture({ idleTimeoutMs: 10 });
    const { promise: requested, resolve: began } =
      Promise.withResolvers<void>();
    const { promise: response, resolve: finish } =
      Promise.withResolvers<null>();
    server.peer.onRequest("textDocument/hover", () => {
      began();
      return response;
    });
    const client = await server.pool.get(server.config);
    // Startup readiness needs a progressing clock; freeze it before request activity.
    const clock = spyOn(Date, "now").mockReturnValue(0);
    const pending = client.request("textDocument/hover", {});
    try {
      await requested;
      clock.mockReturnValue(BUSY_CLOCK_MS);
      if (!sweep) {
        throw new Error("Expected pool-owned idle sweep");
      }
      sweep();
      expect(server.pool.clients()).toEqual([client]);
      expect(server.stop).not.toHaveBeenCalled();
      finish(null);
      await pending;
      clock.mockReturnValue(EXPIRED_CLOCK_MS);
      sweep();
      expect(server.pool.clients()).toEqual([]);
      await server.pool.stop();
      expect(server.stop).toHaveBeenCalledTimes(1);
      expect(clear).not.toHaveBeenCalled();
      await server.pool.dispose();
      expect(clear).toHaveBeenCalledWith(timerHandle);
    } finally {
      finish(null);
      await pending;
    }
  });
});

describe("LanguageServer.diagnostics", () => {
  test("should withhold a versioned publication until peer work progress ends", async () => {
    const server = fixture();
    const file = "/project/example.ts";
    spyOn(fs, "readFile").mockResolvedValue("let value = 1;\n");
    const client = await server.pool.get(server.config);
    await client.syncFile(file, "let value = 1;\n");
    await server.peer.sendNotification("$/progress", {
      token: "indexing",
      value: { kind: "begin" },
    });
    await server.peer.sendNotification("textDocument/publishDiagnostics", {
      uri: pathToFileURL(file).href,
      version: client.document(file)?.version,
      diagnostics: [],
    });
    await server.peer.sendRequest("workspace/workspaceFolders");
    const { promise: polling, resolve: polled } = Promise.withResolvers<void>();
    const timerHandle: NodeJS.Timeout = Object.create(null);
    const { setTimeout: timeout, clearTimeout } = timers;
    let resume: (() => void) | undefined;
    spyOn(timers, "setTimeout").mockImplementation((callback, delay) => {
      if (delay === DIAGNOSTIC_POLL_MS) {
        resume = callback;
        polled();
        return timerHandle;
      }
      return timeout(callback, delay);
    });
    spyOn(timers, "clearTimeout").mockImplementation((timer) => {
      if (timer !== timerHandle) {
        clearTimeout(timer);
      }
    });
    let complete = false;
    const pending = client
      .diagnostics(file, undefined, PROGRESS_DIAGNOSTIC_TIMEOUT_MS)
      .then((report) => {
        complete = true;
        return report;
      });
    try {
      await polling;
      expect(complete).toBe(false);
    } finally {
      await server.peer.sendNotification("$/progress", {
        token: "indexing",
        value: { kind: "end" },
      });
    }
    await server.peer.sendRequest("workspace/workspaceFolders");
    resume?.();
    expect(await pending).toEqual({ items: [], freshness: "versioned" });
  });
});

describe("LanguageServer.request", () => {
  test("should stop a peer that ignores request cancellation after the grace period", async () => {
    const server = fixture();
    const requested = Promise.withResolvers<void>();
    const response = Promise.withResolvers<null>();
    let hoverToken: CancellationToken | undefined;
    server.peer.onRequest(
      "textDocument/hover",
      (_params: unknown, token: CancellationToken) => {
        hoverToken = token;
        requested.resolve();
        return response.promise;
      },
    );
    const client = await server.pool.get(server.config);
    const controller = new AbortController();
    const graceMs = 1000;
    const handle: NodeJS.Timeout = Object.create(null);
    const { setTimeout: timeout, clearTimeout } = timers;
    let expire: (() => void) | undefined;
    spyOn(timers, "setTimeout").mockImplementation((callback, delay) => {
      if (delay === graceMs) {
        expire = callback;
        return handle;
      }
      return timeout(callback, delay);
    });
    spyOn(timers, "clearTimeout").mockImplementation((timer) => {
      if (timer !== handle) {
        clearTimeout(timer);
      }
    });
    const pending = client.request("textDocument/hover", {}, controller.signal);
    const canceled = pending.catch((error: unknown) => error);
    try {
      await requested.promise;
      const reason = new Error("hover canceled");
      controller.abort(reason);
      expect(await canceled).toBe(reason);
      expect(client.isAlive).toBe(true);
      // The echo reply follows the preceding cancellation notification on this transport.
      await client.request("test/echo", null);
      expect(hoverToken?.isCancellationRequested).toBe(true);
      expect(server.stop).not.toHaveBeenCalled();
      if (!expire) {
        throw new Error("Expected cancellation grace timer");
      }
      expire();
      await expect(client.request("test/echo", {})).rejects.toThrow(
        "ignored cancellation of textDocument/hover",
      );
      await client.shutdown();
      expect(client.isAlive).toBe(false);
      expect(server.stop).toHaveBeenCalledTimes(1);
      expect(server.pool.clients()).toEqual([]);
    } finally {
      response.resolve(null);
      await canceled;
    }
  });
});

describe("StdioLanguageServerPool.get", () => {
  test.each([
    ["a partial header", "Content-Len"],
    ["a partial body", "Content-Length: 20\r\n\r\n{"],
  ])(
    "should reject startup with a framing error when stdout ends after %s",
    async (_condition, bytes) => {
      const server = fixture({ holdInitialize: true });
      const pending = server.pool.get(server.config);
      const rejected = pending.catch((error: unknown) => error);
      await server.initializing;
      server.output.end(bytes);

      expect(await rejected).toMatchObject({
        message: "LSP transport ended with an incomplete message",
      });
      expect(server.pool.clients()).toEqual([]);
      expect(server.stop).toHaveBeenCalledTimes(1);
    },
  );

  test("should reject startup with stderr context when stdout closes at a message boundary", async () => {
    const server = fixture({ holdInitialize: true });
    const pending = server.pool.get(server.config);
    const rejected = pending.catch((error: unknown) => error);
    await server.initializing;
    server.stderr.write("protocol pipe closed\n");
    server.output.end();

    expect(await rejected).toMatchObject({
      message: "LSP test-server closed its transport: protocol pipe closed",
    });
    expect(server.pool.clients()).toEqual([]);
    expect(server.stop).toHaveBeenCalledTimes(1);
  });
});

describe("StdioLanguageServerPool.stop", () => {
  test("should leave a live client available when its name is not selected", async () => {
    const server = fixture();
    const client = await server.pool.get(server.config);
    await server.pool.stop(["another-server"]);

    expect(server.pool.clients()).toEqual([client]);
    expect(server.stop).not.toHaveBeenCalled();
    await client.syncFile("/project/example.ts", "let value = 1;");
    expect(client.document("/project/example.ts")?.content).toBe(
      "let value = 1;",
    );
    await server.pool.stop([server.config.name]);
    expect(server.pool.clients()).toEqual([]);
    expect(client.document("/project/example.ts")).toBeUndefined();
    expect(server.stop).toHaveBeenCalledTimes(1);
  });
});

describe("LanguageServer.shutdown", () => {
  test("should retain transport and cleanup failures and release listeners when process termination rejects", async () => {
    const server = fixture();
    const client = await server.pool.get(server.config);
    const cleanupError = new Error("process group termination failed");
    server.stop.mockRejectedValue(cleanupError);
    const transportError = new Error("broken protocol pipe");
    // This test owns the expected failing disposal instead of the ordinary afterEach path.
    const resource = resources.pop();
    try {
      server.child.emit("error", transportError);
      await expect(client.shutdown()).rejects.toBe(cleanupError);
      await expect(
        client.request("textDocument/hover", {}),
      ).rejects.toMatchObject({
        message: "LSP test-server cleanup failed",
        errors: [transportError, cleanupError],
      });
      expect(server.child.listenerCount("error")).toBe(0);
      expect(server.stderr.listenerCount("data")).toBe(0);
      expect(server.pool.clients()).toEqual([]);
      expect(server.stop).toHaveBeenCalledTimes(1);
      await expect(server.pool.stop()).rejects.toMatchObject({
        message: "Failed to stop language servers",
        errors: [cleanupError],
      });
    } finally {
      resource?.release();
      try {
        await expect(server.pool.dispose()).rejects.toMatchObject({
          message: "Failed to stop language servers",
          errors: [cleanupError],
        });
      } finally {
        server.peer.dispose();
      }
    }
  });
});

describe("StdioLanguageServerPool.get", () => {
  test("should reject startup and release its process when a framed message contains invalid JSON", async () => {
    const server = fixture({ holdInitialize: true });
    const pending = server.pool.get(server.config);
    const rejected = pending.catch((error: unknown) => error);
    await server.initializing;
    const body = '{"jsonrpc":';
    server.output.write(
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );

    expect(await rejected).toBeInstanceOf(SyntaxError);
    expect(server.pool.clients()).toEqual([]);
    expect(server.stop).toHaveBeenCalledTimes(1);
  });
});

describe("LanguageServer.shutdown", () => {
  test("should reject pending work and clear owned documents without sending cancellation traffic when the owner shuts down", async () => {
    const server = fixture();
    const requested = Promise.withResolvers<void>();
    const response = Promise.withResolvers<null>();
    let hoverToken: CancellationToken | undefined;
    server.peer.onRequest(
      "textDocument/hover",
      (_params: unknown, token: CancellationToken) => {
        hoverToken = token;
        requested.resolve();
        return response.promise;
      },
    );
    server.peer.onRequest("shutdown", () => {
      response.resolve(null);
      return null;
    });
    const client = await server.pool.get(server.config);
    const file = "/project/example.ts";
    await client.syncFile(file, "let value = 1;");
    const pending = client.request("textDocument/hover", {});
    const rejected = pending.catch((error: unknown) => error);
    try {
      await requested.promise;
      const shutdown = client.shutdown();
      expect(await rejected).toMatchObject({
        message: "LSP test-server stopped",
      });
      await shutdown;
      expect(hoverToken?.isCancellationRequested).toBe(false);
      expect(client.document(file)).toBeUndefined();
      expect(client.isAlive).toBe(false);
      expect(server.pool.clients()).toEqual([]);
      expect(server.stop).toHaveBeenCalledTimes(1);
      expect(server.child.listenerCount("error")).toBe(0);
    } finally {
      response.resolve(null);
      await rejected;
      await client.shutdown();
    }
  });
});
