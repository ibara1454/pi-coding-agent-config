import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace; copied named imports cannot intercept consumers.
import * as host from "@earendil-works/pi-coding-agent";

import type { TextEdit, WorkspaceEdit } from "vscode-languageserver-protocol";
import {
  applyTextEdits,
  applyWorkspaceEdit,
  directoryFiles,
  fileToUri,
} from "./edits.ts";

const ORIGINAL_TEXT_LENGTH = "old".length;

const filesystem: {
  opendir: (directory: string) => Promise<
    AsyncIterable<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
      isSymbolicLink: () => boolean;
    }>
  >;
} = fs;

/**
 * Replaces filesystem and host-lock effects with test-owned entries for workspace mutations.
 * @param initial - Regular files and contents to seed; directories and links can be added to the result.
 * @returns Mutable fixture state and controls for queued host changes or mutation failures.
 * Missing paths reject with ENOENT; configured write/rename failures leave their source unchanged.
 * Spies are restored after each test, so no fixture operation touches the real filesystem.
 * @example memoryFiles({ "/project/a.ts": "old" }).changeWhileQueued("/project/a.ts", "host")
 * makes a queued workspace edit reject without overwriting "host".
 */
function memoryFiles(initial: Record<string, string>) {
  const files = new Map(
    Object.entries(initial).map(([file, content]) => [
      file,
      { content, revision: 1 },
    ]),
  );
  const writes: string[] = [];
  const directories = new Set(["/", "/project"]);
  const links = new Map<string, string>();
  let temporaryDirectoryCount = 0;
  let beforeLock: (() => void) | undefined;
  let failingWrite: string | undefined;
  let failRename = false;
  spyOn(fs, "lstat").mockImplementation(((value: unknown) => {
    const file = String(value);
    const content = files.get(file);
    if (!(content || directories.has(file) || links.has(file))) {
      return Promise.reject(
        Object.assign(new Error(`Missing ${file}`), { code: "ENOENT" }),
      );
    }
    return Promise.resolve({
      dev: 1,
      ino: file.length,
      size: content?.content.length ?? 0,
      mtimeMs: content?.revision ?? 0,
      ctimeMs: content?.revision ?? 0,
      isSymbolicLink: () => links.has(file),
      isDirectory: () => directories.has(file),
      isFile: () => files.has(file),
    } as Stats);
  }) as typeof fs.lstat);
  spyOn(fs, "realpath").mockImplementation(((value: unknown) => {
    const file = String(value);
    if (!(files.has(file) || directories.has(file) || links.has(file))) {
      return Promise.reject(
        Object.assign(new Error(`Missing ${file}`), { code: "ENOENT" }),
      );
    }
    return Promise.resolve(links.get(file) ?? file);
  }) as typeof fs.realpath);
  spyOn(fs, "readlink").mockImplementation(((value: unknown) =>
    Promise.resolve(links.get(String(value)) ?? "")) as typeof fs.readlink);
  spyOn(filesystem, "opendir").mockImplementation((directory) => {
    const children = [...files.keys(), ...directories, ...links.keys()]
      .filter((file) => file !== directory && path.dirname(file) === directory)
      .map((file) => ({
        name: path.basename(file),
        isDirectory: () => directories.has(file),
        isFile: () => files.has(file),
        isSymbolicLink: () => links.has(file),
      }));
    return Promise.resolve({
      [Symbol.asyncIterator]: () => {
        const iterator = children.values();
        return { next: () => Promise.resolve(iterator.next()) };
      },
    });
  });
  spyOn(fs, "readFile").mockImplementation(((file: unknown) => {
    const value = files.get(String(file));
    if (!value) {
      return Promise.reject(
        Object.assign(new Error(`Missing ${String(file)}`), {
          code: "ENOENT",
        }),
      );
    }
    return Promise.resolve(value.content);
  }) as typeof fs.readFile);
  spyOn(fs, "writeFile").mockImplementation((file, content) => {
    const name = String(file);
    if (name === failingWrite) {
      return Promise.reject(new Error("Disk write failed"));
    }
    writes.push(name);
    files.set(name, {
      content: String(content),
      revision: (files.get(name)?.revision ?? 0) + 1,
    });
    return Promise.resolve();
  });
  spyOn(fs, "mkdir").mockImplementation(((file: unknown) => {
    directories.add(String(file));
    return Promise.resolve();
  }) as typeof fs.mkdir);
  spyOn(fs, "mkdtemp").mockImplementation(((prefix: unknown) => {
    const directory = `${String(prefix)}${++temporaryDirectoryCount}`;
    directories.add(directory);
    return Promise.resolve(directory);
  }) as typeof fs.mkdtemp);
  spyOn(fs, "rmdir").mockImplementation((file) => {
    directories.delete(String(file));
    return Promise.resolve();
  });
  spyOn(fs, "rename").mockImplementation((source, destination) => {
    if (failRename) {
      return Promise.reject(new Error("Cross-device rename failed"));
    }
    const file = files.get(String(source));
    if (!file) {
      return Promise.reject(new Error("Missing rename source"));
    }
    files.set(String(destination), file);
    files.delete(String(source));
    return Promise.resolve();
  });
  spyOn(fs, "rm").mockImplementation((file, options) => {
    const name = String(file);
    for (const candidate of [
      ...files.keys(),
      ...directories,
      ...links.keys(),
    ]) {
      if (
        candidate === name ||
        (options?.recursive && candidate.startsWith(`${name}/`))
      ) {
        files.delete(candidate);
        directories.delete(candidate);
        links.delete(candidate);
      }
    }
    return Promise.resolve();
  });
  spyOn(host, "withFileMutationQueue").mockImplementation(
    async (_file, work) => {
      const run = beforeLock;
      beforeLock = undefined;
      run?.();
      return await work();
    },
  );
  return {
    files,
    writes,
    directories,
    links,
    changeWhileQueued: (file: string, content: string) => {
      beforeLock = () => files.set(file, { content, revision: 2 });
    },
    failWrite: (file: string) => {
      failingWrite = file;
    },
    failMove: () => {
      failRename = true;
    },
  };
}

/**
 * Builds a first-line UTF-16 replacement for snapshot-relative text-edit tests.
 * @param start - Inclusive UTF-16 offset; end is exclusive.
 * @returns An LSP edit without mutating fixture contents.
 * @example replacement(0, 3, "new") replaces "old" with "new".
 */
function replacement(start: number, end: number, newText: string): TextEdit {
  return {
    range: {
      start: { line: 0, character: start },
      end: { line: 0, character: end },
    },
    newText,
  };
}

afterEach(() => {
  mock.restore();
});

describe("applyTextEdits", () => {
  test("should preserve CRLF and replace complete UTF-16 characters", () => {
    const emojiEndOffset = 3;
    expect(
      applyTextEdits("a\u{1f600}b\r\nnext", [
        replacement(1, emojiEndOffset, "x"),
      ]),
    ).toBe("axb\r\nnext");
    expect(() =>
      applyTextEdits("a\u{1f600}b", [replacement(2, emojiEndOffset, "x")]),
    ).toThrow("surrogate");
  });

  test("should preserve declared insertion order when multiple edits share one position", () => {
    expect(
      applyTextEdits("ab", [
        replacement(1, 1, "1"),
        replacement(1, 1, "2"),
        replacement(1, 2, "c"),
      ]),
    ).toBe("a12c");
  });

  test("should reject overlapping replacements instead of overwriting either result", () => {
    const firstRangeEndOffset = 3;
    const secondRangeEndOffset = 4;
    expect(() =>
      applyTextEdits("abcd", [
        replacement(0, firstRangeEndOffset, "x"),
        replacement(2, secondRangeEndOffset, "y"),
      ]),
    ).toThrow("Overlapping");
  });
  test.each([
    [
      "the line is beyond the document",
      { line: 1, character: 0 },
      { line: 1, character: 0 },
      "line 2 is outside",
    ],
    [
      "the character is beyond the line",
      { line: 0, character: 4 },
      { line: 0, character: 4 },
      "character 4 is outside",
    ],
    [
      "the range is reversed",
      { line: 0, character: 2 },
      { line: 0, character: 1 },
      "ends before it starts",
    ],
    [
      "a character is fractional",
      { line: 0, character: 0.5 },
      { line: 0, character: 1 },
      "nonnegative UTF-16 integers",
    ],
  ] as const)(
    "should reject invalid ranges when %s",
    (_condition, start, end, reason) => {
      expect(() =>
        applyTextEdits("abc", [
          {
            range: { start, end },
            newText: "x",
          },
        ]),
      ).toThrow(reason);
    },
  );

  test("should coalesce duplicate replacements when their ranges and text are identical", () => {
    const edit = replacement(0, ORIGINAL_TEXT_LENGTH, "new");
    expect(applyTextEdits("old", [edit, edit])).toBe("new");
  });

  test("should reject snippet syntax instead of inserting unresolved placeholders", () => {
    const edit = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: LSP snippets intentionally use literal placeholder syntax.
      ...replacement(0, ORIGINAL_TEXT_LENGTH, "${1:value}"),
      insertTextFormat: 2,
    };
    expect(() => applyTextEdits("old", [edit])).toThrow(
      "snippet-formatted text edit",
    );
  });
});

// Snapshot consistency, ordered text mutations, and reference rollback.
describe("applyWorkspaceEdit", () => {
  test("should reject stale server versions before changing disk", async () => {
    const documentTextEndOffset = 3;
    const fixture = memoryFiles({ "/project/a.ts": "old" });
    const edit: WorkspaceEdit = {
      documentChanges: [
        {
          textDocument: { uri: fileToUri("/project/a.ts"), version: 1 },
          edits: [replacement(0, documentTextEndOffset, "new")],
        },
      ],
    };
    const result = await applyWorkspaceEdit(edit, {
      cwd: "/project",
      documents: new Map([["/project/a.ts", { version: 1, content: "old" }]]),
      document: () => ({ version: 2, content: "old" }),
    });
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("Stale");
    expect(fixture.files.get("/project/a.ts")?.content).toBe("old");
    expect(fixture.writes).toEqual([]);
  });

  test("should preserve a concurrent host write when content changes while queued", async () => {
    const hostWriteEndOffset = 3;
    const fixture = memoryFiles({ "/project/a.ts": "old" });
    fixture.changeWhileQueued("/project/a.ts", "host update");
    const result = await applyWorkspaceEdit(
      {
        changes: {
          [fileToUri("/project/a.ts")]: [
            replacement(0, hostWriteEndOffset, "new"),
          ],
        },
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(fixture.files.get("/project/a.ts")?.content).toBe("host update");
    expect(fixture.writes).toEqual([]);
  });

  test("should leave all files unchanged when a later bucket has overlapping edits", async () => {
    const firstBucketEndOffset = 3;
    const overlappingBucketEndOffset = 4;
    const fixture = memoryFiles({
      "/project/a.ts": "old",
      "/project/b.ts": "abcd",
    });
    const result = await applyWorkspaceEdit(
      {
        changes: {
          [fileToUri("/project/a.ts")]: [
            replacement(0, firstBucketEndOffset, "new"),
          ],
          [fileToUri("/project/b.ts")]: [
            replacement(0, firstBucketEndOffset, "x"),
            replacement(2, overlappingBucketEndOffset, "y"),
          ],
        },
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(fixture.files.get("/project/a.ts")?.content).toBe("old");
    expect(fixture.writes).toEqual([]);
  });

  test("should apply text edits against their ordered resource-operation state", async () => {
    const renamedTextLength = 5;
    const fixture = memoryFiles({});
    const first = fileToUri("/project/a.ts");
    const second = fileToUri("/project/b.ts");
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          { kind: "create", uri: first },
          {
            textDocument: { uri: first, version: null },
            edits: [replacement(0, 0, "hello")],
          },
          { kind: "rename", oldUri: first, newUri: second },
          {
            textDocument: { uri: second, version: null },
            edits: [replacement(0, renamedTextLength, "world")],
          },
        ],
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(true);
    expect(fixture.files.has("/project/a.ts")).toBe(false);
    expect(fixture.files.get("/project/b.ts")?.content).toBe("world");
  });

  test("should report the committed prefix when a later filesystem write fails", async () => {
    const committedTextEndOffset = 3;
    const fixture = memoryFiles({
      "/project/a.ts": "old",
      "/project/b.ts": "old",
    });
    fixture.failWrite("/project/b.ts");
    const result = await applyWorkspaceEdit(
      {
        changes: {
          [fileToUri("/project/a.ts")]: [
            replacement(0, committedTextEndOffset, "new"),
          ],
          [fileToUri("/project/b.ts")]: [
            replacement(0, committedTextEndOffset, "new"),
          ],
        },
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("already committed");
    expect(fixture.files.get("/project/a.ts")?.content).toBe("new");
    expect(fixture.files.get("/project/b.ts")?.content).toBe("old");
    expect(result.changes.map((change) => change.file)).toEqual([
      "/project/a.ts",
    ]);
  });

  test("should restore only committed reference edits when a rename fails before later edits", async () => {
    const referenceTextEndOffset = 3;
    const fixture = memoryFiles({
      "/project/ref.ts": "old",
      "/project/a.ts": "source",
      "/project/pending.ts": "old",
    });
    fixture.failMove();
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          {
            textDocument: { uri: fileToUri("/project/ref.ts"), version: null },
            edits: [replacement(0, referenceTextEndOffset, "new")],
          },
          {
            kind: "rename",
            oldUri: fileToUri("/project/a.ts"),
            newUri: fileToUri("/project/b.ts"),
          },
          {
            textDocument: {
              uri: fileToUri("/project/pending.ts"),
              version: null,
            },
            edits: [replacement(0, referenceTextEndOffset, "new")],
          },
        ],
      },
      { cwd: "/project", rollbackTextOnRenameFailure: true },
    );
    expect(result.applied).toBe(false);
    expect(fixture.files.get("/project/ref.ts")?.content).toBe("old");
    expect(fixture.files.get("/project/a.ts")?.content).toBe("source");
    expect(fixture.files.get("/project/pending.ts")?.content).toBe("old");
    expect(fixture.files.has("/project/b.ts")).toBe(false);
    expect(result.changes).toEqual([]);
  });

  test("should preserve intervening changes and restore other edits when rename rollback is incomplete", async () => {
    const referenceTextEndOffset = 3;
    const fixture = memoryFiles({
      "/project/other.ts": "old",
      "/project/ref.ts": "old",
      "/project/a.ts": "source",
    });
    const renameFailure = new Error("Rename failed");
    spyOn(fs, "rename").mockImplementation(() => {
      fixture.files.set("/project/ref.ts", {
        content: "host update",
        revision: 2,
      });
      return Promise.reject(renameFailure);
    });

    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          {
            textDocument: {
              uri: fileToUri("/project/other.ts"),
              version: null,
            },
            edits: [replacement(0, referenceTextEndOffset, "new")],
          },
          {
            textDocument: { uri: fileToUri("/project/ref.ts"), version: null },
            edits: [replacement(0, referenceTextEndOffset, "new")],
          },
          {
            kind: "rename",
            oldUri: fileToUri("/project/a.ts"),
            newUri: fileToUri("/project/b.ts"),
          },
        ],
      },
      { cwd: "/project", rollbackTextOnRenameFailure: true },
    );

    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain(renameFailure.message);
    expect(fixture.files.get("/project/ref.ts")?.content).toBe("host update");
    expect(fixture.files.get("/project/other.ts")?.content).toBe("old");
    expect(result.changes).toContainEqual({
      kind: "edit",
      file: "/project/ref.ts",
      files: ["/project/ref.ts"],
    });
  });
});

// Resource operation validation, conflict handling, and directory effects.
describe("applyWorkspaceEdit", () => {
  test.each(["overwrite", "ignoreIfExists", "recursive", "ignoreIfNotExists"])(
    "should reject resource edits without writing when %s is not a boolean",
    async (option) => {
      const fixture = memoryFiles({ "/project/a.ts": "old" });
      const result = await applyWorkspaceEdit(
        {
          documentChanges: [
            {
              kind: "create",
              uri: fileToUri("/project/a.ts"),
              options: { [option]: "true" },
            },
          ],
        },
        { cwd: "/project" },
      );
      expect(result.applied).toBe(false);
      expect(result.failureReason).toContain(
        `Invalid resource operation option ${option}`,
      );
      expect(result.changes).toEqual([]);
      expect(fixture.files.get("/project/a.ts")?.content).toBe("old");
      expect(fixture.writes).toEqual([]);
    },
  );

  test.each([
    [
      "the rename source URI is missing",
      { kind: "rename", newUri: fileToUri("/project/b.ts") },
      "Rename requires oldUri and newUri",
    ],
    [
      "the rename destination URI is missing",
      { kind: "rename", oldUri: fileToUri("/project/a.ts") },
      "Rename requires oldUri and newUri",
    ],
    [
      "the resource kind is unsupported",
      { kind: "copy", uri: fileToUri("/project/a.ts") },
      "Unsupported workspace resource operation",
    ],
    [
      "the create URI is missing",
      { kind: "create" },
      "Resource operation requires a URI",
    ],
    [
      "the delete URI is missing",
      { kind: "delete" },
      "Resource operation requires a URI",
    ],
  ] as const)(
    "should reject malformed resource edits without writing when %s",
    async (_condition, operation, reason) => {
      const fixture = memoryFiles({ "/project/a.ts": "old" });
      const result = await applyWorkspaceEdit(
        { documentChanges: [operation] },
        { cwd: "/project" },
      );
      expect(result.applied).toBe(false);
      expect(result.failureReason).toContain(reason);
      expect(result.changes).toEqual([]);
      expect(fixture.files.get("/project/a.ts")?.content).toBe("old");
      expect(fixture.writes).toEqual([]);
    },
  );

  test.each([
    [
      "a create target already exists",
      { kind: "create", uri: fileToUri("/project/a.ts") },
      "Create target already exists",
    ],
    [
      "a delete target is missing",
      { kind: "delete", uri: fileToUri("/project/missing.ts") },
      "Delete target does not exist",
    ],
    [
      "a rename source is missing",
      {
        kind: "rename",
        oldUri: fileToUri("/project/missing.ts"),
        newUri: fileToUri("/project/b.ts"),
      },
      "Rename source does not exist",
    ],
  ] as const)(
    "should preserve existing files when %s",
    async (_condition, operation, reason) => {
      const fixture = memoryFiles({ "/project/a.ts": "old" });
      const result = await applyWorkspaceEdit(
        { documentChanges: [operation] },
        { cwd: "/project" },
      );
      expect(result.applied).toBe(false);
      expect(result.failureReason).toContain(reason);
      expect(result.changes).toEqual([]);
      expect(fixture.files.get("/project/a.ts")?.content).toBe("old");
      expect(fixture.writes).toEqual([]);
    },
  );

  test.each([
    {
      condition: "ignore is enabled without overwrite",
      options: { overwrite: false, ignoreIfExists: true },
      content: "old",
      kinds: [],
    },
    {
      condition: "overwrite is enabled without ignore",
      options: { overwrite: true, ignoreIfExists: false },
      content: "",
      kinds: ["create"],
    },
    {
      condition: "overwrite and ignore are both enabled",
      options: { overwrite: true, ignoreIfExists: true },
      content: "",
      kinds: ["create"],
    },
  ] as const)(
    "should honor create precedence when $condition",
    async ({ options, content, kinds }) => {
      const fixture = memoryFiles({ "/project/a.ts": "old" });
      const result = await applyWorkspaceEdit(
        {
          documentChanges: [
            {
              kind: "create",
              uri: fileToUri("/project/a.ts"),
              options,
            },
          ],
        },
        { cwd: "/project" },
      );
      expect(result.applied).toBe(true);
      expect(fixture.files.get("/project/a.ts")?.content).toBe(content);
      expect(result.changes.map((change) => change.kind)).toEqual([...kinds]);
      expect(fixture.writes).toEqual(kinds.map(() => "/project/a.ts"));
    },
  );

  test("should preserve a directory when create requests overwrite", async () => {
    const fixture = memoryFiles({});
    fixture.directories.add("/project/folder");
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          {
            kind: "create",
            uri: fileToUri("/project/folder"),
            options: { overwrite: true },
          },
        ],
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain(
      "cannot overwrite directory or symlink",
    );
    expect(fixture.directories.has("/project/folder")).toBe(true);
    expect(fixture.files.has("/project/folder")).toBe(false);
    expect(fixture.writes).toEqual([]);
  });

  test("should preserve a symlink and its target when create requests overwrite", async () => {
    const fixture = memoryFiles({ "/project/a.ts": "old" });
    fixture.links.set("/project/link.ts", "/project/a.ts");
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          {
            kind: "create",
            uri: fileToUri("/project/link.ts"),
            options: { overwrite: true },
          },
        ],
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain(
      "cannot overwrite directory or symlink",
    );
    expect(fixture.links.get("/project/link.ts")).toBe("/project/a.ts");
    expect(fixture.files.get("/project/a.ts")?.content).toBe("old");
    expect(fixture.writes).toEqual([]);
  });

  test.each([
    ["equal", "/project/a.ts"],
    ["inside the source", "/project/a.ts/child"],
    ["an ancestor of the source", "/project"],
  ])(
    "should reject a rename without changing files when its destination is %s",
    async (_condition, destination) => {
      const fixture = memoryFiles({ "/project/a.ts": "old" });
      const result = await applyWorkspaceEdit(
        {
          documentChanges: [
            {
              kind: "rename",
              oldUri: fileToUri("/project/a.ts"),
              newUri: fileToUri(destination),
            },
          ],
        },
        { cwd: "/project" },
      );
      expect(result.applied).toBe(false);
      expect(result.failureReason).toContain("distinct, non-nested paths");
      expect(result.changes).toEqual([]);
      expect(fixture.files.get("/project/a.ts")?.content).toBe("old");
      expect(fixture.writes).toEqual([]);
    },
  );

  test.each([
    {
      condition: "ignore is enabled without overwrite",
      options: { overwrite: false, ignoreIfExists: true },
      source: "source",
      destination: "target",
      kinds: [],
      files: ["/project/a.ts", "/project/b.ts"],
    },
    {
      condition: "overwrite is enabled without ignore",
      options: { overwrite: true, ignoreIfExists: false },
      source: undefined,
      destination: "source",
      kinds: ["rename"],
      files: ["/project/b.ts"],
    },
    {
      condition: "overwrite and ignore are both enabled",
      options: { overwrite: true, ignoreIfExists: true },
      source: undefined,
      destination: "source",
      kinds: ["rename"],
      files: ["/project/b.ts"],
    },
  ] as const)(
    "should honor rename precedence when $condition",
    async ({ options, source, destination, kinds, files }) => {
      const fixture = memoryFiles({
        "/project/a.ts": "source",
        "/project/b.ts": "target",
      });
      const result = await applyWorkspaceEdit(
        {
          documentChanges: [
            {
              kind: "rename",
              oldUri: fileToUri("/project/a.ts"),
              newUri: fileToUri("/project/b.ts"),
              options,
            },
          ],
        },
        { cwd: "/project" },
      );
      expect(result.applied).toBe(true);
      expect(fixture.files.get("/project/a.ts")?.content).toBe(source);
      expect(fixture.files.get("/project/b.ts")?.content).toBe(destination);
      expect(result.changes.map((change) => change.kind)).toEqual([...kinds]);
      expect([...fixture.files.keys()].sort()).toEqual([...files]);
      expect([...fixture.directories].sort()).toEqual(["/", "/project"]);
    },
  );

  test("should ignore a missing delete target when ignoreIfNotExists is enabled", async () => {
    const fixture = memoryFiles({ "/project/a.ts": "old" });
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          {
            kind: "delete",
            uri: fileToUri("/project/missing.ts"),
            options: { ignoreIfNotExists: true },
          },
        ],
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(true);
    expect(result.changes).toEqual([]);
    expect(fixture.files.get("/project/a.ts")?.content).toBe("old");
    expect(fixture.writes).toEqual([]);
  });

  test("should recreate and edit deleted content in declared operation order", async () => {
    const fixture = memoryFiles({ "/project/a.ts": "old" });
    const uri = fileToUri("/project/a.ts");
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          { kind: "delete", uri },
          { kind: "create", uri },
          {
            textDocument: { uri, version: null },
            edits: [replacement(0, 0, "new")],
          },
        ],
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(true);
    expect(fixture.files.get("/project/a.ts")?.content).toBe("new");
    expect(result.changes.map((change) => change.kind)).toEqual([
      "delete",
      "create",
      "edit",
    ]);
  });

  test("should remove an empty directory when recursive deletion is disabled", async () => {
    const fixture = memoryFiles({});
    fixture.directories.add("/project/empty");
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [{ kind: "delete", uri: fileToUri("/project/empty") }],
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(true);
    expect(fixture.directories.has("/project/empty")).toBe(false);
    expect(result.changes).toEqual([
      { kind: "delete", file: "/project/empty", files: [] },
    ]);
  });

  test("should preserve a nonempty directory when recursive deletion is disabled", async () => {
    const fixture = memoryFiles({ "/project/folder/a.ts": "old" });
    fixture.directories.add("/project/folder");
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          { kind: "delete", uri: fileToUri("/project/folder") },
        ],
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("nonempty directory");
    expect(result.changes).toEqual([]);
    expect(fixture.directories.has("/project/folder")).toBe(true);
    expect(fixture.files.get("/project/folder/a.ts")?.content).toBe("old");
  });

  test("should report descendant files and preserve siblings when deleting recursively", async () => {
    const fixture = memoryFiles({
      "/project/folder/nested/a.ts": "old",
      "/project/sibling.ts": "keep",
    });
    fixture.directories.add("/project/folder");
    fixture.directories.add("/project/folder/nested");
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          {
            kind: "delete",
            uri: fileToUri("/project/folder"),
            options: { recursive: true },
          },
        ],
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(true);
    expect([...fixture.files.keys()]).toEqual(["/project/sibling.ts"]);
    expect(fixture.files.get("/project/sibling.ts")?.content).toBe("keep");
    expect([...fixture.directories].sort()).toEqual(["/", "/project"]);
    expect(result.changes).toEqual([
      {
        kind: "delete",
        file: "/project/folder",
        files: ["/project/folder/nested/a.ts"],
      },
    ]);
  });

  test("should report only removed descendants when recursive deletion partially fails", async () => {
    const fixture = memoryFiles({
      "/project/folder/a.ts": "first",
      "/project/folder/b.ts": "second",
    });
    fixture.directories.add("/project/folder");
    spyOn(fs, "rm").mockImplementation(() => {
      fixture.files.delete("/project/folder/a.ts");
      return Promise.reject(new Error("Delete interrupted"));
    });
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          {
            kind: "delete",
            uri: fileToUri("/project/folder"),
            options: { recursive: true },
          },
        ],
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("Delete interrupted");
    expect(fixture.files.has("/project/folder/a.ts")).toBe(false);
    expect(fixture.files.get("/project/folder/b.ts")?.content).toBe("second");
    expect(result.changes).toEqual([
      {
        kind: "delete",
        file: "/project/folder",
        files: ["/project/folder/a.ts"],
      },
    ]);
  });
});

// Canonical document aliases and mutation-time snapshot checks.
describe("applyWorkspaceEdit", () => {
  test("should reject conflicting text aliases before committing either edit", async () => {
    const fixture = memoryFiles({ "/project/a.ts": "old" });
    fixture.links.set("/project/link.ts", "/project/a.ts");
    const result = await applyWorkspaceEdit(
      {
        changes: {
          [fileToUri("/project/link.ts")]: [replacement(0, 1, "x")],
          [fileToUri("/project/a.ts")]: [replacement(1, 2, "y")],
        },
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("conflicting aliases");
    expect(result.changes).toEqual([]);
    expect(fixture.files.get("/project/a.ts")?.content).toBe("old");
    expect(fixture.writes).toEqual([]);
  });

  test("should edit a canonical target using the aliased document snapshot", async () => {
    const fixture = memoryFiles({ "/project/a.ts": "old" });
    fixture.links.set("/project/link.ts", "/project/a.ts");
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          {
            textDocument: { uri: fileToUri("/project/link.ts"), version: 1 },
            edits: [replacement(0, "old".length, "new")],
          },
        ],
      },
      {
        cwd: "/project",
        documents: new Map([
          ["/project/link.ts", { version: 1, content: "old" }],
        ]),
        document: (file) =>
          file === "/project/link.ts"
            ? { version: 1, content: "old" }
            : undefined,
      },
    );
    expect(result.applied).toBe(true);
    expect(fixture.files.get("/project/a.ts")?.content).toBe("new");
    expect(fixture.links.get("/project/link.ts")).toBe("/project/a.ts");
    expect(result.changes).toEqual([
      {
        kind: "edit",
        file: "/project/a.ts",
        files: ["/project/a.ts", "/project/link.ts"],
      },
    ]);
  });

  test("should reject a missing text target without creating a file", async () => {
    const fixture = memoryFiles({});
    const result = await applyWorkspaceEdit(
      {
        changes: {
          [fileToUri("/project/missing.ts")]: [replacement(0, 0, "new")],
        },
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("Missing /project/missing.ts");
    expect(result.changes).toEqual([]);
    expect(fixture.files.size).toBe(0);
    expect(fixture.writes).toEqual([]);
  });

  test("should preserve a text target when canonical resolution fails with a nonmissing error", async () => {
    const fixture = memoryFiles({ "/project/a.ts": "old" });
    spyOn(fs, "realpath").mockRejectedValue(
      Object.assign(new Error("Canonical access denied"), { code: "EACCES" }),
    );
    const result = await applyWorkspaceEdit(
      { changes: { [fileToUri("/project/a.ts")]: [replacement(0, 1, "x")] } },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("Canonical access denied");
    expect(result.changes).toEqual([]);
    expect(fixture.files.get("/project/a.ts")?.content).toBe("old");
    expect(fixture.writes).toEqual([]);
  });

  test("should preserve a newly appeared create target when another writer wins the lock", async () => {
    const fixture = memoryFiles({});
    fixture.changeWhileQueued("/project/a.ts", "host");
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [{ kind: "create", uri: fileToUri("/project/a.ts") }],
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("File changed while waiting");
    expect(fixture.files.get("/project/a.ts")?.content).toBe("host");
    expect(fixture.writes).toEqual([]);
  });

  test("should reject queued edits when file metadata changes without changing content", async () => {
    const fixture = memoryFiles({ "/project/a.ts": "old" });
    fixture.changeWhileQueued("/project/a.ts", "old");
    const result = await applyWorkspaceEdit(
      { changes: { [fileToUri("/project/a.ts")]: [replacement(0, 1, "x")] } },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("File changed while waiting");
    expect(fixture.files.get("/project/a.ts")?.content).toBe("old");
    expect(fixture.writes).toEqual([]);
  });

  test("should reject a text mutation when the live document version advances after planning", async () => {
    const fixture = memoryFiles({ "/project/a.ts": "old" });
    const document = mock(() => ({
      version: 2,
      content: "old",
    })).mockReturnValueOnce({ version: 1, content: "old" });
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          {
            textDocument: { uri: fileToUri("/project/a.ts"), version: 1 },
            edits: [replacement(0, 1, "x")],
          },
        ],
      },
      {
        cwd: "/project",
        documents: new Map([["/project/a.ts", { version: 1, content: "old" }]]),
        document,
      },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain(
      "Document version changed before mutation",
    );
    expect(result.changes).toEqual([]);
    expect(fixture.files.get("/project/a.ts")?.content).toBe("old");
    expect(fixture.writes).toEqual([]);
  });
});

// Untrusted edit metadata, annotations, and document bucket validation.
describe("applyWorkspaceEdit", () => {
  test.each([
    ["the workspace edit is null", null, "Invalid WorkspaceEdit"],
    [
      "documentChanges is not an array",
      { documentChanges: {} },
      "documentChanges must be an array",
    ],
    [
      "text edits are not an array",
      { changes: { [fileToUri("/project/a.ts")]: {} } },
      "text edits must be an array",
    ],
    [
      "a document URI is missing",
      { documentChanges: [{ textDocument: {}, edits: [] }] },
      "missing its document URI",
    ],
    [
      "a document version is fractional",
      {
        documentChanges: [
          {
            textDocument: { uri: fileToUri("/project/a.ts"), version: 1.5 },
            edits: [],
          },
        ],
      },
      "Invalid workspace edit document version",
    ],
    [
      "a replacement is not text",
      {
        changes: {
          [fileToUri("/project/a.ts")]: [
            { ...replacement(0, 1, "x"), newText: 3 },
          ],
        },
      },
      "newText must be a string",
    ],
    [
      "an edit uses snippets",
      {
        changes: {
          [fileToUri("/project/a.ts")]: [
            { ...replacement(0, 1, "x"), insertTextFormat: 2 },
          ],
        },
      },
      "Snippet-formatted",
    ],
    [
      "a position is negative",
      {
        changes: {
          [fileToUri("/project/a.ts")]: [
            {
              range: {
                start: { line: -1, character: 0 },
                end: { line: 0, character: 1 },
              },
              newText: "x",
            },
          ],
        },
      },
      "nonnegative UTF-16 integers",
    ],
  ] as const)(
    "should reject invalid edits without mutation when %s",
    async (_condition, edit, reason) => {
      const fixture = memoryFiles({ "/project/a.ts": "old" });
      const result = await applyWorkspaceEdit(edit, { cwd: "/project" });
      expect(result.applied).toBe(false);
      expect(result.failureReason).toContain(reason);
      expect(result.changes).toEqual([]);
      expect(fixture.files.get("/project/a.ts")?.content).toBe("old");
      expect(fixture.writes).toEqual([]);
    },
  );

  test.each([
    ["the annotation is unknown", {}, "missing", "unknown change annotation"],
    [
      "the annotation identifier is not text",
      { known: {} },
      1,
      "unknown change annotation",
    ],
    [
      "the annotation data is malformed",
      { known: null },
      "known",
      "Invalid change annotation",
    ],
    [
      "confirmation has a label",
      { known: { needsConfirmation: true, label: "approve rename" } },
      "known",
      "requires confirmation: approve rename",
    ],
    [
      "confirmation has no label",
      { known: { needsConfirmation: true } },
      "known",
      "requires confirmation: known",
    ],
  ] as const)(
    "should reject unapproved edits without mutation when %s",
    async (_condition, changeAnnotations, annotationId, reason) => {
      const fixture = memoryFiles({ "/project/a.ts": "old" });
      const result = await applyWorkspaceEdit(
        {
          changeAnnotations,
          changes: {
            [fileToUri("/project/a.ts")]: [
              { ...replacement(0, ORIGINAL_TEXT_LENGTH, "new"), annotationId },
            ],
          },
        },
        { cwd: "/project" },
      );
      expect(result.applied).toBe(false);
      expect(result.failureReason).toContain(reason);
      expect(fixture.files.get("/project/a.ts")?.content).toBe("old");
      expect(fixture.writes).toEqual([]);
    },
  );

  test("should apply annotated changes when confirmation is not required", async () => {
    const fixture = memoryFiles({ "/project/a.ts": "old" });
    const result = await applyWorkspaceEdit(
      {
        changeAnnotations: {
          accepted: { label: "replace", needsConfirmation: false },
        },
        changes: {
          [fileToUri("/project/a.ts")]: [
            {
              ...replacement(0, ORIGINAL_TEXT_LENGTH, "new"),
              annotationId: "accepted",
            },
          ],
        },
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(true);
    expect(fixture.files.get("/project/a.ts")?.content).toBe("new");
  });

  test("should combine edits into one snapshot-relative mutation when document buckets share a version", async () => {
    const fixture = memoryFiles({ "/project/a.ts": "old" });
    const textDocument = { uri: fileToUri("/project/a.ts"), version: null };
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          { textDocument, edits: [replacement(0, 1, "n")] },
          { textDocument, edits: [replacement(1, ORIGINAL_TEXT_LENGTH, "ew")] },
        ],
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(true);
    expect(fixture.files.get("/project/a.ts")?.content).toBe("new");
    expect(result.changes).toEqual([
      { kind: "edit", file: "/project/a.ts", files: ["/project/a.ts"] },
    ]);
    expect(fixture.writes).toEqual(["/project/a.ts"]);
  });

  test("should reject all document buckets when their versions conflict", async () => {
    const fixture = memoryFiles({ "/project/a.ts": "old" });
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          {
            textDocument: { uri: fileToUri("/project/a.ts"), version: 1 },
            edits: [replacement(0, 1, "n")],
          },
          {
            textDocument: { uri: fileToUri("/project/a.ts"), version: 2 },
            edits: [replacement(1, ORIGINAL_TEXT_LENGTH, "ew")],
          },
        ],
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("Conflicting document versions");
    expect(fixture.files.get("/project/a.ts")?.content).toBe("old");
    expect(fixture.writes).toEqual([]);
  });

  test("should reject a batch without filesystem access when it exceeds 2000 operations", async () => {
    const fixture = memoryFiles({});
    const result = await applyWorkspaceEdit(
      {
        documentChanges: Array.from({ length: 2001 }, (_, index) => ({
          kind: "create",
          uri: fileToUri(`/project/${index}.ts`),
        })),
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("exceeds 2000 operations");
    expect(fixture.files.size).toBe(0);
    expect(fixture.writes).toEqual([]);
    expect(fs.lstat).not.toHaveBeenCalled();
  });
});

// Reconciliation after partial writes and overwrite-rename failures.
describe("applyWorkspaceEdit", () => {
  test("should retain partially written content in the reconciliation report when a write truncates before failing", async () => {
    const fixture = memoryFiles({ "/project/a.ts": "old" });
    spyOn(fs, "writeFile").mockImplementation((file) => {
      fixture.files.set(String(file), { content: "", revision: 2 });
      return Promise.reject(new Error("Disk full"));
    });
    const result = await applyWorkspaceEdit(
      {
        changes: {
          [fileToUri("/project/a.ts")]: [
            replacement(0, ORIGINAL_TEXT_LENGTH, "new"),
          ],
        },
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("Disk full");
    expect(fixture.files.get("/project/a.ts")?.content).toBe("");
    expect(result.changes).toEqual([
      { kind: "edit", file: "/project/a.ts", files: ["/project/a.ts"] },
    ]);
    expect(result.summary).toContain(
      "Partially changed /project/a.ts before filesystem failure",
    );
  });

  test("should restore the displaced destination when an overwrite rename fails", async () => {
    const fixture = memoryFiles({
      "/project/a.ts": "source",
      "/project/b.ts": "destination",
    });
    spyOn(fs, "rename").mockImplementation((source, destination) => {
      if (String(source) === "/project/a.ts") {
        return Promise.reject(new Error("Source rename failed"));
      }
      const file = fixture.files.get(String(source));
      if (!file) {
        return Promise.reject(new Error("Missing source"));
      }
      fixture.files.set(String(destination), file);
      fixture.files.delete(String(source));
      return Promise.resolve();
    });
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          {
            kind: "rename",
            oldUri: fileToUri("/project/a.ts"),
            newUri: fileToUri("/project/b.ts"),
            options: { overwrite: true },
          },
        ],
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("Source rename failed");
    expect(result.changes).toEqual([]);
    expect([...fixture.files.keys()].sort()).toEqual([
      "/project/a.ts",
      "/project/b.ts",
    ]);
    expect(fixture.files.get("/project/b.ts")?.content).toBe("destination");
    expect([...fixture.directories].sort()).toEqual(["/", "/project"]);
  });

  test("should retain a recoverable backup and report the lost destination when rename restoration fails", async () => {
    const fixture = memoryFiles({
      "/project/a.ts": "source",
      "/project/b.ts": "destination",
    });
    spyOn(fs, "rename").mockImplementation((source, destination) => {
      if (String(source) !== "/project/b.ts") {
        return Promise.reject(new Error("Rename unavailable"));
      }
      const file = fixture.files.get(String(source));
      if (!file) {
        return Promise.reject(new Error("Missing source"));
      }
      fixture.files.set(String(destination), file);
      fixture.files.delete(String(source));
      return Promise.resolve();
    });
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          {
            kind: "rename",
            oldUri: fileToUri("/project/a.ts"),
            newUri: fileToUri("/project/b.ts"),
            options: { overwrite: true },
          },
        ],
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("destination restore failed");
    expect(result.failureReason).toContain(
      "Original retained at /project/.pi-lsp-displaced-1/original",
    );
    expect(
      fixture.files.get("/project/.pi-lsp-displaced-1/original")?.content,
    ).toBe("destination");
    expect(fixture.files.get("/project/a.ts")?.content).toBe("source");
    expect(fixture.files.has("/project/b.ts")).toBe(false);
    expect(result.changes).toEqual([
      { kind: "delete", file: "/project/b.ts", files: ["/project/b.ts"] },
    ]);
  });

  test("should report a committed rename and retained backup when displaced destination cleanup fails", async () => {
    const fixture = memoryFiles({
      "/project/a.ts": "source",
      "/project/b.ts": "destination",
    });
    spyOn(fs, "rm").mockRejectedValue(new Error("Cleanup denied"));
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          {
            kind: "rename",
            oldUri: fileToUri("/project/a.ts"),
            newUri: fileToUri("/project/b.ts"),
            options: { overwrite: true },
          },
        ],
      },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain(
      "Rename committed, but displaced destination cleanup failed",
    );
    expect(fixture.files.has("/project/a.ts")).toBe(false);
    expect(fixture.files.get("/project/b.ts")?.content).toBe("source");
    expect(
      fixture.files.get("/project/.pi-lsp-displaced-1/original")?.content,
    ).toBe("destination");
    expect(result.changes).toEqual([
      {
        kind: "rename",
        file: "/project/a.ts",
        newFile: "/project/b.ts",
        files: ["/project/a.ts"],
        removedFiles: ["/project/b.ts"],
      },
    ]);
  });
});

describe("directoryFiles", () => {
  test("should sort nested files and symlinks without traversing a symlink target", async () => {
    const fixture = memoryFiles({
      "/project/tree/z.ts": "last",
      "/project/tree/nested/a.ts": "first",
      "/outside/secret.ts": "not selected",
    });
    fixture.directories.add("/project/tree");
    fixture.directories.add("/project/tree/nested");
    fixture.links.set("/project/tree/link", "/outside");

    expect(await directoryFiles("/project/tree")).toEqual([
      "/project/tree/link",
      "/project/tree/nested/a.ts",
      "/project/tree/z.ts",
    ]);
    expect(fixture.files.get("/outside/secret.ts")?.content).toBe(
      "not selected",
    );
  });

  test("should reject traversal when the directory contains more than 1000 files", async () => {
    const fileCount = 1001;
    const fixture = memoryFiles(
      Object.fromEntries(
        Array.from({ length: fileCount }, (_, index) => [
          `/project/tree/${index}.ts`,
          "",
        ]),
      ),
    );
    fixture.directories.add("/project/tree");

    await expect(directoryFiles("/project/tree")).rejects.toThrow(
      "more than 1000 files",
    );
    expect(fixture.files.size).toBe(fileCount);
    expect(fixture.writes).toEqual([]);
  });

  test("should reject unsupported entries instead of returning an incomplete file list", async () => {
    memoryFiles({});
    spyOn(filesystem, "opendir").mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield await Promise.resolve({
          name: "socket",
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => false,
        });
      },
    });

    await expect(directoryFiles("/project/tree")).rejects.toThrow(
      "Unsupported filesystem object: /project/tree/socket",
    );
  });
});

describe("applyWorkspaceEdit", () => {
  test("should create missing parent directories before creating a nested file", async () => {
    const fixture = memoryFiles({});
    const file = "/project/new/nested/a.ts";
    const result = await applyWorkspaceEdit(
      { documentChanges: [{ kind: "create", uri: fileToUri(file) }] },
      { cwd: "/project" },
    );

    expect(result.applied).toBe(true);
    expect(result.changes).toEqual([{ kind: "create", file, files: [file] }]);
    expect(fixture.files.get(file)?.content).toBe("");
    expect(fixture.directories.has("/project/new/nested")).toBe(true);
  });

  test("should preserve the destination and remove the empty backup directory when displacement fails", async () => {
    const fixture = memoryFiles({
      "/project/a.ts": "source",
      "/project/b.ts": "destination",
    });
    fixture.failMove();
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          {
            kind: "rename",
            oldUri: fileToUri("/project/a.ts"),
            newUri: fileToUri("/project/b.ts"),
            options: { overwrite: true },
          },
        ],
      },
      { cwd: "/project" },
    );

    expect(result.applied).toBe(false);
    expect(result.failureReason).toContain("Cross-device rename failed");
    expect(result.changes).toEqual([]);
    expect(fixture.files.get("/project/a.ts")?.content).toBe("source");
    expect(fixture.files.get("/project/b.ts")?.content).toBe("destination");
    expect([...fixture.directories]).toEqual(["/", "/project"]);
  });
});
