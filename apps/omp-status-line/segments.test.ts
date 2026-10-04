import { describe, expect, spyOn, test } from "bun:test";
import { renderSegment } from "./segments.ts";
import type {
  SegmentContext,
  StatusLineSegmentId,
  UsageStats,
} from "./types.ts";

const ASCII_PATH_LABEL = "dir: ";
const FIXED_CLOCK_MINUTE = 5;
const FIXED_CLOCK_SECOND = 9;

/**
 * Creates a status-line context with no recorded usage and plain theme effects.
 * @param options Host labels and subscription state to expose during rendering.
 * @returns A fresh context whose usage and display policies tests can change.
 * @example createContext({ subscription: true }); // Cost can show "(sub)" without spend.
 */
function createContext(options?: {
  cwd?: string;
  modelName?: string;
  modelId?: string;
  reasoning?: boolean;
  thinkingLevel?: string;
  pullRequestUrl?: string;
  subscription?: boolean;
}): SegmentContext {
  return {
    extensionContext: {
      cwd: options?.cwd ?? "/tmp/project",
      model: {
        id: options?.modelId ?? "test-model",
        name: options?.modelName ?? "Test",
        reasoning: options?.reasoning ?? false,
      },
      thinkingLevel: options?.thinkingLevel ?? "off",
      modelRegistry: {
        // biome-ignore lint/style/useNamingConvention: host API method name
        isUsingOAuth: () => options?.subscription ?? false,
      },
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

  expect(plain).toStartWith(ASCII_PATH_LABEL);
  expect(
    Bun.stringWidth(plain.slice(ASCII_PATH_LABEL.length)),
  ).toBeLessThanOrEqual(10);
  expect(plain).toEndWith("é.ts");
});

describe("renderSegment", () => {
  test.each([
    {
      name: "Claude Sonnet",
      id: "test-model",
      expected: "Sonnet",
    },
    {
      name: "Friendly label",
      id: "gpt-5.2-codex",
      expected: "GPT-5.2-Codex",
    },
    { name: "\n\t", id: "fallback-model", expected: "fallback-model" },
    { name: "", id: "", expected: "no-model" },
  ])(
    "should render the model label as $expected when its name is '$name' and ID is '$id'",
    ({ name, id, expected }) => {
      const context = createContext({ modelName: name, modelId: id });

      expect(Bun.stripANSI(renderSegment("model", context).content)).toBe(
        `[M] ${expected}`,
      );
    },
  );

  test.each([
    {
      level: "off",
      ascii: true,
      compact: false,
      expected: "[M] Test · [off]",
    },
    {
      level: "medium",
      ascii: true,
      compact: false,
      expected: "[M] Test · [med]",
    },
    {
      level: "xhigh",
      ascii: true,
      compact: false,
      expected: "[M] Test · [xhi]",
    },
    {
      level: "high",
      ascii: false,
      compact: false,
      expected: "⬢ Test · ◒ high",
    },
    {
      level: "high",
      ascii: false,
      compact: true,
      expected: "◒ Test",
    },
    {
      level: "future",
      ascii: false,
      compact: false,
      expected: "⬢ Test · future",
    },
  ])(
    "should render reasoning as '$expected' when level is $level, ascii is $ascii, and compact is $compact",
    ({ level, ascii, compact, expected }) => {
      const context = createContext({ reasoning: true, thinkingLevel: level });
      context.settings.preset = ascii ? "ascii" : "custom";
      context.settings.compactThinkingLevel = compact;

      expect(Bun.stripANSI(renderSegment("model", context).content)).toBe(
        expected,
      );
      context.options.model = { showThinkingLevel: false };
      expect(Bun.stripANSI(renderSegment("model", context).content)).toBe(
        ascii ? "[M] Test" : "⬢ Test",
      );
    },
  );

  test.each([
    { hours: 0, format: "12h", seconds: false, expected: "12:05am" },
    { hours: 13, format: "12h", seconds: true, expected: "1:05:09pm" },
    { hours: 13, format: "24h", seconds: true, expected: "13:05:09" },
  ] as const)(
    "should render time as $expected when the hour is $hours in $format format with seconds $seconds",
    ({ hours, format, seconds, expected }) => {
      const hour = spyOn(Date.prototype, "getHours").mockReturnValue(hours);
      const minute = spyOn(Date.prototype, "getMinutes").mockReturnValue(
        FIXED_CLOCK_MINUTE,
      );
      const second = spyOn(Date.prototype, "getSeconds").mockReturnValue(
        FIXED_CLOCK_SECOND,
      );
      try {
        const context = createContext();
        context.options.time = { format, showSeconds: seconds };

        expect(renderSegment("time", context)).toEqual({
          content: `time: ${expected}`,
          visible: true,
        });
      } finally {
        second.mockRestore();
        minute.mockRestore();
        hour.mockRestore();
      }
    },
  );

  test.each([
    {
      url: "https://example.com/pr/42",
      expected: "\x1b]8;;https://example.com/pr/42\x07PR #42\x1b]8;;\x07",
    },
    {
      url: "http://example.com/pr/42",
      expected: "\x1b]8;;http://example.com/pr/42\x07PR #42\x1b]8;;\x07",
    },
    { url: "file:///tmp/pr/42", expected: "PR #42" },
    { url: "not-a-url", expected: "PR #42" },
    { url: "https://example.com/pr/42 next", expected: "PR #42" },
  ])(
    "should render the PR label with only a safe HTTP hyperlink when its URL is $url",
    ({ url, expected }) => {
      const context = createContext({ pullRequestUrl: url });
      const rendered = renderSegment("pr", context);

      expect(rendered.visible).toBe(true);
      expect(Bun.stripANSI(rendered.content)).toBe("PR #42");
      expect(rendered.content).toBe(expected);
    },
  );

  test("should total input, output, and cache writes without cache reads when rendering token_total", () => {
    const context = createContext();
    Object.assign(context.usage, {
      input: 120,
      output: 30,
      cacheWrite: 50,
      cacheRead: 400,
    });

    const rendered = renderSegment("token_total", context);

    expect(rendered.visible).toBe(true);
    expect(Bun.stripANSI(rendered.content)).toBe("tok: 200");
  });

  test.each([{ cacheRead: 0 }, { cacheRead: 400 }])(
    "should hide token_total when counted usage is zero and cache reads are $cacheRead",
    ({ cacheRead }) => {
      const context = createContext();
      context.usage.cacheRead = cacheRead;

      expect(renderSegment("token_total", context)).toEqual({
        content: "",
        visible: false,
      });
    },
  );

  test.each([
    { expected: "999", input: 999 },
    { expected: "1K", input: 1000 },
    { expected: "1.5K", input: 1500 },
    { expected: "1M", input: 1_000_000 },
    { expected: "1B", input: 1_000_000_000 },
  ])(
    "should render token_total as $expected when counted usage is $input",
    ({ expected, input }) => {
      const context = createContext();
      context.usage.input = input;

      const rendered = renderSegment("token_total", context);

      expect(rendered.visible).toBe(true);
      expect(Bun.stripANSI(rendered.content)).toBe(`tok: ${expected}`);
    },
  );

  test("should display dirty counts and respect git visibility options when a branch has changes", () => {
    const context = createContext();
    Object.assign(context.git, {
      branch: "feature\n\tbranch",
      staged: 2,
      unstaged: 3,
      untracked: 4,
    });

    const dirty = renderSegment("git", context);
    expect(dirty.visible).toBe(true);
    expect(Bun.stripANSI(dirty.content)).toBe("@ feature branch *3 +2 ?4");

    context.options.git = {
      showBranch: false,
      showStaged: false,
      showUnstaged: false,
    };
    expect(Bun.stripANSI(renderSegment("git", context).content)).toBe(
      "git: ?4",
    );

    context.options.git.showUntracked = false;
    expect(renderSegment("git", context)).toEqual({
      content: "",
      visible: false,
    });
  });

  test("should show a clean branch but hide git when repository information is absent", () => {
    const context = createContext();
    expect(renderSegment("git", context)).toEqual({
      content: "",
      visible: false,
    });

    context.git.branch = "main";
    const rendered = renderSegment("git", context);
    expect(rendered.visible).toBe(true);
    expect(Bun.stripANSI(rendered.content)).toBe("@ main");
  });

  test.each([
    { id: "token_in", key: "input", value: 1250, expected: "in: 1.3K" },
    { id: "token_out", key: "output", value: 500, expected: "out: 500" },
    { id: "cache_read", key: "cacheRead", value: 100, expected: "cache 100" },
    { id: "cache_write", key: "cacheWrite", value: 500, expected: "cache 500" },
    {
      id: "token_rate",
      key: "tokensPerSecond",
      value: 12.345,
      expected: "tok/s: 12.3 tok/s",
    },
  ] satisfies {
    id: StatusLineSegmentId;
    key: keyof UsageStats;
    value: number;
    expected: string;
  }[])(
    "should show $expected instead of an empty segment when $key usage is recorded",
    ({ id, key, value, expected }) => {
      const context = createContext();
      expect(renderSegment(id, context)).toEqual({
        content: "",
        visible: false,
      });

      context.usage[key] = value;
      const rendered = renderSegment(id, context);
      expect(rendered.visible).toBe(true);
      expect(Bun.stripANSI(rendered.content)).toBe(expected);
    },
  );

  test("should calculate cache hits from input and both cache counters when output tokens are present", () => {
    const context = createContext();
    expect(renderSegment("cache_hit", context).visible).toBe(false);
    Object.assign(context.usage, {
      input: 100,
      cacheRead: 300,
      cacheWrite: 200,
      output: 900,
    });

    const rendered = renderSegment("cache_hit", context);
    expect(rendered.visible).toBe(true);
    expect(Bun.stripANSI(rendered.content)).toBe("cache 50.00%");
  });

  test.each([
    {
      label: "no spend or subscription is present",
      subscription: false,
      cost: 0,
      premiumRequests: 0,
      expected: "",
      visible: false,
    },
    {
      label: "only a subscription is present",
      subscription: true,
      cost: 0,
      premiumRequests: 0,
      expected: "(sub)",
      visible: true,
    },
    {
      label: "billed and premium usage accompany a subscription",
      subscription: true,
      cost: 1.236,
      premiumRequests: 2,
      expected: "$1.24 ★ 2 (sub)",
      visible: true,
    },
    {
      label: "a premium fraction rounds below the reporting precision",
      subscription: false,
      cost: 0,
      premiumRequests: 0.001,
      expected: "",
      visible: false,
    },
  ])(
    "should render cost as '$expected' when $label",
    ({ subscription, cost, premiumRequests, expected, visible }) => {
      const context = createContext({ subscription });
      Object.assign(context.usage, { cost, premiumRequests });

      const rendered = renderSegment("cost", context);
      expect(rendered.visible).toBe(visible);
      expect(Bun.stripANSI(rendered.content)).toBe(expected);
    },
  );

  test.each([
    { percent: 49.9, window: 0, severity: undefined },
    { percent: 50, window: 0, severity: "warning" },
    { percent: 70, window: 0, severity: "thinkingHigh" },
    { percent: 90, window: 0, severity: "error" },
    { percent: 15, window: 1_000_000, severity: "warning" },
    { percent: 27, window: 1_000_000, severity: "thinkingHigh" },
    { percent: 50, window: 1_000_000, severity: "error" },
  ])(
    "should select context severity $severity when usage is $percent percent of a $window token window",
    ({ percent, window, severity }) => {
      const context = createContext();
      context.contextPercent = percent;
      context.contextWindow = window;
      const selected: string[] = [];
      context.theme.getFgAnsi = (color) => {
        selected.push(color);
        return "";
      };

      expect(renderSegment("context_pct", context).visible).toBe(true);
      expect(selected).toEqual(severity ? [severity] : []);
    },
  );

  test("should distinguish unknown usage from an unknown capacity when rendering context", () => {
    const context = createContext();
    const usage = { tokens: 1500, window: 200_000, percent: 25 };
    context.contextTokens = usage.tokens;
    expect(Bun.stripANSI(renderSegment("context_pct", context).content)).toBe(
      "ctx: 1.5K/? auto",
    );
    expect(renderSegment("context_total", context).visible).toBe(false);

    context.contextWindow = usage.window;
    expect(Bun.stripANSI(renderSegment("context_pct", context).content)).toBe(
      "ctx: ?/200K auto",
    );
    context.contextPercent = usage.percent;
    context.autoCompactEnabled = false;
    expect(Bun.stripANSI(renderSegment("context_pct", context).content)).toBe(
      "ctx: 25.0%/200K",
    );
    expect(Bun.stripANSI(renderSegment("context_total", context).content)).toBe(
      "ctx: 200K",
    );
  });

  test.each([
    { milliseconds: 999, expected: "", visible: false },
    { milliseconds: 1000, expected: "time: 1s", visible: true },
    { milliseconds: 60_000, expected: "time: 1m", visible: true },
    { milliseconds: 61_999, expected: "time: 1m 1s", visible: true },
    { milliseconds: 3_600_000, expected: "time: 1h", visible: true },
    { milliseconds: 3_660_000, expected: "time: 1h 1m", visible: true },
  ])(
    "should render elapsed time as '$expected' when active duration is $milliseconds milliseconds",
    ({ milliseconds, expected, visible }) => {
      const context = createContext();
      context.activeMs = milliseconds;

      const rendered = renderSegment("time_spent", context);
      expect(rendered.visible).toBe(visible);
      expect(Bun.stripANSI(rendered.content)).toBe(expected);
    },
  );

  test("should hide empty extension status and sanitize visible status when footer data changes", () => {
    const context = createContext();
    const statuses = new Map([["mode", "\n\t"]]);
    context.footerData = {
      getExtensionStatuses: () => statuses,
    } as never;
    expect(renderSegment("mode", context)).toEqual({
      content: "",
      visible: false,
    });

    statuses.set("mode", "\x1b[31mplan\nready\x1b[0m");
    expect(renderSegment("mode", context)).toEqual({
      content: "plan ready",
      visible: true,
    });
  });
});
