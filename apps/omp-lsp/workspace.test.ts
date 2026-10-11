import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import type { TextEdit, WorkspaceEdit } from "vscode-languageserver-protocol";
// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace to intercept configuration-loading effects.
import * as config from "./config.ts";
// biome-ignore lint/performance/noNamespaceImport: Bun spies intercept the effect-owning edit transaction boundary.
import * as edits from "./edits.ts";
import type { LanguageServer, LanguageServerPool } from "./runtime.ts";
import type { LspConfig, ServerConfig } from "./types.ts";
import { LspWorkspace } from "./workspace.ts";

const workspaces: LspWorkspace[] = [];
const EAGER_STARTUP_CONCURRENCY = 3;
const STARTUP_SERVER_COUNT = 5;
const ACTION_DEADLINE_MS = 5000;
const MUTATION_DEADLINE_MS = 15_000;
const MUTATION_RESPONSE_DEADLINE_MS = 16_000;
const timers: {
  setTimeout: (callback: () => void, delay?: number) => NodeJS.Timeout;
  clearTimeout: (timer: NodeJS.Timeout | undefined) => void;
} = globalThis;
const filesystem: { stat: (file: string) => Promise<Stats> } = fs;
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
  test("should warm eligible servers and retain startup failures as warnings when eager startup is enabled", async () => {
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

  test.each([
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

  test("should bound concurrent starts and order warnings by configuration when startups settle out of order", async () => {
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
});

describe("LspWorkspace.execute", () => {
  test("should aggregate negotiated capabilities and startup failures while excluding disabled servers and CLI linters", async () => {
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

  test.each([
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

  test("should filter workspace symbols case-insensitively and deduplicate locations while retaining failed sources", async () => {
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

  test("should bound displayed workspace symbols while retaining the total match count", async () => {
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

  test("should distinguish an empty symbol search from invalid peer data and unavailable servers", async () => {
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

  test("should reload compatible servers and restart notification failures while preserving server-specific errors", async () => {
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
});

describe("LspWorkspace.execute", () => {
  test("should cancel server startup and release its deadline when the action exceeds the minimum timeout", async () => {
    const { loaded, get, poolFactory } = fixture();
    loaded.settings.lazy = true;
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
});

describe("LspWorkspace.afterMutation", () => {
  test("should bound the response and cancel pending feedback without reversing a successful host edit when feedback stalls", async () => {
    const { loaded, poolFactory } = fixture();
    loaded.settings.lazy = true;
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
});

describe("LspWorkspace.create", () => {
  test("should reconcile committed edits and retain document snapshots when live servers match changed files", async () => {
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

  test("should leave servers and tracked documents unchanged when an edit is rejected before committing", async () => {
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

  test.each([
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

describe("LspWorkspace.dispose", () => {
  const failure = new Error("edit transaction failed");
  test.each([
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

describe("LspWorkspace.execute", () => {
  test("should replace and dispose injected pools in order when reloading changes the idle timeout", async () => {
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
});

describe("LspWorkspace.execute", () => {
  test("should sort unverified diagnostic sources without claiming a verified clean file", async () => {
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

  test("should select one code action by a case-insensitive title fragment without executing other actions", async () => {
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

  test.each([
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
});
