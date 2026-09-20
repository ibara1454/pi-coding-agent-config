import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { LspAction, LspResult } from "./types.ts";
import { LspWorkspace } from "./workspace.ts";

const CONTROL_CHARACTER = /\p{Cc}/gu;
const PATH_WHITESPACE = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;
const LEADING_AT = /^@/;
const WINDOWS_MOUNT = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i;
const FILE_URI = /^file:\/\//;
const URI_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

const actions = [
  "diagnostics",
  "definition",
  "references",
  "hover",
  "symbols",
  "rename",
  "rename_file",
  "code_actions",
  "type_definition",
  "implementation",
  "status",
  "reload",
  "capabilities",
  "request",
] as const satisfies readonly LspAction[];

const parameters = Type.Object(
  {
    action: Type.Union(actions.map((action) => Type.Literal(action))),
    file: Type.Optional(
      Type.String({
        description:
          "File path; diagnostics also accepts globs. Use * for workspace diagnostics, symbols, capabilities or reload.",
      }),
    ),
    line: Type.Optional(
      Type.Integer({ minimum: 1, description: "1-indexed source line." }),
    ),
    symbol: Type.Optional(
      Type.String({
        description:
          "Symbol text on the line; append #N to select an occurrence.",
      }),
    ),
    query: Type.Optional(
      Type.String({
        description:
          "Symbol search, code-action title/index/kind, or raw LSP method name.",
      }),
    ),
    // biome-ignore lint/style/useNamingConvention: LSP tool schema preserves the external new_name argument.
    new_name: Type.Optional(
      Type.String({
        description: "New symbol name or destination file/directory path.",
      }),
    ),
    apply: Type.Optional(
      Type.Boolean({
        description:
          "Rename and rename_file apply by default; false previews. Code actions require true to apply a selected action.",
      }),
    ),
    timeout: Type.Optional(
      Type.Number({
        minimum: 5,
        maximum: 300,
        description: "Request timeout in seconds; default 20.",
      }),
    ),
    payload: Type.Optional(
      Type.String({
        description: "JSON-encoded parameters for a raw request.",
      }),
    ),
  },
  { additionalProperties: false },
);

function cleanText(text: string): string {
  return stripTerminalSequences(text).replace(
    CONTROL_CHARACTER,
    (character) => {
      if (character === "\n") {
        return character;
      }
      return character === "\t" ? "  " : "";
    },
  );
}

function outputText(result: LspResult): string {
  const text = cleanText(result.text);
  const limit = 64 * 1024;
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[LSP output truncated; narrow the request.]`;
}

/** Matches Pi's write/edit path aliases so feedback synchronizes the file the host actually changed. */
function mutationFile(input: string, cwd: string): string | undefined {
  let file = input.replace(PATH_WHITESPACE, " ").replace(LEADING_AT, "");
  if (
    process.platform === "win32" &&
    file.startsWith("/") &&
    !file.startsWith("//") &&
    !file.includes("\\")
  ) {
    const drive = file.match(WINDOWS_MOUNT);
    if (drive?.[1]) {
      file = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
    }
  }
  if (file === "~") {
    file = homedir();
  } else if (
    file.startsWith("~/") ||
    (process.platform === "win32" && file.startsWith("~\\"))
  ) {
    file = join(homedir(), file.slice(2));
  } else if (FILE_URI.test(file)) {
    file = fileURLToPath(file);
  } else if (URI_SCHEME.test(file)) {
    return undefined;
  }
  return resolve(cwd, file);
}

interface WorkspaceState {
  cwd: string;
  controller: AbortController;
  ready: Promise<LspWorkspace>;
}

/** Registers the session-owned LSP tool and optional feedback for successful host mutations. */
export default function lsp(pi: ExtensionAPI): void {
  let state: WorkspaceState | undefined;

  /** Aborts current work and releases its workspace once pending creation settles. */
  async function release(): Promise<void> {
    const previous = state;
    state = undefined;
    if (!previous) {
      return;
    }
    previous.controller.abort(new Error("LSP session ended"));
    // Creation's cancellation path disposes any workspace it acquired.
    await previous.ready.then(
      (workspace) => workspace.dispose(),
      () => undefined,
    );
  }

  /** Reuses the current context's workspace and disposes its predecessor before replacement. */
  function workspaceFor(ctx: ExtensionContext): WorkspaceState {
    const cwd = resolve(ctx.cwd);
    if (state?.cwd === cwd && !state.controller.signal.aborted) {
      return state;
    }
    const previous = state;
    previous?.controller.abort(new Error("LSP workspace changed"));
    const controller = new AbortController();
    const ready = Promise.resolve().then(async () => {
      if (previous) {
        let previousWorkspace: LspWorkspace | undefined;
        try {
          previousWorkspace = await previous.ready;
        } catch {
          // Failed initialization has no reusable session state.
        }
        await previousWorkspace?.dispose();
      }
      controller.signal.throwIfAborted();
      const workspace = await LspWorkspace.create({
        cwd,
        agentDir: getAgentDir(),
        trusted: ctx.isProjectTrusted(),
      });
      if (controller.signal.aborted) {
        await workspace.dispose();
        controller.signal.throwIfAborted();
      }
      return workspace;
    });
    const next = { cwd, controller, ready };
    state = next;
    // The original promise is still observed by callers; avoid an unhandled
    // rejection when a session shuts down before any caller awaits creation.
    ready.catch(() => {
      if (state === next) {
        state = undefined;
      }
    });
    return next;
  }

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description:
      "Language-server code intelligence and refactoring. Inspect diagnostics, definitions, type definitions, implementations, references, hover information and symbols; rename symbols/files, apply code actions, inspect/reload servers, or send a raw LSP request. Requires a trusted project and an installed matching server. Servers and workspace checkers run with host permissions, outside the Bash sandbox.",
    promptSnippet:
      "Semantic code navigation, diagnostics, and symbol-aware refactoring using installed language servers",
    promptGuidelines: [
      "Use lsp for symbol definitions, references, renames and code actions when a server is available.",
      "Use file + 1-indexed line + symbol for precise positions; name#N selects a repeated occurrence.",
      "rename and rename_file apply by default; pass apply:false to preview. code_actions lists by default; select one with query and apply:true.",
      "Use symbols with file:* and query to search the workspace. diagnostics with file:* runs available project checkers.",
      "Missing servers and failed diagnostics are not evidence that code is correct; inspect lsp status for configuration problems.",
    ],
    parameters,
    executionMode: "sequential",
    // biome-ignore lint/complexity/useMaxParams: The base execute signature already has many parameters.
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!ctx.isProjectTrusted()) {
        await release();
        throw new Error(
          "LSP requires a trusted project before running language servers or project checkers.",
        );
      }
      const current = workspaceFor(ctx);
      const combined = signal
        ? AbortSignal.any([signal, current.controller.signal])
        : current.controller.signal;
      combined.throwIfAborted();
      const workspace = await current.ready;
      combined.throwIfAborted();
      const result = await workspace.execute(params, combined);
      if (result.isError) {
        throw new Error(outputText(result));
      }
      return {
        content: [{ type: "text", text: outputText(result) }],
        details: { action: params.action, success: true, ...result.details },
      };
    },
    renderCall(args, theme) {
      const action =
        typeof args.action === "string"
          ? cleanText(args.action).replaceAll("\n", " ")
          : "";
      const target =
        typeof args.file === "string"
          ? ` ${cleanText(args.file).replaceAll("\n", " ")}`
          : "";
      const position =
        typeof args.line === "number" && Number.isFinite(args.line)
          ? `:${args.line}`
          : "";
      const symbol =
        typeof args.symbol === "string"
          ? ` ${cleanText(args.symbol).replaceAll("\n", " ")}`
          : "";
      return new Text(
        theme.fg("toolTitle", `lsp ${action}${target}${position}${symbol}`),
        0,
        0,
      );
    },
    renderResult(result, options, theme, context) {
      const text = cleanText(
        result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      );
      const lines = text.split("\n");
      const visible =
        options.expanded || lines.length <= 6
          ? text
          : `${lines.slice(0, 6).join("\n")}\n… ${lines.length - 6} more lines`;
      return new Text(
        theme.fg(context.isError ? "error" : "toolOutput", visible),
        0,
        0,
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await release();
    if (!ctx.isProjectTrusted()) {
      return;
    }
    try {
      const workspace = await workspaceFor(ctx).ready;
      if (ctx.hasUI) {
        for (const warning of workspace.warnings) {
          ctx.ui.notify(cleanText(`LSP: ${warning}`), "warning");
        }
      }
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          cleanText(`LSP initialization failed: ${String(error)}`),
          "error",
        );
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (
      event.isError ||
      (event.toolName !== "write" && event.toolName !== "edit")
    ) {
      return;
    }
    if (!ctx.isProjectTrusted()) {
      return;
    }
    const { path: inputPath } = event.input;
    if (typeof inputPath !== "string") {
      return;
    }
    const current = workspaceFor(ctx);
    const combined = ctx.signal
      ? AbortSignal.any([ctx.signal, current.controller.signal])
      : current.controller.signal;
    try {
      const file = mutationFile(inputPath, ctx.cwd);
      if (!file) {
        return;
      }
      combined.throwIfAborted();
      const workspace = await current.ready;
      combined.throwIfAborted();
      const feedback = await workspace.afterMutation(
        [file],
        event.toolName,
        combined,
      );
      if (!feedback || combined.aborted) {
        return;
      }
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: outputText(feedback) },
        ],
      };
    } catch (error) {
      if (combined.aborted) {
        return;
      }
      // Optional feedback must not turn an already-committed write into failure.
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: cleanText(`LSP feedback unavailable: ${String(error)}`),
          },
        ],
      };
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await release();
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          cleanText(`LSP shutdown failed: ${String(error)}`),
          "error",
        );
      }
    }
  });
}
