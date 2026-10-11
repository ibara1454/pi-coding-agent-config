import { describe, expect, test } from "bun:test";
import {
  calculateContextUsage,
  estimateContextEntryTokens,
  estimateContextOverhead,
  hasProviderContextAnchor,
} from "./context-usage.ts";

const SUMMARY_CONTEXT_TOKENS = 9;
const PI_MESSAGE_TOKENS = 3;
const PROMPT_AND_TOOL_TOKENS = 7;
const ESTIMATED_CONTEXT_TOKENS = 16;
const ESTIMATED_CONTEXT_PERCENT = 1.6;
const CONTEXT_WINDOW = 1000;
const ESTIMATED_INPUT = Object.freeze({
  reportedTokens: undefined,
  providerAnchored: false,
  estimatedMessageTokens: SUMMARY_CONTEXT_TOKENS,
  estimatedOverheadTokens: PROMPT_AND_TOOL_TOKENS,
  contextWindow: CONTEXT_WINDOW,
  modelContextWindow: undefined,
});

interface CyclicValue {
  readonly self?: CyclicValue;
}

const CYCLIC_VALUE: CyclicValue = {};
Object.assign(CYCLIC_VALUE, { self: CYCLIC_VALUE });
Object.freeze(CYCLIC_VALUE);

const SUMMARY_ENTRIES = Object.freeze([
  Object.freeze({ type: "compaction" as const, summary: "12345678" }),
  Object.freeze({ type: "branch_summary" as const, summary: "1234" }),
  Object.freeze({ type: "custom_message" as const, content: "12345678" }),
  Object.freeze({
    type: "custom_message" as const,
    content: Object.freeze({ text: "界" }),
  }),
]);

const TOOL_OVERHEAD = Object.freeze({
  systemPrompt: "界界",
  activeToolNames: Object.freeze(["tool", "loop"]),
  tools: Object.freeze([
    Object.freeze({
      name: "tool",
      description: "read",
      parameters: Object.freeze({}),
    }),
    Object.freeze({
      name: "loop",
      description: "loop",
      parameters: CYCLIC_VALUE,
    }),
    Object.freeze({
      name: "inactive",
      description: "must not count",
      parameters: Object.freeze({}),
    }),
  ]),
});

const PRE_COMPACTION_ANCHOR = Object.freeze({
  type: "message" as const,
  message: Object.freeze({
    role: "assistant",
    usage: Object.freeze({ input: 500 }),
  }),
});

const COMPACTED_BRANCH = Object.freeze([
  PRE_COMPACTION_ANCHOR,
  Object.freeze({ type: "compaction" as const }),
  Object.freeze({
    type: "message" as const,
    message: Object.freeze({ role: "user", content: "next" }),
  }),
]);

const PROVIDER_MESSAGE = Object.freeze({
  type: "message" as const,
  message: Object.freeze({
    role: "assistant",
    usage: Object.freeze({ totalTokens: 500 }),
  }),
});

describe("calculateContextUsage", () => {
  test("should estimate 16 tokens and 1.6 percent from summaries and active tools when compaction removes the provider anchor", () => {
    const providerAnchored = hasProviderContextAnchor(COMPACTED_BRANCH);
    const estimatedMessageTokens = estimateContextEntryTokens(SUMMARY_ENTRIES);
    const estimatedOverheadTokens = estimateContextOverhead(TOOL_OVERHEAD);

    const usage = calculateContextUsage({
      reportedTokens: null,
      providerAnchored,
      estimatedMessageTokens,
      estimatedOverheadTokens,
      contextWindow: CONTEXT_WINDOW,
      modelContextWindow: undefined,
    });

    expect(providerAnchored).toBe(false);
    // UTF-8 byte estimates: prompt 2, active tools 5, summaries/custom entries 9.
    expect(estimatedMessageTokens).toBe(SUMMARY_CONTEXT_TOKENS);
    expect(estimatedOverheadTokens).toBe(PROMPT_AND_TOOL_TOKENS);
    expect(usage).toEqual({
      contextTokens: ESTIMATED_CONTEXT_TOKENS,
      contextPercent: ESTIMATED_CONTEXT_PERCENT,
      contextWindow: CONTEXT_WINDOW,
    });
  });

  test.each([
    {
      label: "positive",
      reportedTokens: 500,
      contextTokens: 500,
      contextPercent: 50,
    },
    { label: "zero", reportedTokens: 0, contextTokens: 0, contextPercent: 0 },
  ])(
    "should retain reported tokens without adding estimates when anchored usage is $label",
    ({ reportedTokens, contextTokens, contextPercent }) => {
      const input = Object.freeze({
        ...ESTIMATED_INPUT,
        providerAnchored: hasProviderContextAnchor([PROVIDER_MESSAGE]),
        reportedTokens,
      });

      expect(calculateContextUsage(input)).toEqual({
        contextTokens,
        contextPercent,
        contextWindow: CONTEXT_WINDOW,
      });
      expect(input.estimatedMessageTokens).toBe(SUMMARY_CONTEXT_TOKENS);
      expect(input.estimatedOverheadTokens).toBe(PROMPT_AND_TOOL_TOKENS);
    },
  );

  test.each([
    {
      label: "positive",
      reportedTokens: 500,
      contextTokens: 507,
      contextPercent: 50.7,
    },
    { label: "zero", reportedTokens: 0, contextTokens: 7, contextPercent: 0.7 },
  ])(
    "should add overhead to reported tokens without adding entry estimates when unanchored usage is $label",
    ({ reportedTokens, contextTokens, contextPercent }) => {
      const usage = calculateContextUsage({
        ...ESTIMATED_INPUT,
        reportedTokens,
      });
      expect(usage.contextTokens).toBe(contextTokens);
      expect(usage.contextWindow).toBe(CONTEXT_WINDOW);
      expect(usage.contextPercent).toBeCloseTo(contextPercent);
    },
  );

  test.each([
    { label: "missing", reportedTokens: undefined },
    { label: "null", reportedTokens: null },
  ])(
    "should add both estimates despite a provider anchor when reported usage is $label",
    ({ reportedTokens }) => {
      expect(
        calculateContextUsage({
          ...ESTIMATED_INPUT,
          providerAnchored: true,
          reportedTokens,
        }),
      ).toEqual({
        contextTokens: ESTIMATED_CONTEXT_TOKENS,
        contextPercent: ESTIMATED_CONTEXT_PERCENT,
        contextWindow: CONTEXT_WINDOW,
      });
    },
  );

  test.each([
    {
      label: "reported",
      contextWindow: 1000,
      modelContextWindow: 2000,
      expectedWindow: 1000,
      expectedPercent: 1.6,
    },
    {
      label: "null with a model fallback",
      contextWindow: null,
      modelContextWindow: 2000,
      expectedWindow: 2000,
      expectedPercent: 0.8,
    },
    {
      label: "missing with a model fallback",
      contextWindow: undefined,
      modelContextWindow: 2000,
      expectedWindow: 2000,
      expectedPercent: 0.8,
    },
    {
      label: "zero despite a model fallback",
      contextWindow: 0,
      modelContextWindow: 2000,
      expectedWindow: 0,
      expectedPercent: null,
    },
    {
      label: "negative",
      contextWindow: -1,
      modelContextWindow: 2000,
      expectedWindow: -1,
      expectedPercent: null,
    },
    {
      label: "missing without a model fallback",
      contextWindow: undefined,
      modelContextWindow: undefined,
      expectedWindow: 0,
      expectedPercent: null,
    },
    {
      label: "smaller than usage",
      contextWindow: 8,
      modelContextWindow: undefined,
      expectedWindow: 8,
      expectedPercent: 200,
    },
  ])(
    "should preserve window precedence and an unclamped percentage when the window is $label",
    ({
      contextWindow,
      modelContextWindow,
      expectedWindow,
      expectedPercent,
    }) => {
      expect(
        calculateContextUsage({
          ...ESTIMATED_INPUT,
          contextWindow,
          modelContextWindow,
        }),
      ).toEqual({
        contextTokens: ESTIMATED_CONTEXT_TOKENS,
        contextPercent: expectedPercent,
        contextWindow: expectedWindow,
      });
    },
  );
});

describe("hasProviderContextAnchor", () => {
  test("should reject prior provider usage when the latest compaction removes its anchor", () => {
    expect(hasProviderContextAnchor(COMPACTED_BRANCH)).toBe(false);
    expect(
      hasProviderContextAnchor([
        ...COMPACTED_BRANCH,
        PROVIDER_MESSAGE,
        { type: "compaction" },
      ]),
    ).toBe(false);
  });

  test("should accept fresh provider usage when an assistant completes after compaction", () => {
    expect(
      hasProviderContextAnchor([...COMPACTED_BRANCH, PROVIDER_MESSAGE]),
    ).toBe(true);
  });

  test("should reject an anchor when the branch is empty", () => {
    expect(hasProviderContextAnchor([])).toBe(false);
  });

  test("should retain earlier provider usage when later entries are not messages", () => {
    expect(
      hasProviderContextAnchor([PROVIDER_MESSAGE, { type: "branch_summary" }]),
    ).toBe(true);
  });

  test.each([
    { label: "a positive total", usage: { totalTokens: 5 }, expected: true },
    {
      label: "a component sum",
      usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      expected: true,
    },
    {
      label: "a zero total with positive input",
      usage: { totalTokens: 0, input: 1 },
      expected: true,
    },
    {
      label: "a nonfinite total with positive input",
      usage: { totalTokens: Number.POSITIVE_INFINITY, input: 1 },
      expected: true,
    },
    {
      label: "a negative total with positive input",
      usage: { totalTokens: -1, input: 5 },
      expected: false,
    },
    {
      label: "invalid component counts",
      usage: {
        totalTokens: "5",
        input: Number.NaN,
        output: Number.POSITIVE_INFINITY,
        cacheRead: null,
        cacheWrite: "5",
      },
      expected: false,
    },
    { label: "zero usage", usage: {}, expected: false },
  ])(
    "should return $expected when assistant usage has $label",
    ({ usage, expected }) => {
      expect(
        hasProviderContextAnchor([
          { type: "message", message: { role: "assistant", usage } },
        ]),
      ).toBe(expected);
    },
  );

  test.each([
    {
      label: "aborted",
      message: { ...PROVIDER_MESSAGE.message, stopReason: "aborted" },
    },
    {
      label: "failed",
      message: { ...PROVIDER_MESSAGE.message, stopReason: "error" },
    },
    { label: "a user message", message: { role: "user", usage: { input: 5 } } },
    { label: "missing usage", message: { role: "assistant" } },
    { label: "non-object usage", message: { role: "assistant", usage: 5 } },
    { label: "array usage", message: { role: "assistant", usage: [] } },
  ])("should ignore a candidate when the message is $label", ({ message }) => {
    const branch = [{ type: "message" as const, message }];
    expect(hasProviderContextAnchor(branch)).toBe(false);
    expect(hasProviderContextAnchor([PROVIDER_MESSAGE, ...branch])).toBe(true);
  });
});

describe("estimateContextOverhead", () => {
  test("should count only active tools and retain their names and descriptions when a schema is cyclic", () => {
    expect(estimateContextOverhead(TOOL_OVERHEAD)).toBe(PROMPT_AND_TOOL_TOKENS);
    expect(TOOL_OVERHEAD.tools.at(1)?.parameters).toBe(CYCLIC_VALUE);
    expect(CYCLIC_VALUE.self).toBe(CYCLIC_VALUE);
  });

  test.each([
    { label: "zero bytes", systemPrompt: "", expected: 0 },
    { label: "one byte", systemPrompt: "a", expected: 1 },
    { label: "four bytes", systemPrompt: "abcd", expected: 1 },
    { label: "five bytes", systemPrompt: "abcde", expected: 2 },
    { label: "six UTF-8 bytes", systemPrompt: "界界", expected: 2 },
  ])(
    "should round UTF-8 bytes up to groups of four when the prompt has $label",
    ({ systemPrompt, expected }) => {
      expect(
        estimateContextOverhead({
          systemPrompt,
          activeToolNames: [],
          tools: [],
        }),
      ).toBe(expected);
    },
  );

  test("should omit only schema tokens when the schema cannot serialize to text", () => {
    expect(
      estimateContextOverhead({
        systemPrompt: "",
        activeToolNames: ["tool"],
        tools: [{ name: "tool", description: "read", parameters: undefined }],
      }),
    ).toBe(2);
  });
});

describe("estimateContextEntryTokens", () => {
  test("should count summaries and string or serialized custom content using UTF-8 bytes", () => {
    expect(estimateContextEntryTokens(SUMMARY_ENTRIES)).toBe(
      SUMMARY_CONTEXT_TOKENS,
    );
  });

  test("should add explicit Pi message contributions without interpreting their contents and ignore other entries", () => {
    const entries = Object.freeze([
      Object.freeze({ type: "message" as const, tokens: PI_MESSAGE_TOKENS }),
      Object.freeze({ type: "message" as const, tokens: 0 }),
      Object.freeze({ type: "model_change" as const }),
    ]);
    expect(estimateContextEntryTokens(entries)).toBe(PI_MESSAGE_TOKENS);
    expect(estimateContextEntryTokens([])).toBe(0);
  });

  test("should propagate serialization failure when custom content is cyclic", () => {
    expect(() =>
      estimateContextEntryTokens([
        { type: "custom_message", content: CYCLIC_VALUE },
      ]),
    ).toThrow(TypeError);
    expect(CYCLIC_VALUE.self).toBe(CYCLIC_VALUE);
  });

  test("should propagate byte-measurement failure when custom content serializes to no text", () => {
    expect(() =>
      estimateContextEntryTokens([
        { type: "custom_message", content: undefined },
      ]),
    ).toThrow(TypeError);
  });
});
