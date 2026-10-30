import { describe, expect, test as it, spyOn } from "bun:test";
import { getEventListeners } from "node:events";
import { RuntimeFailure } from "../../diagnostics/index.ts";
import { runtimeFixture } from "../test/index.helper.ts";
import { assertLive, deadline, waitBounded } from "./operations.ts";

const ABORTED = /aborted/u;
const INITIAL_CLOCK_MS = 10.5;
const ADVANCED_CLOCK_MS = 13.7;
const DEADLINE_MS = 10;
const FLOORED_REMAINING_MS = 6;
const EXPECTED_RESULT = 7;
const LATE_RESULT = 9;

describe("assertLive", () => {
  it("should reject aborted signals without leaking the signal reason", () => {
    const controller = new AbortController();
    assertLive(controller.signal);
    controller.abort(new Error("secret native cause"));
    expect(() => assertLive(controller.signal)).toThrow(ABORTED);
    let failure: unknown;
    try {
      assertLive(controller.signal);
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).name).toBe("AbortError");
    expect(JSON.stringify(failure)).not.toContain("secret");
  });
});

describe("deadline", () => {
  it("should floor remaining time, propagate caller cancellation, and clear its timer", () => {
    const fixture = runtimeFixture();
    const canceled = new AbortController();
    let now = INITIAL_CLOCK_MS;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    let callback: () => void = () => undefined;
    let cleared = false;
    try {
      const limit = deadline(
        {
          ...fixture.effects,
          setTimer: (run) => {
            callback = run;
            return DEADLINE_MS;
          },
          clearTimer: () => {
            cleared = true;
          },
        },
        DEADLINE_MS,
        [canceled.signal],
      );
      now = ADVANCED_CLOCK_MS;
      expect(limit.remaining()).toBe(FLOORED_REMAINING_MS);
      canceled.abort();
      expect(limit.signal.aborted).toBe(true);
      limit.close();
      expect(cleared).toBe(true);
      callback();
      expect(limit.remaining()).toBe(FLOORED_REMAINING_MS);
    } finally {
      clock.mockRestore();
    }
  });
  it("should abort with a safe timeout when its timer fires", () => {
    const fixture = runtimeFixture();
    let callback: () => void = () => undefined;
    const limit = deadline(
      {
        ...fixture.effects,
        setTimer: (run) => {
          callback = run;
          return DEADLINE_MS;
        },
      },
      DEADLINE_MS,
    );
    callback();
    expect((limit.signal.reason as RuntimeFailure).failure.code).toBe(
      "timeout",
    );
    limit.close();
  });
});

describe("waitBounded", () => {
  it("should settle an ordinary result without leaving an abort listener", async () => {
    const controller = new AbortController();
    expect(
      await waitBounded(Promise.resolve(EXPECTED_RESULT), controller.signal),
    ).toBe(EXPECTED_RESULT);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort();
  });
  it("should reject a pending task on cancellation while leaving raw work alive", async () => {
    const controller = new AbortController();
    const raw = Promise.withResolvers<number>();
    const bounded = waitBounded(raw.promise, controller.signal);
    controller.abort(new Error("private"));
    await expect(bounded).rejects.toMatchObject({
      name: "AbortError",
      failure: { code: "aborted" },
    });
    raw.resolve(LATE_RESULT);
    expect(await raw.promise).toBe(LATE_RESULT);
  });
  it("should preserve a safe deadline reason for an already-aborted signal despite settled raw work", async () => {
    const controller = new AbortController();
    controller.abort(
      new RuntimeFailure("timeout", "deadline", "Command timed out"),
    );
    await expect(
      waitBounded(Promise.resolve(EXPECTED_RESULT), controller.signal),
    ).rejects.toMatchObject({ failure: { code: "timeout" } });
    await expect(
      waitBounded(
        Promise.reject(new Error("private raw failure")),
        controller.signal,
      ),
    ).rejects.toMatchObject({ failure: { code: "timeout" } });
  });
});
