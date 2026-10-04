import { describe, expect, test } from "bun:test";
import { color, getSeparator, sessionAccentAnsi } from "./theme.ts";

const TRUECOLOR_PREFIX = "\x1b[38;2;";
const TRUECOLOR_CHANNELS = /^\d+;\d+;\d+m$/;
const RGB_CHANNEL_MAX = 255;

describe("getSeparator", () => {
  test("should override powerline separators and caps when ASCII is enabled", () => {
    expect(getSeparator("powerline", true)).toEqual({
      left: ">",
      right: "<",
      endCaps: { left: "", right: "" },
    });
  });

  test("should retain powerline separators and caps when ASCII is disabled", () => {
    expect(getSeparator("powerline", false)).toEqual({
      left: "▶",
      right: "◀",
      endCaps: { left: "◀", right: "▶" },
    });
  });
});

describe("sessionAccentAnsi", () => {
  test.each([
    ["empty", ""],
    ["plain ASCII", "session-name"],
    ["Unicode", "界é\u{1f680}"],
    ["terminal control-bearing", "\x1b[0m\r\n\x1b]8;;https://example.com\x07"],
  ])(
    "should return a stable safe truecolor foreground when the name is %s",
    (_label, name) => {
      const accent = sessionAccentAnsi(name);

      expect(sessionAccentAnsi(name)).toBe(accent);
      expect(accent).toStartWith(TRUECOLOR_PREFIX);
      expect(accent.slice(TRUECOLOR_PREFIX.length)).toMatch(TRUECOLOR_CHANNELS);
      for (const channel of accent
        .slice(TRUECOLOR_PREFIX.length, -1)
        .split(";")) {
        expect(Number(channel)).toBeGreaterThanOrEqual(0);
        expect(Number(channel)).toBeLessThanOrEqual(RGB_CHANNEL_MAX);
      }
    },
  );
});

describe("color", () => {
  test("should reset only the foreground when wrapping text in a color", () => {
    const foreground = "\x1b[38;2;10;20;30m";

    expect(color(foreground, "status")).toBe(`${foreground}status\x1b[39m`);
  });
});
