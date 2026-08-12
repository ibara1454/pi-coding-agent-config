import { expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

mock.module("@earendil-works/pi-coding-agent", () => ({
  CustomEditor: class {},
  estimateTokens: () => 0,
}));
mock.module("@earendil-works/pi-tui", () => ({
  truncateToWidth: (value: string): string => value,
  visibleWidth: (value: string): number => Bun.stringWidth(Bun.stripANSI(value)),
}));

function statusText(line: string): string {
  const plain = Bun.stripANSI(line);
  const capIndex = plain.indexOf("▶", 3);
  if (capIndex < 0) throw new Error(`Expected status-line end cap in ${plain}`);
  return plain.slice(3, capIndex + 1);
}

test("shrinks a short path before dropping context usage", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-status-line-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let editorFactory: ((...args: unknown[]) => { render(width: number): string[] }) | undefined;

  try {
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        statusLine: {
          preset: "custom",
          leftSegments: ["model", "path", "context_pct"],
          rightSegments: [],
          separator: "powerline-thin",
          sessionAccent: false,
          segmentOptions: {
            model: { showThinkingLevel: false },
            path: { abbreviate: false, maxLength: 40, stripWorkPrefix: false },
          },
        },
      }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const theme = {
      fg: (_color: string, text: string): string => text,
      getFgAnsi: (_color: string): string => "",
    };
    const ui = {
      theme,
      getEditorComponent: () => () => ({ render: (_width: number): string[] => ["header", "prompt", "────"] }),
      setEditorComponent: (factory: unknown): void => {
        editorFactory = factory as (...args: unknown[]) => { render(width: number): string[] };
      },
      setFooter: (_factory: unknown): void => {},
    };
    const context = {
      cwd: "/tmp/status-priority-path",
      mode: "tui",
      ui,
      model: { id: "test-model", name: "Test", contextWindow: 272_000, reasoning: false },
      thinkingLevel: "off",
      getContextUsage: () => ({ tokens: 18_768, contextWindow: 272_000 }),
      getSystemPrompt: () => "",
      modelRegistry: { isUsingOAuth: () => false },
      sessionManager: {
        getBranch: () => [{
          type: "message",
          message: { role: "assistant", stopReason: "stop", usage: { input: 18_768 } },
        }],
        buildContextEntries: () => [],
        getSessionName: () => undefined,
        getSessionId: () => undefined,
      },
    };
    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown): void => {
        handlers.set(event, handler);
      },
      exec: async () => ({ code: 1, stdout: "" }),
      getActiveTools: () => [],
      getAllTools: () => [],
    };
    // The extension is loaded after its Pi-host runtime modules are mocked.
    const { default: ompStatusLine } = await import("./index.ts");

    ompStatusLine(pi as never);
    const sessionStart = handlers.get("session_start");
    if (!sessionStart) throw new Error("Expected session_start handler");
    await sessionStart({}, context);
    if (!editorFactory) throw new Error("Expected editor component to be installed");

    const editor = editorFactory({}, theme, {});
    const fullStatus = statusText(editor.render(160)[0] ?? "");
    expect(fullStatus).toContain("6.9%/272K");

    // Two columns short: the configured 40-column limit does not constrain this path yet.
    const narrowWidth = Bun.stringWidth(fullStatus) + 4;
    const narrowTop = editor.render(narrowWidth)[0] ?? "";
    const narrowStatus = statusText(narrowTop);
    expect(narrowStatus).toContain("6.9%/272K");
    expect(narrowStatus).toContain("…");
    expect(Bun.stringWidth(Bun.stripANSI(narrowTop))).toBe(narrowWidth);
  } finally {
    await handlers.get("session_shutdown")?.({});
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
