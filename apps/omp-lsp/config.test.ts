import { describe, expect, spyOn, test } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: Spies must intercept the loader's live named filesystem imports.
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLspConfig, serversForFile } from "./config.ts";

const cwd = "/project";
const agentDir = "/agent";
const installed = "/installed/language-server";
const projectConfig = join(cwd, ".pi", "lsp.json");

const filesystem: {
  access: (file: string) => Promise<void>;
  stat: (file: string) => Promise<{ isFile: () => boolean }>;
  open: (
    file: string,
    flags: string,
  ) => Promise<{
    stat: () => Promise<{ isFile: () => boolean; size: number }>;
    read: (
      buffer: Buffer,
      offset: number,
      length: number,
      position: null,
    ) => Promise<{ bytesRead: number }>;
    close: () => Promise<void>;
  }>;
} = fs;

/**
 * Replaces configuration reads and executable probes with an in-memory fixture.
 * @param override - Optional JSON document installed as the visible project layer.
 * @returns Mutable path-to-text entries for additional configuration layers; missing paths report ENOENT.
 * @example fixture().set("/agent/settings.json", '{"lsp":{"enabled":false}}') adds agent settings.
 */
function fixture(override?: unknown): Map<string, string> {
  const preset = {
    args: [],
    fileTypes: [".ts"],
    rootMarkers: ["package.json"],
  };
  const files = new Map([
    [
      fileURLToPath(new URL("./defaults.json", import.meta.url)),
      JSON.stringify({
        available: { ...preset, command: installed },
        optional: { ...preset, command: "/missing/language-server" },
      }),
    ],
  ]);
  if (override !== undefined) {
    files.set(projectConfig, JSON.stringify(override));
  }
  const missing = () =>
    Object.assign(new Error("Not found"), { code: "ENOENT" });
  spyOn(filesystem, "access").mockImplementation((file) => {
    if (file !== join(cwd, "package.json") && file !== installed) {
      return Promise.reject(missing());
    }
    return Promise.resolve();
  });
  spyOn(filesystem, "stat").mockImplementation((file) => {
    if (file !== installed) {
      return Promise.reject(missing());
    }
    return Promise.resolve({ isFile: () => true });
  });
  spyOn(filesystem, "open").mockImplementation((file) => {
    const text = files.get(file);
    if (text === undefined) {
      return Promise.reject(missing());
    }
    const content = Buffer.from(text);
    let position = 0;
    return Promise.resolve({
      stat: () => Promise.resolve({ isFile: () => true, size: content.length }),
      read: (buffer, offset, length) => {
        const bytesRead = content.copy(
          buffer,
          offset,
          position,
          position + length,
        );
        position += bytesRead;
        return Promise.resolve({ bytesRead });
      },
      close: () => Promise.resolve(),
    });
  });
  return files;
}

describe("loadLspConfig", () => {
  test("should select installed servers without warnings when optional executables are missing", async () => {
    fixture();
    const config = await loadLspConfig(cwd, agentDir, true);
    expect(config.warnings).toEqual([]);
    expect(
      serversForFile(config, join(cwd, "example.ts")).map(
        (server) => server.name,
      ),
    ).toEqual(["available"]);
  });

  test("should report invalid user overrides while retaining an available server", async () => {
    fixture({ servers: { available: { args: "--stdio" } } });
    const config = await loadLspConfig(cwd, agentDir, true);
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain(projectConfig);
    expect(config.warnings[0]).toContain("available");
    expect(
      serversForFile(config, join(cwd, "example.ts")).map(
        (server) => server.name,
      ),
    ).toEqual(["available"]);
  });

  test("should merge valid layers and retain earlier values when project settings are invalid", async () => {
    const files = fixture({
      idleTimeoutMs: -1,
      servers: {
        available: {
          args: ["--project"],
          extensionToLanguage: { ".tsx": "typescriptreact" },
          languageId: "typescriptreact",
          initializationOptions: { options: [null, "strict", 1, true] },
          // biome-ignore lint/style/useNamingConvention: Environment variable names are external keys.
          env: { MODE: "test" },
          warmupTimeoutMs: 0,
          workspaceReadyTimings: { timeoutMs: 250, pollMs: 0 },
        },
        optional: { disabled: true },
      },
    });
    files.set(
      join(agentDir, "settings.json"),
      JSON.stringify({
        lsp: { enabled: false, lazy: false, diagnosticsOnWrite: false },
      }),
    );
    files.set(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ lsp: { enabled: true, diagnosticsOnWrite: "yes" } }),
    );
    files.set(
      join(agentDir, "lsp.json"),
      JSON.stringify({
        idleTimeoutMs: 250,
        servers: {
          available: { args: ["--agent"], settings: { strict: true } },
        },
      }),
    );
    files.set(
      join(cwd, ".pi", "lsp.yaml"),
      "servers:\n  available:\n    args: [--yaml]\n",
    );
    files.set(
      join(cwd, ".pi", ".lsp.json"),
      JSON.stringify({ servers: { available: { args: ["--hidden"] } } }),
    );

    const config = await loadLspConfig(cwd, agentDir, true);
    expect(config).toMatchObject({
      idleTimeoutMs: 250,
      settings: { enabled: true, lazy: false, diagnosticsOnWrite: false },
    });
    expect(config.warnings).toEqual([
      expect.stringContaining("lsp.diagnosticsOnWrite must be a boolean"),
      expect.stringContaining("keeping previous idle timeout"),
    ]);
    expect(serversForFile(config, join(cwd, "example.tsx"))).toMatchObject([
      {
        name: "available",
        args: ["--project"],
        fileTypes: [".tsx"],
        extensionToLanguage: { ".tsx": "typescriptreact" },
        languageId: "typescriptreact",
        initOptions: { options: [null, "strict", 1, true] },
        settings: { strict: true },
        // biome-ignore lint/style/useNamingConvention: Environment variable names are external keys.
        env: { MODE: "test" },
        warmupTimeoutMs: 0,
        workspaceReadyTimings: { timeoutMs: 250, pollMs: 0 },
      },
    ]);
    expect(serversForFile(config, join(cwd, "example.ts"))).toEqual([]);
  });

  test("should load only agent settings and skip executable discovery when the project is untrusted", async () => {
    const files = fixture({ servers: { available: { args: ["--project"] } } });
    files.set(
      join(agentDir, "settings.json"),
      JSON.stringify({ lsp: { enabled: false } }),
    );
    files.set(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ lsp: { enabled: true } }),
    );

    const config = await loadLspConfig(cwd, agentDir, false);
    expect(config.servers).toEqual([]);
    expect(config.settings.enabled).toBe(false);
    expect(config.warnings).toEqual([
      expect.stringContaining("Project is not trusted"),
    ]);
    expect(filesystem.open).not.toHaveBeenCalledWith(projectConfig, "r");
    expect(filesystem.open).not.toHaveBeenCalledWith(
      join(cwd, ".pi", "settings.json"),
      "r",
    );
    expect(filesystem.stat).not.toHaveBeenCalled();
    expect(filesystem.access).not.toHaveBeenCalled();
  });

  test("should warn and preserve defaults when user settings and configuration cannot be parsed", async () => {
    const files = fixture();
    files.set(join(agentDir, "settings.json"), "[]");
    files.set(projectConfig, "{");

    const config = await loadLspConfig(cwd, agentDir, true);
    expect(config.settings.enabled).toBe(true);
    expect(config.warnings).toEqual([
      expect.stringContaining("settings must be an object"),
      expect.stringContaining(`${projectConfig}:`),
    ]);
    expect(
      serversForFile(config, join(cwd, "example.ts")).map(
        (server) => server.name,
      ),
    ).toEqual(["available"]);
  });
});
