import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
// biome-ignore lint/performance/noNamespaceImport: Bun spies must intercept and restore the runtime's live filesystem imports.
import * as fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
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
const QUEUE_PROGRESS_TIMEOUT_MS = 2000;
const INVALID_TEXT_SYNC_KIND = 3;
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
 * Holds the next matching timeout so a test can advance one deadline without sleeping.
 * Other timers remain real; the inert held handle is ignored by clearTimeout.
 * @param delay - Exact timeout delay in milliseconds to intercept once.
 * @returns The held callback after production schedules it; the caller must resume it.
 * @example const polling = holdTimeout(50); const pending = client.diagnostics(file); (await polling)();
 */
function holdTimeout(delay: number): Promise<() => void> {
  const { promise, resolve: scheduled } = Promise.withResolvers<() => void>();
  // biome-ignore lint/plugin/biome-rules/use-undefined: A null prototype creates an inert opaque timer handle.
  const handle: NodeJS.Timeout = Object.create(null);
  const { setTimeout, clearTimeout } = timers;
  let held = false;
  spyOn(timers, "setTimeout").mockImplementation((callback, milliseconds) => {
    if (!held && milliseconds === delay) {
      held = true;
      scheduled(callback);
      return handle;
    }
    return setTimeout(callback, milliseconds);
  });
  spyOn(timers, "clearTimeout").mockImplementation((timer) => {
    if (timer !== handle) {
      clearTimeout(timer);
    }
  });
  return promise;
}

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
    EventEmitter & {
      exitCode: ChildProcessWithoutNullStreams["exitCode"];
    } = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 12_345,
    // biome-ignore lint/plugin/biome-rules/use-undefined: The fake preserves Node's null exitCode for a running child.
    exitCode: null as ChildProcessWithoutNullStreams["exitCode"],
    // biome-ignore lint/plugin/biome-rules/use-undefined: The fake preserves Node's null signalCode for a running child.
    signalCode: null,
  });
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
  // biome-ignore lint/plugin/biome-rules/use-undefined: LSP shutdown replies must contain a null result.
  peer.onRequest("shutdown", () => null);
  peer.onRequest("test/echo", (value: unknown) => value);
  peer.onNotification("exit", () => {
    child.exitCode = 0;
    // biome-ignore lint/plugin/biome-rules/use-undefined: Node emits a null signal for a numeric exit.
    child.emit("exit", 0, null);
    // biome-ignore lint/plugin/biome-rules/use-undefined: Node emits a null signal for a numeric close.
    child.emit("close", 0, null);
  });
  peer.listen();
  const spawn = spyOn(processes, "spawnProcess").mockReturnValue(
    child as ChildProcessWithoutNullStreams,
  );
  const stop = spyOn(processes, "stopProcess").mockImplementation(() => {
    child.exitCode = 0;
    // biome-ignore lint/plugin/biome-rules/use-undefined: Node emits a null signal for a numeric exit.
    child.emit("exit", 0, null);
    // biome-ignore lint/plugin/biome-rules/use-undefined: Node emits a null signal for a numeric close.
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
  it("should keep shared startup usable when one waiting caller cancels", async () => {
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

  it.each([
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

  it.each([
    ["a non-object result", false, "invalid initialize result"],
    [
      "non-object capabilities",
      { capabilities: [] },
      "invalid initialize result",
    ],
    [
      "a different position encoding",
      { capabilities: { positionEncoding: "utf-8" } },
      "unsupported position encoding: utf-8",
    ],
    [
      "a nonnumeric synchronization kind",
      { capabilities: { textDocumentSync: false } },
      "invalid text synchronization capabilities",
    ],
    [
      "an unknown synchronization change kind",
      {
        capabilities: { textDocumentSync: { change: INVALID_TEXT_SYNC_KIND } },
      },
      "invalid text synchronization options",
    ],
  ] as const)(
    "should reject initialization and release the process when the peer returns %s",
    async (_condition, result, error) => {
      const server = fixture();
      server.peer.onRequest<unknown, unknown>("initialize", () => result);
      await expect(server.pool.get(server.config)).rejects.toThrow(error);
      expect(server.pool.clients()).toEqual([]);
      expect(server.stop).toHaveBeenCalledTimes(1);
      expect(server.child.listenerCount("error")).toBe(0);
      expect(server.stderr.listenerCount("data")).toBe(0);
    },
  );

  it("should wait for a loaded rust workspace and completed indexing before returning a client", async () => {
    const server = fixture();
    server.config.command = "rust-analyzer";
    server.config.workspaceReadyTimings = {
      settleMs: 1,
      pollMs: 1,
    };
    let clock = 0;
    spyOn(Date, "now").mockImplementation(() => clock);
    server.peer.onRequest<string, unknown>(
      "rust-analyzer/analyzerStatus",
      async () => {
        clock++;
        if (clock === 1) {
          await server.peer.sendNotification("$/progress", {
            token: 1,
            value: { kind: "begin" },
          });
          return "No workspaces loaded";
        }
        await server.peer.sendNotification("$/progress", {
          token: 1,
          value: { kind: "end" },
        });
        return "Workspace loaded";
      },
    );
    const client = await server.pool.get(server.config);
    expect(clock).toBe(2);
    expect(client.isAlive).toBe(true);
    await client.syncFile("/project/main.rs", "fn main() {}");
    expect(client.document("/project/main.rs")?.content).toBe("fn main() {}");
  });
});

describe("StdioLanguageServerPool.dispose", () => {
  it("should reject pending startup and release the process when disposed before initialization responds", async () => {
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
  it("should reject unverified clean state when no diagnostic publication arrives", async () => {
    const server = fixture();
    spyOn(fs, "readFile").mockResolvedValue("const value = 1;\n");
    const client = await server.pool.get(server.config);
    // Freeze the polling deadline so only the diagnostic abort timer can expire.
    spyOn(Date, "now").mockReturnValue(0);
    await expect(
      client.diagnostics(
        "/project/example.ts",
        undefined,
        UNVERIFIED_DIAGNOSTIC_TIMEOUT_MS,
      ),
    ).rejects.toThrow("clean state is unverified");
    expect(client.isAlive).toBe(true);
  });

  it("should discard a completed pull when the document changes while the request is in flight", async () => {
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

  it("should ignore an old version publication rather than replace the current document report", async () => {
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

  it("should mark a late unversioned empty report as unverified after the document changes", async () => {
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

  it("should withhold a versioned publication until peer work progress ends", async () => {
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
    // biome-ignore lint/plugin/biome-rules/use-undefined: A null prototype creates an inert timer handle without inherited properties.
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

  it.each([
    ["no report", false],
    ["an unchanged report without a cached result", { kind: "unchanged" }],
  ] as const)(
    "should reject %s and recover when a complete pull report arrives",
    async (_condition, report) => {
      const server = fixture({
        capabilities: {
          textDocumentSync: 2,
          diagnosticProvider: {
            identifier: "semantic",
            interFileDependencies: false,
            workspaceDiagnostics: false,
          },
        },
      });
      spyOn(fs, "readFile").mockResolvedValue("let value = 1;");
      server.peer.onRequest<unknown, unknown>(
        "textDocument/diagnostic",
        () => report,
      );
      const client = await server.pool.get(server.config);
      const failure = await client
        .diagnostics("/project/example.ts")
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        message: expect.stringContaining("no complete diagnostic report"),
      });
      expect(client.isAlive).toBe(true);
      server.peer.onRequest("textDocument/diagnostic", () => ({
        kind: "full",
        items: [],
      }));
      expect(await client.diagnostics("/project/example.ts")).toEqual({
        items: [],
        freshness: "pull",
      });
    },
  );

  it("should reject malformed publications, recover, and invalidate cached diagnostics when refreshed", async () => {
    const server = fixture();
    const file = "/project/example.ts";
    spyOn(fs, "readFile").mockResolvedValue("let value = 1;");
    const client = await server.pool.get(server.config);
    await client.syncFile(file, "let value = 1;");
    const publication = {
      uri: pathToFileURL(file).href,
      version: client.document(file)?.version,
      diagnostics: [],
    };
    await server.peer.sendNotification("textDocument/publishDiagnostics", {
      ...publication,
      diagnostics: [{ message: "missing range" }],
    });
    await server.peer.sendRequest("workspace/workspaceFolders");
    const failure = await client
      .diagnostics(file)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: "Language server returned malformed diagnostics",
    });
    await server.peer.sendNotification(
      "textDocument/publishDiagnostics",
      publication,
    );
    for (const uri of [
      "https://example.invalid/example.ts",
      "file:///project/unopened.ts",
    ]) {
      await server.peer.sendNotification("textDocument/publishDiagnostics", {
        uri,
        diagnostics: [{ message: "not an open file" }],
      });
    }
    await server.peer.sendRequest("workspace/workspaceFolders");
    expect(await client.diagnostics(file)).toEqual({
      items: [],
      freshness: "versioned",
    });
    await server.peer.sendRequest("workspace/diagnostic/refresh");
    const polling = holdTimeout(DIAGNOSTIC_POLL_MS);
    let completed = false;
    const pending = client.diagnostics(file).then((report) => {
      completed = true;
      return report;
    });
    const resume = await polling;
    try {
      expect(completed).toBe(false);
      await server.peer.sendNotification(
        "textDocument/publishDiagnostics",
        publication,
      );
      await server.peer.sendRequest("workspace/workspaceFolders");
    } finally {
      resume();
    }
    expect(await pending).toEqual({ items: [], freshness: "versioned" });
  });
});

describe("LanguageServer.capabilities", () => {
  it("should overlay dynamic registrations and restore initialization capabilities when unregistered", async () => {
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

  it("should preserve registrations atomically when a registration or unregistration batch is invalid", async () => {
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
        // biome-ignore lint/plugin/biome-rules/use-undefined: This malformed peer entry tests rejection of external null.
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
  it("should resolve exact and nested settings without exposing inherited configuration when the peer requests sections", async () => {
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
    ).toEqual([
      server.config.settings,
      EXACT_TAB_SIZE,
      false,
      // biome-ignore lint/plugin/biome-rules/use-undefined: A missing LSP configuration section must serialize as null.
      null,
      // biome-ignore lint/plugin/biome-rules/use-undefined: An inherited configuration key is unavailable and must serialize as null.
      null,
    ]);
    await expect(
      // biome-ignore lint/plugin/biome-rules/use-undefined: This malformed peer item tests rejection of external null.
      server.peer.sendRequest("workspace/configuration", { items: [null] }),
    ).rejects.toMatchObject({ code: -32_602 });
    await expect(
      server.peer.sendRequest("workspace/configuration", {
        items: [{ section: 42 }],
      }),
    ).rejects.toMatchObject({ code: -32_602 });
  });

  it("should report invalid edits and handler failures without applying malformed peer requests", async () => {
    const apply = mock<
      ConstructorParameters<typeof StdioLanguageServerPool>[0]["onApplyEdit"]
    >().mockRejectedValue(new Error("edit transaction refused"));
    const server = fixture({ onApplyEdit: apply });
    const client = await server.pool.get(server.config);
    expect(await server.peer.sendRequest("workspace/applyEdit")).toEqual({
      applied: false,
      failureReason: "Invalid workspace edit",
    });
    expect(
      await server.peer.sendRequest<unknown>("workspace/applyEdit", {
        // biome-ignore lint/plugin/biome-rules/use-undefined: This malformed peer edit tests rejection of external null.
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

  it("should stop a peer that ignores request cancellation after the grace period", async () => {
    const server = fixture();
    const requested = Promise.withResolvers<void>();
    // biome-ignore lint/plugin/biome-rules/use-undefined: Preserve the LSP nullable hover response.
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
    // biome-ignore lint/plugin/biome-rules/use-undefined: A null prototype creates an inert opaque timer handle.
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
      // biome-ignore lint/plugin/biome-rules/use-undefined: Preserve an explicit null on the JSON-RPC echo transport.
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
      // biome-ignore lint/plugin/biome-rules/use-undefined: Complete the pending LSP hover with an empty response.
      response.resolve(null);
      await canceled;
    }
  });

  it.each([
    ["missing configuration parameters", "workspace/configuration", undefined],
    [
      "a non-array configuration list",
      "workspace/configuration",
      { items: {} },
    ],
    ["missing registration parameters", "client/registerCapability", undefined],
    [
      "a non-array registration list",
      "client/registerCapability",
      { registrations: {} },
    ],
    [
      "a non-object registration",
      "client/registerCapability",
      { registrations: [false] },
    ],
    [
      "missing unregistration parameters",
      "client/unregisterCapability",
      undefined,
    ],
  ] as const)(
    "should reject %s without losing active capabilities",
    async (_condition, method, params) => {
      const server = fixture({ capabilities: { hoverProvider: true } });
      const client = await server.pool.get(server.config);
      const failure = await server.peer
        .sendRequest(method, params)
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: -32_602 });
      expect(client.capabilities.hoverProvider).toBe(true);
      expect(client.isAlive).toBe(true);
    },
  );
});

describe("LanguageServer.syncFile", () => {
  it("should cancel an in-flight read and synchronize the next queued update without retaining stale text", async () => {
    const server = fixture();
    const client = await server.pool.get(server.config);
    const file = "/project/example.ts";
    await client.syncFile(file, "original");
    const version = client.document(file)?.version;
    const started = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<string>();
    const read = spyOn(fs, "readFile").mockImplementation(((
      ..._args: Parameters<typeof fs.readFile>
    ): ReturnType<typeof fs.readFile> => {
      started.resolve();
      return reading.promise;
    }) as typeof fs.readFile);
    const controller = new AbortController();
    const pending = client.syncFile(file, undefined, controller.signal);
    const canceled = pending.catch((error: unknown) => error);
    const next = client.syncFile(
      file,
      "updated",
      AbortSignal.timeout(QUEUE_PROGRESS_TIMEOUT_MS),
    );
    try {
      await started.promise;
      const reason = new Error("document read canceled");
      controller.abort(reason);
      await next;
      expect(await canceled).toBe(reason);
      expect(read.mock.calls[0]?.[1]).toMatchObject({
        signal: { aborted: true },
      });
      const updated = { version: (version ?? 0) + 1, content: "updated" };
      expect(client.document(file)).toEqual(updated);
      reading.resolve("stale disk text");
      await setImmediate();
      expect(client.document(file)).toEqual(updated);
      expect(client.isAlive).toBe(true);
      expect(server.stop).not.toHaveBeenCalled();
    } finally {
      reading.resolve("stale disk text");
      try {
        await Promise.allSettled([pending, next]);
      } finally {
        read.mockRestore();
      }
    }
  });
  it("should replace numeric incremental synchronization with a UTF-16 range across CRLF", async () => {
    const server = fixture({ capabilities: { textDocumentSync: 2 } });
    const changes = mock();
    server.peer.onNotification("textDocument/didChange", changes);
    const client = await server.pool.get(server.config);
    const file = "/project/example.ts";
    await client.syncFile(file, "a\r\n😀");
    const priorVersion = client.document(file)?.version;
    await client.syncFile(file, "replacement");
    await client.request("test/echo", undefined);
    expect(changes).toHaveBeenCalledWith({
      textDocument: {
        uri: pathToFileURL(file).href,
        version: client.document(file)?.version,
      },
      contentChanges: [
        {
          text: "replacement",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 1, character: 2 },
          },
        },
      ],
    });
    expect(client.document(file)?.version).toBe((priorVersion ?? 0) + 1);
  });

  it("should close and reopen changed text when the peer only supports open-close synchronization", async () => {
    const server = fixture({
      capabilities: { textDocumentSync: { openClose: true, change: 0 } },
    });
    const opened = mock();
    const closed = mock();
    server.peer.onNotification("textDocument/didOpen", opened);
    server.peer.onNotification("textDocument/didClose", closed);
    const client = await server.pool.get(server.config);
    const file = "/project/example.ts";
    await client.syncFile(file, "before");
    await client.syncFile(file, "after");
    await client.request("test/echo", undefined);
    expect(
      opened.mock.calls.map(([params]) => params.textDocument.text),
    ).toEqual(["before", "after"]);
    expect(closed.mock.calls).toEqual([
      [{ textDocument: { uri: pathToFileURL(file).href } }],
    ]);
    expect(client.document(file)?.content).toBe("after");
  });

  it("should retain the prior snapshot when changes are unsupported and allow a later reopen", async () => {
    const server = fixture({ capabilities: { textDocumentSync: 0 } });
    const client = await server.pool.get(server.config);
    const file = "/project/example.ts";
    await client.syncFile(file, "before");
    const prior = client.document(file);
    await expect(client.syncFile(file, "after")).rejects.toThrow(
      "cannot synchronize changes",
    );
    expect(client.document(file)).toEqual(prior);
    await client.closeFile(file);
    await client.syncFile(file, "after");
    expect(client.document(file)?.content).toBe("after");
    expect(() => client.syncFile("example.ts", "content")).toThrow(
      "LSP requires an absolute file path",
    );
  });

  it("should reject a pre-cancelled synchronization without poisoning the document queue", async () => {
    const server = fixture();
    const client = await server.pool.get(server.config);
    const file = "/project/example.ts";
    await expect(
      client.syncFile(
        file,
        "cancelled",
        AbortSignal.abort("cancelled by caller"),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(client.document(file)).toBeUndefined();
    await client.syncFile(file, "accepted");
    expect(client.document(file)?.content).toBe("accepted");
  });
});

describe("LanguageServer.saved", () => {
  it("should send current saved text and watched changes but stop saving a closed document", async () => {
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
    server.peer.onRequest("test/barrier", () => undefined);
    await client.request("test/barrier", undefined);
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
  it("should retain bounded stderr and release owned listeners when the server exits unexpectedly", async () => {
    const server = fixture();
    const client = await server.pool.get(server.config);
    server.stderr.write(
      `${"x".repeat(OVERSIZED_STDERR_CHARACTERS)}permission denied\n`,
    );
    server.child.exitCode = FAILURE_EXIT_CODE;
    // biome-ignore lint/plugin/biome-rules/use-undefined: Node emits a null signal for a numeric exit.
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

  it("should retain transport and cleanup failures and release listeners when process termination rejects", async () => {
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

  it("should reject pending work and clear owned documents without sending cancellation traffic when the owner shuts down", async () => {
    const server = fixture();
    const requested = Promise.withResolvers<void>();
    // biome-ignore lint/plugin/biome-rules/use-undefined: Preserve the LSP nullable hover response.
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
      // biome-ignore lint/plugin/biome-rules/use-undefined: Complete the pending LSP hover with an empty response.
      response.resolve(null);
      // biome-ignore lint/plugin/biome-rules/use-undefined: The LSP shutdown response requires null.
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
      // biome-ignore lint/plugin/biome-rules/use-undefined: Complete the pending LSP hover with an empty response.
      response.resolve(null);
      await rejected;
      await client.shutdown();
    }
  });

  it.each([
    ["missing parameters", undefined],
    ["a missing document URI", { diagnostics: [] }],
  ] as const)(
    "should stop a peer that publishes diagnostics with %s",
    async (_condition, params) => {
      const server = fixture();
      const client = await server.pool.get(server.config);
      const closed = Promise.withResolvers<void>();
      server.child.once("close", () => closed.resolve());
      await server.peer.sendNotification(
        "textDocument/publishDiagnostics",
        params,
      );
      await closed.promise;
      await expect(client.diagnostics("/project/example.ts")).rejects.toThrow(
        "published diagnostics without a document URI",
      );
      await client.shutdown();
      expect(server.stop).toHaveBeenCalledTimes(1);
      expect(server.pool.clients()).toEqual([]);
      expect(server.stderr.listenerCount("data")).toBe(0);
    },
  );
});

describe("StdioLanguageServerPool.clients", () => {
  it("should keep active requests alive and stop idle clients when the owned idle sweep runs", async () => {
    // biome-ignore lint/plugin/biome-rules/use-undefined: A null prototype creates an inert timer handle without inherited properties.
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
      // biome-ignore lint/plugin/biome-rules/use-undefined: An LSP hover response is null when no hover is available.
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
      // biome-ignore lint/plugin/biome-rules/use-undefined: An LSP hover reply is null when no hover is available.
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
      // biome-ignore lint/plugin/biome-rules/use-undefined: An LSP hover reply is null when no hover is available.
      finish(null);
      await pending;
    }
  });
});

describe("StdioLanguageServerPool.stop", () => {
  it("should leave a live client available when its name is not selected", async () => {
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

describe("startup transport failures", () => {
  describe("StdioLanguageServerPool.get", () => {
    it.each([
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

    it("should reject startup with stderr context when stdout closes at a message boundary", async () => {
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

    it("should reject startup and release its process when a framed message contains invalid JSON", async () => {
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

    it.each([
      ["a missing length", "Content-Type: application/json\r\n\r\n"],
      ["a nonnumeric length", "Content-Length: invalid\r\n\r\n"],
    ])(
      "should reject startup and release the process when the header has %s",
      async (_condition, bytes) => {
        const server = fixture({ holdInitialize: true });
        const pending = server.pool
          .get(server.config)
          .catch((error: unknown) => error);
        await server.initializing;
        server.output.write(bytes);
        expect(await pending).toMatchObject({
          message: "Invalid LSP Content-Length header",
        });
        expect(server.stop).toHaveBeenCalledTimes(1);
        expect(server.pool.clients()).toEqual([]);
      },
    );
  });
});
