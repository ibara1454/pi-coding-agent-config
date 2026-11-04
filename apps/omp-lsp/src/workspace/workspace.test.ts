import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import type { TextEdit, WorkspaceEdit } from "vscode-languageserver-protocol";
// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace to intercept configuration-loading effects.
import * as config from "../configuration/config.ts";
import type { LanguageServer, LanguageServerPool } from "../runtime/runtime.ts";
import type { LspConfig, ServerConfig } from "../runtime/types.ts";
// biome-ignore lint/performance/noNamespaceImport: Bun spies intercept the effect-owning edit transaction boundary.
import * as edits from "./edits.ts";
// biome-ignore lint/performance/noNamespaceImport: Bun spies intercept CLI effects without replacing workspace decisions.
import * as linters from "./linters.ts";
import { LspWorkspace } from "./workspace.ts";

const workspaces: LspWorkspace[] = [];
const EAGER_STARTUP_CONCURRENCY = 3;
const STARTUP_SERVER_COUNT = 5;
const ACTION_DEADLINE_MS = 5000;
const MUTATION_DEADLINE_MS = 15_000;
const MUTATION_RESPONSE_DEADLINE_MS = 16_000;
const MAX_DIAGNOSTIC_TARGET_FILES = 20;
const timers: {
  setTimeout: (callback: () => void, delay?: number) => NodeJS.Timeout;
  clearTimeout: (timer: NodeJS.Timeout | undefined) => void;
} = globalThis;
const filesystem: {
  stat: (file: string) => Promise<Stats>;
  lstat: (file: string) => Promise<Stats>;
  opendir: (
    directory: string,
  ) => Promise<
    AsyncIterable<
      Pick<Dirent, "name" | "isFile" | "isDirectory" | "isSymbolicLink">
    >
  >;
} = fs;
type PoolFactory = NonNullable<Parameters<typeof LspWorkspace.create>[1]>;

/**
 * Replaces configuration loading and pool effects without mocking workspace policy.
 * @returns Mutable configuration, pool effects, edit callback, and fake protocol peer.
 * @example fixture().loaded.settings.lazy = true prevents eager acquisitions.
 */
function fixture() {
  const serverConfig: ServerConfig = {
    name: "test-server",
    command: "test-server",
    resolvedCommand: "/installed/test-server",
    args: [],
    root: "/project",
    rootMarkers: [],
    fileTypes: [".ts"],
  };
  const loaded: LspConfig = {
    servers: [serverConfig],
    warnings: [],
    settings: {
      enabled: true,
      lazy: false,
      formatOnWrite: false,
      diagnosticsOnWrite: false,
      diagnosticsOnEdit: false,
      diagnosticsDeduplicate: true,
    },
  };
  spyOn(config, "loadLspConfig").mockResolvedValue(loaded);
  // biome-ignore lint/plugin/biome-rules/use-undefined: Model the LSP null result for methods with no response data.
  const request = mock<LanguageServer["request"]>().mockResolvedValue(null);
  const server: LanguageServer = {
    config: serverConfig,
    isAlive: true,
    capabilities: { hoverProvider: true },
    request: request as LanguageServer["request"],
    notify: mock<LanguageServer["notify"]>().mockResolvedValue(undefined),
    syncFile: mock<LanguageServer["syncFile"]>().mockResolvedValue(undefined),
    saved: mock<LanguageServer["saved"]>().mockResolvedValue(undefined),
    closeFile: mock<LanguageServer["closeFile"]>().mockResolvedValue(undefined),
    diagnostics: mock<LanguageServer["diagnostics"]>().mockResolvedValue({
      items: [],
      freshness: "pull",
    }),
    document: () => undefined,
    shutdown: () => Promise.resolve(),
  };
  const get = mock<LanguageServerPool["get"]>().mockResolvedValue(server);
  const pool = {
    get,
    clients: mock<LanguageServerPool["clients"]>().mockReturnValue([]),
    stop: mock<LanguageServerPool["stop"]>().mockResolvedValue(undefined),
    dispose: mock<LanguageServerPool["dispose"]>().mockResolvedValue(undefined),
  };
  let onApplyEdit: Parameters<PoolFactory>[2] | undefined;
  /**
   * Supplies test-owned pool effects and retains the workspace's edit policy.
   * @returns The fixture pool; disposal remains the workspace's responsibility.
   * @example await createWorkspace(poolFactory) installs the callback without starting processes.
   */
  const poolFactory: PoolFactory = (_cwd, _idleTimeoutMs, applyEdit) => {
    onApplyEdit = applyEdit;
    return pool;
  };
  return {
    loaded,
    server,
    get,
    request,
    pool,
    poolFactory,
    /**
     * Invokes the installed server-edit policy through the requesting peer.
     * @param edit - Edit passed to the workspace transaction boundary.
     * @returns Application status after workspace reconciliation.
     * @throws If no workspace has installed a callback or the transaction rejects.
     * @example const setup = fixture(); await createWorkspace(setup.poolFactory); await setup.applyEdit({});
     */
    applyEdit: (edit: Parameters<Parameters<PoolFactory>[2]>[0]) => {
      if (!onApplyEdit) {
        throw new Error(
          "Expected workspace creation to install its edit callback",
        );
      }
      return onApplyEdit(edit, server);
    },
  };
}

/**
 * Creates one workspace through its production interface and registers disposal.
 * @param poolFactory - Test-owned pool effects and server edit callback capture.
 * @param trusted - Whether project server startup is permitted.
 * @returns The workspace whose injected pool is disposed by afterEach.
 * @throws If workspace creation fails.
 * @example await createWorkspace(fixture().poolFactory, false) prevents server startup.
 */
async function createWorkspace(
  poolFactory: PoolFactory,
  trusted = true,
): Promise<LspWorkspace> {
  const workspace = await LspWorkspace.create(
    { cwd: "/project", agentDir: "/agent", trusted },
    poolFactory,
  );
  workspaces.push(workspace);
  return workspace;
}

/**
 * Supplies one bounded document while keeping workspace validation and protocol handling real.
 * @param content - UTF-8 source returned by the filesystem boundary.
 * @example mockDocument("const value = 1;") allows position-based workspace actions.
 */
function mockDocument(content = "const value = 1;"): void {
  spyOn(filesystem, "stat").mockResolvedValue({
    size: content.length,
    isFile: () => true,
  } as Stats);
  spyOn(fs, "readFile").mockResolvedValue(content);
}

// Dispose test-owned pools, even when a test assertion fails.
afterEach(async () => {
  try {
    for (const workspace of workspaces.splice(0)) {
      await workspace.dispose();
    }
  } finally {
    mock.restore();
  }
});

describe("LspWorkspace.create", () => {
  it("should warm eligible servers and retain startup failures as warnings when eager startup is enabled", async () => {
    const { loaded, server, get, poolFactory } = fixture();
    loaded.warnings.push("configuration warning");
    const unavailable = { ...server.config, name: "unavailable-server" };
    const rejected = { ...server.config, name: "rejected-server" };
    const { resolvedCommand: _resolvedCommand, ...uninstalled } = server.config;
    loaded.servers.push(
      unavailable,
      { ...server.config, name: "disabled-server", disabled: true },
      { ...uninstalled, name: "uninstalled-server" },
      { ...server.config, name: "biome" },
      { ...server.config, name: "swiftlint" },
      rejected,
    );
    get.mockImplementation((selected) => {
      if (selected.name === unavailable.name) {
        return Promise.reject(new Error("executable missing"));
      }
      if (selected.name === rejected.name) {
        return Promise.reject("launcher refused");
      }
      return Promise.resolve(server);
    });

    const workspace = await createWorkspace(poolFactory);

    expect(get.mock.calls.map(([selected]) => selected.name)).toEqual([
      server.config.name,
      unavailable.name,
      rejected.name,
    ]);
    expect(workspace.warnings).toEqual([
      "configuration warning",
      "unavailable-server: eager startup failed: executable missing",
      "rejected-server: eager startup failed: launcher refused",
    ]);
  });

  it.each([
    ["the project is untrusted", false, true, false],
    ["LSP is disabled", true, false, false],
    ["lazy startup is enabled", true, true, true],
  ] as const)(
    "should leave servers stopped when %s",
    async (_condition, trusted, enabled, lazy) => {
      const { loaded, get, poolFactory } = fixture();
      loaded.settings.enabled = enabled;
      loaded.settings.lazy = lazy;

      const workspace = await createWorkspace(poolFactory, trusted);

      expect(get).not.toHaveBeenCalled();
      expect(workspace.warnings).toEqual([]);
    },
  );

  it("should bound concurrent starts and order warnings by configuration when startups settle out of order", async () => {
    const { loaded, server, get, poolFactory } = fixture();
    const starts = Array.from({ length: STARTUP_SERVER_COUNT }, (_, index) => ({
      config: { ...server.config, name: `server-${index}` },
      started: Promise.withResolvers<void>(),
      result: Promise.withResolvers<LanguageServer>(),
    }));
    const [first, second, third, fourth, fifth] = starts;
    if (!(first && second && third && fourth && fifth)) {
      throw new Error("Expected five startup fixtures");
    }
    loaded.servers = starts.map((start) => start.config);
    let active = 0;
    let peak = 0;
    get.mockImplementation((selected) => {
      const start = starts.find((entry) => entry.config === selected);
      if (!start) {
        throw new Error("Unexpected startup configuration");
      }
      active++;
      peak = Math.max(peak, active);
      start.started.resolve();
      return start.result.promise.finally(() => {
        active--;
      });
    });
    const creating = createWorkspace(poolFactory);
    try {
      await first.started.promise;
      expect(get).toHaveBeenCalledTimes(EAGER_STARTUP_CONCURRENCY);
      expect(active).toBe(EAGER_STARTUP_CONCURRENCY);
      second.result.reject(new Error("second failed"));
      await fourth.started.promise;
      expect(get).toHaveBeenCalledTimes(EAGER_STARTUP_CONCURRENCY + 1);
      expect(active).toBe(EAGER_STARTUP_CONCURRENCY);
      third.result.resolve(server);
      await fifth.started.promise;
      expect(get).toHaveBeenCalledTimes(STARTUP_SERVER_COUNT);
      first.result.reject(new Error("first failed"));
      fourth.result.resolve(server);
      fifth.result.resolve(server);

      const workspace = await creating;

      expect(peak).toBe(EAGER_STARTUP_CONCURRENCY);
      expect(active).toBe(0);
      expect(get.mock.calls.map(([selected]) => selected.name)).toEqual(
        loaded.servers.map((selected) => selected.name),
      );
      expect(workspace.warnings).toEqual([
        "server-0: eager startup failed: first failed",
        "server-1: eager startup failed: second failed",
      ]);
    } finally {
      for (const start of starts) {
        start.result.resolve(server);
      }
      await creating;
    }
  });

  it("should reconcile committed edits and retain document snapshots when live servers match changed files", async () => {
    const { loaded, server, pool, poolFactory, applyEdit } = fixture();
    loaded.settings.lazy = true;
    const file = "/project/sample.ts";
    let snapshot: edits.DocumentSnapshot | undefined;
    server.document = (selected) => (selected === file ? snapshot : undefined);
    const sync = mock<LanguageServer["syncFile"]>().mockImplementation(() => {
      snapshot = { version: 2, content: "updated" };
      return Promise.resolve();
    });
    const syncStarted = Promise.withResolvers<void>();
    const synced = Promise.withResolvers<void>();
    server.syncFile = sync;
    const matching: LanguageServer = {
      ...server,
      config: { ...server.config, name: "matching-server" },
      document: () => undefined,
      syncFile: mock<LanguageServer["syncFile"]>().mockImplementation(() => {
        syncStarted.resolve();
        return synced.promise;
      }),
      saved: mock<LanguageServer["saved"]>().mockResolvedValue(undefined),
      notify: mock<LanguageServer["notify"]>().mockResolvedValue(undefined),
    };
    const unrelated: LanguageServer = {
      ...matching,
      config: { ...server.config, name: "python-server", fileTypes: [".py"] },
      syncFile: mock<LanguageServer["syncFile"]>().mockResolvedValue(undefined),
      saved: mock<LanguageServer["saved"]>().mockResolvedValue(undefined),
      notify: mock<LanguageServer["notify"]>().mockResolvedValue(undefined),
    };
    const dead: LanguageServer = {
      ...matching,
      config: { ...server.config, name: "dead-server" },
      isAlive: false,
      syncFile: mock<LanguageServer["syncFile"]>().mockResolvedValue(undefined),
      saved: mock<LanguageServer["saved"]>().mockResolvedValue(undefined),
      notify: mock<LanguageServer["notify"]>().mockResolvedValue(undefined),
    };
    loaded.servers.push(matching.config, unrelated.config, dead.config);
    pool.clients.mockReturnValue([server, matching, unrelated, dead]);
    const transaction = spyOn(edits, "applyWorkspaceEdit")
      .mockResolvedValueOnce({
        applied: true,
        summary: ["Applied sample.ts"],
        changes: [{ kind: "edit", file, files: [file] }],
      })
      .mockResolvedValue({ applied: true, summary: [], changes: [] });
    await createWorkspace(poolFactory);

    const editing = applyEdit({});
    try {
      await Promise.race([
        syncStarted.promise,
        editing.then(() => {
          throw new Error(
            "Expected matching-server synchronization before edit completion",
          );
        }),
      ]);
      expect(matching.saved).not.toHaveBeenCalled();
      expect(matching.notify).not.toHaveBeenCalled();
      synced.resolve();
      expect(await editing).toEqual({ applied: true });
    } finally {
      synced.resolve();
      await editing;
    }
    for (const client of [server, matching]) {
      expect(client.syncFile).toHaveBeenCalledWith(
        file,
        undefined,
        expect.any(AbortSignal),
      );
      expect(client.saved).toHaveBeenCalledWith(file);
      expect(client.notify).toHaveBeenCalledWith(
        "workspace/didChangeWatchedFiles",
        {
          changes: [{ uri: "file:///project/sample.ts", type: 2 }],
        },
      );
    }
    for (const client of [unrelated, dead]) {
      expect(client.syncFile).not.toHaveBeenCalled();
      expect(client.saved).not.toHaveBeenCalled();
    }
    expect(dead.notify).not.toHaveBeenCalled();
    expect(transaction.mock.calls[0]?.[1].documents?.size).toBe(0);
    await applyEdit({});
    expect(transaction.mock.calls[1]?.[1].documents).toEqual(
      new Map([[file, { version: 2, content: "updated" }]]),
    );
  });

  it("should leave servers and tracked documents unchanged when an edit is rejected before committing", async () => {
    const { loaded, server, pool, poolFactory, applyEdit } = fixture();
    loaded.settings.lazy = true;
    server.document = () => ({ version: 1, content: "original" });
    pool.clients.mockReturnValue([server]);
    const transaction = spyOn(edits, "applyWorkspaceEdit").mockResolvedValue({
      applied: false,
      summary: [],
      changes: [],
      failureReason: "document changed",
    });
    await createWorkspace(poolFactory);

    expect(await applyEdit({})).toEqual({
      applied: false,
      failureReason: "document changed",
    });
    await applyEdit({});
    expect(transaction.mock.calls[1]?.[1].documents?.size).toBe(0);
    expect(pool.clients).not.toHaveBeenCalled();
    expect(server.syncFile).not.toHaveBeenCalled();
    expect(server.saved).not.toHaveBeenCalled();
    expect(server.closeFile).not.toHaveBeenCalled();
    expect(server.notify).not.toHaveBeenCalled();
  });

  it.each([
    ["the project is untrusted", false, true],
    ["LSP is disabled", true, false],
  ] as const)(
    "should reject server edits without acquiring effects when %s",
    async (_condition, trusted, enabled) => {
      const { loaded, pool, poolFactory, applyEdit } = fixture();
      loaded.settings.enabled = enabled;
      const transaction = spyOn(edits, "applyWorkspaceEdit").mockResolvedValue({
        applied: true,
        summary: [],
        changes: [],
      });
      await createWorkspace(poolFactory, trusted);

      expect(await applyEdit({})).toEqual({
        applied: false,
        failureReason: "LSP workspace untrusted, disabled, or disposed",
      });
      expect(transaction).not.toHaveBeenCalled();
      expect(pool.get).not.toHaveBeenCalled();
      expect(pool.clients).not.toHaveBeenCalled();
    },
  );
});

describe("LspWorkspace.execute", () => {
  it("should aggregate negotiated capabilities and startup failures while excluding disabled servers and CLI linters", async () => {
    const { loaded, server, get, poolFactory } = fixture();
    loaded.settings.lazy = true;
    loaded.servers.push(
      { ...server.config, name: "broken-server" },
      { ...server.config, name: "disabled-server", disabled: true },
      { ...server.config, name: "biome" },
    );
    get.mockImplementation((selected) =>
      selected.name === "broken-server"
        ? Promise.reject(new Error("launch denied"))
        : Promise.resolve(server),
    );
    const workspace = await createWorkspace(poolFactory);
    const result = await workspace.execute({
      action: "capabilities",
      file: "*",
    });
    expect(result.isError).not.toBe(true);
    expect(result.text).toBe(
      'test-server:\n{\n  "hoverProvider": true\n}\n\nbroken-server: failed to start (launch denied)',
    );
    expect(get.mock.calls.map(([selected]) => selected.name)).toEqual([
      "test-server",
      "broken-server",
    ]);
    expect(result.details).toMatchObject({
      action: "capabilities",
      serverName: "test-server, broken-server",
      success: true,
    });
  });

  it.each([
    [
      "no configured server matches the file",
      "sample.py",
      "No language servers configured",
      0,
    ],
    [
      "the matching server cannot start",
      "sample.ts",
      "failed to start (launch denied)",
      1,
    ],
  ] as const)(
    "should report unavailable capabilities when %s",
    async (_condition, file, message, acquisitions) => {
      const { loaded, get, poolFactory } = fixture();
      loaded.settings.lazy = true;
      get.mockRejectedValue(new Error("launch denied"));
      const workspace = await createWorkspace(poolFactory);
      const result = await workspace.execute({ action: "capabilities", file });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(message);
      expect(get).toHaveBeenCalledTimes(acquisitions);
    },
  );

  it("should filter workspace symbols case-insensitively and deduplicate locations while retaining failed sources", async () => {
    const { loaded, server, get, request, poolFactory } = fixture();
    loaded.settings.lazy = true;
    loaded.servers.push(
      { ...server.config, name: "second-server" },
      { ...server.config, name: "failed-server" },
    );
    const range = {
      start: { line: 2, character: 4 },
      end: { line: 2, character: 10 },
    };
    const widget = {
      name: "Widget",
      kind: 5,
      containerName: "UI",
      location: { uri: "file:///project/ui.ts", range },
    };
    request.mockResolvedValue([
      widget,
      widget,
      {
        name: "render",
        kind: 12,
        containerName: "WidgetFactory",
        location: { uri: "file:///project/factory.ts", range },
      },
      {
        name: "bootstrap",
        kind: 12,
        location: { uri: "file:///project/widget-start.ts" },
      },
      {
        name: "Unrelated",
        kind: 5,
        location: { uri: "file:///project/other.ts", range },
      },
    ]);
    get.mockImplementation((selected) =>
      selected.name === "failed-server"
        ? Promise.reject(new Error("server refused"))
        : Promise.resolve(server),
    );
    const workspace = await createWorkspace(poolFactory);
    const result = await workspace.execute({
      action: "symbols",
      file: "*",
      query: "  WIDGET  ",
    });
    expect(result.isError).not.toBe(true);
    expect(result.text).toBe(
      '3 workspace symbol(s) matching "WIDGET":\nWidget (UI) [kind 5] ui.ts:3:5\nrender (WidgetFactory) [kind 12] factory.ts:3:5\nbootstrap [kind 12] widget-start.ts (location unresolved)\nServer failures:\nfailed-server: server refused',
    );
    expect(request).toHaveBeenCalledTimes(2);
    for (const [method, params, signal] of request.mock.calls) {
      expect(method).toBe("workspace/symbol");
      expect(params).toEqual({ query: "WIDGET" });
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("should bound displayed workspace symbols while retaining the total match count", async () => {
    const { loaded, request, poolFactory } = fixture();
    loaded.settings.lazy = true;
    request.mockResolvedValue(
      Array.from({ length: 201 }, (_, index) => ({
        name: `Widget${index}`,
        kind: 5,
        location: { uri: "file:///project/widgets.ts" },
      })),
    );
    const workspace = await createWorkspace(poolFactory);
    const result = await workspace.execute({
      action: "symbols",
      file: "*",
      query: "Widget",
    });
    expect(result.text).toContain("201 workspace symbol(s)");
    expect(result.text).toContain("Widget199 [kind 5]");
    expect(result.text).not.toContain("Widget200 [kind 5]");
    expect(result.text).toContain("…1 symbols elided…");
  });

  it("should distinguish an empty symbol search from invalid peer data and unavailable servers", async () => {
    const { loaded, request, get, poolFactory } = fixture();
    loaded.settings.lazy = true;
    const workspace = await createWorkspace(poolFactory);
    request.mockResolvedValue([]);
    const empty = await workspace.execute({
      action: "symbols",
      file: "*",
      query: "missing",
    });
    expect(empty.isError).not.toBe(true);
    expect(empty.text).toBe('No symbols matching "missing"');
    request.mockResolvedValue({ symbols: [] });
    const invalid = await workspace.execute({
      action: "symbols",
      file: "*",
      query: "missing",
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain("Invalid symbol response");
    const before = get.mock.calls.length;
    const missingQuery = await workspace.execute({
      action: "symbols",
      file: "*",
      query: " ",
    });
    expect(missingQuery.isError).toBe(true);
    expect(missingQuery.text).toContain("query parameter required");
    expect(get).toHaveBeenCalledTimes(before);
    loaded.servers = [];
    const unavailable = await workspace.execute({
      action: "symbols",
      file: "*",
      query: "missing",
    });
    expect(unavailable.isError).toBe(true);
    expect(unavailable.text).toContain(
      "No language servers configured and available",
    );
  });

  it("should reload compatible servers and restart notification failures while preserving server-specific errors", async () => {
    const { loaded, server, get, request, pool, poolFactory } = fixture();
    loaded.settings.lazy = true;
    loaded.servers = [
      { ...server.config, name: "rust-analyzer", command: "rust-analyzer" },
      {
        ...server.config,
        name: "restart-server",
        settings: { mode: "strict" },
      },
      { ...server.config, name: "failed-server" },
    ];
    request.mockRejectedValue({ code: -32_601 });
    const rustNotify =
      mock<LanguageServer["notify"]>().mockResolvedValue(undefined);
    const restartNotify = mock<LanguageServer["notify"]>().mockRejectedValue(
      new Error("transport lost"),
    );
    get.mockImplementation((selected) => {
      if (selected.name === "failed-server") {
        return Promise.reject(new Error("launch denied"));
      }
      return Promise.resolve({
        ...server,
        config: selected,
        notify: selected.name === "restart-server" ? restartNotify : rustNotify,
      });
    });
    const { stop } = pool;
    const workspace = await createWorkspace(poolFactory);
    const result = await workspace.execute({ action: "reload", file: "*" });
    expect(result.isError).not.toBe(true);
    expect(result.text).toBe(
      "rust-analyzer: reloaded\nrestart-server: restarted after configuration notification failed (transport lost)\nfailed-server: reload failed: launch denied",
    );
    expect(request).toHaveBeenCalledWith(
      "rust-analyzer/reloadWorkspace",
      // biome-ignore lint/plugin/biome-rules/use-undefined: rust-analyzer reloadWorkspace is a parameterless JSON-RPC request.
      null,
      expect.any(AbortSignal),
    );
    expect(restartNotify).toHaveBeenCalledWith(
      "workspace/didChangeConfiguration",
      { settings: { mode: "strict" } },
    );
    expect(stop).toHaveBeenCalledWith(["restart-server"]);
    expect(get.mock.calls.map(([selected]) => selected.name)).toEqual([
      "rust-analyzer",
      "restart-server",
      "failed-server",
      "restart-server",
    ]);
  });

  it("should cancel server startup and release its deadline when the action exceeds the minimum timeout", async () => {
    const { loaded, get, poolFactory } = fixture();
    loaded.settings.lazy = true;
    // biome-ignore lint/plugin/biome-rules/use-undefined: A null-prototype object safely models the opaque host timer handle.
    const timerHandle: NodeJS.Timeout = Object.create(null);
    const schedule = spyOn(timers, "setTimeout").mockReturnValue(timerHandle);
    const clear = spyOn(timers, "clearTimeout").mockReturnValue(undefined);
    const response = Promise.withResolvers<LanguageServer>();
    get.mockImplementation((_config, signal) => {
      signal?.addEventListener("abort", () => response.reject(signal.reason), {
        once: true,
      });
      return response.promise;
    });
    const workspace = await createWorkspace(poolFactory);
    const pending = workspace.execute({ action: "capabilities", timeout: 1 });
    const [expire, delay] = schedule.mock.calls[0] ?? [];
    expect(delay).toBe(ACTION_DEADLINE_MS);
    if (!expire) {
      throw new Error("Expected action deadline");
    }
    expire();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.text).toContain("LSP capabilities timed out after 5s");
    expect(get.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(clear).toHaveBeenCalledWith(timerHandle);
  });

  it("should replace and dispose injected pools in order when reloading changes the idle timeout", async () => {
    const initialIdleTimeoutMs = 1000;
    const reloadedIdleTimeoutMs = 2000;
    const { loaded, server, pool, poolFactory } = fixture();
    loaded.settings.lazy = true;
    loaded.idleTimeoutMs = initialIdleTimeoutMs;
    const stopping = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    pool.dispose.mockImplementation(() => {
      stopping.resolve();
      return stopped.promise;
    });
    const replacement = {
      get: mock<LanguageServerPool["get"]>().mockResolvedValue(server),
      clients: mock<LanguageServerPool["clients"]>().mockReturnValue([server]),
      stop: mock<LanguageServerPool["stop"]>().mockResolvedValue(undefined),
      dispose:
        mock<LanguageServerPool["dispose"]>().mockResolvedValue(undefined),
    };
    let onApplyEdit: Parameters<PoolFactory>[2] | undefined;
    const factory = mock<PoolFactory>()
      .mockImplementationOnce(poolFactory)
      .mockImplementation((_cwd, _idleTimeoutMs, applyEdit) => {
        onApplyEdit = applyEdit;
        return replacement;
      });
    const transaction = spyOn(edits, "applyWorkspaceEdit").mockResolvedValue({
      applied: true,
      summary: [],
      changes: [
        {
          kind: "edit",
          file: "/project/sample.ts",
          files: ["/project/sample.ts"],
        },
      ],
    });
    const workspace = await createWorkspace(factory);
    spyOn(config, "loadLspConfig").mockResolvedValue({
      ...loaded,
      idleTimeoutMs: reloadedIdleTimeoutMs,
    });
    const reload = workspace.execute({ action: "reload", file: "*" });
    try {
      await stopping.promise;
      expect(factory).toHaveBeenCalledTimes(1);
      expect(replacement.get).not.toHaveBeenCalled();
      stopped.resolve();
      expect((await reload).isError).not.toBe(true);
      expect(pool.get).not.toHaveBeenCalled();
      expect(replacement.get).toHaveBeenCalledTimes(1);
      expect(
        factory.mock.calls.map(([, idleTimeoutMs]) => idleTimeoutMs),
      ).toEqual([initialIdleTimeoutMs, reloadedIdleTimeoutMs]);
      if (!onApplyEdit) {
        throw new Error(
          "Expected the replacement pool to receive an edit callback",
        );
      }
      expect(await onApplyEdit({}, server)).toEqual({ applied: true });
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(replacement.clients).toHaveBeenCalledTimes(1);
      expect(pool.clients).not.toHaveBeenCalled();
      expect(server.saved).toHaveBeenCalledWith("/project/sample.ts");
      await workspace.dispose();
      expect(pool.dispose).toHaveBeenCalledTimes(1);
      expect(replacement.dispose).toHaveBeenCalledTimes(1);
      expect(await onApplyEdit({}, server)).toEqual({
        applied: false,
        failureReason: "LSP workspace untrusted, disabled, or disposed",
      });
      expect(transaction).toHaveBeenCalledTimes(1);
    } finally {
      stopped.resolve();
      await reload;
      await workspace.dispose();
    }
  });

  it("should sort unverified diagnostic sources without claiming a verified clean file", async () => {
    const { loaded, server, get, poolFactory } = fixture();
    loaded.settings.lazy = true;
    const names = ["zeta-server", "alpha-server", "middle-server"];
    loaded.servers = names.map((name) => ({ ...server.config, name }));
    const diagnostics = mock<LanguageServer["diagnostics"]>().mockResolvedValue(
      {
        items: [],
        freshness: "unversioned",
      },
    );
    get.mockImplementation((selected) =>
      Promise.resolve({ ...server, config: selected, diagnostics }),
    );
    spyOn(filesystem, "stat").mockResolvedValue({
      size: 3,
      isFile: () => true,
    } as Stats);
    spyOn(fs, "readFile").mockResolvedValue("old");
    const workspace = await createWorkspace(poolFactory);

    const result = await workspace.execute({
      action: "diagnostics",
      file: "/project/sample.ts",
    });

    expect(result.isError).not.toBe(true);
    expect(result.text).toBe(
      "sample.ts: No diagnostics reported\nDiagnostic freshness-unverified from alpha-server, middle-server, zeta-server: unversioned publications may be stale.",
    );
    expect(diagnostics).toHaveBeenCalledTimes(names.length);
  });

  it("should select one code action by a case-insensitive title fragment without executing other actions", async () => {
    const { loaded, request, poolFactory } = fixture();
    loaded.settings.lazy = true;
    spyOn(filesystem, "stat").mockResolvedValue({
      size: "const value = 1;".length,
      isFile: () => true,
    } as Stats);
    spyOn(fs, "readFile").mockResolvedValue("const value = 1;");
    request
      .mockResolvedValueOnce([
        {
          title: "Organize imports",
          command: { title: "Organize", command: "test.organize" },
        },
        {
          title: "Fix unused VALUE",
          command: { title: "Fix", command: "test.fixUnused" },
        },
      ])
      // biome-ignore lint/plugin/biome-rules/use-undefined: LSP workspace/executeCommand may return a JSON null result.
      .mockResolvedValue(null);
    const workspace = await createWorkspace(poolFactory);

    const result = await workspace.execute({
      action: "code_actions",
      file: "/project/sample.ts",
      line: 1,
      symbol: "value",
      query: "uNuSeD value",
      apply: true,
    });

    expect(result.isError).not.toBe(true);
    expect(result.text).toBe(
      'Applied code action "Fix unused VALUE":\nExecuted command: test.fixUnused',
    );
    expect(
      request.mock.calls.filter(
        ([method]) => method === "workspace/executeCommand",
      ),
    ).toEqual([
      [
        "workspace/executeCommand",
        { command: "test.fixUnused", arguments: [] },
        expect.any(AbortSignal),
      ],
    ]);
  });

  it.each([
    {
      condition: "duplicate edits",
      conflictStart: 6,
      conflictText: "renamed",
      laterText: "const renamed = 2;",
    },
    {
      condition: "overlapping edits",
      conflictStart: 8,
      conflictText: "conflict",
      laterText: "const vaconflict = 2;",
    },
  ])(
    "should discard the later conflicting rename reference and preserve independent edits when servers return $condition",
    async ({ conflictStart, conflictText, laterText }) => {
      const { loaded, server, get, request, poolFactory } = fixture();
      loaded.settings.lazy = true;
      const file = "/project/sample.ts";
      const destination = "/project/moved.ts";
      const uri = edits.fileToUri(file);
      const original = "const value = 1;";
      const first = {
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
        newText: "renamed",
      };
      const conflicting = {
        range: {
          start: { line: 0, character: conflictStart },
          end: { line: 0, character: 11 },
        },
        newText: conflictText,
      };
      const independent = {
        range: {
          start: { line: 0, character: 14 },
          end: { line: 0, character: 15 },
        },
        newText: "2",
      };
      expect(edits.applyTextEdits(original, [first])).toBe(
        "const renamed = 1;",
      );
      expect(edits.applyTextEdits(original, [conflicting, independent])).toBe(
        laterText,
      );
      const firstResponse = { changes: { [uri]: [first] } };
      const laterResponse = {
        changes: { [uri]: [conflicting, independent] },
      };
      request.mockResolvedValue(firstResponse);
      const secondRequest =
        mock<LanguageServer["request"]>().mockResolvedValue(laterResponse);
      const second: LanguageServer = {
        ...server,
        config: { ...server.config, name: "later-server" },
        request: secondRequest as LanguageServer["request"],
      };
      loaded.servers.push(second.config);
      get.mockImplementation((selected) =>
        Promise.resolve(selected.name === second.config.name ? second : server),
      );
      spyOn(fs, "lstat").mockImplementation(((target: unknown) =>
        String(target) === destination
          ? Promise.reject(
              Object.assign(new Error("missing destination"), {
                code: "ENOENT",
              }),
            )
          : Promise.resolve({
              isFile: () => true,
              isDirectory: () => false,
            } as Stats)) as typeof fs.lstat);
      spyOn(fs, "readFile").mockResolvedValue(original);
      spyOn(filesystem, "stat").mockResolvedValue({
        size: original.length,
        isFile: () => true,
      } as Stats);
      const writeFile = spyOn(fs, "writeFile").mockResolvedValue(undefined);
      const rename = spyOn(fs, "rename").mockResolvedValue(undefined);
      const transaction = spyOn(edits, "applyWorkspaceEdit").mockImplementation(
        (edit) => {
          const response = edit as WorkspaceEdit;
          for (const textEdits of Object.values(response.changes ?? {})) {
            edits.applyTextEdits(original, textEdits);
          }
          for (const change of response.documentChanges ?? []) {
            if ("textDocument" in change) {
              edits.applyTextEdits(original, change.edits as TextEdit[]);
            }
          }
          return Promise.resolve({ applied: true, summary: [], changes: [] });
        },
      );
      const workspace = await createWorkspace(poolFactory);

      const result = await workspace.execute({
        action: "rename_file",
        file,
        // biome-ignore lint/style/useNamingConvention: LSP tool schema preserves the external new_name argument.
        new_name: destination,
        apply: false,
      });

      expect(result.isError).not.toBe(true);
      expect(result.text).toContain("Rename preview");
      expect(result.text).toContain(
        "later-server: discarded 1 overlapping/duplicate reference edit(s)",
      );
      expect(transaction.mock.calls.at(-1)?.[0]).toEqual({
        documentChanges: [
          // biome-ignore lint/plugin/biome-rules/use-undefined: LSP TextDocumentEdit requires null for an unversioned document identifier.
          { textDocument: { uri, version: null }, edits: [first, independent] },
          {
            kind: "rename",
            oldUri: uri,
            newUri: edits.fileToUri(destination),
          },
        ],
        changeAnnotations: {},
      });
      for (const [, options] of transaction.mock.calls) {
        expect(options.preview).toBe(true);
      }
      expect(server.syncFile).toHaveBeenCalledWith(
        file,
        original,
        expect.any(AbortSignal),
      );
      expect(request).toHaveBeenCalledTimes(1);
      expect(secondRequest).toHaveBeenCalledTimes(1);
      expect(writeFile).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(server.saved).not.toHaveBeenCalled();
      expect(server.notify).not.toHaveBeenCalled();
    },
  );

  it("should describe configured server states without starting disabled, unavailable or on-demand tools", async () => {
    const { loaded, server, get, pool, poolFactory } = fixture();
    loaded.settings.lazy = true;
    const { resolvedCommand: _resolvedCommand, ...missing } = server.config;
    loaded.servers = [
      { ...server.config, name: "disabled", disabled: true },
      { ...missing, name: "missing" },
      { ...server.config, name: "biome" },
      server.config,
      { ...server.config, name: "stopped" },
    ];
    pool.clients.mockReturnValue([server]);
    const workspace = await createWorkspace(poolFactory);
    const status = await workspace.execute({ action: "status" });
    expect(status.text.split("\n")).toEqual([
      "LSP: enabled; lazy; session-owned servers",
      "disabled: disabled; root=/project; command=/installed/test-server",
      "missing: unavailable (executable not installed); root=/project; command=test-server",
      "biome: CLI linter (runs on demand); root=/project; command=/installed/test-server",
      "test-server: running; root=/project; command=/installed/test-server",
      "stopped: configured, not started; root=/project; command=/installed/test-server",
    ]);
    expect(get).not.toHaveBeenCalled();
  });

  it("should retain diagnostic uncertainty and reject ambiguous or disabled action selections", async () => {
    const { loaded, server, request, poolFactory } = fixture();
    loaded.settings.lazy = true;
    mockDocument();
    const diagnostics = spyOn(server, "diagnostics").mockResolvedValue({
      items: [],
      freshness: "unversioned",
    });
    request.mockResolvedValue([
      { title: "Fix value", kind: "quickfix", isPreferred: true },
      { title: "Fix import", disabled: { reason: "Read-only document" } },
    ]);
    const workspace = await createWorkspace(poolFactory);
    const target = {
      action: "code_actions",
      file: "sample.ts",
      symbol: "value",
    } as const;
    const list = await workspace.execute({ ...target, query: "quickfix" });
    expect(list.text).toBe(
      "2 action(s):\n0: [quickfix] Fix value (preferred)\n1: [action] Fix import (disabled: Read-only document)\nDiagnostic context freshness-unverified from test-server: unversioned diagnostics may be stale.",
    );
    const ambiguous = await workspace.execute({
      ...target,
      apply: true,
      query: "fix",
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain('Multiple code actions match "fix"');
    const disabled = await workspace.execute({
      ...target,
      apply: true,
      query: "1",
    });
    expect(disabled.isError).toBe(true);
    expect(disabled.text).toContain("Code action disabled: Read-only document");
    diagnostics.mockRejectedValueOnce(new Error("diagnostics disconnected"));
    // biome-ignore lint/plugin/biome-rules/use-undefined: An LSP action request may return null.
    request.mockResolvedValue(null);
    const unavailable = await workspace.execute(target);
    expect(unavailable.isError).toBe(true);
    expect(unavailable.text).toBe(
      "No code actions available\nDiagnostic context unavailable: diagnostics disconnected",
    );
    expect(
      request.mock.calls.every(
        ([method]) => method === "textDocument/codeAction",
      ),
    ).toBe(true);
  });

  it("should follow committed rename chains and suppress commands when reconciliation later fails", async () => {
    const { loaded, server, pool, request, poolFactory } = fixture();
    loaded.settings.lazy = true;
    mockDocument();
    const source = "/project/sample.ts";
    const intermediate = "/project/intermediate.ts";
    const final = "/project/final.py";
    const doomed = "/project/doomed.ts";
    const gone = "/project/gone.py";
    const created = "/project/created.ts";
    server.document = (file) =>
      [source, doomed].includes(file)
        ? { version: 1, content: "const value = 1;" }
        : undefined;
    pool.clients.mockReturnValue([server]);
    spyOn(edits, "applyWorkspaceEdit").mockImplementation(async () => ({
      applied: true,
      summary: ["Committed document changes"],
      changes: [
        {
          kind: "rename",
          file: source,
          newFile: intermediate,
          files: [source],
        },
        {
          kind: "rename",
          file: intermediate,
          newFile: final,
          files: [intermediate],
          removedFiles: [final],
        },
        { kind: "rename", file: doomed, newFile: gone, files: [doomed] },
        { kind: "delete", file: gone, files: [gone] },
        { kind: "create", file: created, files: [created] },
      ],
    }));
    request.mockResolvedValue([
      {
        title: "Move documents",
        edit: {},
        command: { title: "Refresh", command: "test.refresh" },
      },
    ]);
    const workspace = await createWorkspace(poolFactory);
    const target = {
      action: "code_actions",
      file: source,
      symbol: "value",
      apply: true,
      query: "0",
    } as const;
    const committed = await workspace.execute(target);
    expect(committed.isError).not.toBe(true);
    for (const removed of [source, intermediate, doomed, gone]) {
      expect(server.closeFile).toHaveBeenCalledWith(removed);
      expect(server.saved).not.toHaveBeenCalledWith(removed);
    }
    expect(server.saved).toHaveBeenCalledWith(final);
    expect(server.saved).toHaveBeenCalledWith(created);
    expect(server.notify).toHaveBeenCalledWith(
      "workspace/didChangeWatchedFiles",
      {
        changes: [
          ...[source, intermediate, doomed, gone].map((file) => ({
            uri: edits.fileToUri(file),
            type: 3,
          })),
          ...[final, created].map((file) => ({
            uri: edits.fileToUri(file),
            type: 1,
          })),
        ],
      },
    );
    expect(committed.text).toContain("Executed command: test.refresh");
    const commands = request.mock.calls.filter(
      ([method]) => method === "workspace/executeCommand",
    ).length;
    spyOn(server, "saved").mockRejectedValue(
      new Error("save notification failed"),
    );
    const failed = await workspace.execute(target);
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain(
      'Code action "Move documents" failed:\nCommitted document changes',
    );
    expect(failed.text).toContain(
      "Filesystem changes committed, but server synchronization failed:\ntest-server: save notification failed",
    );
    expect(
      request.mock.calls.filter(
        ([method]) => method === "workspace/executeCommand",
      ),
    ).toHaveLength(commands);
  });

  registerDocumentActionTests();
});

/**
 * Registers direct action cases without moving baseline workspace tests.
 * @example describe("LspWorkspace.execute", registerDocumentActionTests);
 */
function registerDocumentActionTests(): void {
  describe("document results", () => {
    const outputLimit = 60_000;
    it.each([
      [
        "oversized hover text",
        "hover",
        { contents: "x".repeat(outputLimit + 1) },
        `${"x".repeat(outputLimit)}\n…output truncated at 60000 characters…`,
      ],
      // biome-ignore lint/plugin/biome-rules/use-undefined: The LSP hover response may be null.
      ["missing hover information", "hover", null, "No hover information"],
      ["empty document symbols", "symbols", [], "No symbols found"],
    ] as const)(
      "should bound or explain %s",
      async (_condition, action, response, text) => {
        const { loaded, request, poolFactory } = fixture();
        loaded.settings.lazy = true;
        mockDocument();
        request.mockResolvedValue(response);
        const workspace = await createWorkspace(poolFactory);
        const result = await workspace.execute({ action, file: "sample.ts" });
        expect(result.isError).not.toBe(true);
        expect(result.text).toBe(text);
      },
    );

    it("should limit document-symbol output and explain omitted matches", async () => {
      const { loaded, request, poolFactory } = fixture();
      loaded.settings.lazy = true;
      mockDocument();
      const symbolLimit = 200;
      const range = {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      };
      request.mockResolvedValue(
        Array.from({ length: symbolLimit + 1 }, (_, index) => ({
          name: `symbol${index}`,
          kind: 13,
          range,
          selectionRange: range,
        })),
      );
      const workspace = await createWorkspace(poolFactory);

      const result = await workspace.execute({
        action: "symbols",
        file: "sample.ts",
      });

      expect(result.text).toContain(`symbol${symbolLimit - 1} `);
      expect(result.text).not.toContain(`symbol${symbolLimit} `);
      expect(result.text).toContain("…1 symbols elided…");
    });

    it("should render raw results and attribute request failures without opening an unspecified document", async () => {
      const { loaded, server, request, poolFactory } = fixture();
      loaded.settings.lazy = true;
      const workspace = await createWorkspace(poolFactory);
      const target = { action: "request", query: "test/state" } as const;
      const empty = await workspace.execute(target);
      expect(empty.text).toBe("test-server ← test/state:\nnull");
      expect(server.syncFile).not.toHaveBeenCalled();
      const invalid = await workspace.execute({ ...target, payload: "{" });
      expect(invalid.isError).toBe(true);
      expect(invalid.text).toContain("Invalid JSON in payload");
      request.mockRejectedValue(new Error("permission denied"));
      const failed = await workspace.execute({
        ...target,
        payload: '{"key":"value"}',
      });
      expect(failed.isError).toBe(true);
      expect(failed.text).toBe(
        'LSP error from test-server on test/state: permission denied\n  params: {"key":"value"}',
      );
      expect(failed.details).toMatchObject({
        serverName: "test-server",
        success: false,
      });
    });
  });

  describe("rename_file", () => {
    it("should combine annotated references and resource edits while retaining unavailable-peer notes and rejecting changed sources", async () => {
      const { loaded, server, get, request, poolFactory } = fixture();
      loaded.settings.lazy = true;
      mockDocument();
      const source = "/project/source";
      const destination = "/project/moved";
      const file = `${source}/a.ts`;
      const uri = edits.fileToUri(file);
      const sidecar = {
        kind: "create",
        uri: "file:///project/sidecar.ts",
        annotationId: "sidecar",
      };
      const reference = {
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
        newText: "renamed",
        annotationId: "reference",
      };
      spyOn(filesystem, "lstat").mockImplementation((candidatePath) =>
        candidatePath === destination
          ? Promise.reject(
              Object.assign(new Error("missing"), { code: "ENOENT" }),
            )
          : Promise.resolve({ isDirectory: () => true } as Stats),
      );
      const discovery = spyOn(edits, "directoryFiles").mockResolvedValue([
        file,
        `${source}/notes.py`,
      ]);
      server.document = (documentFile) =>
        documentFile === file
          ? { version: 1, content: "const value = 1;" }
          : undefined;
      request.mockResolvedValue({
        changeAnnotations: {
          reference: { label: "Update import" },
          sidecar: { label: "Create sidecar" },
        },
        documentChanges: [
          {
            textDocument: { uri, version: 1 },
            edits: [reference],
          },
          sidecar,
          {
            textDocument: { uri, version: 1 },
            edits: [{ ...reference, newText: "later" }],
          },
        ],
      });
      loaded.servers.push(
        { ...server.config, name: "unavailable" },
        { ...server.config, name: "unsupported" },
      );
      get.mockImplementation((selected) => {
        if (selected.name === "unavailable") {
          return Promise.reject(new Error("executable missing"));
        }
        return Promise.resolve(
          selected.name === "unsupported"
            ? {
                ...server,
                config: selected,
                request: mock<LanguageServer["request"]>().mockRejectedValue({
                  code: -32_601,
                }) as LanguageServer["request"],
              }
            : server,
        );
      });
      const transaction = spyOn(edits, "applyWorkspaceEdit").mockResolvedValue({
        applied: true,
        summary: [],
        changes: [],
      });
      const workspace = await createWorkspace(poolFactory);
      const target = {
        action: "rename_file",
        file: source,
        // biome-ignore lint/style/useNamingConvention: LSP tool schema preserves the external new_name argument.
        new_name: destination,
        apply: false,
      } as const;
      const preview = await workspace.execute(target);
      expect(preview.isError).not.toBe(true);
      expect(preview.text).toContain(
        "Rename preview: /project/source → /project/moved (2 file(s))",
      );
      expect(preview.text).toContain(
        "unavailable: failed to start: executable missing",
      );
      expect(preview.text).toContain(
        "unsupported: willRenameFiles is not supported",
      );
      expect(transaction.mock.calls.at(-1)?.[0]).toEqual({
        documentChanges: [
          {
            // biome-ignore lint/plugin/biome-rules/use-undefined: Aggregated reference edits are unversioned.
            textDocument: { uri, version: null },
            edits: [{ ...reference, annotationId: "test-server:reference" }],
          },
          { ...sidecar, annotationId: "test-server:sidecar" },
          {
            // biome-ignore lint/plugin/biome-rules/use-undefined: Aggregated reference edits are unversioned.
            textDocument: { uri, version: null },
            edits: [
              {
                ...reference,
                newText: "later",
                annotationId: "test-server:reference",
              },
            ],
          },
          {
            kind: "rename",
            oldUri: edits.fileToUri(source),
            newUri: edits.fileToUri(destination),
          },
        ],
        changeAnnotations: {
          "test-server:reference": { label: "Update import" },
          "test-server:sidecar": { label: "Create sidecar" },
        },
      });
      expect(server.syncFile).not.toHaveBeenCalledWith(
        `${source}/notes.py`,
        expect.anything(),
        expect.anything(),
      );
      discovery
        .mockResolvedValueOnce([file])
        .mockResolvedValue([file, `${source}/new.ts`]);
      const before = transaction.mock.calls.length;
      const changed = await workspace.execute(target);
      expect(changed.isError).toBe(true);
      expect(changed.text).toContain(
        "Directory contents changed while computing rename references; no files moved",
      );
      expect(transaction).toHaveBeenCalledTimes(before + 1);
      discovery.mockResolvedValue([file]);
      transaction.mockResolvedValueOnce({
        applied: false,
        summary: [],
        changes: [],
        failureReason: "stale references",
      });
      const stale = await workspace.execute(target);
      expect(stale.isError).toBe(true);
      expect(stale.text).toContain(
        "Aborted rename: workspace/willRenameFiles failed. No files moved.",
      );
      expect(stale.text).toContain("test-server: stale references");
      expect(stale.text).toContain("Server notes:");
      expect(transaction).toHaveBeenCalledTimes(before + 2);
    });
  });

  describe("diagnostics", () => {
    it("should bound selected files and combine CLI findings with source failures without treating an unmatched or unknown workspace as clean", async () => {
      const { loaded, server, get, poolFactory } = fixture();
      loaded.settings.lazy = true;
      loaded.servers.push(
        { ...server.config, name: "biome" },
        { ...server.config, name: "disconnected" },
      );
      get.mockImplementation((candidate) =>
        candidate.name === "disconnected"
          ? Promise.reject(new Error("transport closed"))
          : Promise.resolve(server),
      );
      mockDocument();
      spyOn(filesystem, "stat").mockImplementation((file) =>
        file.includes("*")
          ? Promise.reject(
              Object.assign(new Error("missing"), { code: "ENOENT" }),
            )
          : Promise.resolve({ isFile: () => true, size: 16 } as Stats),
      );
      const entries = Array.from(
        { length: MAX_DIAGNOSTIC_TARGET_FILES + 1 },
        (_, index) => ({
          name: `sample-${index}.ts`,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        }),
      );
      spyOn(filesystem, "opendir").mockResolvedValue({
        [Symbol.asyncIterator]: () => {
          const iterator = entries.values();
          return { next: () => Promise.resolve(iterator.next()) };
        },
      });
      const lint = spyOn(linters, "lintWithCli").mockResolvedValue([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          severity: 2,
          message: "unused value",
        },
      ]);
      const workspace = await createWorkspace(poolFactory);
      const selected = await workspace.execute({
        action: "diagnostics",
        file: "*.ts",
      });
      expect(selected.isError).not.toBe(true);
      expect(
        selected.text.match(/sample-\d+\.ts: 0 error\(s\), 1 warning\(s\)/g),
      ).toHaveLength(MAX_DIAGNOSTIC_TARGET_FILES);
      expect(selected.text).not.toContain("sample-20.ts");
      expect(selected.text).toContain(
        "diagnostics limited to 20 matched files; narrow the glob",
      );
      expect(selected.text).toContain(
        "Server failures:\ndisconnected: transport closed",
      );
      expect(lint).toHaveBeenCalledTimes(MAX_DIAGNOSTIC_TARGET_FILES);
      const acquisitions = get.mock.calls.length;
      const unmatched = await workspace.execute({
        action: "diagnostics",
        file: "*.py",
      });
      expect(unmatched.text).toBe("No files matched pattern: *.py");
      expect(get).toHaveBeenCalledTimes(acquisitions);
      spyOn(fs, "access").mockRejectedValue(
        Object.assign(new Error("missing marker"), { code: "ENOENT" }),
      );
      const unknown = await workspace.execute({
        action: "diagnostics",
        file: "*",
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain("Cannot detect project type");
      expect(unknown.text).toContain("Workspace was not verified");
      expect(unknown.details).toMatchObject({
        action: "diagnostics",
        request: { action: "diagnostics", file: "*" },
        success: false,
      });
    });
  });
}

describe("LspWorkspace.afterMutation", () => {
  it("should bound the response and cancel pending feedback without reversing a successful host edit when feedback stalls", async () => {
    const { loaded, poolFactory } = fixture();
    loaded.settings.lazy = true;
    // biome-ignore lint/plugin/biome-rules/use-undefined: A null-prototype object safely models the opaque host timer handle.
    const timerHandle: NodeJS.Timeout = Object.create(null);
    const schedule = spyOn(timers, "setTimeout").mockReturnValue(timerHandle);
    const clear = spyOn(timers, "clearTimeout").mockReturnValue(undefined);
    const probe = Promise.withResolvers<Stats>();
    spyOn(filesystem, "stat").mockReturnValue(probe.promise);
    const workspace = await createWorkspace(poolFactory);
    const pending = workspace.afterMutation(["sample.ts"], "edit");
    const inner = schedule.mock.calls.find(
      ([, delay]) => delay === MUTATION_DEADLINE_MS,
    );
    const outer = schedule.mock.calls.find(
      ([, delay]) => delay === MUTATION_RESPONSE_DEADLINE_MS,
    );
    if (!(inner && outer)) {
      throw new Error("Expected mutation cancellation and response deadlines");
    }
    try {
      inner[0]();
      outer[0]();
      expect(await pending).toEqual({
        text: "LSP feedback timed out; the host edit already succeeded. Cancellation was requested for pending LSP work.",
        details: { action: "afterMutation", source: "edit" },
      });
    } finally {
      probe.reject(new Error("file probe canceled"));
      await workspace.dispose();
    }
    expect(clear).toHaveBeenCalledWith(timerHandle);
  });

  it("should skip unchanged CLI formatting and report guarded-application failures without reversing the host write", async () => {
    const { loaded, server, poolFactory } = fixture();
    loaded.settings.lazy = true;
    loaded.settings.formatOnWrite = true;
    loaded.servers = [{ ...server.config, name: "biome" }];
    const original = "const value = 1;";
    mockDocument(original);
    const format = spyOn(linters, "formatWithCli").mockResolvedValue(original);
    const transaction = spyOn(edits, "applyWorkspaceEdit").mockResolvedValue({
      applied: true,
      summary: [],
      changes: [],
    });
    const workspace = await createWorkspace(poolFactory);
    expect(
      await workspace.afterMutation(["sample.ts"], "write"),
    ).toBeUndefined();
    expect(transaction).not.toHaveBeenCalled();
    format.mockResolvedValue("const value = 2;");
    expect((await workspace.afterMutation(["sample.ts"], "write"))?.text).toBe(
      "Formatted sample.ts with biome",
    );
    expect(transaction.mock.calls[0]?.[0]).toEqual({
      changes: {
        "file:///project/sample.ts": [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: original.length },
            },
            newText: "const value = 2;",
          },
        ],
      },
    });
    transaction.mockResolvedValue({
      applied: false,
      summary: [],
      changes: [],
      failureReason: "host wrote newer content",
    });
    const failed = await workspace.afterMutation(["sample.ts"], "write");
    expect(failed?.text).toBe("Formatting failed: host wrote newer content");
    expect(failed?.isError).not.toBe(true);
    expect(failed?.details).toEqual({
      action: "afterMutation",
      source: "write",
    });
  });

  it("should select a capable formatter and discard unavailable, empty or stale formatting feedback", async () => {
    const { loaded, server, get, request, poolFactory } = fixture();
    loaded.settings.lazy = true;
    loaded.settings.formatOnWrite = true;
    const incapable = {
      ...server,
      config: { ...server.config, name: "no-formatter" },
      capabilities: {},
    };
    loaded.servers.unshift(incapable.config);
    get.mockImplementation((selected) =>
      Promise.resolve(
        selected.name === incapable.config.name ? incapable : server,
      ),
    );
    server.capabilities.documentFormattingProvider = true;
    mockDocument();
    server.document = () => ({ version: 1, content: "const value = 1;" });
    const transaction = spyOn(edits, "applyWorkspaceEdit").mockResolvedValue({
      applied: true,
      summary: [],
      changes: [],
    });
    const workspace = await createWorkspace(poolFactory);
    expect(
      await workspace.afterMutation(["sample.ts"], "write"),
    ).toBeUndefined();
    expect(transaction).not.toHaveBeenCalled();
    request.mockResolvedValue([]);
    expect(
      await workspace.afterMutation(["sample.ts"], "write"),
    ).toBeUndefined();
    request.mockResolvedValue([
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 16 },
        },
        newText: "const value = 2;",
      },
    ]);
    transaction.mockResolvedValue({
      applied: true,
      summary: [],
      changes: [
        {
          kind: "edit",
          file: "/project/sample.ts",
          files: ["/project/sample.ts"],
        },
      ],
    });
    expect((await workspace.afterMutation(["sample.ts"], "write"))?.text).toBe(
      "Formatted sample.ts with test-server",
    );
    transaction.mockResolvedValue({
      applied: false,
      summary: [],
      changes: [],
      failureReason: "stale formatter response",
    });
    expect((await workspace.afterMutation(["sample.ts"], "write"))?.text).toBe(
      "Formatting failed: stale formatter response",
    );
    server.capabilities.documentFormattingProvider = false;
    expect((await workspace.afterMutation(["sample.ts"], "write"))?.text).toBe(
      "Formatting unavailable: no matching formatting-capable server is installed",
    );
    server.capabilities.documentFormattingProvider = true;
    spyOn(fs, "readFile")
      .mockResolvedValueOnce("const value = 1;")
      .mockResolvedValue("newer");
    const requests = request.mock.calls.length;
    expect((await workspace.afterMutation(["sample.ts"], "write"))?.text).toBe(
      "Formatting failed: File changed before formatting; stale formatter result discarded",
    );
    expect(request).toHaveBeenCalledTimes(requests);
  });
});

describe("LspWorkspace.dispose", () => {
  const failure = new Error("edit transaction failed");
  it.each([
    [
      "resolves",
      (pending: PromiseWithResolvers<edits.EditResult>) =>
        pending.resolve({ applied: true, summary: [], changes: [] }),
      { value: { applied: true } },
    ],
    [
      "rejects",
      (pending: PromiseWithResolvers<edits.EditResult>) =>
        pending.reject(failure),
      { error: failure },
    ],
  ] as const)(
    "should cancel edits, wait for settlement, and finish idempotent cleanup when an in-flight edit %s",
    async (_condition, settle, expected) => {
      const { loaded, pool, poolFactory, applyEdit } = fixture();
      loaded.settings.lazy = true;
      const pending = Promise.withResolvers<edits.EditResult>();
      const transaction = spyOn(edits, "applyWorkspaceEdit").mockReturnValue(
        pending.promise,
      );
      const workspace = await createWorkspace(poolFactory);
      const edit = applyEdit({}).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const signal = transaction.mock.calls[0]?.[1].signal;
      const disposal = workspace.dispose();
      let disposed = false;
      const completed = disposal.then(() => {
        disposed = true;
      });
      try {
        expect(workspace.dispose()).toBe(disposal);
        expect(signal?.aborted).toBe(true);
        expect(await applyEdit({})).toEqual({
          applied: false,
          failureReason: "LSP workspace untrusted, disabled, or disposed",
        });
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(pool.dispose).toHaveBeenCalledTimes(1);
        expect(disposed).toBe(false);
        settle(pending);
        expect(await edit).toEqual(expected);
        await completed;
        expect(disposed).toBe(true);
        expect(workspace.dispose()).toBe(disposal);
        expect(pool.dispose).toHaveBeenCalledTimes(1);
      } finally {
        pending.resolve({ applied: true, summary: [], changes: [] });
        await edit;
        await completed;
      }
    },
  );
});
