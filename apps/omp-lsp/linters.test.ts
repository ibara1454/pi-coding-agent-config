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
const unresolvedServer: ServerConfig = {
  name: "biome",
  command: "biome",
  args: [],
  root: "/project",
  fileTypes: [".ts"],
  rootMarkers: [],
};
const infoSeverity = 3;
const hintSeverity = 4;
const unexpectedExitCode = 9;
const errorDetailRepeats = 400;
const errorDetailLimit = 1500;
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
 * @param text - UTF-8 source bytes exposed by the handle.
 * @param options - Planned metadata or read failures for validating guarded file access.
 * @returns Close spy for verifying the adapter releases the handle.
 * @example mockSourceFile("abc") makes Biome offsets validate against three characters.
 */
function mockSourceFile(
  text: string,
  options: {
    regular?: boolean;
    size?: number;
    readError?: unknown;
    onRead?: () => void;
  } = {},
) {
  const content = Buffer.from(text);
  let position = 0;
  const close = mock(() => Promise.resolve());
  spyOn(filesystem, "open").mockResolvedValue({
    stat: () =>
      Promise.resolve({
        isFile: () => options.regular !== false,
        size: options.size ?? content.length,
      }),
    read: (buffer, offset, length) => {
      if (options.readError !== undefined) {
        return Promise.reject(options.readError);
      }
      options.onRead?.();
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

const swiftRuleId = "rule_id";
const swiftFinding = {
  reason: "Unused import",
  file: "main.swift",
  line: 1,
  character: 2,
  [swiftRuleId]: "unused_import",
  severity: "warning",
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

describe("lintWithCli", () => {
  test.each([
    [
      "the server is unsupported",
      { ...server, name: "custom" },
      "not a CLI linter",
    ],
    [
      "the server is disabled",
      { ...server, disabled: true },
      "unavailable or disabled",
    ],
    [
      "the executable is unresolved",
      unresolvedServer,
      "unavailable or disabled",
    ],
  ] as const)(
    "should reject before accessing source or spawning when %s",
    async (_condition, override, message) => {
      const open = spyOn(filesystem, "open");
      const run = spyOn(processes, "runCommand");
      await expect(lintWithCli(override, file)).rejects.toThrow(message);
      expect(open).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["the source is a directory", { regular: false }, "regular source file"],
    ["the source exceeds 8 MiB", { size: 8_388_609 }, "no larger than 8 MiB"],
    ["the source grows after stat", { size: 1 }, "changed while being read"],
    [
      "reading the source fails",
      { readError: new Error("read failure") },
      "read failure",
    ],
  ] as const)(
    "should close the source and avoid spawning when %s",
    async (_condition, options, message) => {
      const close = mockSourceFile("abc", options);
      const run = spyOn(processes, "runCommand");
      await expect(lintWithCli(server, file)).rejects.toThrow(message);
      expect(close).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
    },
  );

  test("should close the source and stop before spawning when cancellation occurs during reading", async () => {
    const controller = new AbortController();
    const close = mockSourceFile("abc", {
      onRead: () => controller.abort(new Error("cancelled read")),
    });
    const run = spyOn(processes, "runCommand");
    await expect(lintWithCli(server, file, controller.signal)).rejects.toThrow(
      "cancelled read",
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  test.each([
    ["the JSON root is an array", [], "did not return diagnostics array"],
    [
      "diagnostics is not an array",
      { diagnostics: {} },
      "did not return a diagnostics array",
    ],
    [
      "the diagnostic count exceeds the limit",
      { diagnostics: Array.from({ length: 1001 }, () => finding) },
      "more than 1000",
    ],
    [
      "a finding is not an object",
      { diagnostics: [null] },
      "without a message",
    ],
    [
      "the message is empty",
      { diagnostics: [{ ...finding, message: "" }] },
      "without a message",
    ],
    [
      "the location is missing",
      { diagnostics: [{ ...finding, location: null }] },
      "could not locate",
    ],
    [
      "the location path is empty",
      {
        diagnostics: [
          { ...finding, location: { ...finding.location, path: "" } },
        ],
      },
      "could not locate",
    ],
    [
      "the category is not a string",
      { diagnostics: [{ ...finding, category: 1 }] },
      "invalid diagnostic category",
    ],
    [
      "the start position is missing",
      {
        diagnostics: [
          { ...finding, location: { ...finding.location, start: null } },
        ],
      },
      "invalid start position",
    ],
    [
      "the start line is fractional",
      {
        diagnostics: [
          {
            ...finding,
            location: { ...finding.location, start: { line: 1.5, column: 1 } },
          },
        ],
      },
      "invalid start position",
    ],
    [
      "the end column is zero",
      {
        diagnostics: [
          {
            ...finding,
            location: { ...finding.location, end: { line: 1, column: 0 } },
          },
        ],
      },
      "invalid end position",
    ],
    [
      "the severity is unknown",
      { diagnostics: [{ ...finding, severity: "notice" }] },
      "unrecognized diagnostic severity",
    ],
  ] as const)(
    "should reject malformed Biome diagnostics when %s",
    async (_condition, report, message) => {
      mockSourceFile("abc");
      spyOn(processes, "runCommand").mockResolvedValue({
        stdout: JSON.stringify(report),
        stderr: "",
        exitCode: 0,
      });
      await expect(lintWithCli(server, file)).rejects.toThrow(message);
    },
  );

  test.each([
    ["fatal", 1],
    ["error", 1],
    ["INFO", infoSeverity],
    ["information", infoSeverity],
    ["hint", hintSeverity],
  ] as const)(
    "should map %s severity to its LSP value when Biome reports a file-level finding",
    async (severity, expected) => {
      mockSourceFile("");
      spyOn(processes, "runCommand").mockResolvedValue({
        stdout: JSON.stringify({
          diagnostics: [
            {
              message: "File-level finding",
              severity,
              location: { path: "main.ts", start: { line: 0, column: 0 } },
            },
          ],
        }),
        stderr: "",
        exitCode: 0,
      });
      expect(await lintWithCli(server, file)).toEqual([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          severity: expected,
          message: "File-level finding",
          source: "biome",
        },
      ]);
    },
  );

  test.each([
    ["the JSON root is an object", {}, "violations array"],
    [
      "the finding count exceeds the limit",
      Array.from({ length: 1001 }, () => swiftFinding),
      "more than 1000",
    ],
    ["a finding is not an object", [null], "invalid violation"],
    [
      "the reason is empty",
      [{ ...swiftFinding, reason: "" }],
      "invalid violation",
    ],
    [
      "the file path is empty",
      [{ ...swiftFinding, file: "" }],
      "invalid violation",
    ],
    [
      "the line is zero",
      [{ ...swiftFinding, line: 0 }],
      "invalid diagnostic line",
    ],
    [
      "the column is fractional",
      [{ ...swiftFinding, character: 1.5 }],
      "invalid diagnostic column",
    ],
    [
      "the rule identifier is not a string",
      [{ ...swiftFinding, [swiftRuleId]: 12 }],
      "invalid rule identifier",
    ],
    [
      "the severity is not a string",
      [{ ...swiftFinding, severity: 3 }],
      "unrecognized diagnostic severity",
    ],
  ] as const)(
    "should reject malformed SwiftLint diagnostics when %s",
    async (_condition, report, message) => {
      spyOn(processes, "runCommand").mockResolvedValue({
        stdout: JSON.stringify(report),
        stderr: "",
        exitCode: 0,
      });
      await expect(
        lintWithCli({ ...server, name: "swiftlint", args: [] }, "main.swift"),
      ).rejects.toThrow(message);
    },
  );

  test("should preserve explicit SwiftLint columns and avoid duplicate quiet flags when configured", async () => {
    const run = spyOn(processes, "runCommand").mockResolvedValue({
      stdout: JSON.stringify([
        { ...swiftFinding, line: 2, character: 4, severity: "Error" },
        {
          ...swiftFinding,
          reason: "Other file",
          file: "other.swift",
          [swiftRuleId]: "other",
        },
      ]),
      stderr: "",
      exitCode: 1,
    });
    const config = {
      ...server,
      name: "swiftlint",
      args: [
        "check",
        "--quiet",
        "--reporter=json",
        "--max-diagnostics",
        "3",
        "--config",
        "custom.yml",
      ],
      env: { mode: "test" },
    };
    const { signal } = new AbortController();
    expect(await lintWithCli(config, "main.swift", signal)).toEqual([
      {
        range: {
          start: { line: 1, character: 3 },
          end: { line: 1, character: 3 },
        },
        severity: 1,
        message: "Unused import",
        source: "swiftlint",
        code: "unused_import",
      },
    ]);
    expect(run).toHaveBeenCalledWith(
      "/installed/biome",
      [
        "lint",
        "--quiet",
        "--config",
        "custom.yml",
        "--reporter",
        "json",
        "/project/main.swift",
      ],
      { cwd: "/project", env: { mode: "test" }, signal, timeoutMs: 30_000 },
    );
  });

  test.each([-1, 2, unexpectedExitCode])(
    "should reject abnormal Biome exits even with usable diagnostics when exit code is %s",
    async (exitCode) => {
      mockSourceFile("abc");
      spyOn(processes, "runCommand").mockResolvedValue({
        stdout: JSON.stringify({ diagnostics: [finding] }),
        stderr: "failed",
        exitCode,
      });
      await expect(lintWithCli(server, file)).rejects.toThrow(
        `exited with code ${exitCode}`,
      );
    },
  );

  test("should surface bounded stderr and retain the parse cause when a command emits no JSON", async () => {
    mockSourceFile("abc");
    spyOn(processes, "runCommand").mockResolvedValue({
      stdout: "",
      stderr: " detail ".repeat(errorDetailRepeats),
      exitCode: 1,
    });
    const failure = await lintWithCli(server, file).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toBeInstanceOf(SyntaxError);
    expect((failure as Error).message).toEndWith(
      " detail ".repeat(errorDetailRepeats).trim().slice(0, errorDetailLimit),
    );
  });
});

describe("formatWithCli", () => {
  test("should return the unchanged snapshot without spawning when SwiftLint is selected", async () => {
    const run = spyOn(processes, "runCommand");
    expect(
      await formatWithCli(
        { ...server, name: "swiftlint" },
        "main.swift",
        "let x=1",
      ),
    ).toBe("let x=1");
    expect(run).not.toHaveBeenCalled();
  });

  test.each([
    [
      "the formatter is unsupported",
      { ...server, name: "custom" },
      "not a CLI formatter",
    ],
    [
      "the formatter is disabled",
      { ...server, disabled: true },
      "unavailable or disabled",
    ],
    [
      "the formatter has no executable",
      unresolvedServer,
      "unavailable or disabled",
    ],
  ] as const)(
    "should reject without spawning when %s",
    async (_condition, override, message) => {
      const run = spyOn(processes, "runCommand");
      await expect(formatWithCli(override, file, "abc")).rejects.toThrow(
        message,
      );
      expect(run).not.toHaveBeenCalled();
    },
  );

  test("should return stdout and forward a bounded stdin-only request when Biome formats successfully", async () => {
    const run = spyOn(processes, "runCommand").mockResolvedValue({
      stdout: "const x = 1;\n",
      stderr: "",
      exitCode: 0,
    });
    const { signal } = new AbortController();
    expect(
      await formatWithCli(
        {
          ...server,
          args: ["--config-path=custom.json"],
          env: { mode: "test" },
        },
        "main.ts",
        "const x=1",
        signal,
      ),
    ).toBe("const x = 1;\n");
    expect(run).toHaveBeenCalledWith(
      "/installed/biome",
      [
        "format",
        "--config-path=custom.json",
        "--stdin-file-path=/project/main.ts",
      ],
      {
        cwd: "/project",
        input: "const x=1",
        env: { mode: "test" },
        signal,
        timeoutMs: 30_000,
        maxOutputBytes: 16_777_216,
      },
    );
  });

  test("should allow empty stdout when the input contains only whitespace", async () => {
    spyOn(processes, "runCommand").mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    expect(await formatWithCli(server, file, " \n")).toBe("");
  });

  test("should reject before spawning when cancellation precedes formatting", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled format"));
    const run = spyOn(processes, "runCommand");
    await expect(
      formatWithCli(server, file, "abc", controller.signal),
    ).rejects.toThrow("cancelled format");
    expect(run).not.toHaveBeenCalled();
  });

  test("should reject successful output when cancellation occurs while the command is running", async () => {
    const controller = new AbortController();
    spyOn(processes, "runCommand").mockImplementation(() => {
      controller.abort(new Error("cancelled format"));
      return Promise.resolve({ stdout: "abc", stderr: "", exitCode: 0 });
    });
    await expect(
      formatWithCli(server, file, "abc", controller.signal),
    ).rejects.toThrow("cancelled format");
  });
});
