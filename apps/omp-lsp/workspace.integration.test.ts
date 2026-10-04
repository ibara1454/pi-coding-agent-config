import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// biome-ignore lint/performance/noNamespaceImport: Bun spies require a live module namespace to intercept timer effects.
import * as timers from "node:timers/promises";
// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace; copied named imports cannot intercept consumers.
import * as host from "@earendil-works/pi-coding-agent";
import type { Diagnostic } from "vscode-languageserver-protocol";
// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace; copied named imports cannot intercept consumers.
import * as config from "./config.ts";
import { fileToUri } from "./edits.ts";
// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace; copied named imports cannot intercept consumers.
import * as linters from "./linters.ts";

import {
  type LanguageServer,
  LanguageServerPool,
  type DiagnosticReport as ServerDiagnosticReport,
} from "./runtime.ts";
import type { LspConfig, ServerConfig } from "./types.ts";
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
const MAX_REFERENCE_ATTEMPTS = 3;

/**
 * Builds a navigation response location without filesystem access.
 * @param target - Absolute fixture path; defaults to /project/sample.ts.
 * @param line - Zero-based line number.
 * @param character - Zero-based UTF-16 code-unit column.
 * @returns A file URI and a range spanning one code unit on the requested line.
 * @example location("/project/a.ts", 1, 2) has URI file:///project/a.ts and range (1, 2)–(1, 3).
 */
const location = (target = file, line = 0, character = 0) => ({
  uri: fileToUri(target),
  range: {
    start: { line, character },
    end: { line, character: character + 1 },
  },
});

const finding: Diagnostic = {
  range: location().range,
  severity: 1,
  message: "Unknown identifier",
};

/**
 * Creates an in-memory workspace and installs filesystem, host-queue, configuration, and server-pool spies.
 * @param linter - Selects the Biome fixture with no live pool clients when true; otherwise uses a semantic test server.
 * @returns The workspace, mutable server/config controls, request mock, stat factory, and current-content reader.
 * Registered workspaces are disposed by this file's afterEach; the shared test preload restores spies and clears mock calls.
 * @throws Propagates workspace creation failures.
 * @example
 * const { workspace, content } = await fixture();
 * // content() is "const   value={foo:1}\n"; afterEach disposes workspace.
 */
async function fixture(linter = false) {
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
  return { workspace, request, server, loaded, stat, content: () => content };
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

  test("should emit normalized findings once and clear them once when diagnostics become clean", async () => {
    const { workspace, server, loaded } = await fixture();
    loaded.settings.diagnosticsOnEdit = true;
    const diagnostics = spyOn(server, "diagnostics")
      .mockResolvedValueOnce({
        items: [{ ...finding, severity: 2 }, finding],
        freshness: "pull",
      })
      .mockResolvedValueOnce({
        items: [finding, { ...finding, severity: 2 }],
        freshness: "pull",
      })
      .mockResolvedValue({ items: [], freshness: "pull" });

    const first = await workspace.afterMutation([file, file], "edit");
    expect(first?.text).toContain("1 error(s), 0 warning(s)");
    expect(first?.text.match(/Unknown identifier/g)).toHaveLength(1);
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(await workspace.afterMutation([file], "edit")).toBeUndefined();
    expect((await workspace.afterMutation([file], "edit"))?.text).toBe(
      "sample.ts: OK",
    );
    expect(await workspace.afterMutation([file], "edit")).toBeUndefined();
  });

  test("should repeat findings when diagnostic deduplication is disabled", async () => {
    const { workspace, server, loaded } = await fixture();
    loaded.settings.diagnosticsOnWrite = true;
    loaded.settings.formatOnWrite = false;
    loaded.settings.diagnosticsDeduplicate = false;
    spyOn(server, "diagnostics").mockResolvedValue({
      items: [finding],
      freshness: "versioned",
    });
    const first = await workspace.afterMutation([file], "write");
    const second = await workspace.afterMutation([file], "write");
    expect(first?.text).toContain("Unknown identifier");
    expect(second?.text).toBe(first?.text);
  });

  test("should emit changed severity when the diagnostic range and message stay unchanged", async () => {
    const { workspace, server, loaded } = await fixture();
    loaded.settings.diagnosticsOnEdit = true;
    spyOn(server, "diagnostics")
      .mockResolvedValueOnce({ items: [finding], freshness: "pull" })
      .mockResolvedValue({
        items: [{ ...finding, severity: 2 }],
        freshness: "pull",
      });
    expect((await workspace.afterMutation([file], "edit"))?.text).toContain(
      "1 error(s), 0 warning(s)",
    );
    expect((await workspace.afterMutation([file], "edit"))?.text).toContain(
      "0 error(s), 1 warning(s)",
    );
  });

  test("should distinguish unverified silence from clean diagnostics and clear the freshness warning", async () => {
    const { workspace, server, loaded } = await fixture();
    loaded.settings.diagnosticsOnEdit = true;
    spyOn(server, "diagnostics")
      .mockResolvedValueOnce({ items: [], freshness: "pull" })
      .mockResolvedValueOnce({ items: [], freshness: "unversioned" })
      .mockResolvedValueOnce({ items: [], freshness: "unversioned" })
      .mockResolvedValue({ items: [], freshness: "versioned" });
    expect(await workspace.afterMutation([file], "edit")).toBeUndefined();
    const unverified = await workspace.afterMutation([file], "edit");
    expect(unverified?.text).toContain("sample.ts: No diagnostics reported");
    expect(unverified?.text).toContain(
      "Diagnostic freshness-unverified from test-server",
    );
    expect(unverified?.text).not.toContain("sample.ts: OK");
    expect(await workspace.afterMutation([file], "edit")).toBeUndefined();
    expect((await workspace.afterMutation([file], "edit"))?.text).toBe(
      "sample.ts: OK",
    );
    expect(await workspace.afterMutation([file], "edit")).toBeUndefined();
  });

  test("should preserve previous findings when every diagnostic source fails", async () => {
    const { workspace, server, loaded } = await fixture();
    loaded.settings.diagnosticsOnEdit = true;
    spyOn(server, "diagnostics")
      .mockResolvedValueOnce({ items: [finding], freshness: "pull" })
      .mockRejectedValueOnce(new Error("diagnostic transport closed"))
      .mockResolvedValueOnce({ items: [finding], freshness: "pull" })
      .mockResolvedValue({ items: [], freshness: "pull" });
    expect((await workspace.afterMutation([file], "edit"))?.text).toContain(
      "Unknown identifier",
    );
    const failed = await workspace.afterMutation([file], "edit");
    expect(failed?.text).toBe(
      "Diagnostics unavailable:\ntest-server: diagnostic transport closed",
    );
    expect(failed?.text).not.toContain("sample.ts: OK");
    expect(await workspace.afterMutation([file], "edit")).toBeUndefined();
    expect((await workspace.afterMutation([file], "edit"))?.text).toBe(
      "sample.ts: OK",
    );
  });

  test("should keep partial-source failures visible when repeated findings are deduplicated", async () => {
    const { workspace, server, loaded } = await fixture();
    loaded.settings.diagnosticsOnEdit = true;
    const failingConfig = { ...server.config, name: "failing-server" };
    const failingServer: LanguageServer = {
      ...server,
      config: failingConfig,
      diagnostics: mock<LanguageServer["diagnostics"]>().mockRejectedValue(
        new Error("diagnostic source unavailable"),
      ),
    };
    loaded.servers.push(failingConfig);
    spyOn(LanguageServerPool.prototype, "get").mockImplementation(
      async (selected) =>
        selected.name === failingConfig.name ? failingServer : server,
    );
    spyOn(server, "diagnostics").mockResolvedValue({
      items: [finding],
      freshness: "pull",
    });
    const first = await workspace.afterMutation([file], "edit");
    expect(first?.text).toContain("Unknown identifier");
    expect(first?.text).toContain(
      "Diagnostics partially unavailable:\nfailing-server: diagnostic source unavailable",
    );
    expect((await workspace.afterMutation([file], "edit"))?.text).toBe(
      "Diagnostics partially unavailable:\nfailing-server: diagnostic source unavailable",
    );
  });

  test("should continue synchronizing later live servers and skip saves after failed synchronization", async () => {
    const { workspace, server, loaded } = await fixture();
    loaded.settings.formatOnWrite = false;
    const sync = spyOn(server, "syncFile").mockRejectedValue(
      new Error("document update rejected"),
    );
    const saved = spyOn(server, "saved");
    const tracked: LanguageServer = {
      ...server,
      config: { ...server.config, name: "tracked-server", fileTypes: [".rs"] },
      syncFile: mock<LanguageServer["syncFile"]>().mockResolvedValue(undefined),
      saved: mock<LanguageServer["saved"]>().mockResolvedValue(undefined),
    };
    const unrelated: LanguageServer = {
      ...tracked,
      config: { ...tracked.config, name: "unrelated-server" },
      document: () => undefined,
      syncFile: mock<LanguageServer["syncFile"]>().mockResolvedValue(undefined),
    };
    const dead: LanguageServer = {
      ...tracked,
      isAlive: false,
      syncFile: mock<LanguageServer["syncFile"]>().mockResolvedValue(undefined),
    };
    spyOn(LanguageServerPool.prototype, "clients").mockReturnValue([
      server,
      unrelated,
      dead,
      tracked,
    ]);
    const result = await workspace.afterMutation([file], "write");
    expect(result?.text).toBe(
      "test-server: synchronization failed: document update rejected",
    );
    expect(sync).toHaveBeenCalledWith(file, undefined, expect.any(AbortSignal));
    expect(saved).not.toHaveBeenCalled();
    expect(tracked.syncFile).toHaveBeenCalledTimes(1);
    expect(tracked.saved).toHaveBeenCalledWith(file);
    expect(unrelated.syncFile).not.toHaveBeenCalled();
    expect(dead.syncFile).not.toHaveBeenCalled();
  });

  test("should report a failed save without preventing synchronization of the next selected server", async () => {
    const { workspace, server } = await fixture();
    spyOn(server, "saved").mockRejectedValue(new Error("save rejected"));
    const next: LanguageServer = {
      ...server,
      syncFile: mock<LanguageServer["syncFile"]>().mockResolvedValue(undefined),
      saved: mock<LanguageServer["saved"]>().mockResolvedValue(undefined),
      document: () => undefined,
    };
    spyOn(LanguageServerPool.prototype, "clients").mockReturnValue([
      server,
      next,
    ]);
    const result = await workspace.afterMutation([file], "edit");
    expect(result?.text).toBe(
      "test-server: synchronization failed: save rejected",
    );
    expect(next.syncFile).toHaveBeenCalledTimes(1);
    expect(next.saved).toHaveBeenCalledWith(file);
  });

  test("should discard diagnostics for changed content without suppressing the next stable report", async () => {
    const { workspace, server, loaded } = await fixture();
    loaded.settings.diagnosticsOnEdit = true;
    spyOn(server, "diagnostics")
      .mockImplementationOnce(async () => {
        await fs.writeFile(file, "const changed = 2;\n", "utf8");
        return { items: [finding], freshness: "pull" };
      })
      .mockResolvedValue({ items: [finding], freshness: "pull" });
    const stale = await workspace.afterMutation([file], "edit");
    expect(stale?.text).toContain(
      "File changed during diagnostics; result discarded",
    );
    expect(stale?.text).not.toContain("Unknown identifier");
    expect((await workspace.afterMutation([file], "edit"))?.text).toContain(
      "Unknown identifier",
    );
  });

  test("should discard superseded feedback without replacing the latest diagnostic fingerprint", async () => {
    const { workspace, server, loaded } = await fixture();
    loaded.settings.diagnosticsOnEdit = true;
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<ServerDiagnosticReport>();
    let firstSignal: AbortSignal | undefined;
    spyOn(server, "diagnostics")
      .mockImplementationOnce((_file, signal) => {
        firstSignal = signal;
        started.resolve();
        return pending.promise;
      })
      .mockResolvedValue({
        items: [{ ...finding, message: "Latest finding" }],
        freshness: "pull",
      });
    const first = workspace.afterMutation([file], "edit");
    await started.promise;
    const second = await workspace.afterMutation([file], "edit");
    pending.resolve({ items: [finding], freshness: "pull" });
    expect(firstSignal?.aborted).toBe(true);
    expect(second?.text).toContain("Latest finding");
    expect(await first).toBeUndefined();
    expect(await workspace.afterMutation([file], "edit")).toBeUndefined();
  });

  test("should clear diagnostic history and close documents when a deleted file is recreated", async () => {
    const { workspace, server, loaded, stat } = await fixture();
    loaded.settings.diagnosticsOnEdit = true;
    spyOn(server, "diagnostics").mockResolvedValue({
      items: [finding],
      freshness: "pull",
    });
    expect((await workspace.afterMutation([file], "edit"))?.text).toContain(
      "Unknown identifier",
    );
    spyOn(filesystem, "stat").mockRejectedValue(
      Object.assign(new Error("file removed"), { code: "ENOENT" }),
    );
    expect(await workspace.afterMutation([file], "edit")).toBeUndefined();
    expect(server.closeFile).toHaveBeenCalledWith(file);
    expect(server.notify).toHaveBeenCalledWith(
      "workspace/didChangeWatchedFiles",
      { changes: [{ uri: fileToUri(file), type: 3 }] },
    );
    spyOn(filesystem, "stat").mockImplementation(async () => stat());
    expect((await workspace.afterMutation([file], "edit"))?.text).toContain(
      "Unknown identifier",
    );
  });

  test("should cancel pending feedback and reject later hooks when the workspace is disposed", async () => {
    const { workspace, server, loaded } = await fixture();
    loaded.settings.diagnosticsOnEdit = true;
    const started = Promise.withResolvers<void>();
    let diagnosticSignal: AbortSignal | undefined;
    const diagnostics = spyOn(server, "diagnostics").mockImplementation(
      (_file, signal) => {
        const pending = Promise.withResolvers<ServerDiagnosticReport>();
        diagnosticSignal = signal;
        signal?.addEventListener("abort", () => pending.reject(signal.reason), {
          once: true,
        });
        started.resolve();
        return pending.promise;
      },
    );
    const feedback = workspace.afterMutation([file], "edit");
    await started.promise;
    const disposal = workspace.dispose();
    expect(workspace.dispose()).toBe(disposal);
    await disposal;
    expect(diagnosticSignal?.aborted).toBe(true);
    expect(await feedback).toBeUndefined();
    expect(await workspace.afterMutation([file], "edit")).toBeUndefined();
    expect(diagnostics).toHaveBeenCalledTimes(1);
  });
});

describe("LspWorkspace.execute", () => {
  test.each(["definition", "type_definition", "implementation"] as const)(
    "should return a declaration without reference retries when the action is %s",
    async (action) => {
      const { workspace, request } = await fixture();
      const delay = spyOn(timers, "setTimeout").mockResolvedValue(undefined);
      request.mockResolvedValue([location()]);
      const result = await workspace.execute({
        action,
        file,
        line: 1,
        symbol: "value",
      });
      expect(result.isError).not.toBe(true);
      expect(result.text).toContain(`sample.ts:1:1  ${original.trim()}`);
      expect(request).toHaveBeenCalledTimes(1);
      expect(delay).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["empty", []],
    ["declaration-only", [location()]],
  ])(
    "should discover references in another file when the first response is %s",
    async (_label, initial) => {
      const { workspace, request } = await fixture();
      const delay = spyOn(timers, "setTimeout").mockResolvedValue(undefined);
      request
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce([location("/project/consumer.ts")]);
      const result = await workspace.execute({
        action: "references",
        file,
        line: 1,
        symbol: "value",
      });
      expect(result.isError).not.toBe(true);
      expect(result.text).toContain("1 reference(s):\nconsumer.ts:1:1");
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(
        1,
        "textDocument/references",
        {
          textDocument: { uri: fileToUri(file) },
          position: { line: 0, character: 8 },
          context: { includeDeclaration: true },
        },
        expect.any(AbortSignal),
      );
      expect(request.mock.calls[1]?.[1]).toEqual(request.mock.calls[0]?.[1]);
      expect(delay).toHaveBeenCalledTimes(1);
    },
  );

  test("should stop after two retries when references remain empty", async () => {
    const { workspace, request } = await fixture();
    const delay = spyOn(timers, "setTimeout").mockResolvedValue(undefined);
    request.mockResolvedValue([]);
    const result = await workspace.execute({
      action: "references",
      file,
      line: 1,
      symbol: "value",
    });
    expect(result.isError).not.toBe(true);
    expect(result.text).toBe("No references found");
    expect(request).toHaveBeenCalledTimes(MAX_REFERENCE_ATTEMPTS);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  test("should retry twice when a declaration-only response is followed by empty references", async () => {
    const { workspace, request } = await fixture();
    const delay = spyOn(timers, "setTimeout").mockResolvedValue(undefined);
    request
      .mockResolvedValueOnce([location()])
      .mockResolvedValueOnce([])
      .mockResolvedValue([location("/project/consumer.ts")]);
    const result = await workspace.execute({
      action: "references",
      file,
      line: 1,
      symbol: "value",
    });
    expect(result.text).toContain("consumer.ts:1:1");
    expect(request).toHaveBeenCalledTimes(MAX_REFERENCE_ATTEMPTS);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  test("should return references on another line without retrying the requested declaration", async () => {
    const { workspace, request } = await fixture();
    const delay = spyOn(timers, "setTimeout").mockResolvedValue(undefined);
    request.mockResolvedValue([location(file, 1)]);
    const result = await workspace.execute({
      action: "references",
      file,
      line: 1,
      symbol: "value",
    });
    expect(result.text).toBe("1 reference(s):\nsample.ts:2:1");
    expect(request).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  test("should return linter references without semantic retries when only the declaration is found", async () => {
    const { workspace, request, server } = await fixture();
    server.config.isLinter = true;
    const delay = spyOn(timers, "setTimeout").mockResolvedValue(undefined);
    request.mockResolvedValue([location()]);
    const result = await workspace.execute({
      action: "references",
      file,
      line: 1,
      symbol: "value",
    });
    expect(result.text).toContain("1 reference(s):\nsample.ts:1:1");
    expect(request).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  test("should report a failed reference retry without returning the earlier declaration as complete", async () => {
    const { workspace, request } = await fixture();
    spyOn(timers, "setTimeout").mockResolvedValue(undefined);
    request
      .mockResolvedValueOnce([location()])
      .mockRejectedValueOnce(new Error("reference request failed"));
    const result = await workspace.execute({
      action: "references",
      file,
      line: 1,
      symbol: "value",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("reference request failed");
    expect(result.text).not.toContain("1 reference(s)");
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("should stop before sending another reference request when cancellation occurs during retry delay", async () => {
    const { workspace, request } = await fixture();
    const controller = new AbortController();
    spyOn(timers, "setTimeout").mockImplementation(() => {
      const reason = new Error("reference lookup cancelled");
      controller.abort(reason);
      return Promise.reject(reason);
    });
    request.mockResolvedValue([]);
    const result = await workspace.execute(
      { action: "references", file, line: 1, symbol: "value" },
      controller.signal,
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("reference lookup cancelled");
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("should preserve navigation order and bounded cached context when targets are unreadable or oversized", async () => {
    const { workspace, request, stat } = await fixture();
    const longFile = "/project/long.ts";
    const unavailable = "/project/unavailable.ts";
    const oversized = "/project/oversized.ts";
    const blank = "/project/blank.ts";
    const limits = { sourceLength: 600, displayedLength: 500, missingLine: 20 };
    const longLine = "x".repeat(limits.sourceLength);
    const reads = spyOn(filesystem, "readFile").mockImplementation((target) => {
      if (target === unavailable) {
        return Promise.reject(new Error("access denied"));
      }
      if (target === longFile) {
        return Promise.resolve(`  ${longLine}  \r\n  second line  \r\n`);
      }
      return Promise.resolve(target === blank ? "  \n" : original);
    });
    spyOn(filesystem, "stat").mockImplementation(async (target) =>
      target === oversized ? { ...stat(), size: 16_777_217 } : stat(),
    );
    request.mockResolvedValue([
      location(longFile, 1, 2),
      location(unavailable),
      location(longFile),
      location(oversized),
      location(blank),
      location(longFile, limits.missingLine),
      location(unavailable, 0, 1),
    ]);
    const result = await workspace.execute({
      action: "definition",
      file,
      line: 1,
      symbol: "value",
    });
    expect(result.isError).not.toBe(true);
    expect(result.text.split("\n")).toEqual([
      "7 definition location(s):",
      "long.ts:2:3  second line",
      "unavailable.ts:1:1  Context unavailable: access denied",
      `long.ts:1:1  ${"x".repeat(limits.displayedLength)}`,
      "oversized.ts:1:1  Context unavailable: file exceeds context limit",
      "blank.ts:1:1",
      "long.ts:21:1",
      "unavailable.ts:1:2  Context unavailable: access denied",
    ]);
    expect(
      reads.mock.calls.filter(([target]) => target === longFile),
    ).toHaveLength(1);
    expect(
      reads.mock.calls.filter(([target]) => target === unavailable),
    ).toHaveLength(1);
    expect(reads.mock.calls.some(([target]) => target === oversized)).toBe(
      false,
    );
  });

  test("should limit reference context reads while reporting the total location count", async () => {
    const { workspace, request } = await fixture();
    const reads = spyOn(filesystem, "readFile");
    request.mockResolvedValue(
      Array.from({ length: 52 }, (_unused, line) =>
        location("/project/consumer.ts", line),
      ),
    );
    const result = await workspace.execute({
      action: "references",
      file,
      line: 1,
      symbol: "value",
    });
    expect(result.text).toStartWith("52 reference(s):");
    expect(result.text).toContain("consumer.ts:50:1");
    expect(result.text).not.toContain("consumer.ts:51:1");
    expect(result.text).toEndWith("…2 locations elided…");
    expect(
      reads.mock.calls.filter(([target]) => target === "/project/consumer.ts"),
    ).toHaveLength(1);
  });

  test("should discard navigation context when cancellation interrupts reading the first target", async () => {
    const { workspace, request } = await fixture();
    const controller = new AbortController();
    const first = "/project/first.ts";
    const second = "/project/second.ts";
    const reads = spyOn(filesystem, "readFile").mockImplementation((target) => {
      if (target === first) {
        controller.abort(new Error("context lookup cancelled"));
      }
      return Promise.resolve(original);
    });
    request.mockResolvedValue([location(first), location(second)]);
    const result = await workspace.execute(
      { action: "definition", file, line: 1, symbol: "value" },
      controller.signal,
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("context lookup cancelled");
    expect(reads.mock.calls.some(([target]) => target === second)).toBe(false);
  });

  test("should synchronize a raw-request file and derive its resolved document position when no payload is supplied", async () => {
    const { workspace, request, server } = await fixture();
    request.mockResolvedValue({ accepted: true });
    const result = await workspace.execute({
      action: "request",
      file,
      query: "test/documentPosition",
      line: 1,
      symbol: "value",
    });
    expect(result.isError).not.toBe(true);
    expect(server.syncFile).toHaveBeenCalledWith(
      file,
      original,
      expect.any(AbortSignal),
    );
    expect(request).toHaveBeenCalledWith(
      "test/documentPosition",
      {
        textDocument: { uri: fileToUri(file) },
        position: { line: 0, character: 8 },
      },
      expect.any(AbortSignal),
    );
    expect(result.text).toContain('"accepted": true');
  });

  test("should abort a file rename without requesting later edits when servers disagree about snapshots", async () => {
    const { workspace, request, server, loaded, stat, content } =
      await fixture();
    const destination = "/project/moved.ts";
    spyOn(filesystem, "lstat").mockImplementation((target) => {
      if (target === destination) {
        return Promise.reject(
          Object.assign(new Error("not found"), { code: "ENOENT" }),
        );
      }
      return Promise.resolve(stat());
    });
    request.mockResolvedValue(null);
    const secondRequest =
      mock<LanguageServer["request"]>().mockResolvedValue(null);
    const second: LanguageServer = {
      ...server,
      config: { ...server.config, name: "second-server" },
      request: secondRequest as LanguageServer["request"],
      document: () => ({ version: 1, content: "const divergent = true;\n" }),
    };
    loaded.servers.push(second.config);
    spyOn(LanguageServerPool.prototype, "get").mockImplementation(
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
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      `Servers disagree about current content of ${file}`,
    );
    expect(result.text).toContain("No files moved");
    expect(request).toHaveBeenCalledTimes(1);
    expect(secondRequest).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(content()).toBe(original);
  });

  test("should preview a file rename when server snapshots agree on content despite different document versions", async () => {
    const { workspace, request, server, loaded, stat, content } =
      await fixture();
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
      mock<LanguageServer["request"]>().mockResolvedValue(null);
    const second: LanguageServer = {
      ...server,
      config: { ...server.config, name: "second-server" },
      request: secondRequest as LanguageServer["request"],
      document: () => ({ version: 99, content: original }),
    };
    loaded.servers.push(second.config);
    spyOn(LanguageServerPool.prototype, "get").mockImplementation(
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

  test("should reject stale edits to files opened before a later rename synchronization fails", async () => {
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
      spyOn(LanguageServerPool.prototype, "get").mockResolvedValue(server);
      spyOn(LanguageServerPool.prototype, "clients").mockReturnValue([server]);
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
