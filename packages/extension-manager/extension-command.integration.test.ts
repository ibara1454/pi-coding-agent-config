import { describe, expect, mock, test } from "bun:test";
import type {
  ExtensionCommandContext,
  ExtensionHandler,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { ExtensionCatalog } from "./catalog.ts";
import { PackageResolutionFailure } from "./discovery.ts";
import {
  type ExtensionManagerApi,
  registerExtensionManager,
} from "./extension-command.ts";
import type { ExtensionManagerRuntime } from "./extension-runtime.ts";
import type {
  CatalogSeed,
  CommitRequest,
  ResourceScope,
  SettingsDocument,
} from "./types.ts";

type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void> | void;

type DiscoverInput = Parameters<ExtensionManagerRuntime["discover"]>[0];

interface CommandRegistration {
  readonly name: string;
  readonly description: string;
  readonly handler: CommandHandler;
}

interface PiHarness {
  readonly commands: readonly CommandRegistration[];
  readonly events: readonly string[];
  readonly run: (ctx: ExtensionCommandContext) => Promise<void>;
  readonly shutdown: () => void;
}

interface CommandHost {
  readonly ctx: ExtensionCommandContext;
  readonly notifications: readonly {
    readonly message: string;
    readonly level: string;
  }[];
  readonly prompts: readonly {
    readonly message: string;
    readonly options: readonly string[];
  }[];
}

function seed(overrides: Partial<CatalogSeed> = {}): CatalogSeed {
  return {
    rows: [],
    targets: new Map(),
    settings: new Map(),
    diagnostics: [],
    projectTrusted: true,
    tuiMode: "regular",
    reloadPending: false,
    ...overrides,
  };
}

function runtimeAdapter(
  overrides: Partial<ExtensionManagerRuntime> = {},
): ExtensionManagerRuntime {
  return {
    agentDir: () => "/agent",
    commit: async () => ({ scopes: [], committedScopes: [] }),
    discover: async (input) => seed({ reloadPending: input.reloadPending }),
    openPanel: async () => ({ type: "closed" }),
    selfPath: "/packages/extension-manager/index.ts",
    dispose: () => undefined,
    ...overrides,
  };
}

function piHarness(runtime: ExtensionManagerRuntime): PiHarness {
  const commands: CommandRegistration[] = [];
  const events: string[] = [];
  let shutdownHandler: ExtensionHandler<SessionShutdownEvent>;
  const pi: ExtensionManagerApi = {
    on(event, handler) {
      events.push(event);
      if (event === "session_shutdown") {
        shutdownHandler = handler as ExtensionHandler<SessionShutdownEvent>;
      }
    },
    registerCommand(name, options) {
      commands.push({
        name,
        description: options.description,
        handler: options.handler,
      });
    },
  };
  registerExtensionManager(pi, runtime);
  return {
    commands,
    events,
    async run(ctx) {
      const command = commands[0];
      if (command === undefined) {
        throw new Error("Command was not registered");
      }
      await command.handler("", ctx);
    },
    shutdown() {
      const dummyEvent = {} as SessionShutdownEvent;
      const dummyCtx = {} as ExtensionCommandContext;
      shutdownHandler?.(dummyEvent, dummyCtx);
    },
  };
}

function commandHost(options: {
  readonly mode?: "tui" | "rpc" | "json" | "print";
  readonly trace?: string[];
  readonly selections?: readonly string[];
  readonly trusted?: boolean;
}): CommandHost {
  const notifications: { message: string; level: string }[] = [];
  const prompts: { message: string; options: readonly string[] }[] = [];
  const selections = [...(options.selections ?? [])];
  return {
    notifications,
    prompts,
    ctx: {
      mode: options.mode ?? "tui",
      cwd: "/repo",
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        async select(message: string, choices: readonly string[]) {
          prompts.push({ message, options: choices });
          return selections.shift();
        },
      },
      async waitForIdle() {
        options.trace?.push("wait");
      },
      isProjectTrusted() {
        return options.trusted ?? true;
      },
    } as ExtensionCommandContext,
  };
}

describe("registerExtensionManager", () => {
  test("should register the extensions command and session shutdown handler", () => {
    const pi = piHarness(runtimeAdapter());

    expect(pi.commands).toHaveLength(1);
    expect(pi.commands[0]?.name).toBe("extensions");
    expect(pi.commands[0]?.description).toBe(
      "Manage persistent Extensions and Skills",
    );
    expect(pi.events).toContain("session_shutdown");
  });

  test.each(["rpc", "json", "print"] as const)(
    "should warn without waiting for idle or discovering in %s mode",
    async (mode) => {
      const trace: string[] = [];
      const discover = mock(async () => seed());
      const pi = piHarness(runtimeAdapter({ discover }));
      const host = commandHost({ mode, trace });

      await pi.run(host.ctx);

      expect(discover).not.toHaveBeenCalled();
      expect(trace).toEqual([]);
      expect(host.notifications).toEqual([
        {
          message: "/extensions is available only in TUI mode",
          level: "warning",
        },
      ]);
    },
  );

  test("should wait for idle before discovery and forward agent dir, cwd, and trust", async () => {
    const trace: string[] = [];
    const inputs: DiscoverInput[] = [];
    const pi = piHarness(
      runtimeAdapter({
        discover: async (input) => {
          trace.push("discover");
          inputs.push(input);
          return seed();
        },
        openPanel: async () => {
          trace.push("open");
          return { type: "closed" };
        },
      }),
    );
    const host = commandHost({ trace, trusted: false });

    await pi.run(host.ctx);

    expect(trace).toEqual(["wait", "discover", "open"]);
    expect(inputs).toEqual([
      {
        agentDir: "/agent",
        cwd: "/repo",
        projectTrusted: false,
        reloadPending: false,
      },
    ]);
  });

  test("should retry discovery only while the package resolution prompt is accepted", async () => {
    let attempts = 0;
    const openPanel = mock(async () => ({ type: "closed" }) as const);
    const pi = piHarness(
      runtimeAdapter({
        discover: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new PackageResolutionFailure("resolver failed");
          }
          return seed();
        },
        openPanel,
      }),
    );
    const host = commandHost({ selections: ["Retry"] });

    await pi.run(host.ctx);

    expect(attempts).toBe(2);
    expect(host.prompts).toEqual([
      { message: "resolver failed", options: ["Retry", "Close"] },
    ]);
    expect(openPanel).toHaveBeenCalledTimes(1);
    expect(host.notifications).toEqual([]);
  });

  test("should not open the panel when the package resolution prompt is closed", async () => {
    const openPanel = mock(async () => ({ type: "closed" }) as const);
    const pi = piHarness(
      runtimeAdapter({
        discover: async () => {
          throw new PackageResolutionFailure("resolver failed");
        },
        openPanel,
      }),
    );
    const host = commandHost({ selections: ["Close"] });

    await pi.run(host.ctx);

    expect(openPanel).not.toHaveBeenCalled();
    expect(host.notifications).toEqual([]);
  });

  test.each([
    ["error instances report their message", new Error("boom"), "boom"],
    [
      "non-error throws are stringified",
      "resolver exploded",
      "resolver exploded",
    ],
  ] as const)(
    "should notify without prompting or opening the panel for discovery failures: %s",
    async (_name, thrown, expected) => {
      const openPanel = mock(async () => ({ type: "closed" }) as const);
      const pi = piHarness(
        runtimeAdapter({
          discover: async () => {
            throw thrown;
          },
          openPanel,
        }),
      );
      const host = commandHost({});

      await pi.run(host.ctx);

      expect(host.prompts).toEqual([]);
      expect(openPanel).not.toHaveBeenCalled();
      expect(host.notifications).toEqual([
        { message: expected, level: "error" },
      ]);
    },
  );

  test("should build the panel catalog from the discovered seed and runtime committer", async () => {
    const settings = new Map<ResourceScope, SettingsDocument>();
    const requests: CommitRequest[] = [];
    let opened:
      | {
          readonly ctx: ExtensionCommandContext;
          readonly catalog: ExtensionCatalog;
          readonly selfPath: string;
        }
      | undefined;
    const runtime = runtimeAdapter({
      commit: async (request) => {
        requests.push(request);
        return { scopes: [], committedScopes: [] };
      },
      discover: async () =>
        seed({ settings, tuiMode: "fullscreen", projectTrusted: false }),
      openPanel: async (ctx, catalog, selfPath) => {
        opened = { ctx, catalog, selfPath };
        return { type: "closed" };
      },
    });
    const pi = piHarness(runtime);
    const host = commandHost({});

    await pi.run(host.ctx);

    expect(opened?.ctx).toBe(host.ctx);
    expect(opened?.selfPath).toBe(runtime.selfPath);
    expect(opened?.catalog).toBeInstanceOf(ExtensionCatalog);
    expect(opened?.catalog.view()).toMatchObject({
      tuiMode: "fullscreen",
      projectTrusted: false,
      reloadPending: false,
    });

    await opened?.catalog.commit();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.documents).toBe(settings);
  });

  test("should not notify or mark later discovery pending when panels close", async () => {
    const pending: boolean[] = [];
    const pi = piHarness(
      runtimeAdapter({
        discover: async (input) => {
          pending.push(input.reloadPending);
          return seed({ reloadPending: input.reloadPending });
        },
      }),
    );
    const host = commandHost({});

    await pi.run(host.ctx);
    await pi.run(host.ctx);

    expect(pending).toEqual([false, false]);
    expect(host.notifications).toEqual([]);
  });

  test("should warn, request a manual reload, and mark later discovery pending when a commit is partial", async () => {
    const pending: boolean[] = [];
    let opens = 0;
    const pi = piHarness(
      runtimeAdapter({
        discover: async (input) => {
          pending.push(input.reloadPending);
          return seed({ reloadPending: input.reloadPending });
        },
        openPanel: async () => {
          opens += 1;
          return opens === 1
            ? {
                type: "commit",
                selfDisableCommitted: false,
                result: {
                  scopes: [
                    { scope: "global", status: "committed" },
                    {
                      scope: "project",
                      status: "failed",
                      message: "disk full",
                    },
                  ],
                  committedScopes: ["global"],
                },
              }
            : { type: "closed" };
        },
      }),
    );
    const host = commandHost({});

    await pi.run(host.ctx);
    await pi.run(host.ctx);

    expect(pending).toEqual([false, true]);
    expect(host.notifications).toHaveLength(1);
    expect(host.notifications[0]?.level).toBe("warning");
    expect(host.notifications[0]?.message).toEndWith(
      "Run /reload to apply saved changes.",
    );
  });

  test("should dispose the runtime on session shutdown but not during command runs", async () => {
    const dispose = mock(() => undefined);
    const pi = piHarness(runtimeAdapter({ dispose }));
    const host = commandHost({});

    await pi.run(host.ctx);

    expect(dispose).not.toHaveBeenCalled();

    pi.shutdown();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
