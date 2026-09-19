import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";

// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace; copied named imports cannot intercept consumers.
import * as host from "@earendil-works/pi-coding-agent";
// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace; copied named imports cannot intercept consumers.
import * as config from "./config.ts";
// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace; copied named imports cannot intercept consumers.
import * as linters from "./linters.ts";

import { type LanguageServer, LanguageServerPool } from "./runtime.ts";
import type { LspConfig, ServerConfig } from "./types.ts";
import { LspWorkspace } from "./workspace.ts";

const filesystem: {
  stat(file: string): Promise<Stats>;
  lstat(file: string): Promise<Stats>;
  realpath(file: string): Promise<string>;
  readFile(file: string, encoding: "utf8"): Promise<string>;
  writeFile(file: string, content: string, encoding: "utf8"): Promise<void>;
} = fs;
const workspaces: LspWorkspace[] = [];
const file = "/project/sample.ts";
const original = "const   value={foo:1}\n";

async function fixture(linter = false) {
  let content = original;
  const stat = () =>
    ({
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      mode: 0o100644,
      size: content.length,
    }) as Stats;
  spyOn(filesystem, "stat").mockImplementation(async () => stat());
  spyOn(filesystem, "lstat").mockImplementation(async () => stat());
  spyOn(filesystem, "realpath").mockImplementation(async (target) => target);
  spyOn(filesystem, "readFile").mockImplementation(async () => content);
  spyOn(filesystem, "writeFile").mockImplementation((_file, text) => {
    content = text;
    return Promise.resolve();
  });
  spyOn(host, "withFileMutationQueue").mockImplementation(async (_file, work) =>
    work(),
  );
  const serverConfig: ServerConfig = {
    name: linter ? "biome" : "test-server",
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
      lazy: true,
      formatOnWrite: true,
      diagnosticsOnWrite: false,
      diagnosticsOnEdit: false,
      diagnosticsDeduplicate: true,
    },
  };
  spyOn(config, "loadLspConfig").mockResolvedValue(loaded);
  const request = mock<LanguageServer["request"]>();
  const server: LanguageServer = {
    config: serverConfig,
    capabilities: { codeActionProvider: { resolveProvider: true } },
    isAlive: true,
    // Bun's mock type erases the caller-selected RPC result type.
    request: request as LanguageServer["request"],
    notify: () => Promise.resolve(),
    syncFile: () => Promise.resolve(),
    saved: () => Promise.resolve(),
    closeFile: () => Promise.resolve(),
    diagnostics: async () => ({ items: [], freshness: "pull" }),
    document: () => ({ version: 1, content }),
    shutdown: () => Promise.resolve(),
  };
  spyOn(LanguageServerPool.prototype, "get").mockResolvedValue(server);
  spyOn(LanguageServerPool.prototype, "clients").mockReturnValue(
    linter ? [] : [server],
  );
  const workspace = await LspWorkspace.create({
    cwd: "/project",
    agentDir: "/agent",
    trusted: true,
  });
  workspaces.push(workspace);
  return { workspace, request, content: () => content };
}

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) {
    await workspace.dispose();
  }
});

describe("LspWorkspace.afterMutation", () => {
  test("should format writes without rewriting targeted edits when formatOnWrite is enabled", async () => {
    const { workspace, content } = await fixture(true);
    const formatted = "const value = { foo: 1 };\n";
    spyOn(linters, "formatWithCli").mockResolvedValue(formatted);
    await workspace.afterMutation([file], "edit");
    expect(content()).toBe(original);
    await workspace.afterMutation([file], "write");
    expect(content()).toBe(formatted);
  });
});

describe("LspWorkspace.execute", () => {
  const invalidAction = {
    title: "Change value",
    edit: {
      changes: {
        "file:///project/sample.ts": [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 1, character: 0 },
            },
            newText: "const changed = 2;\n",
          },
        ],
      },
    },
    command: { title: "Invalid command", command: 42 },
  };
  test.each([
    ["initial", [invalidAction]],
    ["resolved", [{ title: "Change value", data: {} }]],
  ] as const)(
    "should reject a malformed %s code-action command before changing files",
    async (_label, response) => {
      const { workspace, request, content } = await fixture();
      request
        .mockResolvedValueOnce(response)
        .mockResolvedValueOnce(invalidAction);
      const result = await workspace.execute({
        action: "code_actions",
        file,
        line: 1,
        symbol: "value",
        query: "0",
        apply: true,
      });
      expect(result.isError).toBe(true);
      expect(content()).toBe(original);
    },
  );

  test("should report committed edits when a resolved code-action command fails", async () => {
    const { workspace, request, content } = await fixture();
    const action = {
      ...invalidAction,
      command: { title: "Run fix", command: "test.runFix" },
    };
    request
      .mockResolvedValueOnce([
        { title: action.title, command: action.command, data: {} },
      ])
      .mockResolvedValueOnce(action)
      .mockRejectedValueOnce(new Error("server rejected command"));
    const result = await workspace.execute({
      action: "code_actions",
      file,
      line: 1,
      symbol: "value",
      query: "0",
      apply: true,
    });
    expect(content()).toBe("const changed = 2;\n");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("sample.ts");
    expect(result.text).toContain("server rejected command");
  });
});
