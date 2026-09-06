import { expect, test } from "bun:test";
import { renderSegment } from "./segments.ts";
import type { SegmentContext } from "./types.ts";

function createContext(options?: {
  cwd?: string;
  modelName?: string;
  pullRequestUrl?: string;
}): SegmentContext {
  return {
    extensionContext: {
      cwd: options?.cwd ?? "/tmp/project",
      model: {
        id: "test-model",
        name: options?.modelName ?? "Test",
        reasoning: false,
      },
      thinkingLevel: "off",
      modelRegistry: { isUsingOAuth: () => false },
      sessionManager: {
        getSessionId: () => "session-id",
        getSessionName: () => undefined,
      },
    } as never,
    footerData: null,
    theme: {
      fg: (_color: string, text: string): string => text,
      getFgAnsi: (_color: string): string => "",
    } as never,
    settings: {
      preset: "ascii",
      showHookStatus: true,
      sessionAccent: false,
      transparent: false,
      compactThinkingLevel: false,
    },
    options: {},
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      premiumRequests: 0,
      cost: 0,
      tokensPerSecond: null,
    },
    contextTokens: 0,
    contextPercent: null,
    contextWindow: 0,
    autoCompactEnabled: true,
    activeMs: 0,
    git: {
      branch: null,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      pr: options?.pullRequestUrl
        ? { number: 42, url: options.pullRequestUrl }
        : null,
    },
  };
}

test("should remove terminal controls from model text", () => {
  const rendered = renderSegment(
    "model",
    createContext({
      modelName: "\x1b]8;;https://evil.example\x07Model\x1b]8;;\x07\n\t\x00界",
    }),
  );

  expect(Bun.stripANSI(rendered.content)).toContain("Model 界");
  expect(rendered.content).not.toContain("evil.example");
  expect(rendered.content).not.toContain("\n");
});

test("should omit an unsafe pull-request hyperlink", () => {
  const rendered = renderSegment(
    "pr",
    createContext({
      pullRequestUrl: "https://example.com/pr/42\x07https://evil.example",
    }),
  );

  expect(Bun.stripANSI(rendered.content)).toBe("PR #42");
  expect(rendered.content).not.toContain("\x1b]8;;");
});

test("should clamp paths by terminal cells", () => {
  const context = createContext({ cwd: "/tmp/界界/é.ts" });
  context.options.path = {
    abbreviate: false,
    maxLength: 10,
    stripWorkPrefix: false,
  };

  const rendered = renderSegment("path", context);
  const plain = Bun.stripANSI(rendered.content);

  expect(plain).toStartWith("dir: ");
  expect(Bun.stringWidth(plain.slice(5))).toBeLessThanOrEqual(10);
  expect(plain).toEndWith("é.ts");
});
