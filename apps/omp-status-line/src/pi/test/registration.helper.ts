import { spyOn } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: Spies intercept registration's live named filesystem imports.
import * as fs from "node:fs";
import { join } from "node:path";
import process from "node:process";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
/**
 * Plans settings reads without touching project or user files.
 * @param globalStatusLine - User configuration under the statusLine key.
 * @param projectStatusLine - Optional project override, read only for trusted sessions.
 * @returns A fixed project path and cleanup restoring the settings spy and agent-directory environment.
 * @example const settings = createSettingsFixture({ preset: "minimal" }); settings.cleanup();
 */
export function createSettingsFixture(
  globalStatusLine: Record<string, unknown>,
  projectStatusLine?: Record<string, unknown>,
): { projectDir: string; cleanup: () => void } {
  const agentDir = "/virtual/status-line-agent";
  const projectDir = "/virtual/status-line-project";
  const settingsIo: {
    readFileSync: (file: fs.PathOrFileDescriptor, encoding: "utf8") => string;
  } = fs;
  const readSettings = spyOn(settingsIo, "readFileSync").mockImplementation(
    (file) => {
      const path = String(file);
      if (path === join(agentDir, "settings.json")) {
        return JSON.stringify({ statusLine: globalStatusLine });
      }
      if (path === join(projectDir, ".pi", "settings.json")) {
        return JSON.stringify({ statusLine: projectStatusLine });
      }
      return "{}";
    },
  );
  const previousAgentDir = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  return {
    projectDir,
    cleanup(): void {
      readSettings.mockRestore();
      if (previousAgentDir === undefined) {
        delete process.env[AGENT_DIR_ENV];
      } else {
        process.env[AGENT_DIR_ENV] = previousAgentDir;
      }
    },
  };
}

/**
 * Supplies the public Pi UI and lifecycle boundaries used by registration tests.
 * @param options - Workspace trust and optional controlled command effects.
 * @returns Mutable UI slots, registered events, and an inert existing editor factory.
 * @example createHarness({ cwd: "/project", trusted: true }) owns no timers or files.
 */
export function createHarness(options: {
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
