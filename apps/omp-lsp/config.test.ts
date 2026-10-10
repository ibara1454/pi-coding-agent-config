import { describe, expect, mock, spyOn, test } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: Spies must intercept the loader's live named filesystem imports.
import * as fs from "node:fs/promises";
import { delimiter, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  isCliLinter,
  loadLspConfig,
  resolveCommand,
  serversForFile,
} from "./config.ts";
import type { ServerConfig } from "./types.ts";

const cwd = "/project";
const agentDir = "/agent";
const installed = "/installed/language-server";
const projectConfig = join(cwd, ".pi", "lsp.json");
const excessivePayloadDepth = 102;
const excessiveRootEntries = 10_001;
const pathVariable = "PATH";
const typescriptDefaultsJson = JSON.stringify({
  "typescript-native": {
    command: installed,
    fileTypes: [".ts"],
    rootMarkers: [],
  },
  "typescript-language-server": {
    command: installed,
    fileTypes: [".ts"],
    rootMarkers: [],
  },
});

const filesystem: {
  access: (file: string) => Promise<void>;
  opendir: (
    file: string,
  ) => Promise<Iterable<{ name: string }> | AsyncIterable<{ name: string }>>;
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
 * @param options - Planned project-file metadata, open failures, and close observation.
 * @returns Mutable path-to-text entries for additional configuration layers; missing paths report ENOENT.
 * @example fixture().set("/agent/settings.json", '{"lsp":{"enabled":false}}') adds agent settings.
 */
function fixture(
  override?: unknown,
  options: {
    regular?: boolean;
    size?: number;
    openError?: unknown;
    close?: () => Promise<void>;
  } = {},
): Map<string, string> {
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
    if (
      file !== cwd &&
      file !== join(cwd, "package.json") &&
      file !== installed
    ) {
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
    if (file === projectConfig && options.openError !== undefined) {
      return Promise.reject(options.openError);
    }
    const text = files.get(file);
    if (text === undefined) {
      return Promise.reject(missing());
    }
    const content = Buffer.from(text);
    let position = 0;
    return Promise.resolve({
      stat: () =>
        Promise.resolve({
          isFile: () => file !== projectConfig || options.regular !== false,
          size:
            file === projectConfig
              ? (options.size ?? content.length)
              : content.length,
        }),
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
      close:
        file === projectConfig && options.close
          ? options.close
          : () => Promise.resolve(),
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

  test("should apply flat server overrides without treating the idle timeout as a server", async () => {
    fixture({
      idleTimeoutMs: 250,
      available: { args: ["--flat"] },
    });
    const config = await loadLspConfig(cwd, agentDir, true);
    expect(config).toMatchObject({ idleTimeoutMs: 250, warnings: [] });
    expect(serversForFile(config, join(cwd, "example.ts"))).toMatchObject([
      { name: "available", args: ["--flat"] },
    ]);
  });

  test.each([
    { condition: "the document is an array", override: [] },
    { condition: "the server map is an array", override: { servers: [] } },
  ])(
    "should retain the earlier server configuration when $condition",
    async ({ override }) => {
      const files = fixture(override);
      files.set(
        join(agentDir, "lsp.json"),
        JSON.stringify({
          idleTimeoutMs: 250,
          servers: { available: { args: ["--agent"] } },
        }),
      );
      const config = await loadLspConfig(cwd, agentDir, true);
      expect(config).toMatchObject({ idleTimeoutMs: 250 });
      expect(config.warnings).toEqual([expect.stringContaining(projectConfig)]);
      expect(serversForFile(config, join(cwd, "example.ts"))).toMatchObject([
        { name: "available", args: ["--agent"] },
      ]);
    },
  );

  test("should retain prior definitions and apply valid siblings when server entries are malformed", async () => {
    const files = fixture({
      servers: {
        available: null,
        " ": {},
        optional: { disabled: true },
      },
    });
    files.set(
      join(agentDir, "lsp.json"),
      JSON.stringify({ servers: { available: { args: ["--agent"] } } }),
    );
    const config = await loadLspConfig(cwd, agentDir, true);
    expect(config.warnings).toEqual([
      expect.stringContaining(`${projectConfig}: server available:`),
      expect.stringContaining(`${projectConfig}: server  :`),
    ]);
    expect(serversForFile(config, join(cwd, "example.ts"))).toMatchObject([
      { name: "available", args: ["--agent"] },
    ]);
    expect(
      config.servers.find((server) => server.name === "optional"),
    ).toMatchObject({
      disabled: true,
    });
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

describe("loadLspConfig", () => {
  test.each([
    ["the command is blank", { command: " " }, "command must be"],
    ["the command contains a NUL", { command: "tool\0" }, "command must be"],
    [
      "an extension language is blank",
      { extensionToLanguage: { ts: " " } },
      "language identifiers",
    ],
    [
      "an environment value is not a string",
      { env: { mode: false } },
      "env must be",
    ],
    [
      "an environment name contains an equals sign",
      { env: { "bad=name": "value" } },
      "must not contain '='",
    ],
    ["a root marker is blank", { rootMarkers: [" "] }, "empty markers"],
    [
      "the language identifier is blank",
      { languageId: " " },
      "languageId must be",
    ],
    ["disabled is not a boolean", { disabled: "yes" }, "disabled must be"],
    ["isLinter is not a boolean", { isLinter: 1 }, "isLinter must be"],
    [
      "initialization options are an array",
      { initOptions: [] },
      "initOptions must be",
    ],
    [
      "workspace timings are not an object",
      { workspaceReadyTimings: 10 },
      "workspaceReadyTimings must be",
    ],
    [
      "a workspace duration exceeds the timer limit",
      { workspaceReadyTimings: { settleMs: 2_147_483_648 } },
      "workspaceReadyTimings.settleMs must be",
    ],
  ] as const)(
    "should preserve the earlier server definition when %s",
    async (_condition, override, warning) => {
      fixture({ servers: { available: override } });
      const config = await loadLspConfig(cwd, agentDir, true);
      expect(config.warnings).toEqual([expect.stringContaining(warning)]);
      expect(
        config.servers.find((item) => item.name === "available"),
      ).toMatchObject({
        command: installed,
        args: [],
        fileTypes: [".ts"],
      });
    },
  );

  test("should derive file types and a project root when a new server supplies extension languages", async () => {
    fixture({
      servers: {
        custom: {
          command: installed,
          extensionToLanguage: { ".custom": "custom" },
          initOptions: { direct: true },
          initializationOptions: { alias: true },
        },
      },
    });
    const config = await loadLspConfig(cwd, agentDir, true);
    expect(config.warnings).toEqual([]);
    expect(serversForFile(config, join(cwd, "a.custom"))).toMatchObject([
      {
        name: "custom",
        fileTypes: [".custom"],
        rootMarkers: ["."],
        initOptions: { direct: true },
      },
    ]);
  });

  test.each([
    ["the file is a directory", { regular: false }, "expected a regular file"],
    ["the file exceeds the byte limit", { size: 1_048_577 }, "exceeds 1 MiB"],
    ["the file grows after stat", { size: 1 }, "changed while being read"],
  ] as const)(
    "should close the file and retain defaults when %s",
    async (_condition, metadata, warning) => {
      const close = mock(() => Promise.resolve());
      fixture({ servers: {} }, { ...metadata, close });
      const config = await loadLspConfig(cwd, agentDir, true);
      expect(config.warnings).toEqual([expect.stringContaining(warning)]);
      expect(
        config.servers.find((item) => item.name === "available")?.args,
      ).toEqual([]);
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    [
      "access is denied",
      Object.assign(new Error("denied"), { code: "EACCES" }),
      "denied",
    ],
    [
      "the host throws a non-Error value",
      "read unavailable",
      "read unavailable",
    ],
  ] as const)(
    "should expose a configuration read warning when %s",
    async (_condition, openError, warning) => {
      fixture({ servers: {} }, { openError });
      const config = await loadLspConfig(cwd, agentDir, true);
      expect(config.warnings).toEqual([expect.stringContaining(warning)]);
    },
  );

  test.each([
    ["YAML has duplicate keys", "servers: {}\nservers: {}\n", "unique"],
    ["YAML has an unsupported tag", "servers: !unknown {}\n", "Unresolved tag"],
    [
      "YAML aliases create a cycle",
      "servers:\n  available:\n    settings: &settings\n      cycle: *settings\n",
      "cyclic YAML alias",
    ],
    [
      "YAML contains a non-finite number",
      "servers:\n  available:\n    settings:\n      value: .inf\n",
      "JSON-compatible",
    ],
  ] as const)(
    "should warn and retain earlier definitions when %s",
    async (_condition, yaml, warning) => {
      const files = fixture();
      files.set(join(cwd, ".pi", "lsp.yaml"), yaml);
      const config = await loadLspConfig(cwd, agentDir, true);
      expect(config.warnings).toEqual([expect.stringContaining(warning)]);
      expect(
        config.servers.find((item) => item.name === "available")?.args,
      ).toEqual([]);
    },
  );

  test("should reject excessive payload nesting while preserving the earlier definition", async () => {
    let nested: unknown = null;
    for (let depth = 0; depth < excessivePayloadDepth; depth++) {
      nested = { nested };
    }
    fixture({ servers: { available: { settings: nested } } });
    const config = await loadLspConfig(cwd, agentDir, true);
    expect(config.warnings).toEqual([
      expect.stringContaining("100 nesting levels"),
    ]);
    expect(
      config.servers.find((item) => item.name === "available")?.settings,
    ).toBeUndefined();
  });

  test.each([
    ["the settings have no LSP section", {}, []],
    [
      "the LSP section is not an object",
      { lsp: [] },
      [expect.stringContaining("lsp settings must be an object")],
    ],
  ] as const)(
    "should preserve default settings when %s",
    async (_condition, settings, warnings) => {
      const files = fixture();
      files.set(join(agentDir, "settings.json"), JSON.stringify(settings));
      const config = await loadLspConfig(cwd, agentDir, true);
      expect(config.settings.enabled).toBe(true);
      expect(config.warnings).toEqual([...warnings]);
    },
  );

  test.each([
    ["the bundled map is missing", null, "must contain a server map"],
    [
      "a bundled entry is not an object",
      { broken: null },
      "Invalid bundled LSP preset broken",
    ],
  ] as const)(
    "should fail visibly when %s",
    async (_condition, defaults, warning) => {
      const files = fixture();
      files.set(
        fileURLToPath(new URL("./defaults.json", import.meta.url)),
        JSON.stringify(defaults),
      );
      await expect(loadLspConfig(cwd, agentDir, true)).rejects.toThrow(warning);
    },
  );

  test.each([
    ["a literal marker is missing", ["missing.json"], [], false],
    [
      "a brace-expanded glob matches",
      ["*.{sln,csproj}"],
      ["notes.txt", ".app.csproj"],
      true,
    ],
    ["no glob matches", ["*.sln"], ["notes.txt"], false],
    ["no markers are required", [], [], true],
  ] as const)(
    "should select servers by root markers when %s",
    async (_condition, rootMarkers, entries, included) => {
      fixture({ servers: { available: { rootMarkers } } });
      const directory = entries.map((name) => ({ name }));
      spyOn(filesystem, "opendir").mockResolvedValue(directory);
      const config = await loadLspConfig(cwd, agentDir, true);
      expect(config.warnings).toEqual([]);
      expect(config.servers.some((item) => item.name === "available")).toBe(
        included,
      );
    },
  );

  test("should warn without treating discovery as successful when the root scan exceeds its limit", async () => {
    fixture({ servers: { available: { rootMarkers: ["*.sln"] } } });
    const directory = Array.from(
      { length: excessiveRootEntries },
      (_, index) => ({
        name: `file-${index}.txt`,
      }),
    );
    spyOn(filesystem, "opendir").mockResolvedValue(directory);
    const config = await loadLspConfig(cwd, agentDir, true);
    expect(config.warnings).toEqual([
      expect.stringContaining("root-marker discovery exceeded 10000"),
    ]);
    expect(
      config.servers.find((item) => item.name === "available")?.resolvedCommand,
    ).toBeUndefined();
  });

  test("should report root-marker access failures without probing the server executable", async () => {
    fixture();
    const access = spyOn(filesystem, "access").mockRejectedValue(
      new Error("marker access failed"),
    );
    const config = await loadLspConfig(cwd, agentDir, true);
    expect(config.warnings).toEqual([
      "available: marker access failed",
      "optional: marker access failed",
    ]);
    expect(access).not.toHaveBeenCalledWith(installed, expect.anything());
    expect(filesystem.stat).not.toHaveBeenCalled();
  });

  test("should substitute the current process identifier when launching OmniSharp", async () => {
    fixture({
      servers: {
        omnisharp: {
          command: installed,
          args: ["--hostPID", "$PID", "literal"],
          fileTypes: [".cs"],
          rootMarkers: [],
        },
      },
    });
    const config = await loadLspConfig(cwd, agentDir, true);
    expect(
      config.servers.find((item) => item.name === "omnisharp")?.args,
    ).toEqual(["--hostPID", String(process.pid), "literal"]);
  });

  test.each([
    ["the native package has no legacy tsserver", false, "typescript-native"],
    [
      "the package still ships legacy tsserver",
      true,
      "typescript-language-server",
    ],
  ] as const)(
    "should choose the verified TypeScript server when %s",
    async (_condition, legacy, selected) => {
      const files = fixture();
      files.set(
        fileURLToPath(new URL("./defaults.json", import.meta.url)),
        typescriptDefaultsJson,
      );
      spyOn(fs, "realpath").mockResolvedValue("/packages/native/bin/tsgo");
      files.set(
        "/packages/native/package.json",
        JSON.stringify({ name: "@typescript/native-preview" }),
      );
      spyOn(filesystem, "access").mockImplementation((target) =>
        target.endsWith("tsserver.js") && !legacy
          ? Promise.reject(
              Object.assign(new Error("missing"), { code: "ENOENT" }),
            )
          : Promise.resolve(),
      );
      const config = await loadLspConfig(cwd, agentDir, true);
      expect(config.warnings).toEqual([]);
      expect(config.servers.map((item) => item.name)).toEqual([selected]);
    },
  );

  test("should retain the conventional TypeScript server when candidate manifests do not identify native TypeScript", async () => {
    const files = fixture();
    files.set(
      fileURLToPath(new URL("./defaults.json", import.meta.url)),
      typescriptDefaultsJson,
    );
    spyOn(fs, "realpath").mockResolvedValue("/packages/not-bin/tsgo");
    files.set(
      "/typescript/package.json",
      JSON.stringify({ name: "unrelated" }),
    );
    const config = await loadLspConfig(cwd, agentDir, true);
    expect(config.warnings).toEqual([]);
    expect(config.servers.map((item) => item.name)).toEqual([
      "typescript-language-server",
    ]);
  });

  test("should report native selection failure and retain the conventional TypeScript server when realpath fails", async () => {
    const files = fixture();
    files.set(
      fileURLToPath(new URL("./defaults.json", import.meta.url)),
      typescriptDefaultsJson,
    );
    spyOn(fs, "realpath").mockRejectedValue(new Error("symlink unavailable"));
    const config = await loadLspConfig(cwd, agentDir, true);
    expect(config.warnings).toEqual([
      expect.stringContaining(
        "TypeScript server selection: symlink unavailable",
      ),
    ]);
    expect(config.servers.map((item) => item.name)).toEqual([
      "typescript-language-server",
    ]);
  });
});

describe("resolveCommand", () => {
  test("should prefer project-local executables over PATH installations", async () => {
    fixture();
    const local = join(cwd, "node_modules", ".bin", "tool");
    spyOn(filesystem, "stat").mockResolvedValue({ isFile: () => true });
    spyOn(filesystem, "access").mockResolvedValue(undefined);
    expect(
      await resolveCommand("tool", cwd, {
        [pathVariable]: ["/first", "/second"].join(delimiter),
      }),
    ).toBe(local);
    expect(filesystem.stat).toHaveBeenCalledTimes(1);
  });

  test("should search PATH after skipping directories and non-executable local files", async () => {
    fixture();
    spyOn(filesystem, "stat").mockImplementation((target) =>
      Promise.resolve({ isFile: () => !target.includes("node_modules") }),
    );
    spyOn(filesystem, "access").mockImplementation((target) =>
      target === "/installed/tool"
        ? Promise.resolve()
        : Promise.reject(
            Object.assign(new Error("not executable"), { code: "EACCES" }),
          ),
    );
    expect(
      await resolveCommand("tool", cwd, { [pathVariable]: "/installed" }),
    ).toBe("/installed/tool");
  });

  test.each(["ENOENT", "ENOTDIR", "EACCES"])(
    "should return no executable when stat fails with %s",
    async (code) => {
      fixture();
      spyOn(filesystem, "stat").mockRejectedValue(
        Object.assign(new Error("unavailable"), { code }),
      );
      expect(
        await resolveCommand("./tool", cwd, { [pathVariable]: "" }),
      ).toBeUndefined();
    },
  );

  test.each([new Error("I/O failure"), "unexpected host failure"])(
    "should propagate unexpected executable discovery errors when the host returns %s",
    async (failure) => {
      fixture();
      spyOn(filesystem, "stat").mockRejectedValue(failure);
      await expect(
        resolveCommand("./tool", cwd, { [pathVariable]: "" }),
      ).rejects.toBe(failure);
    },
  );
});

describe("serversForFile", () => {
  test("should match case-insensitive filenames and extensions with semantic servers before linters", () => {
    const semantic: ServerConfig = {
      name: "semantic",
      command: installed,
      resolvedCommand: installed,
      args: [],
      root: cwd,
      rootMarkers: [],
      fileTypes: ["TS", "MAKEFILE"],
    };
    const missing: ServerConfig = {
      name: "missing",
      command: installed,
      args: [],
      root: cwd,
      rootMarkers: [],
      fileTypes: ["TS", "MAKEFILE"],
    };
    const servers = [
      { ...semantic, name: "linter", isLinter: true },
      semantic,
      { ...semantic, name: "disabled", disabled: true },
      missing,
    ];
    const config = {
      servers,
      warnings: [],
      settings: {
        enabled: true,
        lazy: true,
        formatOnWrite: false,
        diagnosticsOnWrite: true,
        diagnosticsOnEdit: false,
        diagnosticsDeduplicate: true,
      },
    };
    expect(
      serversForFile(config, "/project/FILE.TS").map((item) => item.name),
    ).toEqual(["semantic", "linter"]);
    expect(
      serversForFile(config, "/project/Makefile").map((item) => item.name),
    ).toEqual(["semantic", "linter"]);
    expect(serversForFile(config, "/project/file.txt")).toEqual([]);
    expect(servers.map((item) => item.name)).toEqual([
      "linter",
      "semantic",
      "disabled",
      "missing",
    ]);
  });
});

describe("isCliLinter", () => {
  test.each([
    ["biome", true],
    ["swiftlint", true],
    ["typescript", false],
  ] as const)(
    "should classify %s as a CLI linter with result %s",
    (name, expected) => {
      expect(
        isCliLinter({
          name,
          command: name,
          args: [],
          fileTypes: [],
          rootMarkers: [],
          root: cwd,
        }),
      ).toBe(expected);
    },
  );
});
