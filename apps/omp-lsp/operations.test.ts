import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import {
  type Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver-protocol";
import {
  diagnosticsText,
  diagnosticTargets,
  formattingOptions,
  hoverText,
  locations,
  normalizeDiagnostics,
  resolvePosition,
  symbols,
} from "./operations.ts";

const CLEAN_STATUS = /\bOK\b/;

const range = {
  start: { line: 1, character: 2 },
  end: { line: 1, character: 3 },
};
type DirectoryEntries = AsyncIterable<{
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}>;

const filesystem: {
  stat: (file: string) => Promise<{ isFile: () => boolean }>;
  opendir: (directory: string) => Promise<DirectoryEntries>;
} = fs;

/**
 * Supplies directory entries without touching the host filesystem.
 * @param entries - Names and types returned by an in-memory directory.
 * @returns An asynchronous iterable compatible with the filesystem boundary.
 * @example directoryEntries([{ name: "a.ts", kind: "file" }]) yields one file.
 */
function directoryEntries(
  entries: readonly { name: string; kind: "directory" | "file" | "link" }[],
) {
  const items = entries.map(({ name, kind }) => ({
    name,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "link",
  }));
  return {
    [Symbol.asyncIterator]: () => {
      const iterator = items.values();
      return { next: () => Promise.resolve(iterator.next()) };
    },
  };
}

/**
 * Installs in-memory EditorConfig reads; the test preload restores both spies after each test.
 * @param files - Read-only path-to-text fixtures; absent paths reject with ENOENT.
 * @returns Filesystem spies for injecting failures and checking search boundaries.
 * @example mockEditorConfigFiles({ "/project/.editorconfig": "[*]\nindent_size=4" }) supplies four-space indentation.
 */
function mockEditorConfigFiles(files: Readonly<Record<string, string>>) {
  const configFilesystem: {
    stat: (file: string) => Promise<{ size: number }>;
    readFile: (file: string, encoding: "utf8") => Promise<string>;
  } = fs;
  const missing = Object.assign(new Error("Missing configuration"), {
    code: "ENOENT",
  });
  const stat = spyOn(configFilesystem, "stat").mockImplementation((file) => {
    const content = files[file];
    return content === undefined
      ? Promise.reject(missing)
      : Promise.resolve({ size: Buffer.byteLength(content) });
  });
  const readFile = spyOn(configFilesystem, "readFile").mockImplementation(
    (file) => {
      const content = files[file];
      return content === undefined
        ? Promise.reject(missing)
        : Promise.resolve(content);
    },
  );
  return { stat, readFile };
}

describe("resolvePosition", () => {
  test("should select the requested whole-identifier occurrence using UTF-16 columns", () => {
    expect(resolvePosition("\u{1f600} foobar foo + foo", 1, "foo#2")).toEqual({
      line: 0,
      character: 16,
    });
  });

  test("should fall back to case-insensitive matches only when no exact match exists", () => {
    expect(resolvePosition("FOO foo", 1, "foo")).toEqual({
      line: 0,
      character: 4,
    });
    expect(resolvePosition("FOO FOO", 1, "foo#2")).toEqual({
      line: 0,
      character: 4,
    });
  });

  test("should reject nonexistent occurrences and invalid lines instead of querying unrelated positions", () => {
    expect(() => resolvePosition("foo", 1, "foo#2")).toThrow("out of bounds");
    expect(() => resolvePosition("foo", 0, "foo")).toThrow("1-based");
    expect(() => resolvePosition("foo", 2, "foo")).toThrow("outside");
  });

  test.each([
    {
      condition: "the requested line is indented after CRLF",
      content: "first\r\n  next",
      line: 2,
      character: 2,
    },
    {
      condition: "the requested line contains only whitespace",
      content: " \t ",
      line: 1,
      character: 0,
    },
  ])(
    "should select the first non-whitespace column when $condition",
    ({ content, line, character }) => {
      expect(resolvePosition(content, line)).toEqual({
        line: line - 1,
        character,
      });
    },
  );
});

describe("normalizeDiagnostics", () => {
  test("should merge equivalent server findings while retaining the most severe diagnostic", () => {
    const result = normalizeDiagnostics([
      { range, message: "Undefined variable", severity: 2, source: "lint" },
      { range, message: "Undefined variable", severity: 1, source: "semantic" },
    ]);
    expect(result).toEqual([
      { range, message: "Undefined variable", severity: 1, source: "semantic" },
    ]);
  });

  test("should order findings by severity and then source position when servers return unsorted results", () => {
    const diagnostics = [
      { range, message: "warning", severity: 2 },
      { range, message: "zeta" },
      {
        range: {
          start: { line: 0, character: 4 },
          end: { line: 0, character: 5 },
        },
        message: "earlier",
      },
      { range, message: "alpha", severity: 1 },
    ];
    expect(
      normalizeDiagnostics(diagnostics).map(({ message }) => message),
    ).toEqual(["earlier", "alpha", "zeta", "warning"]);
  });

  test.each([
    {
      condition: "the response is not an array",
      value: {},
      error: "expected an array",
    },
    {
      condition: "a finding is not an object",
      value: [null],
      error: "Invalid diagnostic response",
    },
    {
      condition: "the message is not text",
      value: [{ range, message: false }],
      error: "Invalid diagnostic message",
    },
    {
      condition: "the severity is outside the protocol values",
      value: [{ range, message: "bad", severity: 5 }],
      error: "Invalid diagnostic severity",
    },
    {
      condition: "a position is negative",
      value: [
        {
          range: { ...range, start: { line: -1, character: 0 } },
          message: "bad",
        },
      ],
      error: "Invalid LSP position",
    },
    {
      condition: "the range ends before it starts",
      value: [
        { range: { start: range.end, end: range.start }, message: "bad" },
      ],
      error: "Invalid reversed LSP range",
    },
  ])("should reject malformed findings when $condition", ({ value, error }) => {
    expect(() => normalizeDiagnostics(value)).toThrow(error);
  });
});

describe("diagnosticsText", () => {
  test("should label empty unversioned publications as unverified rather than clean", () => {
    const text = diagnosticsText("/project/a.ts", [], "/project", [
      "legacy-server",
    ]);
    expect(text).toContain("freshness-unverified");
    expect(text).toContain("legacy-server");
    expect(text).not.toMatch(CLEAN_STATUS);
  });

  test("should retain findings when their publication freshness cannot be verified", () => {
    const diagnostics = [
      {
        range: {
          start: { line: 1, character: 2 },
          end: { line: 1, character: 3 },
        },
        message: "Undefined variable",
        severity: 1 as const,
      },
    ];
    const text = diagnosticsText("/project/a.ts", diagnostics, "/project", [
      "legacy-server",
    ]);
    expect(text).toContain("Undefined variable");
    expect(text).toContain("a.ts:2:3");
    expect(text).toContain("freshness-unverified");
  });

  test("should count all findings but bound rendered details when the report exceeds its display limit", () => {
    const counts = {
      displayed: 200,
      total: 201,
      errors: 1,
    };
    const diagnostics: Diagnostic[] = Array.from(
      { length: counts.total },
      (_, index): Diagnostic => ({
        range,
        message: `finding-${index}`,
        ...(index === 0
          ? { source: "semantic" }
          : { severity: DiagnosticSeverity.Warning }),
      }),
    );
    const text = diagnosticsText("/project/a.ts", diagnostics, "/project", []);
    expect(text).toContain(
      `a.ts: ${counts.errors} error(s), ${counts.displayed} warning(s), ${counts.total} diagnostic(s)`,
    );
    expect(text).toContain("a.ts:2:3 [error] finding-0 (semantic)");
    expect(text).toContain(`finding-${counts.displayed - 1}`);
    expect(text).not.toContain(`finding-${counts.displayed}`);
    expect(text).toContain("1 diagnostics elided");
    expect(text).not.toContain("freshness-unverified");
  });
});

describe("symbols", () => {
  test("should leave workspace symbol positions unresolved when the server omits their ranges", () => {
    const result = symbols([
      { name: "Thing", kind: 5, location: { uri: "file:///project/a.ts" } },
    ]);
    expect(result[0]?.position).toBeUndefined();
  });

  test("should flatten children in document order using selection ranges when document symbols are nested", () => {
    const childRange = {
      start: { line: 2, character: 4 },
      end: { line: 2, character: 9 },
    };
    const result = symbols(
      [
        {
          name: "Outer",
          kind: 5,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 4, character: 0 },
          },
          selectionRange: range,
          children: [
            {
              name: "inner",
              kind: 6,
              range: childRange,
              containerName: "Outer",
            },
          ],
        },
      ],
      "/project/a.ts",
    );
    expect(result).toEqual([
      {
        name: "Outer",
        kind: 5,
        position: range.start,
        depth: 0,
        container: "",
        file: "/project/a.ts",
      },
      {
        name: "inner",
        kind: 6,
        position: childRange.start,
        depth: 1,
        container: "Outer",
        file: "/project/a.ts",
      },
    ]);
  });
});

describe("locations", () => {
  test("should decode file paths and deduplicate equivalent targets when locations and links are mixed", () => {
    const targetUri = "file:///project/a%20b.ts";
    const broadRange = {
      start: { line: 0, character: 0 },
      end: { line: 4, character: 0 },
    };
    expect(
      locations([
        { uri: targetUri, range },
        { targetUri, targetSelectionRange: range, targetRange: broadRange },
        { targetUri: "file:///project/other.ts", targetRange: broadRange },
      ]),
    ).toEqual([
      { file: "/project/a b.ts", range },
      { file: "/project/other.ts", range: broadRange },
    ]);
    expect(locations({ uri: targetUri, range })).toEqual([
      { file: "/project/a b.ts", range },
    ]);
  });

  test("should return no navigation targets when the server returns null", () => {
    expect(locations(null)).toEqual([]);
  });

  test.each([
    {
      condition: "the URI is missing",
      value: { range },
      error: "Invalid location URI",
    },
    {
      condition: "the URI names a non-file document",
      value: { uri: "https://example.com/a.ts", range },
      error: "Unsupported document URI",
    },
    {
      condition: "the range has a fractional coordinate",
      value: {
        uri: "file:///project/a.ts",
        range: { ...range, end: { line: 1, character: 2.5 } },
      },
      error: "Invalid LSP position",
    },
  ])(
    "should reject unsafe navigation targets when $condition",
    ({ value, error }) => {
      expect(() => locations(value)).toThrow(error);
    },
  );
});

describe("hoverText", () => {
  test("should separate prose and fence language snippets when the hover combines marked strings and markup", () => {
    expect(
      hoverText({
        contents: [
          "Summary",
          { language: "typescript", value: "const answer: number" },
          { kind: "markdown", value: "**Details**" },
        ],
      }),
    ).toBe(
      "Summary\n\n```typescript\nconst answer: number\n```\n\n**Details**",
    );
  });

  test("should render no hover text when the server returns no value", () => {
    expect(hoverText(undefined)).toBe("");
  });

  test("should reject malformed markup when its value is not text", () => {
    expect(() =>
      hoverText({ contents: { kind: "markdown", value: false } }),
    ).toThrow("Invalid hover contents");
  });
});

describe("diagnosticTargets", () => {
  test.each([
    {
      condition: "the literal exists with a glob character in its name",
      pattern: "a[1].ts",
      exists: true,
    },
    {
      condition: "the literal does not exist",
      pattern: "missing.ts",
      exists: false,
    },
  ])(
    "should preserve a literal target when $condition",
    async ({ pattern, exists }) => {
      spyOn(filesystem, "stat").mockImplementation(() =>
        exists
          ? Promise.resolve({ isFile: () => true })
          : Promise.reject(
              Object.assign(new Error("Missing"), { code: "ENOENT" }),
            ),
      );
      const open = spyOn(filesystem, "opendir").mockResolvedValue(
        directoryEntries([]),
      );
      expect(await diagnosticTargets(pattern, "/project")).toEqual({
        files: [`/project/${pattern}`],
        truncated: false,
      });
      expect(open).not.toHaveBeenCalled();
    },
  );

  test("should sort matching files and skip ignored trees when a glob traverses nested directories", async () => {
    spyOn(filesystem, "stat").mockRejectedValue(
      Object.assign(new Error("Missing"), { code: "ENOENT" }),
    );
    const directories: Record<string, DirectoryEntries> = {
      "/project": directoryEntries([
        { name: "z.ts", kind: "file" },
        { name: "src", kind: "directory" },
        { name: ".git", kind: "directory" },
        { name: "node_modules", kind: "directory" },
        { name: "linked-tree", kind: "link" },
      ]),
      "/project/src": directoryEntries([
        { name: ".hidden.ts", kind: "file" },
        { name: "a.ts", kind: "file" },
        { name: "linked.ts", kind: "link" },
        { name: "readme.md", kind: "file" },
      ]),
    };
    const open = spyOn(filesystem, "opendir").mockImplementation(
      (directory) => {
        const entries = directories[directory];
        return entries
          ? Promise.resolve(entries)
          : Promise.reject(new Error(`Unexpected traversal: ${directory}`));
      },
    );
    expect(await diagnosticTargets("**/*.ts", "/project")).toEqual({
      files: [
        "/project/src/.hidden.ts",
        "/project/src/a.ts",
        "/project/src/linked.ts",
        "/project/z.ts",
      ],
      truncated: false,
    });
    expect(open.mock.calls.map(([directory]) => directory)).toEqual([
      "/project",
      "/project/src",
    ]);
  });

  test("should mark the result incomplete when more than twenty files match", async () => {
    const limits = { retained: 20, matching: 21, digits: 2 };
    spyOn(filesystem, "stat").mockResolvedValue({ isFile: () => false });
    spyOn(filesystem, "opendir")
      .mockRejectedValue(new Error("Unexpected traversal"))
      .mockResolvedValueOnce(
        directoryEntries([{ name: "src", kind: "directory" }]),
      )
      .mockResolvedValueOnce(
        directoryEntries(
          Array.from({ length: limits.matching }, (_, index) => ({
            name: `file-${index.toString().padStart(limits.digits, "0")}.ts`,
            kind: "file" as const,
          })),
        ),
      );
    const result = await diagnosticTargets("**/*.ts", "/project");
    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(limits.retained);
    expect(result.files.at(0)).toBe("/project/src/file-00.ts");
    expect(result.files.at(-1)).toBe("/project/src/file-19.ts");
    expect(result.files).not.toContain("/project/src/file-20.ts");
  });

  test("should return no matches when the glob root is missing", async () => {
    spyOn(filesystem, "stat").mockResolvedValue({ isFile: () => false });
    spyOn(filesystem, "opendir").mockRejectedValue(
      Object.assign(new Error("Directory unavailable"), { code: "ENOENT" }),
    );
    expect(await diagnosticTargets("*.ts", "/project")).toEqual({
      files: [],
      truncated: false,
    });
  });

  test("should preserve traversal errors when the glob root cannot be read", async () => {
    const error = Object.assign(new Error("Directory unavailable"), {
      code: "EACCES",
    });
    spyOn(filesystem, "stat").mockResolvedValue({ isFile: () => false });
    spyOn(filesystem, "opendir").mockRejectedValue(error);
    await expect(diagnosticTargets("*.ts", "/project")).rejects.toBe(error);
  });

  test("should preserve filesystem errors when probing a target fails without ENOENT", async () => {
    const error = new Error("Storage unavailable");
    spyOn(filesystem, "stat").mockRejectedValue(error);
    const open = spyOn(filesystem, "opendir").mockResolvedValue(
      directoryEntries([]),
    );
    await expect(diagnosticTargets("*.ts", "/project")).rejects.toBe(error);
    expect(open).not.toHaveBeenCalled();
  });

  test("should stop before opening a directory when glob traversal is already cancelled", async () => {
    const reason = new Error("Cancelled");
    spyOn(filesystem, "stat").mockResolvedValue({ isFile: () => false });
    const open = spyOn(filesystem, "opendir").mockResolvedValue(
      directoryEntries([]),
    );
    await expect(
      diagnosticTargets("*.ts", "/project", AbortSignal.abort(reason)),
    ).rejects.toBe(reason);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("formattingOptions", () => {
  test.each([
    {
      condition: "space-indented lines have different nesting depths",
      content: "top\n\n  one\n      three\n    two\n  \n",
      expected: { tabSize: 2, insertSpaces: true },
    },
    {
      condition: "tab-indented lines precede space-indented lines",
      content: "\tfirst\n    second\n",
      expected: { tabSize: 4, insertSpaces: false },
    },
  ])(
    "should infer indentation from the document when $condition",
    async ({ content, expected }) => {
      mockEditorConfigFiles({});
      expect(
        await formattingOptions("/project/main.ts", content, "/project"),
      ).toMatchObject(expected);
    },
  );

  test("should apply nearer files and later matching sections over inherited indentation", async () => {
    mockEditorConfigFiles({
      "/project/.editorconfig": "[*]\nindent_style=tab\nindent_size=8",
      "/project/src/.editorconfig": [
        "# child settings",
        "; another comment",
        "",
        "indent_size=99",
        "[*]",
        "Indent_Style = SPACE",
        "indent_size=6",
        "malformed setting",
        "[*.ts]",
        "INDENT_SIZE = 4",
        "[*.md]",
        "indent_size=9",
      ].join("\r\n"),
    });
    expect(
      await formattingOptions("/project/src/main.ts", "\tvalue\n", "/project"),
    ).toMatchObject({ tabSize: 4, insertSpaces: true });
  });

  test.each([
    {
      condition: "the nearest config declares root=true",
      preamble: "root = true\n",
      cwd: "/project",
    },
    {
      condition: "the nearest config is at the workspace boundary",
      preamble: "",
      cwd: "/project/src",
    },
  ])(
    "should ignore settings above the search boundary when $condition",
    async ({ preamble, cwd }) => {
      const { stat } = mockEditorConfigFiles({
        "/project/.editorconfig": "[*]\nindent_style=tab\nindent_size=8",
        "/project/src/.editorconfig": `${preamble}[*]\nindent_size=4`,
      });
      expect(
        await formattingOptions("/project/src/main.ts", "  value\n", cwd),
      ).toMatchObject({ tabSize: 4, insertSpaces: true });
      expect(stat).not.toHaveBeenCalledWith("/project/.editorconfig");
    },
  );

  test("should infer indentation again when a child unsets inherited width and style", async () => {
    mockEditorConfigFiles({
      "/project/.editorconfig": "[*]\nindent_style=tab\nindent_size=8",
      "/project/src/.editorconfig":
        "[*.ts]\nindent_size=unset\nindent_style=unset",
    });
    expect(
      await formattingOptions("/project/src/main.ts", "   value\n", "/project"),
    ).toMatchObject({ tabSize: 3, insertSpaces: true });
  });

  test.each([
    {
      condition: "a basename pattern matches a file in a subdirectory",
      pattern: "*.ts",
      tabSize: 4,
    },
    {
      condition: "a rooted pattern matches the relative path",
      pattern: "/src/*.ts",
      tabSize: 4,
    },
    {
      condition: "a section targets a different file type",
      pattern: "*.md",
      tabSize: 8,
    },
  ])(
    "should apply only matching section settings when $condition",
    async ({ pattern, tabSize }) => {
      mockEditorConfigFiles({
        "/project/.editorconfig": `[*]\nindent_size=8\n[${pattern}]\nindent_size=4`,
      });
      expect(
        await formattingOptions(
          "/project/src/main.ts",
          "  value\n",
          "/project",
        ),
      ).toMatchObject({ tabSize, insertSpaces: true });
    },
  );

  test.each([
    {
      condition: "indent_size=tab selects the configured tab width",
      settings: "indent_style=tab\nindent_size=tab\ntab_width=6",
      expected: { tabSize: 6, insertSpaces: false },
    },
    {
      condition: "tab_width is set without indent_size",
      settings: "indent_style=space\ntab_width=3",
      expected: { tabSize: 3, insertSpaces: true },
    },
    {
      condition: "a numeric indent_size overrides tab_width",
      settings: "indent_size=4\ntab_width=8",
      expected: { tabSize: 4, insertSpaces: true },
    },
  ])(
    "should choose the effective indentation width when $condition",
    async ({ settings, expected }) => {
      mockEditorConfigFiles({ "/project/.editorconfig": `[*]\n${settings}` });
      expect(
        await formattingOptions("/project/main.ts", "  value\n", "/project"),
      ).toMatchObject(expected);
    },
  );

  test.each(["0", "2.5", "invalid", "9007199254740992"])(
    "should retain inferred indentation when the configured width is %s",
    async (width) => {
      mockEditorConfigFiles({
        "/project/.editorconfig": `[*]\nindent_size=${width}`,
      });
      expect(
        await formattingOptions("/project/main.ts", "   value\n", "/project"),
      ).toMatchObject({ tabSize: 3, insertSpaces: true });
    },
  );

  test.each(["stat", "readFile"] as const)(
    "should preserve filesystem errors when %s cannot access a config",
    async (operation) => {
      const filesystemSpies = mockEditorConfigFiles({
        "/project/.editorconfig": "[*]\nindent_size=4",
      });
      const error = Object.assign(new Error("Permission denied"), {
        code: "EACCES",
      });
      filesystemSpies[operation].mockRejectedValue(error);
      await expect(
        formattingOptions("/project/main.ts", "  value\n", "/project"),
      ).rejects.toBe(error);
    },
  );

  test("should retain ancestor settings when a child config disappears before reading", async () => {
    const { readFile } = mockEditorConfigFiles({
      "/project/.editorconfig": "[*]\nindent_size=4",
      "/project/src/.editorconfig": "[*]\nindent_size=8",
    });
    readFile.mockRejectedValueOnce(
      Object.assign(new Error("Config disappeared"), { code: "ENOENT" }),
    );
    expect(
      await formattingOptions("/project/src/main.ts", "  value\n", "/project"),
    ).toMatchObject({ tabSize: 4, insertSpaces: true });
  });

  test("should accept a config exactly at the one-MiB size limit", async () => {
    const limits = { bytes: 1_048_576 };
    const { stat } = mockEditorConfigFiles({
      "/project/.editorconfig": "[*]\nindent_size=4",
    });
    stat.mockResolvedValue({ size: limits.bytes });
    expect(
      await formattingOptions("/project/main.ts", "  value\n", "/project"),
    ).toMatchObject({ tabSize: 4, insertSpaces: true });
  });

  test("should reject an oversized config before reading its contents", async () => {
    const limits = { bytes: 1_048_576 };
    const { stat, readFile } = mockEditorConfigFiles({
      "/project/.editorconfig": "[*]\nindent_size=4",
    });
    stat.mockResolvedValue({ size: limits.bytes + 1 });
    await expect(
      formattingOptions("/project/main.ts", "  value\n", "/project"),
    ).rejects.toThrow("EditorConfig exceeds 1 MiB");
    expect(readFile).not.toHaveBeenCalled();
  });
});
