import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace; copied named imports cannot intercept consumers.
import * as host from "@earendil-works/pi-coding-agent";
// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace; copied named imports cannot intercept consumers.
import * as config from "./config.ts";

import lsp from "./index.ts";
import type { LspConfig, LspParams } from "./types.ts";

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
        context as ExtensionContext,
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
  for (const shutdown of shutdowns.splice(0)) {
    await shutdown();
  }
});

describe("lsp.execute", () => {
  test("should reject navigation requests when the matching server is not installed", async () => {
    const { execute } = fixture();
    await expect(
      execute({
        action: "hover",
        file: "example.ts",
        line: 1,
        symbol: "value",
      }),
    ).rejects.toThrow("No language server found");
  });

  test("should reject diagnostics instead of reporting a clean file when the matching server is not installed", async () => {
    const { execute } = fixture();
    await expect(
      execute({ action: "diagnostics", file: "example.ts" }),
    ).rejects.toThrow("No language server found");
  });

  test("should discard cached configuration when project trust is revoked", async () => {
    const { context, execute, loadConfig, loaded } = fixture();
    await execute({ action: "status" });
    context.isProjectTrusted = () => false;
    await expect(execute({ action: "status" })).rejects.toThrow(
      "trusted project",
    );
    expect(loadConfig).toHaveBeenCalledTimes(1);

    context.isProjectTrusted = () => true;
    loadConfig.mockResolvedValue({
      ...loaded,
      settings: { ...loaded.settings, enabled: false },
    });
    const result = await execute({ action: "status" });
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("disabled") },
    ]);
  });

  test("should replace stale configuration when the host changes workspace roots", async () => {
    const { context, execute, loadConfig, loaded } = fixture();
    await execute({ action: "status" });
    context.cwd = "/second-project";
    loadConfig.mockResolvedValue({
      ...loaded,
      servers: [],
      settings: { ...loaded.settings, enabled: false },
    });

    const result = await execute({ action: "status" });
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("disabled"),
      },
    ]);
    expect(result.content).not.toEqual([
      { type: "text", text: expect.stringContaining("uninstalled") },
    ]);
    expect(loadConfig).toHaveBeenLastCalledWith(
      "/second-project",
      "/agent",
      true,
    );
  });

  test("should apply reloaded settings when configuration disables the extension", async () => {
    const { execute, loadConfig, loaded } = fixture();
    await execute({ action: "status" });
    loadConfig.mockResolvedValue({
      ...loaded,
      settings: { ...loaded.settings, enabled: false },
    });

    expect((await execute({ action: "reload" })).details).toMatchObject({
      action: "reload",
      success: true,
    });
    expect((await execute({ action: "status" })).content).toEqual([
      { type: "text", text: expect.stringContaining("disabled") },
    ]);
    await expect(
      execute({ action: "hover", file: "example.ts", line: 1 }),
    ).rejects.toThrow("disabled");
  });

  test("should report a sanitized reload failure when no configured server is available", async () => {
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

  test("should preserve cached settings when reloading configuration fails", async () => {
    const { execute, loadConfig } = fixture();
    const before = await execute({ action: "status" });
    loadConfig.mockRejectedValueOnce(new Error("configuration unreadable"));
    await expect(execute({ action: "reload" })).rejects.toThrow(
      "LSP error: configuration unreadable",
    );
    expect(await execute({ action: "status" })).toEqual(before);
  });

  test("should retain a usable workspace when only the caller cancels a request", async () => {
    const { execute, loadConfig } = fixture();
    const before = await execute({ action: "status" });
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    await expect(
      execute({ action: "status" }, controller.signal),
    ).rejects.toThrow("caller cancelled");
    expect(await execute({ action: "status" })).toEqual(before);
    expect(loadConfig).toHaveBeenCalledTimes(1);
  });
});

describe("lsp.session_start", () => {
  test("should avoid reading configuration when the project is untrusted", async () => {
    const { context, emit, loadConfig, notifications } = fixture();
    context.hasUI = true;
    context.isProjectTrusted = () => false;
    await emit("session_start");
    expect(loadConfig).not.toHaveBeenCalled();
    expect(notifications).toEqual([]);
  });

  test.each([
    { mode: "interactive", hasUi: true, notificationCount: 1 },
    { mode: "non-interactive", hasUi: false, notificationCount: 0 },
  ])(
    "should initialize usable status with safe warning delivery when the host is $mode",
    async ({ hasUi, notificationCount }) => {
      const { context, emit, execute, loaded, notifications } = fixture();
      context.hasUI = hasUi;
      loaded.warnings.push("\u001b[31munsafe\tconfiguration\u0007\u001b[0m");
      await emit("session_start");
      expect(notifications).toHaveLength(notificationCount);
      for (const notification of notifications) {
        expect(notification.level).toBe("warning");
        expect(notification.message).toContain("unsafe");
        expect(notification.message).toContain("configuration");
        expect(notification.message).not.toMatch(CONTROL_CHARACTER);
      }
      const result = await execute({ action: "status" });
      expect(result.details).toMatchObject({ action: "status", success: true });
      expect(result.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining("unsafe"),
        },
      ]);
      for (const part of result.content) {
        if (part.type === "text") {
          expect(part.text.replaceAll("\n", "")).not.toMatch(CONTROL_CHARACTER);
        }
      }
    },
  );

  test.each([
    { mode: "interactive", hasUi: true, notificationCount: 1 },
    { mode: "non-interactive", hasUi: false, notificationCount: 0 },
  ])(
    "should recover from initialization failure without failing the session when the host is $mode",
    async ({ hasUi, notificationCount }) => {
      const { context, emit, execute, loadConfig, notifications } = fixture();
      context.hasUI = hasUi;
      loadConfig.mockRejectedValueOnce(
        new Error("\u001b[31mbad\tconfiguration\u0007\u001b[0m"),
      );
      await emit("session_start");
      expect(notifications).toHaveLength(notificationCount);
      for (const notification of notifications) {
        expect(notification.level).toBe("error");
        expect(notification.message).toContain("bad");
        expect(notification.message).toContain("configuration");
        expect(notification.message).not.toMatch(CONTROL_CHARACTER);
      }
      expect((await execute({ action: "status" })).details).toMatchObject({
        action: "status",
        success: true,
      });
    },
  );
});

describe("lsp.session_shutdown", () => {
  test("should cancel pending initialization and allow a fresh session when shutdown occurs while configuration loads", async () => {
    const { emit, execute, loadConfig, loaded } = fixture();
    const { promise: pending, resolve: finishLoading } =
      Promise.withResolvers<LspConfig>();
    const { promise: loading, resolve: markLoading } =
      Promise.withResolvers<void>();
    loadConfig.mockImplementationOnce(() => {
      markLoading();
      return pending;
    });
    const result = execute({ action: "status" }).then(
      () => "unexpected success",
      (error: unknown) => String(error),
    );
    try {
      await loading;
      const shutdown = emit("session_shutdown");
      finishLoading(loaded);
      await shutdown;
      expect(await result).toContain("LSP session ended");
      await emit("session_start");
      expect((await execute({ action: "status" })).details).toMatchObject({
        action: "status",
        success: true,
      });
    } finally {
      finishLoading(loaded);
      await result;
    }
  });
});

describe("lsp.tool_result", () => {
  test.each([
    {
      condition: "the host operation failed",
      toolName: "write",
      isError: true,
      path: "example.ts",
      trusted: true,
    },
    {
      condition: "the host operation is not a mutation",
      toolName: "read",
      isError: false,
      path: "example.ts",
      trusted: true,
    },
    {
      condition: "project trust was not granted",
      toolName: "write",
      isError: false,
      path: "example.ts",
      trusted: false,
    },
    {
      condition: "the mutation path is not a string",
      toolName: "edit",
      isError: false,
      path: null,
      trusted: true,
    },
  ])(
    "should leave host output untouched without reading configuration when $condition",
    async ({ toolName, isError, path, trusted }) => {
      const { context, emit, loadConfig } = fixture();
      context.isProjectTrusted = () => trusted;
      expect(
        await emit("tool_result", {
          toolName,
          isError,
          input: { path },
          content: [{ type: "text", text: "original host output" }],
        }),
      ).toBeUndefined();
      expect(loadConfig).not.toHaveBeenCalled();
    },
  );

  test("should append safe feedback without failing a committed write when file inspection fails", async () => {
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

  test("should preserve committed host output when the mutation path uses an unsupported URI scheme", async () => {
    const { emit } = fixture();
    const content = [{ type: "text", text: "host edit succeeded" }];
    expect(
      await emit("tool_result", {
        toolName: "edit",
        isError: false,
        input: { path: "https://example.com/file.ts" },
        content,
      }),
    ).toBeUndefined();
  });

  test("should omit optional feedback when the host has already cancelled mutation work", async () => {
    const { context, emit } = fixture();
    const controller = new AbortController();
    controller.abort(new Error("host cancelled"));
    context.signal = controller.signal;
    expect(
      await emit("tool_result", {
        toolName: "write",
        isError: false,
        input: { path: "example.ts" },
        content: [{ type: "text", text: "host write succeeded" }],
      }),
    ).toBeUndefined();
  });

  test("should leave host output untouched when optional feedback is disabled", async () => {
    const { emit } = fixture();
    expect(
      await emit("tool_result", {
        toolName: "edit",
        isError: false,
        input: { path: "example.ts" },
        content: [{ type: "text", text: "host edit succeeded" }],
      }),
    ).toBeUndefined();
  });
});
