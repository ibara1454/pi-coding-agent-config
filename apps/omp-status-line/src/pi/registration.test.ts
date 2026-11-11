import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: Spies intercept the live settings-read boundary.
import * as fs from "node:fs";
import { join } from "node:path";
// biome-ignore lint/performance/noNamespaceImport: Spies isolate the owner of command and refresh effects.
import * as git from "../git/git-status.ts";
// biome-ignore lint/performance/noNamespaceImport: Spies observe registration's settings/context decisions before segment rendering.
import * as segments from "../rendering/segments.ts";
import { registerStatusLine } from "./registration.ts";
import {
  createHarness,
  createSettingsFixture,
} from "./test/registration.helper.ts";

const RENDER_WIDTH = 160;
const shutdowns: Array<() => Promise<void>> = [];

/**
 * Registers real settings and event policy with inert Git, timer and rendering boundaries.
 * @param options - User/project settings and the host trust decision.
 * @returns Recorded policy inputs and host events; afterEach releases the session and restores spies/environment.
 * @example await fixture({ trusted: false }).emit("session_start"); // Never reads project settings.
 */
function fixture(
  options: {
    trusted?: boolean;
    global?: Record<string, unknown>;
    project?: Record<string, unknown>;
  } = {},
) {
  const settings = createSettingsFixture(options.global ?? {}, options.project);
  const harness = createHarness({
    cwd: settings.projectDir,
    trusted: options.trusted ?? true,
  });
  const owner = {
    snapshot: {
      branch: undefined,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      pr: undefined,
    },
    start: mock(async () => undefined),
    stop: mock(async () => undefined),
    requestRefresh: mock(() => undefined),
    invalidate: mock(
      (_reason: "working-tree" | "branch" | "pending-pr") => undefined,
    ),
  };
  spyOn(git, "createGitStatus").mockReturnValue(owner);
  const render = spyOn(segments, "renderSegment").mockReturnValue({
    content: "segment",
    visible: true,
  });
  // biome-ignore lint/plugin/biome-rules/use-undefined: An inert null-prototype handle allocates no timer.
  const timer: NodeJS.Timeout = Object.create(null);
  spyOn(globalThis, "setInterval").mockReturnValue(timer);
  spyOn(globalThis, "clearInterval").mockReturnValue(undefined);
  registerStatusLine(harness.pi as never);
  shutdowns.push(async () => {
    try {
      await harness.handlers.get("session_shutdown")?.({});
    } finally {
      settings.cleanup();
    }
  });
  const requestRender = mock(() => undefined);
  return {
    harness,
    owner,
    render,
    requestRender,
    /**
     * Delivers a registered host event with a supplied or current context.
     * @returns The handler's completion or optional output.
     * @example await emit("session_start") installs registration-owned UI.
     */
    emit(
      event: string,
      data: unknown = {},
      context: unknown = harness.context,
    ) {
      return harness.handlers.get(event)?.(data, context);
    },
    /**
     * Connects the host footer so event invalidation reaches its public render callback.
     * @throws If the session did not install a footer factory.
     * @example connectFooter() makes requestRender observe context-refresh events.
     */
    connectFooter(): void {
      const factory = harness.getFooterFactory();
      if (typeof factory !== "function") {
        throw new Error("Expected the status footer factory");
      }
      factory({ requestRender }, harness.theme, {
        getGitBranch: () => "main",
        getExtensionStatuses: () => new Map(),
        onBranchChange: () => () => undefined,
      });
    },
    /**
     * Exercises registration-owned framing while isolating segment behavior.
     * @throws If the session did not install an editor factory.
     * @example renderEditor() records the current context at the segment boundary.
     */
    renderEditor(): void {
      const factory = harness.getEditorFactory();
      if (typeof factory !== "function") {
        throw new Error("Expected the status editor factory");
      }
      factory({}, harness.theme, {}).render(RENDER_WIDTH);
    },
  };
}

afterEach(async () => {
  try {
    for (const shutdown of shutdowns.splice(0)) {
      await shutdown();
    }
  } finally {
    mock.restore();
  }
});

describe("registerStatusLine.session_start", () => {
  it.each([
    ["the project is untrusted", false, ["model"], "ascii"],
    ["the project is trusted", true, ["path"], "pipe"],
  ] as const)(
    "should apply the allowed settings scope when %s",
    async (_condition, trusted, expectedSegments, expectedSeparator) => {
      const setup = fixture({
        trusted,
        global: {
          preset: "custom",
          leftSegments: ["model"],
          rightSegments: [],
          separator: "ascii",
          sessionAccent: false,
        },
        project: { leftSegments: ["path"], separator: "pipe" },
      });
      const reads = spyOn(fs, "readFileSync");
      await setup.emit("session_start");
      setup.renderEditor();
      const context = setup.render.mock.calls[0]?.[1];
      expect(context?.settings.leftSegments).toEqual([...expectedSegments]);
      expect(context?.settings.separator).toBe(expectedSeparator);
      expect(context?.settings.sessionAccent).toBe(false);
      expect(
        reads.mock.calls.some(
          ([file]) =>
            String(file) ===
            join(setup.harness.context.cwd, ".pi", "settings.json"),
        ),
      ).toBe(trusted);
    },
  );
});

describe("registerStatusLine", () => {
  it.each([
    "session_info_changed",
    "model_select",
    "thinking_level_select",
    "session_tree",
    "session_compact",
  ])("should replace the rendered context when %s fires", async (event) => {
    const setup = fixture({ global: { preset: "minimal" } });
    await setup.emit("session_start");
    setup.connectFooter();
    const nextContext = { ...setup.harness.context, cwd: "/replacement" };
    await setup.emit(event, {}, nextContext);
    setup.renderEditor();
    expect(setup.render.mock.calls[0]?.[1].extensionContext.cwd).toBe(
      nextContext.cwd,
    );
    expect(setup.requestRender).toHaveBeenCalledTimes(1);
  });
});

describe("registerStatusLine.tool_result", () => {
  it.each([
    ["a write completed", { toolName: "write" }, ["working-tree"]],
    ["an edit completed", { toolName: "edit" }, ["working-tree"]],
    [
      "a shell command changed branches",
      { toolName: "bash", input: { command: "git switch feature" } },
      ["branch"],
    ],
    ["a read completed", { toolName: "read" }, []],
    [
      "a shell command did not change git state",
      { toolName: "bash", input: { command: "printf hello" } },
      [],
    ],
  ] as const)(
    "should invalidate only the affected git state when %s",
    async (_condition, event, reasons) => {
      const setup = fixture();
      await setup.emit("session_start");
      await setup.emit("tool_result", event);
      expect<readonly string[]>(
        setup.owner.invalidate.mock.calls.map(([reason]) => reason),
      ).toEqual(reasons);
    },
  );
});
