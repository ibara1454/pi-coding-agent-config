import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace to intercept host effects.
import * as host from "@earendil-works/pi-coding-agent";
import lsp from "./index.ts";
import type { LspParams, LspResult } from "./types.ts";
import { LspWorkspace } from "./workspace.ts";

type Handler = (event: unknown, context: ExtensionContext) => unknown;
const shutdowns: Array<() => unknown> = [];
const RENDER_WIDTH = 200;
const OUTPUT_LIMIT = 65_536;

/**
 * Registers real host policy with a workspace double owning only external effects.
 * @returns The tool, events, context and planned workspace effects; afterEach releases the session.
 * @example await fixture().execute({ action: "status" }) returns sanitized workspace text.
 */
function fixture() {
  const workspace = {
    warnings: [] as string[],
    execute: mock(async (): Promise<LspResult> => ({ text: "ready" })),
    afterMutation: mock(
      async (_files: readonly string[]): Promise<LspResult | undefined> => ({
        text: "feedback",
      }),
    ),
    dispose: mock(async () => undefined),
  };
  const workspaceFactory: {
    create: (
      ...args: Parameters<typeof LspWorkspace.create>
    ) => Promise<
      Pick<LspWorkspace, "warnings" | "execute" | "afterMutation" | "dispose">
    >;
  } = LspWorkspace;
  const create = spyOn(workspaceFactory, "create").mockResolvedValue(workspace);
  spyOn(host, "getAgentDir").mockReturnValue("/agent");
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Handler>();
  const pi = {
    registerTool(definition: ToolDefinition): void {
      tools.set(definition.name, definition);
    },
    on(name: string, handler: Handler): void {
      handlers.set(name, handler);
    },
  };
  lsp(pi as ExtensionAPI);
  const notifications: Array<{ message: string; level: string }> = [];
  const context = {
    cwd: "/project",
    // biome-ignore lint/style/useNamingConvention: Host context uses this public field.
    hasUI: true,
    isProjectTrusted: () => true,
    signal: undefined as AbortSignal | undefined,
    ui: {
      notify(
        message: string,
        level: "info" | "warning" | "error" = "info",
      ): void {
        notifications.push({ message, level });
      },
    },
  };
  const tool = tools.get("lsp");
  if (!tool) {
    throw new Error("LSP tool was not registered");
  }
  /**
   * Delivers a registered event through its public host interface.
   * @returns The handler's optional feedback or lifecycle completion.
   * @example await emit("session_shutdown") releases the session's workspace.
   */
  function emit(name: string, event: unknown = { type: name }) {
    const handler = handlers.get(name);
    if (!handler) {
      throw new Error(`Missing handler: ${name}`);
    }
    return handler(event, context as ExtensionContext);
  }
  shutdowns.push(() => emit("session_shutdown"));
  return {
    workspace,
    create,
    tool,
    context,
    notifications,
    emit,
    /**
     * Executes a real registered host command against the planned workspace result.
     * @returns Host content and details, rejecting required-operation failures.
     * @example await execute({ action: "status" }) returns a text content block.
     */
    execute(params: LspParams) {
      return tool.execute(
        "host-policy",
        params,
        undefined,
        undefined,
        context as ExtensionContext,
      );
    },
  };
}

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) {
    await shutdown();
  }
  mock.restore();
});

const theme = {
  fg: (_color: string, text: string) => text,
} as Parameters<NonNullable<ToolDefinition["renderCall"]>>[1];

describe("lsp.execute", () => {
  test("should clip sanitized output and preserve details when a workspace returns oversized text", async () => {
    const { workspace, execute } = fixture();
    workspace.execute.mockResolvedValue({
      text: `\u001b[31m${"x".repeat(OUTPUT_LIMIT + 1)}\u0007`,
      details: { count: 3 },
    });
    const result = await execute({ action: "status" });
    expect(result.content).toEqual([
      {
        type: "text",
        text: `${"x".repeat(OUTPUT_LIMIT)}\n[LSP output truncated; narrow the request.]`,
      },
    ]);
    expect(result.details).toEqual({
      action: "status",
      success: true,
      count: 3,
    });
  });

  test("should reject sanitized workspace failures when the requested command cannot complete", async () => {
    const { workspace, execute } = fixture();
    workspace.execute.mockResolvedValue({
      text: "\u001b[31mfailed\trequest\u0007",
      isError: true,
    });
    await expect(execute({ action: "status" })).rejects.toThrow(
      "failed  request",
    );
  });
});

describe("lsp.renderCall", () => {
  test.each([
    [
      {
        action: "hover\n\u0007",
        file: "\u001b[31ma.ts",
        line: 2,
        symbol: "value\t\nname",
      },
      "lsp hover  a.ts:2 value   name",
    ],
    [{ action: "status" }, "lsp status"],
    [{ action: null, file: 3, line: Number.NaN, symbol: false }, "lsp"],
  ])(
    "should render a sanitized command when arguments are %j",
    (args, expected) => {
      const { tool } = fixture();
      const rendered = tool.renderCall?.(
        args as Parameters<NonNullable<ToolDefinition["renderCall"]>>[0],
        theme,
        {} as Parameters<NonNullable<ToolDefinition["renderCall"]>>[2],
      );
      expect(
        rendered
          ?.render(RENDER_WIDTH)
          .map((line) => line.trimEnd())
          .join("\n"),
      ).toBe(expected);
    },
  );
});

describe("lsp.renderResult", () => {
  test.each([
    {
      condition: "a long result is collapsed",
      expanded: false,
      isError: false,
      text: "one\ntwo\nthree\nfour\nfive\nsix\nseven",
      expected: "one\ntwo\nthree\nfour\nfive\nsix\n… 1 more lines",
      color: "toolOutput",
    },
    {
      condition: "a long result is expanded",
      expanded: true,
      isError: false,
      text: "one\ntwo\nthree\nfour\nfive\nsix\nseven",
      expected: "one\ntwo\nthree\nfour\nfive\nsix\nseven",
      color: "toolOutput",
    },
    {
      condition: "a short result reports an error",
      expanded: false,
      isError: true,
      text: "\u001b[31mfailed\trequest\u0007",
      expected: "failed  request",
      color: "error",
    },
  ])(
    "should render sanitized bounded text when $condition",
    ({ expanded, isError, text, expected, color }) => {
      const { tool } = fixture();
      const foreground = spyOn(theme, "fg").mockImplementation(
        (_color, value) => value,
      );
      const rendered = tool.renderResult?.(
        {
          content: [
            { type: "image", data: "ignored", mimeType: "image/png" },
            { type: "text", text },
          ],
          details: {},
        },
        { expanded, isPartial: false },
        theme,
        { isError } as Parameters<
          NonNullable<ToolDefinition["renderResult"]>
        >[3],
      );
      expect(
        rendered
          ?.render(RENDER_WIDTH)
          .map((line) => line.trimEnd())
          .join("\n"),
      ).toBe(expected);
      expect(foreground).toHaveBeenCalledWith(color, expected);
    },
  );
});

describe("lsp.tool_result", () => {
  test.each([
    ["~", homedir()],
    ["~/source.ts", join(homedir(), "source.ts")],
    [pathToFileURL("/project/source.ts").href, "/project/source.ts"],
    ["@nested\u00a0file.ts", resolve("/project", "nested file.ts")],
  ])(
    "should retain host output and append feedback when the mutation path is %s",
    async (input, expected) => {
      const { workspace, emit } = fixture();
      workspace.afterMutation.mockImplementation(async (files) => ({
        text: `checked ${files.join(",")}`,
      }));
      const result = await emit("tool_result", {
        toolName: "write",
        input: { path: input },
        isError: false,
        content: [{ type: "text", text: "written" }],
      });
      expect(result).toEqual({
        content: [
          { type: "text", text: "written" },
          { type: "text", text: `checked ${expected}` },
        ],
      });
    },
  );

  test("should preserve successful mutation content when optional feedback fails", async () => {
    const { workspace, emit } = fixture();
    workspace.afterMutation.mockRejectedValue(
      new Error("\u001b[31munavailable\tserver\u0007"),
    );
    expect(
      await emit("tool_result", {
        toolName: "edit",
        input: { path: "source.ts" },
        content: [{ type: "text", text: "edited" }],
      }),
    ).toEqual({
      content: [
        { type: "text", text: "edited" },
        {
          type: "text",
          text: "LSP feedback unavailable: Error: unavailable  server",
        },
      ],
    });
  });

  test("should omit optional feedback when cancellation interrupts the mutation event", async () => {
    const { context, workspace, emit } = fixture();
    context.signal = AbortSignal.abort(new Error("cancelled"));
    expect(
      await emit("tool_result", {
        toolName: "write",
        input: { path: "source.ts" },
        content: [],
      }),
    ).toBeUndefined();
    expect(workspace.afterMutation).not.toHaveBeenCalled();
  });
});

describe("lsp.session_start", () => {
  test("should notify initialization failure and allow recovery when workspace acquisition rejects", async () => {
    const { create, emit, notifications, execute } = fixture();
    create.mockRejectedValueOnce(
      new Error("\u001b[31mconfiguration\tfailed\u0007"),
    );
    await emit("session_start");
    expect(notifications).toEqual([
      {
        message: "LSP initialization failed: Error: configuration  failed",
        level: "error",
      },
    ]);
    expect((await execute({ action: "status" })).content).toEqual([
      { type: "text", text: "ready" },
    ]);
  });
});

describe("lsp.session_shutdown", () => {
  test("should report sanitized disposal failures and release state when the session shuts down", async () => {
    const { workspace, emit, notifications, execute } = fixture();
    await execute({ action: "status" });
    workspace.dispose.mockRejectedValueOnce(
      new Error("\u001b[31mdispose\tfailed\u0007"),
    );
    await emit("session_shutdown");
    expect(notifications).toEqual([
      {
        message: "LSP shutdown failed: Error: dispose  failed",
        level: "error",
      },
    ]);
    await emit("session_shutdown");
    expect(workspace.dispose).toHaveBeenCalledTimes(1);
  });
});
