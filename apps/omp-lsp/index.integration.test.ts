import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as host from "@earendil-works/pi-coding-agent";
import * as config from "./config";
import lsp from "./index";
import type { LspConfig, LspParams } from "./types";

const filesystem: {
  stat(file: string): Promise<{ isFile(): boolean }>;
} = fs;
const shutdowns: Array<() => unknown> = [];
type HostHandler = (event: unknown, context: ExtensionContext) => unknown;

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
  spyOn(config, "loadLspConfig").mockResolvedValue(loaded);
  spyOn(host, "getAgentDir").mockReturnValue("/agent");
  spyOn(filesystem, "stat").mockResolvedValue({ isFile: () => true });

  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, HostHandler>();
  const pi = {
    registerTool(tool: ToolDefinition): void {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: HostHandler): void {
      handlers.set(event, handler);
    },
  };
  // The fixture supplies only the host APIs and context fields this path uses.
  lsp(pi as ExtensionAPI);
  const context = {
    cwd: "/project",
    hasUI: false,
    isProjectTrusted: () => true,
  } as ExtensionContext;
  const tool = tools.get("lsp");
  const shutdown = handlers.get("session_shutdown");
  if (!tool || !shutdown) throw new Error("LSP extension registration failed");
  shutdowns.push(() =>
    shutdown({ type: "session_shutdown", reason: "quit" }, context),
  );
  return (params: LspParams) =>
    tool.execute(
      "missing-server-test",
      params,
      new AbortController().signal,
      undefined,
      context,
    );
}

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
});

describe("lsp.execute", () => {
  test("should reject navigation requests when the matching server is not installed", async () => {
    const execute = fixture();
    await expect(
      execute({
        action: "hover",
        file: "example.ts",
        line: 1,
        symbol: "value",
      }),
    ).rejects.toThrow(/No language server found/);
  });

  test("should reject diagnostics instead of reporting a clean file when the matching server is not installed", async () => {
    const execute = fixture();
    await expect(
      execute({ action: "diagnostics", file: "example.ts" }),
    ).rejects.toThrow(/No language server found/);
  });
});
