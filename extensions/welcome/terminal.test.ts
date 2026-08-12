import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "./terminal.ts";

describe("terminal-cell helpers", () => {
  test("truncates styled wide graphemes without splitting clusters", () => {
    const input = "\x1b[35m界e\u0301👩‍💻abcdef";
    const output = truncateToWidth(input, 6);

    expect(visibleWidth(input)).toBe(11);
    expect(visibleWidth(output)).toBe(6);
    expect(stripTerminalSequences(output)).toBe("界e\u0301👩‍💻…");
    expect(output.endsWith("\x1b[0m")).toBe(true);
  });

  test("closes an open OSC 8 hyperlink before its ellipsis", () => {
    const input = "\x1b]8;;https://example.test\x07abcdef";
    const output = truncateToWidth(input, 4);

    expect(visibleWidth(output)).toBe(4);
    expect(stripTerminalSequences(output)).toBe("abc…");
    expect(output).toBe("\x1b]8;;https://example.test\x07abc\x1b]8;;\x07…");
  });
});
