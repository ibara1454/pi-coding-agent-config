import { describe, expect, test } from "bun:test";
import { IntroAnimation, RESTING_FRAMES } from "./gradient.ts";
import { sanitizeInline } from "./terminal.ts";

describe("Pi logo gradient", () => {
  const logo = [
    "▀██████████▀",
    " ╘██    ██  ",
    "  ██    ██  ",
    "  ██    ██  ",
    " ▄██▄  ▄██▄ ",
  ];
  const colorCodes = (frame: readonly string[]) => [
    ...new Set(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Match ANSI SGR color escapes.
      frame.join("").match(/\x1b\[38;(?:2;\d+;\d+;\d+|5;\d+)m/g) ?? [],
    ),
  ];

  test("uses the exact five-row block logo and truecolor palette", () => {
    expect(RESTING_FRAMES.truecolor.map(sanitizeInline)).toEqual(logo);
    expect(colorCodes(RESTING_FRAMES.truecolor)).toEqual([
      "\x1b[38;2;200;110;255m",
      "\x1b[38;2;180;115;255m",
      "\x1b[38;2;160;120;255m",
      "\x1b[38;2;140;125;255m",
      "\x1b[38;2;120;130;255m",
      "\x1b[38;2;105;148;255m",
      "\x1b[38;2;90;165;255m",
      "\x1b[38;2;75;183;255m",
      "\x1b[38;2;60;200;255m",
      "\x1b[38;2;75;214;246m",
      "\x1b[38;2;90;228;238m",
      "\x1b[38;2;105;241;229m",
      "\x1b[38;2;214;106;241m",
      "\x1b[38;2;241;97;214m",
      "\x1b[38;2;228;101;228m",
    ]);
  });

  test("uses the exact OMP 256-color ramp", () => {
    expect(RESTING_FRAMES["256color"].map(sanitizeInline)).toEqual(logo);
    expect(colorCodes(RESTING_FRAMES["256color"])).toEqual([
      "\x1b[38;5;135m",
      "\x1b[38;5;99m",
      "\x1b[38;5;75m",
      "\x1b[38;5;51m",
      "\x1b[38;5;87m",
      "\x1b[38;5;171m",
      "\x1b[38;5;199m",
    ]);
  });
});

describe("welcome intro lifecycle", () => {
  test("terminates at three seconds and disposal clears the only timer", () => {
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
    now = 3_000;
    timer?.();
    expect(animation.isActive()).toBe(false);
    expect(cleared).toBe(1);
    animation.dispose();
    expect(cleared).toBe(1);
  });
});
