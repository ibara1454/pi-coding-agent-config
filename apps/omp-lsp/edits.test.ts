import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as host from "@earendil-works/pi-coding-agent";
import type { TextEdit, WorkspaceEdit } from "vscode-languageserver-protocol";
import { applyTextEdits, applyWorkspaceEdit, fileToUri } from "./edits";

function memoryFiles(initial: Record<string, string>) {
  const files = new Map(
    Object.entries(initial).map(([file, content]) => [
      file,
      { content, revision: 1 },
    ]),
  );
  const writes: string[] = [];
  const directories = new Set(["/", "/project"]);
  let beforeLock: (() => void) | undefined;
  let failingWrite: string | undefined;
  let failRename = false;
  spyOn(fs, "lstat").mockImplementation((async (value: unknown) => {
    const file = String(value);
    const content = files.get(file);
    if (!content && !directories.has(file))
      throw Object.assign(new Error(`Missing ${file}`), { code: "ENOENT" });
    return {
      dev: 1,
      ino: file.length,
      size: content?.content.length ?? 0,
      mtimeMs: content?.revision ?? 0,
      ctimeMs: content?.revision ?? 0,
      isSymbolicLink: () => false,
      isDirectory: () => directories.has(file),
      isFile: () => files.has(file),
    } as Stats;
  }) as typeof fs.lstat);
  spyOn(fs, "realpath").mockImplementation((async (file: unknown) =>
    String(file)) as typeof fs.realpath);
  spyOn(fs, "readFile").mockImplementation((async (file: unknown) => {
    const value = files.get(String(file));
    if (!value)
      throw Object.assign(new Error(`Missing ${String(file)}`), {
        code: "ENOENT",
      });
    return value.content;
  }) as typeof fs.readFile);
  spyOn(fs, "writeFile").mockImplementation(async (file, content) => {
    const name = String(file);
    if (name === failingWrite) throw new Error("Disk write failed");
    writes.push(name);
    files.set(name, {
      content: String(content),
      revision: (files.get(name)?.revision ?? 0) + 1,
    });
  });
  spyOn(fs, "mkdir").mockImplementation((async (file: unknown) => {
    directories.add(String(file));
  }) as typeof fs.mkdir);
  spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (failRename) throw new Error("Cross-device rename failed");
    const file = files.get(String(source));
    if (!file) throw new Error("Missing rename source");
    files.set(String(destination), file);
    files.delete(String(source));
  });
  spyOn(fs, "rm").mockImplementation(async (file) => {
    files.delete(String(file));
  });
  spyOn(host, "withFileMutationQueue").mockImplementation(
    async (_file, work) => {
      const run = beforeLock;
      beforeLock = undefined;
      run?.();
      return work();
    },
  );
  return {
    files,
    writes,
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
    expect(
      applyTextEdits("a\u{1f600}b\r\nnext", [replacement(1, 3, "x")]),
    ).toBe("axb\r\nnext");
    expect(() =>
      applyTextEdits("a\u{1f600}b", [replacement(2, 3, "x")]),
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
    expect(() =>
      applyTextEdits("abcd", [replacement(0, 3, "x"), replacement(2, 4, "y")]),
    ).toThrow("Overlapping");
  });
});

describe("applyWorkspaceEdit", () => {
  test("should reject stale server versions before changing disk", async () => {
    const fixture = memoryFiles({ "/project/a.ts": "old" });
    const edit: WorkspaceEdit = {
      documentChanges: [
        {
          textDocument: { uri: fileToUri("/project/a.ts"), version: 1 },
          edits: [replacement(0, 3, "new")],
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
    const fixture = memoryFiles({ "/project/a.ts": "old" });
    fixture.changeWhileQueued("/project/a.ts", "host update");
    const result = await applyWorkspaceEdit(
      { changes: { [fileToUri("/project/a.ts")]: [replacement(0, 3, "new")] } },
      { cwd: "/project" },
    );
    expect(result.applied).toBe(false);
    expect(fixture.files.get("/project/a.ts")?.content).toBe("host update");
    expect(fixture.writes).toEqual([]);
  });

  test("should leave all files unchanged when a later bucket has overlapping edits", async () => {
    const fixture = memoryFiles({
      "/project/a.ts": "old",
      "/project/b.ts": "abcd",
    });
    const result = await applyWorkspaceEdit(
      {
        changes: {
          [fileToUri("/project/a.ts")]: [replacement(0, 3, "new")],
          [fileToUri("/project/b.ts")]: [
            replacement(0, 3, "x"),
            replacement(2, 4, "y"),
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
            edits: [replacement(0, 5, "world")],
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
    const fixture = memoryFiles({
      "/project/a.ts": "old",
      "/project/b.ts": "old",
    });
    fixture.failWrite("/project/b.ts");
    const result = await applyWorkspaceEdit(
      {
        changes: {
          [fileToUri("/project/a.ts")]: [replacement(0, 3, "new")],
          [fileToUri("/project/b.ts")]: [replacement(0, 3, "new")],
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

  test("should restore reference edits when the subsequent file rename fails", async () => {
    const fixture = memoryFiles({
      "/project/ref.ts": "old",
      "/project/a.ts": "source",
    });
    fixture.failMove();
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [
          {
            textDocument: { uri: fileToUri("/project/ref.ts"), version: null },
            edits: [replacement(0, 3, "new")],
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
    expect(fixture.files.get("/project/ref.ts")?.content).toBe("old");
    expect(fixture.files.get("/project/a.ts")?.content).toBe("source");
    expect(fixture.files.has("/project/b.ts")).toBe(false);
    expect(result.changes).toEqual([]);
  });
});
