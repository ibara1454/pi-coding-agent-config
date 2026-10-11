import { Buffer } from "node:buffer";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isObjectRecord } from "./guards.ts";

const TOKEN_ESTIMATE_ROUNDING_OFFSET = 3;
const PERCENT_SCALE = 100;

type ContextBranchEntry =
  | {
      readonly type: "message";
      readonly message: {
        readonly role: string;
        readonly stopReason?: string;
        readonly usage?: unknown;
      };
    }
  | { readonly type: Exclude<SessionEntry["type"], "message"> };

interface ContextOverhead {
  readonly systemPrompt: string;
  readonly activeToolNames: readonly string[];
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  }[];
}

type ContextTokenEntry =
  | { readonly type: "message"; readonly tokens: number }
  | {
      readonly type: "compaction" | "branch_summary";
      readonly summary: string;
    }
  | { readonly type: "custom_message"; readonly content: unknown }
  | {
      readonly type: Exclude<
        SessionEntry["type"],
        "message" | "compaction" | "branch_summary" | "custom_message"
      >;
    };

interface ContextUsageInput {
  readonly reportedTokens: number | null | undefined;
  readonly providerAnchored: boolean;
  readonly estimatedMessageTokens: number;
  readonly estimatedOverheadTokens: number;
  readonly contextWindow: number | null | undefined;
  readonly modelContextWindow: number | null | undefined;
}

interface ContextUsage {
  readonly contextTokens: number;
  readonly contextPercent: number | null;
  readonly contextWindow: number;
}

/**
 * Estimates text as UTF-8 bytes rounded up to groups of four, not tokenizer units.
 * @param text Text to measure without changing it.
 * @returns Approximate tokens; acquires no host resources.
 * @example estimateTextTokens("界界") === 2
 */
function estimateTextTokens(text: string): number {
  return (
    (Buffer.byteLength(text, "utf8") + TOKEN_ESTIMATE_ROUNDING_OFFSET) >> 2
  );
}

/**
 * Treats missing, nonnumeric and nonfinite provider counts as zero.
 * @param value Untrusted provider usage field.
 * @returns Its finite numeric value, including negative values; no effects.
 * @example numeric("10") === 0
 */
function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Finds usable assistant usage strictly after the latest compaction, if any.
 * Aborted/error messages cannot anchor context; a nonzero total takes precedence
 * over the input/output/cache sum, even when that total is negative.
 * @param branch Readonly branch entries in chronological order.
 * @returns Whether positive provider context usage exists; no mutation or effects.
 * @example hasProviderContextAnchor([{ type: "compaction" }]) === false
 */
export function hasProviderContextAnchor(
  branch: readonly ContextBranchEntry[],
): boolean {
  let boundary = -1;
  for (let index = branch.length - 1; index >= 0; index--) {
    if (branch[index]?.type === "compaction") {
      boundary = index;
      break;
    }
  }
  for (let index = branch.length - 1; index > boundary; index--) {
    const entry = branch[index];
    if (entry?.type !== "message") {
      continue;
    }
    const { message } = entry;
    if (
      message.role !== "assistant" ||
      message.stopReason === "aborted" ||
      message.stopReason === "error" ||
      !isObjectRecord(message.usage)
    ) {
      continue;
    }
    const { totalTokens, input, output, cacheRead, cacheWrite } = message.usage;
    const contextTokens =
      numeric(totalTokens) ||
      numeric(input) +
        numeric(output) +
        numeric(cacheRead) +
        numeric(cacheWrite);
    if (contextTokens > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Estimates prompt and active tool overhead using separately byte-rounded fields.
 * Only failing tool schema serialization is omitted; names/descriptions still count.
 * @param input Readonly prompt, active tool names and tool descriptions/schemas.
 * @returns Approximate tokens without host reads or caller-state mutation.
 * @example estimateContextOverhead({ systemPrompt: "界界", activeToolNames: [], tools: [] }) === 2
 */
export function estimateContextOverhead(input: ContextOverhead): number {
  let tokens = estimateTextTokens(input.systemPrompt);
  const activeTools = new Set(input.activeToolNames);
  for (const tool of input.tools) {
    if (!activeTools.has(tool.name)) {
      continue;
    }
    tokens += estimateTextTokens(tool.name);
    tokens += estimateTextTokens(tool.description);
    try {
      tokens += estimateTextTokens(JSON.stringify(tool.parameters));
    } catch {
      // A cyclic extension schema cannot be sent verbatim either; omit only that schema.
    }
  }
  return tokens;
}

/**
 * Adds host-estimated message contributions and byte-rounded summaries/custom text.
 * @param entries Readonly selected context entries; message tokens come from Pi's
 * existing estimator at the adapter, not a replacement tokenizer.
 * @returns Approximate tokens; ignores other entries and never mutates inputs.
 * @throws Custom-message JSON serialization/byte-measurement errors propagate,
 * unlike optional tool schemas. No filesystem, UI or other host effects are owned.
 * @example estimateContextEntryTokens([{ type: "message", tokens: 3 }]) === 3
 */
export function estimateContextEntryTokens(
  entries: readonly ContextTokenEntry[],
): number {
  let tokens = 0;
  for (const entry of entries) {
    if (entry.type === "message") {
      tokens += entry.tokens;
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      tokens += estimateTextTokens(entry.summary);
    } else if (entry.type === "custom_message") {
      tokens += estimateTextTokens(
        typeof entry.content === "string"
          ? entry.content
          : JSON.stringify(entry.content),
      );
    }
  }
  return tokens;
}

/**
 * Selects anchored provider usage or estimated messages plus prompt/tool overhead.
 * @param input Readonly reported usage, anchor decision and numeric estimates.
 * The adapter computes messages only for nullish reported counts, and overhead
 * only without an anchored nonnullish count; unused estimates may be zero.
 * @returns Tokens and percent (0–100 scale, not clamped), with a null percent for
 * nonpositive windows. A reported zero is retained; windows fall back only when
 * nullish. Owns no effects/resources and does not mutate inputs.
 * @example calculateContextUsage({ reportedTokens: 0, providerAnchored: true, estimatedMessageTokens: 0, estimatedOverheadTokens: 0, contextWindow: 1000, modelContextWindow: undefined }).contextPercent === 0
 */
export function calculateContextUsage(input: ContextUsageInput): ContextUsage {
  const contextTokens =
    input.providerAnchored &&
    input.reportedTokens !== null &&
    input.reportedTokens !== undefined
      ? input.reportedTokens
      : input.estimatedOverheadTokens +
        (input.reportedTokens ?? input.estimatedMessageTokens);
  const contextWindow = input.contextWindow ?? input.modelContextWindow ?? 0;
  return {
    contextTokens,
    contextPercent:
      contextWindow > 0
        ? (contextTokens / contextWindow) * PERCENT_SCALE
        : null,
    contextWindow,
  };
}
