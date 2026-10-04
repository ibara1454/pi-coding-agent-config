import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace to intercept configuration-loading effects.
import * as config from "./config.ts";
import { type LanguageServer, LanguageServerPool } from "./runtime.ts";
import type { LspConfig, ServerConfig } from "./types.ts";
import { LspWorkspace } from "./workspace.ts";

const workspaces: LspWorkspace[] = [];
const EAGER_STARTUP_CONCURRENCY = 3;
const STARTUP_SERVER_COUNT = 5;

/**
 * Replaces configuration loading and server acquisition without mocking startup policy.
 * @returns Mutable test-owned configuration, an acquisition spy, and its successful result.
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
  // Creation consumes only acquisition success, never client methods or status.
  const server = { config: serverConfig, isAlive: true } as LanguageServer;
  const get = spyOn(LanguageServerPool.prototype, "get").mockResolvedValue(
    server,
  );
  return { loaded, server, get };
}

/**
 * Creates one workspace through its production interface and registers disposal.
 * @param trusted - Whether project server startup is permitted.
 * @returns The workspace whose real pool is disposed by afterEach.
 * @throws If workspace creation fails.
 * @example await createWorkspace(false) loads configuration without starting servers.
 */
async function createWorkspace(trusted = true): Promise<LspWorkspace> {
  const workspace = await LspWorkspace.create({
    cwd: "/project",
    agentDir: "/agent",
    trusted,
  });
  workspaces.push(workspace);
  return workspace;
}

// Dispose the real empty pools, even when a test assertion fails.
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
    const { loaded, server, get } = fixture();
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

    const workspace = await createWorkspace();

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
      const { loaded, get } = fixture();
      loaded.settings.enabled = enabled;
      loaded.settings.lazy = lazy;

      const workspace = await createWorkspace(trusted);

      expect(get).not.toHaveBeenCalled();
      expect(workspace.warnings).toEqual([]);
    },
  );

  test("should bound concurrent starts and order warnings by configuration when startups settle out of order", async () => {
    const { loaded, server, get } = fixture();
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
    const creating = createWorkspace();
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
