import { describe, expect, mock, spyOn, test } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: Spies intercept live filesystem imports.
import * as fs from "node:fs/promises";
import { formatWithCli, lintWithCli } from "./linters.ts";
// biome-ignore lint/performance/noNamespaceImport: Spies replace the external command boundary.
import * as processes from "./process.ts";
import type { ServerConfig } from "./types.ts";

const server: ServerConfig = {
  name: "biome",
  command: "biome",
  resolvedCommand: "/installed/biome",
  args: ["lsp-proxy", "--reporter", "summary", "--max-diagnostics=10"],
  root: "/project",
  fileTypes: [".ts"],
  rootMarkers: [],
};
const file = "/project/main.ts";
const filesystem: {
  open: (
    file: string,
    flags: string,
  ) => Promise<{
    stat: () => Promise<{ isFile: () => boolean; size: number }>;
    read: (
      buffer: Buffer,
      offset: number,
      length: number,
      position: null,
    ) => Promise<{ bytesRead: number }>;
    close: () => Promise<void>;
  }>;
} = fs;

/**
 * Supplies an in-memory source handle; the shared teardown restores the spy.
 * @returns Close spy for verifying the adapter releases the handle.
 * @example mockSourceFile("abc") makes Biome offsets validate against three characters.
 */
function mockSourceFile(text: string) {
  const content = Buffer.from(text);
  let position = 0;
  const close = mock(() => Promise.resolve());
  spyOn(filesystem, "open").mockResolvedValue({
    stat: () => Promise.resolve({ isFile: () => true, size: content.length }),
    read: (buffer, offset, length) => {
      const bytesRead = content.copy(
        buffer,
        offset,
        position,
        position + length,
      );
      position += bytesRead;
      return Promise.resolve({ bytesRead });
    },
    close,
  });
  return close;
}

const finding = {
  message: "Unexpected identifier",
  severity: "warning",
  category: "lint/suspicious/noExplicitAny",
  location: {
    path: "main.ts",
    start: { line: 1, column: 2 },
    end: { line: 1, column: 3 },
  },
};

describe("lintWithCli", () => {
  test("should convert Unicode positions and filter other files when Biome exits with violations", async () => {
    const close = mockSourceFile("\u{1f600}x\r\n");
    const run = spyOn(processes, "runCommand").mockResolvedValue({
      stdout: JSON.stringify({
        diagnostics: [
          finding,
          { ...finding, location: { ...finding.location, path: "other.ts" } },
        ],
      }),
      stderr: "",
      exitCode: 1,
    });

    expect(await lintWithCli(server, file)).toEqual([
      {
        range: {
          start: { line: 0, character: 2 },
          end: { line: 0, character: 3 },
        },
        severity: 2,
        message: finding.message,
        source: "biome",
        code: finding.category,
      },
    ]);
    expect(run.mock.calls[0]?.[1]).toEqual([
      "lint",
      "--reporter=json",
      "--max-diagnostics=1000",
      file,
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("should use zero-based ranges when SwiftLint omits the column", async () => {
    spyOn(processes, "runCommand").mockResolvedValue({
      stdout: JSON.stringify([
        {
          reason: "Unused import",
          file: "main.swift",
          line: 2,
          severity: "Warning",
          // biome-ignore lint/style/useNamingConvention: SwiftLint reporter field.
          rule_id: "unused_import",
        },
      ]),
      stderr: "",
      exitCode: 2,
    });
    expect(
      await lintWithCli(
        { ...server, name: "swiftlint", args: [] },
        "main.swift",
      ),
    ).toEqual([
      {
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 0 },
        },
        severity: 2,
        message: "Unused import",
        source: "swiftlint",
        code: "unused_import",
      },
    ]);
  });

  test.each([
    ["output is malformed", "not json", 0, "invalid or missing JSON"],
    [
      "a failed command reports no findings",
      '{"diagnostics":[]}',
      1,
      "not verified",
    ],
    [
      "the report is truncated",
      JSON.stringify({
        diagnostics: [],
        summary: { diagnosticsNotPrinted: 1 },
      }),
      0,
      "result is incomplete",
    ],
  ] as const)(
    "should reject an unverified result when %s",
    async (_condition, stdout, exitCode, message) => {
      mockSourceFile("abc");
      spyOn(processes, "runCommand").mockResolvedValue({
        stdout,
        stderr: "",
        exitCode,
      });
      await expect(lintWithCli(server, file)).rejects.toThrow(message);
    },
  );

  test.each([
    ["the end precedes the start", { line: 1, column: 1 }, "reversed"],
    [
      "the line is outside the source",
      { line: 2, column: 1 },
      "out-of-bounds end line",
    ],
    [
      "the column is outside the source",
      { line: 1, column: 5 },
      "out-of-bounds end column",
    ],
  ] as const)(
    "should reject invalid diagnostic ranges when %s",
    async (_condition, end, message) => {
      mockSourceFile("abc");
      spyOn(processes, "runCommand").mockResolvedValue({
        stdout: JSON.stringify({
          diagnostics: [{ ...finding, location: { ...finding.location, end } }],
        }),
        stderr: "",
        exitCode: 1,
      });
      await expect(lintWithCli(server, file)).rejects.toThrow(message);
    },
  );
});

describe("formatWithCli", () => {
  test.each(["--write", "--fix=true", "--unsafe"])(
    "should reject file-mutating configuration when %s is supplied",
    async (flag) => {
      const run = spyOn(processes, "runCommand").mockResolvedValue({
        stdout: "const x = 1;",
        stderr: "",
        exitCode: 0,
      });
      await expect(
        formatWithCli({ ...server, args: ["format", flag] }, file, "const x=1"),
      ).rejects.toThrow("mutating CLI flags");
      expect(run).not.toHaveBeenCalled();
    },
  );

  test.each([
    [
      "the formatter exits unsuccessfully",
      1,
      "const x = 1;",
      "formatting failed",
    ],
    ["the formatter discards nonempty input", 0, "\n", "empty output"],
  ] as const)(
    "should reject unsafe formatting results when %s",
    async (_condition, exitCode, stdout, message) => {
      spyOn(processes, "runCommand").mockResolvedValue({
        stdout,
        stderr: "",
        exitCode,
      });
      await expect(formatWithCli(server, file, "const x=1")).rejects.toThrow(
        message,
      );
    },
  );
});
