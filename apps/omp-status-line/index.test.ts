import { expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

mock.module("@earendil-works/pi-coding-agent", () => ({
  CustomEditor: class {},
  estimateTokens: () => 0,
}));

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function statusText(line: string): string {
  const plain = Bun.stripANSI(line);
  const capIndex = plain.indexOf("▶", 3);
  if (capIndex < 0) throw new Error(`Expected status-line end cap in ${plain}`);
  return plain.slice(3, capIndex + 1);
}

async function createSettingsFixture(
  globalStatusLine: Record<string, unknown>,
  projectStatusLine?: Record<string, unknown>,
): Promise<{
  projectDir: string;
  cleanup(): Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-status-line-"));
  const agentDir = path.join(root, "agent");
  const projectDir = path.join(root, "project");
  await fs.mkdir(path.join(projectDir, ".pi"), { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ statusLine: globalStatusLine }),
  );
  if (projectStatusLine) {
    await fs.writeFile(
      path.join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ statusLine: projectStatusLine }),
    );
  }

  const previousAgentDir = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  return {
    projectDir,
    async cleanup(): Promise<void> {
      if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
      else process.env[AGENT_DIR_ENV] = previousAgentDir;
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function createHarness(options: {
  cwd: string;
  trusted: boolean;
  exec?: (
    command: string,
    args: string[],
    options: { signal?: AbortSignal },
  ) => Promise<{
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
  }>;
}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const theme = {
    fg: (_color: string, text: string): string => text,
    getFgAnsi: (_color: string): string => "",
  };
  const baseEditorFactory = () => ({
    render: (_width: number): string[] => ["header", "prompt", "────"],
  });
  let editorFactory: unknown = baseEditorFactory;
  let footerFactory: unknown;
  const ui = {
    theme,
    getEditorComponent: () => editorFactory,
    setEditorComponent: (factory: unknown): void => {
      editorFactory = factory;
    },
    setFooter: (factory: unknown): void => {
      footerFactory = factory;
    },
  };
  const context = {
    cwd: options.cwd,
    mode: "tui",
    isProjectTrusted: () => options.trusted,
    ui,
    model: {
      id: "test-model",
      name: "Test",
      contextWindow: 272_000,
      reasoning: false,
    },
    thinkingLevel: "off",
    getContextUsage: () => ({ tokens: 18_768, contextWindow: 272_000 }),
    getSystemPrompt: () => "",
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            stopReason: "stop",
            usage: { input: 18_768 },
          },
        },
      ],
      buildContextEntries: () => [],
      getSessionName: () => undefined,
      getSessionId: () => undefined,
    },
  };
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown): void => {
      handlers.set(event, handler);
    },
    exec:
      options.exec ??
      (async () => ({
        stdout: "",
        stderr: "",
        code: 1,
        killed: false,
      })),
    getActiveTools: () => [],
    getAllTools: () => [],
  };

  return {
    baseEditorFactory,
    context,
    handlers,
    pi,
    theme,
    getEditorFactory: () => editorFactory,
    getFooterFactory: () => footerFactory,
    setFooterFactory: (factory: unknown): void => {
      footerFactory = factory;
    },
  };
}

async function loadExtension() {
  // Load after the Pi-host runtime module is mocked.
  return (await import("./index.ts")).default;
}

test("should shrink the path before dropping context usage", async () => {
  const fixture = await createSettingsFixture({
    preset: "custom",
    leftSegments: ["model", "path", "context_pct"],
    rightSegments: [],
    separator: "powerline-thin",
    sessionAccent: false,
    segmentOptions: {
      model: { showThinkingLevel: false },
      path: { abbreviate: false, maxLength: 40, stripWorkPrefix: false },
    },
  });
  const harness = createHarness({ cwd: fixture.projectDir, trusted: true });

  try {
    const ompStatusLine = await loadExtension();
    ompStatusLine(harness.pi as never);
    await harness.handlers.get("session_start")?.({}, harness.context);

    const editorFactory = harness.getEditorFactory();
    if (typeof editorFactory !== "function")
      throw new Error("Expected editor component to be installed");
    const editor = editorFactory({}, harness.theme, {});
    const fullStatus = statusText(editor.render(160)[0] ?? "");
    expect(fullStatus).toContain("6.9%/272K");

    const narrowWidth = Bun.stringWidth(fullStatus) + 4;
    const narrowTop = editor.render(narrowWidth)[0] ?? "";
    const narrowStatus = statusText(narrowTop);
    expect(narrowStatus).toContain("6.9%/272K");
    expect(narrowStatus).toContain("…");
    expect(Bun.stringWidth(Bun.stripANSI(narrowTop))).toBe(narrowWidth);
  } finally {
    await harness.handlers.get("session_shutdown")?.({});
    await fixture.cleanup();
  }
});

test("should ignore project settings when project is untrusted", async () => {
  const fixture = await createSettingsFixture(
    {
      preset: "custom",
      leftSegments: ["model"],
      rightSegments: [],
      sessionAccent: false,
    },
    {
      preset: "custom",
      leftSegments: ["path", "git", "pr"],
      rightSegments: [],
    },
  );
  const harness = createHarness({
    cwd: fixture.projectDir,
    trusted: false,
  });

  try {
    const ompStatusLine = await loadExtension();
    ompStatusLine(harness.pi as never);
    await harness.handlers.get("session_start")?.({}, harness.context);

    const editorFactory = harness.getEditorFactory();
    if (typeof editorFactory !== "function")
      throw new Error("Expected editor component to be installed");
    const status = statusText(
      editorFactory({}, harness.theme, {}).render(120)[0] ?? "",
    );

    expect(status).toContain("Test");
    expect(status).not.toContain(fixture.projectDir);
  } finally {
    await harness.handlers.get("session_shutdown")?.({});
    await fixture.cleanup();
  }
});

test("should release owned resources without replacing newer UI", async () => {
  const fixture = await createSettingsFixture({ preset: "default" });
  let commandSignal: AbortSignal | undefined;
  let unsubscribeCalls = 0;
  const command = Promise.withResolvers<{
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
  }>();
  const harness = createHarness({
    cwd: fixture.projectDir,
    trusted: true,
    exec: async (_command, _args, options) => {
      commandSignal = options.signal;
      options.signal?.addEventListener(
        "abort",
        () =>
          command.resolve({ stdout: "", stderr: "", code: 1, killed: true }),
        { once: true },
      );
      return command.promise;
    },
  });

  try {
    const ompStatusLine = await loadExtension();
    ompStatusLine(harness.pi as never);
    await harness.handlers.get("session_start")?.({}, harness.context);

    const footerFactory = harness.getFooterFactory();
    if (typeof footerFactory !== "function")
      throw new Error("Expected footer component to be installed");
    const footer = footerFactory(
      { requestRender: (): void => {} },
      harness.theme,
      {
        getGitBranch: () => "main",
        getExtensionStatuses: () => new Map(),
        onBranchChange: () => () => {
          unsubscribeCalls++;
        },
      },
    );
    footer.dispose();

    const replacementFooter = (): Record<string, never> => ({});
    harness.setFooterFactory(replacementFooter);
    await harness.handlers.get("session_shutdown")?.({});
    await command.promise;

    expect(commandSignal?.aborted).toBe(true);
    expect(unsubscribeCalls).toBe(1);
    expect(harness.getEditorFactory()).toBe(harness.baseEditorFactory);
    expect(harness.getFooterFactory()).toBe(replacementFooter);
  } finally {
    command.resolve({ stdout: "", stderr: "", code: 1, killed: true });
    await harness.handlers.get("session_shutdown")?.({});
    await fixture.cleanup();
  }
});
