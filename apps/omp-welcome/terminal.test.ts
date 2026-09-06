import { describe, expect, test } from "bun:test";
import { sanitizeInline, truncateToWidth, visibleWidth } from "./terminal.ts";

describe("terminal-cell helpers", () => {
  test("should truncate styled wide graphemes without splitting clusters", () => {
    const input = "\x1b[35m界e\u0301👩‍💻abcdef";
    const output = truncateToWidth(input, 6);

    expect(visibleWidth(input)).toBe(11);
    expect(visibleWidth(output)).toBe(6);
    expect(sanitizeInline(output)).toBe("界e\u0301👩‍💻…");
    expect(output.endsWith("\x1b[0m")).toBe(true);
  });

  test("should close an open OSC 8 hyperlink before its ellipsis", () => {
    const input = "\x1b]8;;https://example.test\x07abcdef";
    const output = truncateToWidth(input, 4);

    expect(visibleWidth(output)).toBe(4);
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
    expect(visibleWidth(output)).toBe(8);
  });
});
