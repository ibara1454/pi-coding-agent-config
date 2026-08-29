import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { ExtensionCatalog } from "./catalog.ts";
import { PackageResolutionFailure } from "./discovery.ts";
import {
  createDefaultRuntime,
  type ExtensionManagerRuntime,
  registerExtensionManager,
} from "./index.ts";
import type { PanelResult } from "./panel.ts";
import type { CatalogSeed } from "./types.ts";

function emptySeed(reloadPending = false): CatalogSeed {
  return {
    rows: [],
    targets: new Map(),
    settings: new Map(),
    diagnostics: [],
    projectTrusted: true,
    tuiMode: "regular",
    reloadPending,
  };
}

interface PiHarness {
  readonly command: () => (
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void> | void;
  readonly shutdown: () => void;
}

function piHarness(runtime: ExtensionManagerRuntime): PiHarness {
  let handler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void)
    | undefined;
  let shutdownHandler: (() => void) | undefined;
  const pi = {
    on(event: string, callback: () => void) {
      if (event === "session_shutdown") {
        shutdownHandler = callback;
      }
    },
    registerCommand(name: string, options: { handler: typeof handler }) {
      expect(name).toBe("extensions");
      handler = options.handler;
    },
  } as unknown as ExtensionAPI;
  registerExtensionManager(pi, runtime);
  return {
    command() {
      if (handler === undefined) {
        throw new Error("Command was not registered");
      }
      return handler;
    },
    shutdown() {
      shutdownHandler?.();
    },
  };
}

function context(options: {
  readonly mode: "tui" | "rpc" | "json" | "print";
  readonly events: string[];
  readonly selections?: string[];
  readonly trusted?: boolean;
}): {
  readonly ctx: ExtensionCommandContext;
  readonly notifications: Array<{
    readonly message: string;
    readonly level: string;
  }>;
} {
  const notifications: Array<{
    readonly message: string;
    readonly level: string;
  }> = [];
  const selections = [...(options.selections ?? [])];
  return {
    notifications,
    ctx: {
      mode: options.mode,
      cwd: "/repo",
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        async select() {
          return selections.shift();
        },
      },
      async waitForIdle() {
        options.events.push("wait");
      },
      isProjectTrusted() {
        return options.trusted ?? true;
      },
    } as unknown as ExtensionCommandContext,
  };
}

function runtime(
  overrides: Partial<ExtensionManagerRuntime> = {},
): ExtensionManagerRuntime {
  return {
    agentDir: () => "/agent",
    commit: async () => ({ scopes: [], committedScopes: [] }),
    discover: async (input) => emptySeed(input.reloadPending),
    openPanel: async () => ({ type: "closed" }),
    selfPath: "/extension-manager/index.ts",
    dispose: () => undefined,
    ...overrides,
  };
}

describe("/extensions command", () => {
  test("rejects non-TUI modes before waiting or discovery", async () => {
    const events: string[] = [];
    const manager = runtime({
      discover: async () => {
        events.push("discover");
        return emptySeed();
      },
    });
    const pi = piHarness(manager);
    const commandContext = context({ mode: "rpc", events });

    await pi.command()("", commandContext.ctx);

    expect(events).toEqual([]);
    expect(commandContext.notifications).toEqual([
      {
        message: "/extensions is available only in TUI mode",
        level: "warning",
      },
    ]);
  });

  test("waits for idle before discovery and forwards project trust", async () => {
    const events: string[] = [];
    const inputs: Parameters<ExtensionManagerRuntime["discover"]>[0][] = [];
    const manager = runtime({
      discover: async (input) => {
        events.push("discover");
        inputs.push(input);
        return emptySeed();
      },
      openPanel: async () => {
        events.push("open");
        return { type: "closed" };
      },
    });
    const pi = piHarness(manager);
    const commandContext = context({
      mode: "tui",
      events,
      trusted: false,
    });

    await pi.command()("", commandContext.ctx);

    expect(events).toEqual(["wait", "discover", "open"]);
    expect(inputs[0]).toEqual({
      agentDir: "/agent",
      cwd: "/repo",
      projectTrusted: false,
      reloadPending: false,
    });
  });

  test("offers Retry and repeats only fatal package resolution", async () => {
    const events: string[] = [];
    let attempts = 0;
    const manager = runtime({
      discover: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new PackageResolutionFailure("resolver failed");
        }
        return emptySeed();
      },
    });
    const pi = piHarness(manager);
    const commandContext = context({
      mode: "tui",
      events,
      selections: ["Retry"],
    });

    await pi.command()("", commandContext.ctx);

    expect(attempts).toBe(2);
  });

  test("reports exact partial results, requests manual reload, and marks later opens pending", async () => {
    const events: string[] = [];
    const pendingValues: boolean[] = [];
    let opens = 0;
    const manager = runtime({
      discover: async (input) => {
        pendingValues.push(input.reloadPending);
        return emptySeed(input.reloadPending);
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
                  { scope: "project", status: "failed", message: "disk full" },
                ],
                committedScopes: ["global"],
              },
            }
          : { type: "closed" };
      },
    });
    const pi = piHarness(manager);
    const commandContext = context({ mode: "tui", events });

    await pi.command()("", commandContext.ctx);
    await pi.command()("", commandContext.ctx);

    expect(pendingValues).toEqual([false, true]);
    expect(commandContext.notifications).toHaveLength(1);
    expect(commandContext.notifications[0]?.level).toBe("warning");
    expect(commandContext.notifications[0]?.message).toContain(
      "Saved Global settings.",
    );
    expect(commandContext.notifications[0]?.message).toContain(
      "Project failed: disk full",
    );
    expect(commandContext.notifications[0]?.message).toEndWith(
      "Run /reload to apply saved changes.",
    );
    expect(commandContext.notifications[0]?.message).not.toContain("pi config");
  });

  test("adds recovery only when effective self-disable commits", async () => {
    const events: string[] = [];
    const manager = runtime({
      openPanel: async () => ({
        type: "commit",
        selfDisableCommitted: true,
        result: {
          scopes: [{ scope: "global", status: "committed" }],
          committedScopes: ["global"],
        },
      }),
    });
    const pi = piHarness(manager);
    const commandContext = context({ mode: "tui", events });

    await pi.command()("", commandContext.ctx);

    expect(commandContext.notifications[0]?.message).toContain(
      "recover with `pi config`",
    );
    expect(commandContext.notifications[0]?.message).toEndWith(
      "Run /reload to apply saved changes.",
    );
  });

  test("disposes active runtime state on session shutdown", () => {
    let disposed = 0;
    const pi = piHarness(runtime({ dispose: () => (disposed += 1) }));
    pi.shutdown();
    expect(disposed).toBe(1);
  });
});

test("default runtimes dispose only their own active panels", async () => {
  function panelContext(): {
    readonly ctx: ExtensionCommandContext;
    readonly finish: (result: PanelResult) => void;
    readonly writes: string[];
  } {
    const writes: string[] = [];
    let finish: (result: PanelResult) => void = () => undefined;
    const tui = {
      mode: "regular",
      terminal: {
        columns: 80,
        rows: 18,
        write(data: string) {
          writes.push(data);
        },
      },
      requestRender() {},
    } as unknown as TUI;
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      italic: (text: string) => text,
      underline: (text: string) => text,
      inverse: (text: string) => text,
      strikethrough: (text: string) => text,
    } as unknown as Theme;
    const ctx = {
      ui: {
        custom<T>(
          factory: (
            value: TUI,
            valueTheme: Theme,
            keybindings: never,
            done: (result: T) => void,
          ) => unknown,
        ): Promise<T> {
          const pending = Promise.withResolvers<T>();
          finish = (result) => pending.resolve(result as T);
          factory(tui, theme, undefined as never, pending.resolve);
          return pending.promise;
        },
      },
    } as unknown as ExtensionCommandContext;
    return {
      ctx,
      finish: (result) => finish(result),
      writes,
    };
  }

  const first = createDefaultRuntime();
  const second = createDefaultRuntime();
  const firstContext = panelContext();
  const secondContext = panelContext();
  const firstOpen = first.openPanel(
    firstContext.ctx,
    new ExtensionCatalog(emptySeed(), first.commit),
    first.selfPath,
  );
  const secondOpen = second.openPanel(
    secondContext.ctx,
    new ExtensionCatalog(emptySeed(), second.commit),
    second.selfPath,
  );

  first.dispose();
  expect(
    firstContext.writes.filter((write) => write.includes("?1000l")),
  ).toHaveLength(1);
  expect(
    secondContext.writes.filter((write) => write.includes("?1000l")),
  ).toHaveLength(0);

  second.dispose();
  expect(
    secondContext.writes.filter((write) => write.includes("?1000l")),
  ).toHaveLength(1);
  firstContext.finish({ type: "closed" });
  secondContext.finish({ type: "closed" });
  await Promise.all([firstOpen, secondOpen]);
});
