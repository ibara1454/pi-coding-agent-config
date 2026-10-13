import { describe, expect, test } from "bun:test";
import { sanitizeInline, truncateToWidth, visibleWidth } from "./terminal.ts";

const GRAPHEME_TRUNCATION_WIDTH = 6;
const GRAPHEME_SOURCE_WIDTH = 11;
const HYPERLINK_TRUNCATION_WIDTH = 4;
const SANITIZED_OUTPUT_WIDTH = 8;
const TAB_SEPARATED_TEXT_WIDTH = 5;

describe("terminal-cell helpers", () => {
  test("should truncate styled wide graphemes without splitting clusters", () => {
    const input = "\x1b[35m界e\u0301👩‍💻abcdef";
    const output = truncateToWidth(input, GRAPHEME_TRUNCATION_WIDTH);

    expect(visibleWidth(input)).toBe(GRAPHEME_SOURCE_WIDTH);
    expect(visibleWidth(output)).toBe(GRAPHEME_TRUNCATION_WIDTH);
    expect(sanitizeInline(output)).toBe("界e\u0301👩‍💻…");
    expect(output.endsWith("\x1b[0m")).toBe(true);
  });

  test("should close an open OSC 8 hyperlink before its ellipsis", () => {
    const input = "\x1b]8;;https://example.test\x07abcdef";
    const output = truncateToWidth(input, HYPERLINK_TRUNCATION_WIDTH);

    expect(visibleWidth(output)).toBe(HYPERLINK_TRUNCATION_WIDTH);
    expect(sanitizeInline(output)).toBe("abc…");
    expect(output).toBe("\x1b]8;;https://example.test\x07abc\x1b]8;;\x07…");
  });
});

describe("sanitizeInline", () => {
  test("should remove terminal sequences and bidi controls at display boundaries", () => {
    const output = sanitizeInline(
      "\x1b]8;;https://example.test\x07界e\u0301\x1b]8;;\x07\n\u202Enext\u0007",
    );

    expect(output).toBe("界e\u0301 next");
    expect(visibleWidth(output)).toBe(SANITIZED_OUTPUT_WIDTH);
  });

  test.each([
    ["an unterminated CSI", "before\x1b[31", "before"],
    ["an ST-terminated OSC", "before\x1b]0;title\x1b\\after", "beforeafter"],
    ["an ST-terminated DCS", "before\x1bPpayload\x1b\\after", "beforeafter"],
    ["an unterminated APC", "before\x1b_payload", "before"],
    ["a two-byte escape", "before\x1b7after", "beforeafter"],
    ["a trailing escape", "before\x1b", "before"],
  ])(
    "should preserve only printable text when input contains %s",
    (_condition, input, expected) => {
      expect(sanitizeInline(input)).toBe(expected);
    },
  );
});

describe("visibleWidth", () => {
  test.each([
    ["a tab", "a\tb", TAB_SEPARATED_TEXT_WIDTH],
    ["a standalone combining mark", "\u0301a", 1],
    ["an invisible format character", "a\u200bb", 2],
  ])(
    "should count terminal cells when text includes %s",
    (_condition, input, expected) => {
      expect(visibleWidth(input)).toBe(expected);
    },
  );
});

describe("truncateToWidth", () => {
  test.each([0, -1])(
    "should return no terminal output when the cell budget is %s",
    (width) => {
      expect(truncateToWidth("\x1b[31mabcdef\x1b[0m", width)).toBe("");
    },
  );

  test("should close an ST-terminated hyperlink when its text exceeds the cell budget", () => {
    const output = truncateToWidth(
      "\x1b]8;;https://example.test\x1b\\abcdef",
      HYPERLINK_TRUNCATION_WIDTH,
    );

    expect(output).toBe("\x1b]8;;https://example.test\x1b\\abc\x1b]8;;\x1b\\…");
    expect(sanitizeInline(output)).toBe("abc…");
    expect(visibleWidth(output)).toBe(HYPERLINK_TRUNCATION_WIDTH);
  });

  test("should preserve a completed hyperlink without reopening it when later text is clipped", () => {
    const link = "\x1b]8;;https://example.test\x07ab\x1b]8;;\x07";
    const output = truncateToWidth(`${link}cdef`, HYPERLINK_TRUNCATION_WIDTH);

    expect(output).toBe(`${link}c…`);
    expect(sanitizeInline(output)).toBe("abc…");
    expect(visibleWidth(output)).toBe(HYPERLINK_TRUNCATION_WIDTH);
  });
});
