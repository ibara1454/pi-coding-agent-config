import { describe, expect, test } from "bun:test";
import { sanitizeInline, truncateToWidth, visibleWidth } from "./terminal.ts";

const GRAPHEME_TRUNCATION_WIDTH = 6;
const GRAPHEME_SOURCE_WIDTH = 11;
const HYPERLINK_TRUNCATION_WIDTH = 4;
const SANITIZED_OUTPUT_WIDTH = 8;

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
});
