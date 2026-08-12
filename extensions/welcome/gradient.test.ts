import { describe, expect, test } from "bun:test";
import { gradientEscape, gradientLogo, IntroAnimation, INTRO_MS, PI_LOGO } from "./gradient.ts";

describe("Pi logo gradient", () => {
  test("uses the exact five-row block logo and truecolor palette endpoints", () => {
    expect(PI_LOGO).toEqual(["▀██████████▀", " ╘██    ██  ", "  ██    ██  ", "  ██    ██  ", " ▄██▄  ▄██▄ "]);
    expect(gradientEscape(0, "truecolor")).toBe("\x1b[38;2;255;92;200m");
    expect(gradientEscape(1, "truecolor")).toBe("\x1b[38;2;120;255;220m");
    expect(gradientLogo(PI_LOGO, "truecolor")).toHaveLength(5);
  });

  test("falls back to the OMP 256-color ramp", () => {
    expect(gradientEscape(0, "256color")).toBe("\x1b[38;5;199m");
    expect(gradientEscape(0.5, "256color")).toBe("\x1b[38;5;99m");
    expect(gradientLogo(PI_LOGO, "256color")[0]).toContain("\x1b[38;5;");
  });
});

describe("welcome intro lifecycle", () => {
  test("terminates at three seconds and disposal clears the only timer", () => {
    let now = 0;
    let timer: (() => void) | undefined;
    let cleared = 0;
    let renders = 0;
    const animation = new IntroAnimation(() => { renders++; }, {
      now: () => now,
      setInterval: handler => {
        timer = handler;
        return 1 as unknown as NodeJS.Timeout;
      },
      clearInterval: () => { cleared++; },
    });

    animation.start();
    expect(animation.isActive()).toBe(true);
    expect(renders).toBe(1);
    now = INTRO_MS;
    timer?.();
    expect(animation.isActive()).toBe(false);
    expect(cleared).toBe(1);
    animation.dispose();
    expect(cleared).toBe(1);
  });
});
