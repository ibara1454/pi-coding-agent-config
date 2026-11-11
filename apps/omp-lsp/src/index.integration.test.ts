import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace; copied named imports cannot intercept consumers.
import * as host from "@earendil-works/pi-coding-agent";
// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace; copied named imports cannot intercept consumers.
import * as config from "./configuration/config.ts";
import lsp from "./index.ts";
import type { LspConfig, LspParams } from "./runtime/types.ts";

const CONTROL_CHARACTER = /\p{Cc}/u;

const filesystem: {
  stat: (file: string) => Promise<{ isFile: () => boolean }>;
} = fs;
const shutdowns: Array<() => unknown> = [];
type HostHandler = (event: unknown, context: ExtensionContext) => unknown;

/**
 * Registers the real extension with an in-memory host and effect-only config/filesystem spies.
 * @returns Mutable host context, commands and events; afterEach owns workspace shutdown.
 * @example await fixture().execute({ action: "status" }) reports unavailable configured servers.
 */
function fixture() {
  const loaded: LspConfig = {
    servers: [
      {
        name: "uninstalled",
        command: "/missing/language-server",
        args: [],
        fileTypes: [".ts"],
        rootMarkers: [],
        root: "/project",
      },
    ],
    warnings: [],
    settings: {
      enabled: true,
      lazy: true,
      formatOnWrite: false,
      diagnosticsOnWrite: false,
      diagnosticsOnEdit: false,
      diagnosticsDeduplicate: true,
    },
  };
  const loadConfig = spyOn(config, "loadLspConfig").mockResolvedValue(loaded);
  spyOn(host, "getAgentDir").mockReturnValue("/agent");
  spyOn(filesystem, "stat").mockResolvedValue({ isFile: () => true });

  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, HostHandler>();
  const pi = {
    registerTool(definition: ToolDefinition): void {
      tools.set(definition.name, definition);
    },
    on(event: string, handler: HostHandler): void {
      handlers.set(event, handler);
    },
  };
  // The fixture supplies only the host APIs and context fields this path uses.
  lsp(pi as ExtensionAPI);
  const notifications: Array<{ message: string; level: string }> = [];
  const context = {
    cwd: "/project",
    // biome-ignore lint/style/useNamingConvention: Host ExtensionContext uses the public hasUI field.
    hasUI: false,
    isProjectTrusted: () => true,
    signal: undefined as AbortSignal | undefined,
    ui: {
      notify(message: string, level: string): void {
        notifications.push({ message, level });
      },
    },
  };
  const tool = tools.get("lsp");
  const shutdown = handlers.get("session_shutdown");
  if (!(tool && shutdown)) {
    throw new Error("LSP extension registration failed");
  }
  shutdowns.push(() =>
    shutdown(
      { type: "session_shutdown", reason: "quit" },
      context as ExtensionContext,
    ),
  );
  return {
    loaded,
    loadConfig,
    context,
    notifications,
    /**
     * Executes the registered host tool with the current context and caller cancellation.
     * @param params - Requested LSP action.
     * @param signal - Optional caller cancellation, independent of session shutdown.
     * @returns Host tool result; rejects when the requested operation fails.
     * @example await execute({ action: "status" }) returns host-formatted status text.
     */
    execute(params: LspParams, signal = new AbortController().signal) {
      return tool.execute(
        "lifecycle-test",
        params,
        signal,
        undefined,
        context as ExtensionToolContext,
      );
    },
    /**
     * Delivers a host event to the extension without replacing its workspace behavior.
     * @param event - Registered host event name.
     * @param data - Event payload, defaulting to its type.
     * @returns The handler's optional host output or completion promise.
     * @throws If the requested event was not registered.
     * @example await emit("session_start") initializes the trusted workspace.
     */
    emit(event: string, data: unknown = { type: event }) {
      const handler = handlers.get(event);
      if (!handler) {
        throw new Error(`Missing LSP event handler: ${event}`);
      }
      return handler(data, context as ExtensionContext);
    },
  };
}

afterEach(async () => {
  try {
    for (const shutdown of shutdowns.splice(0)) {
      await shutdown();
    }
  } finally {
    mock.restore();
  }
});

describe("lsp.execute", () => {
  it("should reject diagnostics instead of reporting a clean file when the matching server is not installed", async () => {
    const { execute } = fixture();
    await expect(
      execute({ action: "diagnostics", file: "example.ts" }),
    ).rejects.toThrow("No language server found");
  });

  it("should report a sanitized reload failure when no configured server is available", async () => {
    const { execute, loaded } = fixture();
    loaded.warnings.push("\u001b[31mmissing\tcommand\u0007\u001b[0m");
    const request = execute({ action: "reload" });
    await expect(request).rejects.toThrow("no language servers available");
    await request.catch((error: unknown) => {
      const message = String(error);
      expect(message).toContain("missing");
      expect(message).toContain("command");
      expect(message.replaceAll("\n", "")).not.toMatch(CONTROL_CHARACTER);
    });
  });
});

describe("lsp.tool_result", () => {
  it("should append safe feedback without failing a committed write when file inspection fails", async () => {
    const { emit } = fixture();
    spyOn(filesystem, "stat").mockRejectedValueOnce(
      new Error("\u001b[31minspection\tdenied\u0007\u001b[0m"),
    );
    const original = { type: "text", text: "host write succeeded" };
    const result = (await emit("tool_result", {
      toolName: "write",
      isError: false,
      input: { path: "@example.ts" },
      content: [original],
    })) as { content: Array<{ type: string; text: string }> };
    expect(result.content).toEqual([
      original,
      { type: "text", text: expect.any(String) },
    ]);
    const [, feedback] = result.content;
    expect(feedback?.type).toBe("text");
    expect(feedback?.text).toContain("example.ts");
    expect(feedback?.text).toContain("inspection");
    expect(feedback?.text).toContain("denied");
    expect(feedback?.text).not.toMatch(CONTROL_CHARACTER);
  });
});
