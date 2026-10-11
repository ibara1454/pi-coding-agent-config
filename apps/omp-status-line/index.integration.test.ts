import { describe, expect, mock, spyOn, test } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: Spies must intercept the extension's live named filesystem imports.
import * as fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

mock.module("@earendil-works/pi-coding-agent", () => ({
  // biome-ignore lint/style/useNamingConvention: host module export identity
  CustomEditor: class {},
  estimateTokens: () => 0,
}));

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const STATUS_LINE_LEADING_BORDER = "╭──";
const WIDE_STATUS_RENDER_WIDTH = 160;
const NARROW_STATUS_WIDTH_PADDING = 4;
const PATH_STATUS_RENDER_WIDTH = 120;
const STATUS_LINE_TRAILING_BORDER = "──╮";
const STATUS_LINE_CHROME_WIDTH = Bun.stringWidth(
  STATUS_LINE_LEADING_BORDER + STATUS_LINE_TRAILING_BORDER,
);
const STATUS_GROUP_GAP_WIDTH = 1;
const FIXED_STATUS_CLOCK_MS = 10_000;
const STREAM_UPDATE_ELAPSED_MS = 2000;
const POST_RUN_IDLE_ELAPSED_MS = 20_000;
const IDLE_REFRESH_INTERVAL_MS = 2_000_000_000;
const SHELL_REFRESH_DELAY_MS = 150;
const INITIAL_GIT_FETCH_COUNT = 1;
const COALESCED_GIT_FETCH_COUNT = 2;
const SHORT_PATH_RENDER_WIDTH = 17;
const MIN_EDITOR_CHROME_RENDER_WIDTH = 10;
const HOOK_STATUS_RENDER_WIDTH = 9;
const EMPTY_EDITOR_BORDER = /^╭─+╮$/;

function statusText(line: string): string {
  const plain = Bun.stripANSI(line);
  const capIndex = plain.indexOf("▶", STATUS_LINE_LEADING_BORDER.length);
  if (capIndex < 0) {
    throw new Error(`Expected status-line end cap in ${plain}`);
  }
  return plain.slice(STATUS_LINE_LEADING_BORDER.length, capIndex + 1);
}

async function createSettingsFixture(
  globalStatusLine: Record<string, unknown>,
  projectStatusLine?: Record<string, unknown>,
): Promise<{
  projectDir: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "omp-status-line-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  await mkdir(join(projectDir, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ statusLine: globalStatusLine }),
  );
  if (projectStatusLine) {
    await writeFile(
      join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ statusLine: projectStatusLine }),
    );
  }

  const previousAgentDir = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  return {
    projectDir,
    async cleanup(): Promise<void> {
      if (previousAgentDir === undefined) {
        delete process.env[AGENT_DIR_ENV];
      } else {
        process.env[AGENT_DIR_ENV] = previousAgentDir;
      }
      await rm(root, { recursive: true, force: true });
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
    modelRegistry: {
      // biome-ignore lint/style/useNamingConvention: host API method name
      isUsingOAuth: () => false,
    },
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
    if (typeof editorFactory !== "function") {
      throw new Error("Expected editor component to be installed");
    }
    const editor = editorFactory({}, harness.theme, {});
    const fullStatus = statusText(
      editor.render(WIDE_STATUS_RENDER_WIDTH)[0] ?? "",
    );
    expect(fullStatus).toContain("6.9%/272K");

    const narrowWidth =
      Bun.stringWidth(fullStatus) + NARROW_STATUS_WIDTH_PADDING;
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
    if (typeof editorFactory !== "function") {
      throw new Error("Expected editor component to be installed");
    }
    const status = statusText(
      editorFactory({}, harness.theme, {}).render(
        PATH_STATUS_RENDER_WIDTH,
      )[0] ?? "",
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
      return await command.promise;
    },
  });

  try {
    const ompStatusLine = await loadExtension();
    ompStatusLine(harness.pi as never);
    await harness.handlers.get("session_start")?.({}, harness.context);

    const footerFactory = harness.getFooterFactory();
    if (typeof footerFactory !== "function") {
      throw new Error("Expected footer component to be installed");
    }
    const footer = footerFactory(
      {
        requestRender: (): void => {
          /* Rendering is not observed in this ownership test. */
        },
      },
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

/**
 * Installs the exported extension against in-memory settings, commands, and host UI.
 * @param settings Segment layout to render; no existing config or repository is read.
 * @param options Deterministic host path, command responses, and hook statuses.
 * @returns Rendered public components, deterministic clock/refresh controls, and cleanup owning session shutdown and environment restoration.
 * @example const fixture = await createRenderedFixture({ leftSegments: ["path"] }); // fixture.top(40)
 */
async function createRenderedFixture(
  settings: Record<string, unknown>,
  options: {
    cwd?: string;
    exec?: Parameters<typeof createHarness>[0]["exec"];
    statuses?: Map<string, string>;
  } = {},
) {
  const agentDir = "/virtual/status-line-agent";
  const previousAgentDir = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  const settingsIo: {
    readFileSync: (file: fs.PathOrFileDescriptor, encoding: "utf8") => string;
  } = fs;
  const readSettings = spyOn(settingsIo, "readFileSync").mockImplementation(
    (file) =>
      String(file) === join(agentDir, "settings.json")
        ? JSON.stringify({
            statusLine: {
              preset: "custom",
              leftSegments: [],
              rightSegments: [],
              separator: "powerline-thin",
              sessionAccent: false,
              segmentOptions: {
                model: { showThinkingLevel: false },
                path: {
                  abbreviate: false,
                  maxLength: 80,
                  stripWorkPrefix: false,
                },
              },
              ...settings,
            },
          })
        : "{}",
  );
  const clock = spyOn(Date, "now").mockReturnValue(FIXED_STATUS_CLOCK_MS);
  // Own an inert host-compatible handle; no test waits for or observes wall-clock ticks.
  const idleRefresh = setInterval(() => undefined, IDLE_REFRESH_INTERVAL_MS);
  const interval = spyOn(globalThis, "setInterval").mockReturnValue(
    idleRefresh,
  );
  const harness = createHarness({
    cwd: options.cwd ?? "/project/界界/é.ts",
    trusted: true,
    ...(options.exec ? { exec: options.exec } : {}),
  });
  let branch = "main";
  let notifyBranchChange = (): void => undefined;
  const unsubscribe = mock(() => undefined);
  const requestRender = mock(() => undefined);

  /** Releases session resources and restores every mocked boundary, including on setup failure. */
  const cleanup = async (): Promise<void> => {
    try {
      await harness.handlers.get("session_shutdown")?.({});
    } finally {
      readSettings.mockRestore();
      clock.mockRestore();
      interval.mockRestore();
      clearInterval(idleRefresh);
      if (previousAgentDir === undefined) {
        delete process.env[AGENT_DIR_ENV];
      } else {
        process.env[AGENT_DIR_ENV] = previousAgentDir;
      }
    }
  };

  try {
    const ompStatusLine = await loadExtension();
    ompStatusLine(harness.pi as never);
    await harness.handlers.get("session_start")?.({}, harness.context);
    const editorFactory = harness.getEditorFactory();
    const footerFactory = harness.getFooterFactory();
    if (
      typeof editorFactory !== "function" ||
      typeof footerFactory !== "function"
    ) {
      throw new Error("Expected status-line components to be installed");
    }
    const editor = editorFactory({}, harness.theme, {}) as {
      render: (width: number) => string[];
    };
    const footer = footerFactory({ requestRender }, harness.theme, {
      getGitBranch: () => branch,
      getExtensionStatuses: () => options.statuses ?? new Map(),
      onBranchChange: (callback: () => void) => {
        notifyBranchChange = callback;
        return unsubscribe;
      },
    }) as {
      render: (width: number) => string[];
      dispose: () => void;
      invalidate: () => void;
    };
    return {
      harness,
      footer,
      unsubscribe,
      cleanup,
      clock,
      interval,
      requestRender,
      top: (width = WIDE_STATUS_RENDER_WIDTH): string =>
        Bun.stripANSI(editor.render(width)[0] ?? ""),
      async changeBranch(nextBranch: string): Promise<void> {
        branch = nextBranch;
        notifyBranchChange();
        // The command boundary resolves immediately; flush its refresh continuation.
        await Promise.resolve();
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

describe("ompStatusLine", () => {
  test.each([
    "session_info_changed",
    "model_select",
    "thinking_level_select",
    "session_tree",
    "session_compact",
  ])(
    "should render the replacement context and invalidate the UI when %s fires",
    async (event) => {
      const fixture = await createRenderedFixture({
        leftSegments: ["model"],
      });
      try {
        expect(fixture.top()).toContain("Test");
        const nextContext = {
          ...fixture.harness.context,
          model: {
            ...fixture.harness.context.model,
            name: "Replacement",
          },
        };
        fixture.requestRender.mockClear();

        await fixture.harness.handlers.get(event)?.({}, nextContext);

        expect(fixture.requestRender).toHaveBeenCalledTimes(1);
        expect(fixture.top()).toContain("Replacement");
        expect(fixture.top()).not.toContain("Test");
      } finally {
        await fixture.cleanup();
      }
    },
  );

  test.each(["message_update", "message_end"])(
    "should render run metrics and invalidate the UI when %s supplies assistant output",
    async (event) => {
      const fixture = await createRenderedFixture({
        leftSegments: ["token_rate", "time_spent"],
      });
      const { handlers, context } = fixture.harness;
      try {
        await handlers.get("agent_start")?.({}, context);
        fixture.clock.mockReturnValue(
          FIXED_STATUS_CLOCK_MS + STREAM_UPDATE_ELAPSED_MS,
        );
        fixture.requestRender.mockClear();

        await handlers.get(event)?.(
          { message: { role: "assistant", usage: { output: 20 } } },
          context,
        );

        expect(fixture.requestRender).toHaveBeenCalled();
        expect(fixture.top()).toContain("10.0 tok/s");
        expect(fixture.top()).toContain("⏱ 2s");

        fixture.requestRender.mockClear();
        await handlers.get("agent_end")?.({}, context);
        expect(fixture.requestRender).toHaveBeenCalled();
        fixture.clock.mockReturnValue(
          FIXED_STATUS_CLOCK_MS + POST_RUN_IDLE_ELAPSED_MS,
        );
        expect(fixture.top()).toContain("⏱ 2s");

        await handlers.get("session_start")?.({}, { ...context, mode: "rpc" });
        expect(fixture.top()).not.toContain("tok/s");
        expect(fixture.top()).not.toContain("⏱");
      } finally {
        await fixture.cleanup();
      }
    },
  );

  test("should keep hook statuses hidden but request renders on invalidation and refresh ticks when hook display is disabled", async () => {
    const fixture = await createRenderedFixture(
      { leftSegments: ["model"], showHookStatus: false },
      { statuses: new Map([["ready", "Ready"]]) },
    );
    try {
      expect(fixture.footer.render(WIDE_STATUS_RENDER_WIDTH)).toEqual([]);
      fixture.requestRender.mockClear();
      fixture.footer.invalidate();
      expect(fixture.requestRender).toHaveBeenCalledTimes(1);
      const tick = fixture.interval.mock.calls[0]?.[0];
      if (typeof tick !== "function") {
        throw new Error("Expected the session refresh callback");
      }
      tick();
      expect(fixture.requestRender).toHaveBeenCalledTimes(2);
      expect(fixture.top()).toContain("Test");
      expect(fixture.top(MIN_EDITOR_CHROME_RENDER_WIDTH - 1)).toBe("header");

      await fixture.cleanup();
      expect(fixture.top()).toBe("header");
      expect(fixture.harness.getEditorFactory()).toBe(
        fixture.harness.baseEditorFactory,
      );
      expect(fixture.harness.getFooterFactory()).toBeUndefined();
      expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.cleanup();
    }
  });

  test("should drop right segments from the end before shortening the left path when both groups overflow", async () => {
    const fixture = await createRenderedFixture({
      leftSegments: ["model", "path"],
      rightSegments: ["context_pct", "git"],
    });
    try {
      const full = fixture.top();
      expect(full).toContain("main");
      expect(full).toContain("6.9%/272K");
      expect(full).toContain(fixture.harness.context.cwd);
      expect(Bun.stringWidth(full)).toBe(WIDE_STATUS_RENDER_WIDTH);
      const left = statusText(full);
      const right = full.slice(
        full.lastIndexOf("◀"),
        -STATUS_LINE_TRAILING_BORDER.length,
      );
      const firstRightWidth = Bun.stringWidth(`${right.split(" < ")[0]} `);
      const mediumWidth =
        Bun.stringWidth(left) +
        firstRightWidth +
        STATUS_GROUP_GAP_WIDTH +
        STATUS_LINE_CHROME_WIDTH;
      const medium = fixture.top(mediumWidth);
      expect(medium).not.toContain("main");
      expect(medium).toContain("6.9%/272K");
      expect(medium).toContain(fixture.harness.context.cwd);
      expect(Bun.stringWidth(medium)).toBe(mediumWidth);

      const narrowWidth = Bun.stringWidth(left) + STATUS_LINE_CHROME_WIDTH;
      const narrow = fixture.top(narrowWidth);
      expect(narrow).not.toContain("6.9%/272K");
      expect(narrow).not.toContain("◀");
      expect(narrow).toContain(fixture.harness.context.cwd);
      expect(Bun.stringWidth(narrow)).toBe(narrowWidth);
      expect(fixture.top()).toBe(full);
    } finally {
      await fixture.cleanup();
    }
  });

  test("should shorten a wide-character path without dropping context or mutating its full rendering when cells overflow", async () => {
    const fixture = await createRenderedFixture(
      { leftSegments: ["model", "path", "context_pct"] },
      { cwd: "/project/界界界界界界/é.ts" },
    );
    try {
      const full = fixture.top();
      const width =
        Bun.stringWidth(statusText(full)) + NARROW_STATUS_WIDTH_PADDING;
      const narrow = fixture.top(width);
      expect(narrow).toContain("Test");
      expect(narrow).toContain("6.9%/272K");
      expect(narrow).toContain("…");
      expect(narrow).toContain("é.ts");
      expect(narrow).not.toContain(fixture.harness.context.cwd);
      expect(Bun.stringWidth(narrow)).toBe(width);
      expect(fixture.top()).toBe(full);
    } finally {
      await fixture.cleanup();
    }
  });

  test("should retain a short trailing path and drop the model when the path cannot shrink", async () => {
    const fixture = await createRenderedFixture(
      { leftSegments: ["model", "path"] },
      { cwd: "/tiny" },
    );
    try {
      expect(fixture.top()).toContain("Test");
      const narrow = fixture.top(SHORT_PATH_RENDER_WIDTH);
      expect(narrow).toContain("📁 /tiny");
      expect(narrow).not.toContain("Test");
      expect(narrow).not.toContain("…");
      expect(Bun.stringWidth(narrow)).toBe(SHORT_PATH_RENDER_WIDTH);
    } finally {
      await fixture.cleanup();
    }
  });

  test.each(["/tiny", "/project/界界界界/é.ts"])(
    "should omit the final path segment when %s cannot fit the editor cell budget",
    async (cwd) => {
      const fixture = await createRenderedFixture(
        { leftSegments: ["path"] },
        { cwd },
      );
      try {
        expect(fixture.top()).toContain("📁");
        const narrow = fixture.top(MIN_EDITOR_CHROME_RENDER_WIDTH);
        expect(narrow).toMatch(EMPTY_EDITOR_BORDER);
        expect(Bun.stringWidth(narrow)).toBe(MIN_EDITOR_CHROME_RENDER_WIDTH);
        expect(fixture.top()).toContain(cwd);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  test.each([
    ["empty or one-character lines", "\nX\n", []],
    [
      "index-only changes",
      "M  modified\nA  added\nD  deleted\nR  old -> new\nC  copied\n",
      ["+5"],
    ],
    ["working-tree-only changes", " M modified\n D deleted\n", ["*2"]],
    ["untracked files", "?? first\n?? second\n", ["?2"]],
    [
      "changes in both columns and conflicts",
      "MM modified\nUU conflict\nAA added\nDD deleted\n",
      ["*4", "+4"],
    ],
    [
      "spaces and question marks outside untracked pairs",
      " ? one\n?  two\n   clean\n",
      [],
    ],
    [
      "mixed status entries",
      "M  staged\n M unstaged\nMM both\nUU conflict\n?? first\n?? second\nX\n\n",
      ["*3", "+3", "?2"],
    ],
  ])(
    "should render independent git counters when porcelain contains %s",
    async (_condition, stdout, counters) => {
      const fixture = await createRenderedFixture(
        { leftSegments: ["git"] },
        {
          exec: async (command) => ({
            stdout: command === "git" ? String(stdout) : "",
            stderr: "",
            code: command === "git" ? 0 : 1,
            killed: false,
          }),
        },
      );
      try {
        const rendered = statusText(fixture.top());
        expect(rendered).toContain("main");
        const renderedCounters: string[] = rendered.match(/[+*?]\d+/g) ?? [];
        expect(renderedCounters).toEqual(counters);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  test.each([
    ["write", undefined],
    ["edit", undefined],
    ["bash", { command: "git switch feature" }],
  ])(
    "should replace previous git counts when a %s tool result forces a refresh within the cache lifetime",
    async (toolName, input) => {
      let stdout = "M  staged\n?? new\n";
      const fixture = await createRenderedFixture(
        { leftSegments: ["git"] },
        {
          exec: async (command) => ({
            stdout: command === "git" ? stdout : "",
            stderr: "",
            code: command === "git" ? 0 : 1,
            killed: false,
          }),
        },
      );
      try {
        expect(statusText(fixture.top()).match(/[+*?]\d+/g)).toEqual([
          "+1",
          "?1",
        ]);
        stdout = " M changed\n D removed\n";
        await fixture.harness.handlers.get("tool_result")?.(
          { toolName, input },
          fixture.harness.context,
        );
        expect(statusText(fixture.top()).match(/[+*?]\d+/g)).toEqual(["*2"]);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  test("should clear old counts and show the new branch when the footer reports a branch change", async () => {
    let stdout = "UU conflict\n?? new\n";
    const fixture = await createRenderedFixture(
      { leftSegments: ["git"] },
      {
        exec: async (command) => ({
          stdout: command === "git" ? stdout : "",
          stderr: "",
          code: command === "git" ? 0 : 1,
          killed: false,
        }),
      },
    );
    try {
      expect(statusText(fixture.top()).match(/[+*?]\d+/g)).toEqual([
        "*1",
        "+1",
        "?1",
      ]);
      stdout = "";
      await fixture.changeBranch("feature");
      const rendered = statusText(fixture.top());
      expect(rendered).toContain("feature");
      expect(rendered).not.toContain("main");
      expect(rendered.match(/[+*?]\d+/g) ?? []).toEqual([]);
      fixture.footer.dispose();
      expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
      await fixture.cleanup();
      expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.cleanup();
    }
  });

  test("should sanitize and truncate hook statuses by cells while omitting duplicates of configured segments", async () => {
    const fixture = await createRenderedFixture(
      { leftSegments: ["mode", "git"] },
      {
        statuses: new Map([
          ["mode", "duplicate mode status"],
          ["git", "duplicate git status"],
          ["z-wide", "界界界界界"],
          ["a-ready", "\x1b[31mReady\x1b[0m\nnext"],
        ]),
      },
    );
    try {
      const full = fixture.footer.render(WIDE_STATUS_RENDER_WIDTH);
      expect(full).toEqual([
        "Ready next",
        "duplicate git status",
        "界界界界界",
      ]);
      const lines = fixture.footer.render(HOOK_STATUS_RENDER_WIDTH);
      expect(lines).toHaveLength(full.length);
      for (const [index, line] of lines.entries()) {
        const source = full[index];
        if (source === undefined) {
          throw new Error(
            "Expected the hook status to retain its sorted position",
          );
        }
        expect(line.startsWith(source.slice(0, 1))).toBe(true);
        expect(line).not.toBe(source);
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(
          HOOK_STATUS_RENDER_WIDTH,
        );
        expect(line).not.toContain("\x1b[31m");
        expect(line).not.toContain("\n");
        expect(line).not.toContain("\r");
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("should coalesce git-changing shell events and release the pending refresh when the session shuts down", async () => {
    const result = { stdout: "", stderr: "", code: 0, killed: false };
    const pendingPr = Promise.withResolvers<typeof result>();
    const timerSpies: { mockRestore: () => void }[] = [];
    let gitFetches = 0;
    let prSignal: AbortSignal | undefined;
    const fixture = await createRenderedFixture(
      { leftSegments: ["git"] },
      {
        exec: (command, _args, options) => {
          if (command === "gh") {
            prSignal = options.signal;
            return pendingPr.promise;
          }
          gitFetches++;
          return Promise.resolve(result);
        },
      },
    );
    try {
      const firstTimer: NodeJS.Timeout = Object.create(null);
      const latestTimer: NodeJS.Timeout = Object.create(null);
      const shutdownTimer: NodeJS.Timeout = Object.create(null);
      const schedule = spyOn(globalThis, "setTimeout")
        .mockReturnValueOnce(firstTimer)
        .mockReturnValueOnce(latestTimer)
        .mockReturnValue(shutdownTimer);
      timerSpies.push(schedule);
      const cancel = spyOn(globalThis, "clearTimeout").mockReturnValue(
        undefined,
      );
      timerSpies.push(cancel);
      expect(gitFetches).toBe(INITIAL_GIT_FETCH_COUNT);
      expect(prSignal?.aborted).toBe(false);

      await fixture.harness.handlers.get("user_bash")?.(
        { command: "git switch feature" },
        fixture.harness.context,
      );
      await fixture.harness.handlers.get("user_bash")?.(
        { command: "git pull" },
        fixture.harness.context,
      );

      expect(schedule.mock.calls.map(([, delay]) => delay)).toEqual([
        SHELL_REFRESH_DELAY_MS,
        SHELL_REFRESH_DELAY_MS,
      ]);
      expect(cancel).toHaveBeenCalledWith(firstTimer);
      expect(gitFetches).toBe(INITIAL_GIT_FETCH_COUNT);
      const refresh = schedule.mock.calls.at(-1)?.[0];
      if (typeof refresh !== "function") {
        throw new Error("Expected coalesced shell refresh callback");
      }
      refresh();
      await Promise.resolve();
      expect(gitFetches).toBe(COALESCED_GIT_FETCH_COUNT);
      expect(prSignal?.aborted).toBe(true);

      await fixture.harness.handlers.get("user_bash")?.(
        { command: "git merge main" },
        fixture.harness.context,
      );
      await fixture.harness.handlers.get("session_shutdown")?.({});

      expect(cancel).toHaveBeenCalledWith(shutdownTimer);
      expect(fixture.unsubscribe).toHaveBeenCalledTimes(1);
      expect(gitFetches).toBe(COALESCED_GIT_FETCH_COUNT);
    } finally {
      pendingPr.resolve(result);
      try {
        await fixture.cleanup();
      } finally {
        for (const timerSpy of timerSpies) {
          timerSpy.mockRestore();
        }
      }
    }
  });

  test("should reject a stale PR response and abort the lookup owned by a replaced branch", async () => {
    let oldSignal: AbortSignal | undefined;
    let completeOldLookup: (() => void) | undefined;
    let lookupCount = 0;
    const fixture = await createRenderedFixture(
      { leftSegments: ["git", "pr"] },
      {
        exec: (command, _args, options) => {
          const result = {
            stdout: '{"number":73,"url":"https://example.com/pr/73"}',
            stderr: "",
            code: 0,
            killed: false,
          };
          if (command !== "gh") {
            return Promise.resolve({ ...result, stdout: "" });
          }
          lookupCount++;
          if (lookupCount === 1) {
            oldSignal = options.signal;
            return new Promise<typeof result>((resolve) => {
              completeOldLookup = () => {
                resolve({
                  ...result,
                  stdout: '{"number":42,"url":"https://example.com/pr/42"}',
                });
              };
            });
          }
          return Promise.resolve(result);
        },
      },
    );
    try {
      expect(fixture.top()).not.toContain("#");
      expect(oldSignal?.aborted).toBe(false);

      await fixture.changeBranch("feature");
      await Promise.resolve();
      expect(oldSignal?.aborted).toBe(true);
      expect(fixture.top()).toContain("#73");

      if (!completeOldLookup) {
        throw new Error("Expected the first branch lookup to remain pending");
      }
      completeOldLookup();
      await Promise.resolve();
      await Promise.resolve();

      const top = fixture.top();
      expect(top).toContain("feature");
      expect(top).toContain("#73");
      expect(top).not.toContain("#42");
      expect(Bun.stringWidth(top)).toBe(WIDE_STATUS_RENDER_WIDTH);
    } finally {
      completeOldLookup?.();
      await fixture.cleanup();
    }
  });
});
