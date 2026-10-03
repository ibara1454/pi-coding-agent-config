import { describe, expect, mock, test } from "bun:test";
import { IntroAnimation, introFrame, RESTING_FRAMES } from "./gradient.ts";
import { sanitizeInline } from "./terminal.ts";

const INTRO_DURATION_MS = 3000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Validate truecolor foreground encoding.
const TRUECOLOR_ESCAPE_RE = /\x1b\[38;2;\d+;\d+;\d+m/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Validate indexed foreground encoding.
const INDEXED_ESCAPE_RE = /\x1b\[38;5;\d+m/;

describe("introFrame", () => {
  test.each([
    { mode: "truecolor" as const, encoding: TRUECOLOR_ESCAPE_RE },
    { mode: "256color" as const, encoding: INDEXED_ESCAPE_RE },
  ])(
    "should preserve logo geometry and change colors before settling when the terminal uses $mode",
    ({ mode, encoding }) => {
      const progress = { start: 0, moving: 0.25, ending: 1 };
      const start = introFrame(progress.start, mode);
      const moving = introFrame(progress.moving, mode);
      const resting = RESTING_FRAMES[mode];

      for (const frame of [start, moving, introFrame(progress.ending, mode)]) {
        expect(frame.map(sanitizeInline)).toEqual(resting.map(sanitizeInline));
        expect(frame.map((line) => Bun.stringWidth(line))).toEqual(
          resting.map((line) => Bun.stringWidth(line)),
        );
        for (const line of frame) {
          expect(line).toMatch(encoding);
          expect(line.trimEnd()).toEndWith("\x1b[0m");
        }
      }

      expect(moving).not.toEqual(start);
      expect<readonly string[]>(introFrame(progress.ending, mode)).toEqual(
        resting,
      );
    },
  );

  test.each([{ mode: "truecolor" as const }, { mode: "256color" as const }])(
    "should clamp late progress to the resting logo when the terminal uses $mode",
    ({ mode }) => {
      const lateProgress = { elapsed: 2 };
      expect<readonly string[]>(introFrame(lateProgress.elapsed, mode)).toEqual(
        RESTING_FRAMES[mode],
      );
    },
  );
});

describe("welcome intro lifecycle", () => {
  test("should terminate at three seconds and clear the only timer during disposal", () => {
    let now = 0;
    let timer: (() => void) | undefined;
    let cleared = 0;
    let renders = 0;
    const timerHandle: NodeJS.Timeout = Object.create(null);
    const animation = new IntroAnimation(
      () => {
        renders++;
      },
      {
        now: () => now,
        setInterval: (handler) => {
          timer = handler;
          return timerHandle;
        },
        clearInterval: () => {
          cleared++;
        },
      },
    );

    animation.start();
    expect(animation.isActive()).toBe(true);
    expect(renders).toBe(1);
    now = INTRO_DURATION_MS;
    timer?.();
    expect(animation.isActive()).toBe(false);
    expect(cleared).toBe(1);
    animation.dispose();
    expect(cleared).toBe(1);
  });
});

describe("IntroAnimation.start", () => {
  test("should reset progress and release replaced timers when an active intro restarts", () => {
    const timing = {
      backward: -100,
      midway: 1500,
      midpointProgress: 0.5,
      restart: 1800,
      overrun: 6000,
    };
    let now = 0;
    let tick: (() => void) | undefined;
    const timerHandle: NodeJS.Timeout = Object.create(null);
    const clearInterval = mock();
    const setInterval = mock((handler: () => void) => {
      tick = handler;
      return timerHandle;
    });
    const renderedProgress: (number | undefined)[] = [];
    const render = mock(() => {
      renderedProgress.push(animation.progress());
    });
    const animation = new IntroAnimation(render, {
      now: () => now,
      setInterval,
      clearInterval,
    });

    try {
      expect(animation.progress()).toBeUndefined();
      expect(animation.isActive()).toBe(false);
      animation.dispose();
      expect(clearInterval).not.toHaveBeenCalled();

      animation.start();
      expect(renderedProgress.at(-1)).toBe(0);
      now = timing.backward;
      expect(animation.progress()).toBe(0);

      now = timing.midway;
      tick?.();
      expect(renderedProgress.at(-1)).toBe(timing.midpointProgress);
      expect(animation.isActive()).toBe(true);
      expect(clearInterval).not.toHaveBeenCalled();

      now = timing.restart;
      animation.start();
      expect(clearInterval).toHaveBeenCalledTimes(1);
      expect(setInterval).toHaveBeenCalledTimes(2);
      expect(animation.progress()).toBe(0);

      now = timing.overrun;
      expect(animation.progress()).toBe(1);
      tick?.();
      expect(animation.isActive()).toBe(false);
      expect(renderedProgress.at(-1)).toBeUndefined();
      expect(clearInterval).toHaveBeenCalledTimes(2);
    } finally {
      animation.dispose();
    }
    expect(clearInterval).toHaveBeenCalledTimes(2);
  });
});
