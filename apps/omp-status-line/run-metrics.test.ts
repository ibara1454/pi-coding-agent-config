import { describe, expect, test } from "bun:test";
import {
  activeRunMilliseconds,
  EMPTY_RUN_METRICS,
  updateRunMetrics,
} from "./run-metrics.ts";

const START_TIMESTAMP_MS = 10_000;
const UPDATE_ELAPSED_MS = 2000;
const END_ELAPSED_MS = 7000;
const IDLE_ELAPSED_MS = 20_000;
const RESTARTED_STREAM_RATE = 20;

const ACTIVE_METRICS = Object.freeze(
  updateRunMetrics(EMPTY_RUN_METRICS, { kind: "start" }, START_TIMESTAMP_MS),
);
const RATED_METRICS = Object.freeze(
  updateRunMetrics(
    ACTIVE_METRICS,
    { kind: "output", output: 20 },
    START_TIMESTAMP_MS + UPDATE_ELAPSED_MS,
  ),
);

describe("updateRunMetrics", () => {
  test("should open active and stream intervals without mutating state when a run starts", () => {
    const previous = Object.freeze({ ...EMPTY_RUN_METRICS });

    const next = updateRunMetrics(previous, { kind: "start" }, 0);

    expect(next).toEqual({
      activeMs: 0,
      activeStartedAt: 0,
      streamStartedAt: 0,
      tokensPerSecond: null,
    });
    expect(previous).toEqual(EMPTY_RUN_METRICS);
  });

  test("should retain the active interval and rate but restart stream timing when start repeats", () => {
    const next = updateRunMetrics(
      RATED_METRICS,
      { kind: "start" },
      START_TIMESTAMP_MS + UPDATE_ELAPSED_MS,
    );
    const updated = updateRunMetrics(
      next,
      { kind: "output", output: 40 },
      START_TIMESTAMP_MS + UPDATE_ELAPSED_MS * 2,
    );

    expect(next).toEqual({
      ...RATED_METRICS,
      streamStartedAt: START_TIMESTAMP_MS + UPDATE_ELAPSED_MS,
    });
    expect(updated.tokensPerSecond).toBe(RESTARTED_STREAM_RATE);
    expect(updated.activeStartedAt).toBe(START_TIMESTAMP_MS);
    expect(RATED_METRICS.streamStartedAt).toBe(START_TIMESTAMP_MS);
    expect(RATED_METRICS.tokensPerSecond).toBe(10);
  });

  test.each([
    { output: 20, elapsedMs: 2000, rate: 10 },
    { output: 40, elapsedMs: 5000, rate: 8 },
    { output: 0.5, elapsedMs: 250, rate: 2 },
  ])(
    "should calculate $rate tokens per second when $output output tokens arrive after $elapsedMs milliseconds",
    ({ output, elapsedMs, rate }) => {
      const next = updateRunMetrics(
        ACTIVE_METRICS,
        { kind: "output", output },
        START_TIMESTAMP_MS + elapsedMs,
      );

      expect(next).toEqual({ ...ACTIVE_METRICS, tokensPerSecond: rate });
      expect(ACTIVE_METRICS.tokensPerSecond).toBeNull();
    },
  );

  test.each([
    { label: "missing", output: undefined },
    { label: "null", output: null },
    { label: "a numeric string", output: "20" },
    { label: "an object", output: {} },
    { label: "zero", output: 0 },
    { label: "negative", output: -1 },
    { label: "NaN", output: Number.NaN },
    { label: "positive infinity", output: Number.POSITIVE_INFINITY },
    { label: "negative infinity", output: Number.NEGATIVE_INFINITY },
  ])("should retain the previous rate when output is $label", ({ output }) => {
    expect(
      updateRunMetrics(
        RATED_METRICS,
        { kind: "output", output },
        START_TIMESTAMP_MS + END_ELAPSED_MS,
      ),
    ).toEqual(RATED_METRICS);
  });

  test.each([
    { label: "zero", elapsedMs: 0 },
    { label: "negative", elapsedMs: -1 },
  ])(
    "should retain the previous rate when stream elapsed time is $label",
    ({ elapsedMs }) => {
      expect(
        updateRunMetrics(
          RATED_METRICS,
          { kind: "output", output: 40 },
          START_TIMESTAMP_MS + elapsedMs,
        ),
      ).toEqual(RATED_METRICS);
    },
  );

  test("should ignore output when no stream has started", () => {
    expect(
      updateRunMetrics(
        EMPTY_RUN_METRICS,
        { kind: "output", output: 20 },
        START_TIMESTAMP_MS,
      ),
    ).toEqual(EMPTY_RUN_METRICS);
  });

  test("should close intervals and retain the rate when a run ends", () => {
    const ended = updateRunMetrics(
      RATED_METRICS,
      { kind: "end" },
      START_TIMESTAMP_MS + END_ELAPSED_MS,
    );

    expect(ended).toEqual({
      activeMs: END_ELAPSED_MS,
      activeStartedAt: null,
      streamStartedAt: null,
      tokensPerSecond: RATED_METRICS.tokensPerSecond,
    });
    expect(
      updateRunMetrics(
        ended,
        { kind: "output", output: 1000 },
        START_TIMESTAMP_MS + IDLE_ELAPSED_MS,
      ),
    ).toEqual(ended);
    expect(
      updateRunMetrics(
        ended,
        { kind: "end" },
        START_TIMESTAMP_MS + IDLE_ELAPSED_MS,
      ),
    ).toEqual(ended);
    expect(RATED_METRICS.activeMs).toBe(0);
    expect(RATED_METRICS.activeStartedAt).toBe(START_TIMESTAMP_MS);
  });

  test("should accumulate only active intervals when a new run follows idle time", () => {
    const ended = updateRunMetrics(
      RATED_METRICS,
      { kind: "end" },
      START_TIMESTAMP_MS + END_ELAPSED_MS,
    );
    const restarted = updateRunMetrics(
      ended,
      { kind: "start" },
      START_TIMESTAMP_MS + IDLE_ELAPSED_MS,
    );
    const next = updateRunMetrics(
      restarted,
      { kind: "end" },
      START_TIMESTAMP_MS + IDLE_ELAPSED_MS + UPDATE_ELAPSED_MS,
    );

    expect(restarted.tokensPerSecond).toBe(ended.tokensPerSecond);
    expect(next.activeMs).toBe(END_ELAPSED_MS + UPDATE_ELAPSED_MS);
  });

  test("should retain signed elapsed time when the clock moves backward before end", () => {
    const ended = updateRunMetrics(
      ACTIVE_METRICS,
      { kind: "end" },
      START_TIMESTAMP_MS - UPDATE_ELAPSED_MS,
    );

    expect(ended.activeMs).toBe(-UPDATE_ELAPSED_MS);
    expect(ended.activeStartedAt).toBeNull();
    expect(ended.streamStartedAt).toBeNull();
  });
});

describe("activeRunMilliseconds", () => {
  test("should return zero when no run has started", () => {
    expect(activeRunMilliseconds(EMPTY_RUN_METRICS, START_TIMESTAMP_MS)).toBe(
      0,
    );
  });

  test.each([
    { label: "at start", elapsedMs: 0 },
    { label: "after start", elapsedMs: UPDATE_ELAPSED_MS },
    {
      label: "before start after clock rollback",
      elapsedMs: -UPDATE_ELAPSED_MS,
    },
  ])(
    "should include signed live elapsed milliseconds when the clock is $label",
    ({ elapsedMs }) => {
      const metrics = Object.freeze({
        ...ACTIVE_METRICS,
        activeMs: END_ELAPSED_MS,
      });

      expect(
        activeRunMilliseconds(metrics, START_TIMESTAMP_MS + elapsedMs),
      ).toBe(END_ELAPSED_MS + elapsedMs);
      expect(metrics.activeMs).toBe(END_ELAPSED_MS);
    },
  );

  test("should return frozen accumulated milliseconds when the agent has ended", () => {
    const ended = updateRunMetrics(
      ACTIVE_METRICS,
      { kind: "end" },
      START_TIMESTAMP_MS + END_ELAPSED_MS,
    );

    expect(
      activeRunMilliseconds(ended, START_TIMESTAMP_MS + IDLE_ELAPSED_MS),
    ).toBe(END_ELAPSED_MS);
  });
});
