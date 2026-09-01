import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

let agentDir = "";

mock.module("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
  createBashTool: () => ({
    name: "bash",
    label: "bash",
    description: "Test bash tool",
    parameters: {},
    execute: async () => ({ content: [], details: undefined }),
  }),
  getAgentDir: () => agentDir,
}));

const { default: sandbox } = await import("./index.ts");
const originalInitialize = SandboxManager.initialize;
const originalReset = SandboxManager.reset;
const temporaryRoots: string[] = [];
let initializeCalls: SandboxRuntimeConfig[] = [];
let resetCalls = 0;
let initializeBehavior: (config: SandboxRuntimeConfig) => Promise<void>;
let resetBehavior: () => Promise<void>;

interface TestContext {
  cwd: string;
  hasUI: boolean;
  isProjectTrusted(): boolean;
  mode: "tui";
  ui: {
    notify(message: string, level: string): void;
    setStatus(key: string, value: string | undefined): void;
    setWidget(key: string, value: unknown): void;
    theme: {
      fg(color: string, text: string): string;
    };
  };
}

interface ContextFixture {
  context: TestContext;
  notifications: Array<{ level: string; message: string }>;
  statuses: Array<{ key: string; value: string | undefined }>;
}

type HostHandler = (event: unknown, context: TestContext) => unknown;

function createContext(cwd: string): ContextFixture {
  const notifications: Array<{ level: string; message: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  return {
    notifications,
    statuses,
    context: {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      mode: "tui",
      ui: {
        notify: (message, level) => notifications.push({ level, message }),
        setStatus: (key, value) => statuses.push({ key, value }),
        setWidget: () => {},
        theme: {
          fg: (_color, text) => text,
        },
      },
    },
  };
}

function createHarness() {
  const handlers = new Map<string, HostHandler>();
  const pi = {
    getFlag: () => false,
    on: (event: string, handler: HostHandler) => handlers.set(event, handler),
    registerCommand: () => {},
    registerFlag: () => {},
    registerTool: () => {},
  };
  sandbox(pi as never);

  const invoke = async (event: string, context: TestContext): Promise<void> => {
    const handler = handlers.get(event);
    if (!handler) throw new Error(`Expected ${event} handler`);
    await handler({}, context);
  };

  return {
    shutdown: (context: TestContext) => invoke("session_shutdown", context),
    start: (context: TestContext) => invoke("session_start", context),
  };
}

async function createConfigFiles(
  globalConfig?: unknown,
  projectConfig?: unknown,
): Promise<{ cwd: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-extension-"));
  temporaryRoots.push(root);
  agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
  if (globalConfig !== undefined) {
    await fs.writeFile(
      path.join(agentDir, "sandbox.json"),
      JSON.stringify(globalConfig),
    );
  }
  if (projectConfig !== undefined) {
    await fs.writeFile(
      path.join(cwd, ".pi", "sandbox.json"),
      JSON.stringify(projectConfig),
    );
  }
  return { cwd };
}

function requireInitializeCall(): SandboxRuntimeConfig {
  const config = initializeCalls[0];
  if (!config) throw new Error("Expected SandboxManager.initialize call");
  return config;
}

beforeEach(() => {
  initializeCalls = [];
  resetCalls = 0;
  initializeBehavior = async () => {};
  resetBehavior = async () => {};
  SandboxManager.initialize = async (config) => {
    initializeCalls.push(config);
    await initializeBehavior(config);
  };
  SandboxManager.reset = async () => {
    resetCalls++;
    await resetBehavior();
  };
});

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

afterAll(() => {
  SandboxManager.initialize = originalInitialize;
  SandboxManager.reset = originalReset;
});

describe("sandbox", () => {
  test("should recursively apply project values over global values when project is trusted", async () => {
    const { cwd } = await createConfigFiles(
      {
        filesystem: { allowWrite: ["global-write"] },
        network: {
          allowedDomains: ["global.example"],
          deniedDomains: ["blocked.example"],
          mitmProxy: {
            socketPath: "/tmp/global.sock",
            domains: ["global.proxy"],
          },
        },
      },
      {
        filesystem: { denyWrite: ["project.key"] },
        network: {
          allowedDomains: ["project.example"],
          mitmProxy: { domains: ["project.proxy"] },
        },
      },
    );
    const { context } = createContext(cwd);
    const harness = createHarness();

    await harness.start(context);
    const config = requireInitializeCall();

    expect(config.network.allowedDomains).toEqual(["project.example"]);
    expect(config.network.deniedDomains).toEqual(["blocked.example"]);
    expect(config.filesystem.allowWrite).toEqual(["global-write"]);
    expect(config.filesystem.denyWrite).toEqual(["project.key"]);
    expect(config.network.mitmProxy).toEqual({
      socketPath: "/tmp/global.sock",
      domains: ["project.proxy"],
    });
    await harness.shutdown(context);
  });

  test("should reject session start when config JSON is malformed", async () => {
    const { cwd } = await createConfigFiles();
    await fs.writeFile(path.join(agentDir, "sandbox.json"), "{");
    const { context } = createContext(cwd);
    const harness = createHarness();

    await expect(harness.start(context)).rejects.toThrow();
    expect(initializeCalls).toHaveLength(0);
  });

  test("should report reset failures during shutdown", async () => {
    const { cwd } = await createConfigFiles();
    const { context, notifications } = createContext(cwd);
    const harness = createHarness();
    await harness.start(context);
    resetBehavior = async () => {
      throw new Error("reset exploded");
    };

    await harness.shutdown(context);

    expect(resetCalls).toBe(1);
    expect(
      notifications.some(
        ({ level, message }) =>
          level === "error" &&
          message === "Sandbox cleanup failed: reset exploded",
      ),
    ).toBe(true);
  });

  test("should reset owned runtime once when shutdown repeats", async () => {
    const { cwd } = await createConfigFiles();
    const { context } = createContext(cwd);
    const harness = createHarness();

    await harness.start(context);
    await harness.shutdown(context);
    await harness.shutdown(context);

    expect(resetCalls).toBe(1);
  });
});
