const MILLISECONDS_PER_SECOND = 1000;

interface RunMetrics {
  readonly activeMs: number;
  readonly activeStartedAt: number | null;
  readonly streamStartedAt: number | null;
  readonly tokensPerSecond: number | null;
}

type RunMetricEvent =
  | { readonly kind: "start" }
  | { readonly kind: "end" }
  | { readonly kind: "output"; readonly output: unknown };

export const EMPTY_RUN_METRICS: RunMetrics = {
  activeMs: 0,
  activeStartedAt: null,
  streamStartedAt: null,
  tokensPerSecond: null,
};

/**
 * Computes run timing and throughput without mutating state or acquiring a clock.
 * Starts retain an active interval but restart the stream; ends close it and retain the rate.
 * Invalid output or nonpositive stream elapsed time retains the previous rate.
 * @param metrics Previous state, owned and replaced by the host.
 * @param event Run transition or assistant output already selected by the host.
 * @param nowMs Event timestamp in wall-clock milliseconds; backward jumps are not clamped.
 * @returns Updated state, or the same state when no metric changes; owns no resources and does not throw.
 * @example updateRunMetrics(EMPTY_RUN_METRICS, { kind: "start" }, 1000).activeStartedAt === 1000
 */
export function updateRunMetrics(
  metrics: RunMetrics,
  event: RunMetricEvent,
  nowMs: number,
): RunMetrics {
  if (event.kind === "start") {
    return {
      ...metrics,
      activeStartedAt: metrics.activeStartedAt ?? nowMs,
      streamStartedAt: nowMs,
    };
  }
  if (event.kind === "end") {
    return {
      ...metrics,
      activeMs: activeRunMilliseconds(metrics, nowMs),
      activeStartedAt: null,
      streamStartedAt: null,
    };
  }
  const { output } = event;
  if (
    metrics.streamStartedAt === null ||
    typeof output !== "number" ||
    !Number.isFinite(output) ||
    output <= 0
  ) {
    return metrics;
  }
  const elapsed = (nowMs - metrics.streamStartedAt) / MILLISECONDS_PER_SECOND;
  return elapsed > 0
    ? { ...metrics, tokensPerSecond: output / elapsed }
    : metrics;
}

/**
 * Reads accumulated active milliseconds plus any open run interval without changing state.
 * @param metrics Run state retained by the host.
 * @param nowMs Snapshot timestamp in wall-clock milliseconds; backward jumps are not clamped.
 * @returns Live duration while active, frozen accumulated duration otherwise; no effects or resources.
 * @example activeRunMilliseconds(EMPTY_RUN_METRICS, 1000) === 0
 */
export function activeRunMilliseconds(
  metrics: RunMetrics,
  nowMs: number,
): number {
  return (
    metrics.activeMs +
    (metrics.activeStartedAt === null ? 0 : nowMs - metrics.activeStartedAt)
  );
}
