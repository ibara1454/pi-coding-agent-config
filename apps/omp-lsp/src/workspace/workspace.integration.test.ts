import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace; copied named imports cannot intercept consumers.
import * as host from "@earendil-works/pi-coding-agent";
// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace; copied named imports cannot intercept consumers.
import * as config from "../configuration/config.ts";
import {
  type LanguageServer,
  StdioLanguageServerPool,
} from "../runtime/runtime.ts";
import type { LspConfig, ServerConfig } from "../runtime/types.ts";
import { fileToUri } from "./edits.ts";
// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace; copied named imports cannot intercept consumers.
import * as linters from "./linters.ts";
import { LspWorkspace } from "./workspace.ts";

const filesystem: {
  stat: (file: string) => Promise<Stats>;
  lstat: (file: string) => Promise<Stats>;
  realpath: (file: string) => Promise<string>;
  readFile: (file: string, encoding: "utf8") => Promise<string>;
  writeFile: (file: string, content: string, encoding: "utf8") => Promise<void>;
} = fs;
const workspaces: LspWorkspace[] = [];
const file = "/project/sample.ts";
const original = "const   value={foo:1}\n";

/**
 * Creates an in-memory workspace and installs filesystem, host-queue, configuration, and server-pool spies.
 * @param linter - Selects the Biome fixture with no live pool clients when true; otherwise uses a semantic test server.
 * @returns The workspace, mutable server/config controls, request mock, stat factory, and current-content reader.
 * Registered workspaces are disposed and spies are restored by this file's afterEach.
 * @throws Propagates workspace creation failures.
 * @example
 * const { workspace, content } = await documentFixture();
 * // content() is "const   value={foo:1}\n"; afterEach disposes workspace.
 */
async function documentFixture(linter = false) {
  let content = original;
  const stat = () =>
    ({
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      mode: 0o10_0644,
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
    notify: mock<LanguageServer["notify"]>().mockResolvedValue(undefined),
    syncFile: mock<LanguageServer["syncFile"]>().mockResolvedValue(undefined),
    saved: mock<LanguageServer["saved"]>().mockResolvedValue(undefined),
    closeFile: mock<LanguageServer["closeFile"]>().mockResolvedValue(undefined),
    diagnostics: mock<LanguageServer["diagnostics"]>().mockResolvedValue({
      items: [],
      freshness: "pull",
    }),
    document: () => ({ version: 1, content }),
    shutdown: () => Promise.resolve(),
  };
  spyOn(StdioLanguageServerPool.prototype, "get").mockResolvedValue(server);
  spyOn(StdioLanguageServerPool.prototype, "clients").mockReturnValue(
    linter ? [] : [server],
  );
  const workspace = await LspWorkspace.create({
    cwd: "/project",
    agentDir: "/agent",
    trusted: true,
  });
  workspaces.push(workspace);
  return { workspace, request, server, loaded, stat, content: () => content };
}

afterEach(async () => {
  try {
    for (const workspace of workspaces.splice(0)) {
      await workspace.dispose();
    }
  } finally {
    mock.restore();
  }
});

describe("LspWorkspace.afterMutation", () => {
  it("should commit CLI formatting through guarded workspace edits when a write succeeds", async () => {
    const { workspace, content } = await documentFixture(true);
    const formatted = "const value = { foo: 1 };\n";
    spyOn(linters, "formatWithCli").mockResolvedValue(formatted);
    await workspace.afterMutation([file], "write");
    expect(content()).toBe(formatted);
  });
});

describe("LspWorkspace.execute", () => {
  it("should preview a file rename when server snapshots agree on content despite different document versions", async () => {
    const { workspace, request, server, loaded, stat, content } =
      await documentFixture();
    const destination = "/project/moved.ts";
    spyOn(filesystem, "lstat").mockImplementation((target) => {
      if (target === destination) {
        return Promise.reject(
          Object.assign(new Error("not found"), { code: "ENOENT" }),
        );
      }
      if (target === "/project") {
        return Promise.resolve({
          ...stat(),
          isFile: () => false,
          isDirectory: () => true,
        });
      }
      return Promise.resolve(stat());
    });
    request.mockResolvedValue({
      changes: {
        [fileToUri(file)]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
            newText: "// renamed\n",
          },
        ],
      },
    });
    const secondRequest =
      // biome-ignore lint/plugin/biome-rules/use-undefined: LSP willRenameFiles uses null when a server contributes no edits.
      mock<LanguageServer["request"]>().mockResolvedValue(null);
    const second: LanguageServer = {
      ...server,
      config: { ...server.config, name: "second-server" },
      request: secondRequest as LanguageServer["request"],
      document: () => ({ version: 99, content: original }),
    };
    loaded.servers.push(second.config);
    spyOn(StdioLanguageServerPool.prototype, "get").mockImplementation(
      async (selected) =>
        selected.name === second.config.name ? second : server,
    );
    const move = spyOn(fs, "rename").mockResolvedValue(undefined);
    const writes = spyOn(filesystem, "writeFile");
    const result = await workspace.execute({
      action: "rename_file",
      file,
      // biome-ignore lint/style/useNamingConvention: LSP tool schema preserves the external new_name argument.
      new_name: destination,
      apply: false,
    });
    expect(result.isError).not.toBe(true);
    expect(result.text).toContain("Rename preview");
    expect(result.text).toContain("sample.ts → moved.ts");
    expect(result.text).toContain("1 edit(s)");
    expect(request).toHaveBeenCalledWith(
      "workspace/willRenameFiles",
      { files: [{ oldUri: fileToUri(file), newUri: fileToUri(destination) }] },
      expect.any(AbortSignal),
    );
    expect(secondRequest).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(content()).toBe(original);
  });

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

  it("should report committed edits when a resolved code-action command fails", async () => {
    const { workspace, request, content } = await documentFixture();
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

  it("should reject stale edits to files opened before a later rename synchronization fails", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "lsp-rename-tracking-"));
    const source = join(root, "source");
    const destination = join(root, "renamed");
    const firstFile = join(source, "a.ts");
    const secondFile = join(source, "b.ts");
    const queryFile = join(root, "query.ts");
    let workspace: LspWorkspace | undefined;
    try {
      await fs.mkdir(source);
      await fs.writeFile(firstFile, original);
      await fs.writeFile(secondFile, original);
      await fs.writeFile(queryFile, "const query = 1;\n");
      const serverConfig: ServerConfig = {
        name: "test-server",
        command: "test-server",
        resolvedCommand: "/installed/test-server",
        args: [],
        root,
        rootMarkers: [],
        fileTypes: [".ts"],
      };
      spyOn(config, "loadLspConfig").mockResolvedValue({
        servers: [serverConfig],
        warnings: [],
        settings: {
          enabled: true,
          lazy: true,
          formatOnWrite: false,
          diagnosticsOnWrite: false,
          diagnosticsOnEdit: false,
          diagnosticsDeduplicate: true,
        },
      });
      const documents = new Map<string, { version: number; content: string }>();
      const request = mock<LanguageServer["request"]>().mockResolvedValue({
        changes: {
          [fileToUri(firstFile)]: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
              newText: "const stale = 0;\n",
            },
          ],
        },
      });
      const server: LanguageServer = {
        config: serverConfig,
        capabilities: {},
        isAlive: true,
        request: request as LanguageServer["request"],
        notify: () => Promise.resolve(),
        syncFile: (target, content) => {
          if (target === secondFile) {
            return Promise.reject(
              new Error("Second document synchronization failed"),
            );
          }
          documents.set(target, { version: 1, content: content ?? "" });
          return Promise.resolve();
        },
        saved: () => Promise.resolve(),
        closeFile: () => Promise.resolve(),
        diagnostics: async () => ({ items: [], freshness: "pull" }),
        document: (target) => documents.get(target),
        shutdown: () => Promise.resolve(),
      };
      spyOn(StdioLanguageServerPool.prototype, "get").mockResolvedValue(server);
      spyOn(StdioLanguageServerPool.prototype, "clients").mockReturnValue([
        server,
      ]);
      workspace = await LspWorkspace.create({
        cwd: root,
        agentDir: join(root, "agent"),
        trusted: true,
      });
      const failedRename = await workspace.execute({
        action: "rename_file",
        file: source,
        // biome-ignore lint/style/useNamingConvention: LSP tool schema preserves the external new_name argument.
        new_name: destination,
      });
      expect(failedRename.isError).toBe(true);
      expect(failedRename.text).toContain(
        "Second document synchronization failed",
      );
      expect(await fs.readFile(firstFile, "utf8")).toBe(original);
      expect(await fs.readFile(secondFile, "utf8")).toBe(original);
      await expect(fs.stat(destination)).rejects.toMatchObject({
        code: "ENOENT",
      });

      const interveningContent = "const edited = 2;\n";
      await fs.writeFile(firstFile, interveningContent);
      const staleRename = await workspace.execute({
        action: "rename",
        file: queryFile,
        line: 1,
        symbol: "query",
        // biome-ignore lint/style/useNamingConvention: LSP tool schema preserves the external new_name argument.
        new_name: "renamedQuery",
      });
      expect(staleRename.isError).toBe(true);
      expect(await fs.readFile(firstFile, "utf8")).toBe(interveningContent);
    } finally {
      try {
        await workspace?.dispose();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });
});
