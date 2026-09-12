import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { Position, TextEdit } from "vscode-languageserver-protocol";

export interface DocumentSnapshot {
  version: number;
  content: string;
}

export interface ExecutedChange {
  kind: "edit" | "create" | "delete" | "rename";
  file: string;
  newFile?: string;
  removedFiles?: string[];
  files: string[];
}

export interface EditResult {
  applied: boolean;
  summary: string[];
  changes: ExecutedChange[];
  failureReason?: string;
}

interface EditOptions {
  cwd: string;
  documents?: ReadonlyMap<string, DocumentSnapshot>;
  document?: (file: string) => DocumentSnapshot | undefined;
  signal?: AbortSignal;
  preview?: boolean;
  rollbackTextOnRenameFailure?: boolean;
}

interface Entry {
  kind: "file" | "directory" | "link";
  signature: string;
  content?: string;
}

type Operation =
  | {
      kind: "text";
      file: string;
      documentFile?: string;
      edits: TextEdit[];
      version: number | null;
    }
  | { kind: "create"; file: string; overwrite: boolean; ignore: boolean }
  | {
      kind: "rename";
      file: string;
      newFile: string;
      overwrite: boolean;
      ignore: boolean;
    }
  | { kind: "delete"; file: string; recursive: boolean; ignore: boolean };

interface PlannedChange {
  op: Operation;
  files: string[];
  before?: string;
  after?: string;
  summary: string;
  removedFiles?: string[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function uriToFile(uri: string): string {
  if (typeof uri !== "string")
    throw new Error("Workspace edit URI must be a string");
  const url = new URL(uri);
  if (url.protocol !== "file:" || url.search || url.hash)
    throw new Error(`Unsupported document URI: ${uri}`);
  return path.resolve(fileURLToPath(url));
}

export function fileToUri(file: string): string {
  return pathToFileURL(file).href;
}

function within(file: string, directory: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function position(value: unknown): Position {
  const { line, character } = record(value, "text edit position");
  if (
    !Number.isSafeInteger(line) ||
    !Number.isSafeInteger(character) ||
    Number(line) < 0 ||
    Number(character) < 0
  ) {
    throw new Error("Text edit positions must be nonnegative UTF-16 integers");
  }
  return { line: Number(line), character: Number(character) };
}

function textEdits(
  value: unknown,
  annotation: (value: unknown) => void,
): TextEdit[] {
  if (!Array.isArray(value))
    throw new Error("Workspace text edits must be an array");
  return value.map((item: unknown) => {
    const edit = record(item, "text edit");
    const { insertTextFormat } = edit;
    if (insertTextFormat === 2 || "snippet" in edit)
      throw new Error("Snippet-formatted workspace edits are not supported");
    const { newText } = edit;
    if (typeof newText !== "string")
      throw new Error("Text edit newText must be a string");
    const { annotationId } = edit;
    annotation(annotationId);
    const { range } = edit;
    const { start, end } = record(range, "text edit range");
    return {
      range: { start: position(start), end: position(end) },
      newText,
    };
  });
}

/** Applies LSP UTF-16 ranges without normalizing line endings or splitting surrogate pairs. */
export function applyTextEdits(
  content: string,
  edits: readonly TextEdit[],
): string {
  const starts = [0];
  for (let index = 0; index < content.length; index++) {
    if (content[index] === "\r") {
      if (content[index + 1] === "\n") index++;
      starts.push(index + 1);
    } else if (content[index] === "\n") starts.push(index + 1);
  }
  const offset = (pos: Position): number => {
    position(pos);
    const start = starts[pos.line];
    if (start === undefined)
      throw new Error(`Text edit line ${pos.line + 1} is outside the document`);
    let end = starts[pos.line + 1] ?? content.length;
    if (starts[pos.line + 1] !== undefined) {
      if (content[end - 1] === "\n") end--;
      if (content[end - 1] === "\r") end--;
    }
    const index = start + pos.character;
    if (index > end)
      throw new Error(
        `Text edit character ${pos.character} is outside line ${pos.line + 1}`,
      );
    const previous = content.charCodeAt(index - 1);
    const next = content.charCodeAt(index);
    if (
      previous >= 0xd800 &&
      previous <= 0xdbff &&
      next >= 0xdc00 &&
      next <= 0xdfff
    )
      throw new Error("Text edit splits a UTF-16 surrogate pair");
    return index;
  };
  const sorted = edits
    .map((edit, index) => {
      if (
        typeof edit.newText !== "string" ||
        ("insertTextFormat" in edit && edit.insertTextFormat === 2)
      )
        throw new Error("Invalid or snippet-formatted text edit");
      const start = offset(edit.range.start);
      const end = offset(edit.range.end);
      if (end < start) throw new Error("Text edit range ends before it starts");
      return { start, end, text: edit.newText, index };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
  const pieces: string[] = [];
  let cursor = 0;
  let previous: (typeof sorted)[number] | undefined;
  for (const edit of sorted) {
    if (
      previous &&
      edit.start === previous.start &&
      edit.end === previous.end &&
      edit.text === previous.text &&
      edit.end > edit.start
    )
      continue;
    if (edit.start < cursor)
      throw new Error(
        "Overlapping workspace text edits; no files were changed",
      );
    pieces.push(content.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
    previous = edit;
  }
  pieces.push(content.slice(cursor));
  return pieces.join("");
}

/** Normalizes raw edit variants, coalescing text edits until the next resource operation. */
function operations(value: unknown): Operation[] {
  const edit = record(value, "WorkspaceEdit");
  const { changeAnnotations } = edit;
  const annotations =
    changeAnnotations === undefined
      ? {}
      : record(changeAnnotations, "changeAnnotations");
  const annotation = (id: unknown): void => {
    if (id === undefined) return;
    if (typeof id !== "string" || !Object.hasOwn(annotations, id))
      throw new Error("Workspace edit references an unknown change annotation");
    const data = record(annotations[id], "change annotation");
    const { needsConfirmation } = data;
    if (needsConfirmation === true) {
      const { label } = data;
      throw new Error(
        `Workspace edit requires confirmation: ${String(label ?? id)}`,
      );
    }
  };
  const result: Operation[] = [];
  const pending = new Map<string, Extract<Operation, { kind: "text" }>>();
  const flush = (): void => {
    result.push(...pending.values());
    pending.clear();
  };
  const add = (uri: unknown, edits: unknown, version: unknown): void => {
    if (typeof uri !== "string")
      throw new Error("Workspace edit is missing its document URI");
    if (
      version !== null &&
      version !== undefined &&
      !Number.isSafeInteger(version)
    )
      throw new Error("Invalid workspace edit document version");
    const file = uriToFile(uri);
    const parsed = textEdits(edits, annotation);
    const prior = pending.get(file);
    if (prior) {
      if (prior.version !== (version ?? null))
        throw new Error(`Conflicting document versions for ${file}`);
      prior.edits.push(...parsed);
    } else
      pending.set(file, {
        kind: "text",
        file,
        edits: parsed,
        version: version == null ? null : Number(version),
      });
  };
  const { documentChanges } = edit;
  if (documentChanges !== undefined) {
    if (!Array.isArray(documentChanges))
      throw new Error("Workspace documentChanges must be an array");
    for (const item of documentChanges) {
      const change = record(item, "workspace change");
      const { textDocument } = change;
      if (textDocument !== undefined) {
        const { uri, version } = record(
          textDocument,
          "text document identifier",
        );
        const { edits } = change;
        add(uri, edits, version);
        continue;
      }
      flush();
      const { annotationId } = change;
      annotation(annotationId);
      const { options: resourceOptions } = change;
      const options =
        resourceOptions === undefined
          ? {}
          : record(resourceOptions, "resource operation options");
      for (const key of [
        "overwrite",
        "ignoreIfExists",
        "recursive",
        "ignoreIfNotExists",
      ]) {
        if (options[key] !== undefined && typeof options[key] !== "boolean")
          throw new Error(`Invalid resource operation option ${key}`);
      }
      const { kind } = change;
      if (kind === "rename") {
        const { oldUri, newUri } = change;
        if (typeof oldUri !== "string" || typeof newUri !== "string")
          throw new Error("Rename requires oldUri and newUri");
        const { overwrite, ignoreIfExists } = options;
        result.push({
          kind: "rename",
          file: uriToFile(oldUri),
          newFile: uriToFile(newUri),
          overwrite: overwrite === true,
          ignore: ignoreIfExists === true,
        });
      } else if (kind === "create" || kind === "delete") {
        const { uri } = change;
        if (typeof uri !== "string")
          throw new Error("Resource operation requires a URI");
        const file = uriToFile(uri);
        if (kind === "create") {
          const { overwrite, ignoreIfExists } = options;
          result.push({
            kind: "create",
            file,
            overwrite: overwrite === true,
            ignore: ignoreIfExists === true,
          });
        } else {
          const { recursive, ignoreIfNotExists } = options;
          result.push({
            kind: "delete",
            file,
            recursive: recursive === true,
            ignore: ignoreIfNotExists === true,
          });
        }
      } else
        throw new Error(
          `Unsupported workspace resource operation: ${String(kind)}`,
        );
    }
  } else {
    const { changes } = edit;
    if (changes !== undefined) {
      for (const [uri, edits] of Object.entries(
        record(changes, "workspace changes"),
      ))
        add(uri, edits, null);
    }
  }
  flush();
  if (result.length > 2000)
    throw new Error(
      "Workspace edit exceeds 2000 operations; split it into smaller changes",
    );
  return result;
}

async function entry(file: string): Promise<Entry | null> {
  try {
    const stat = await fs.lstat(file);
    const kind = stat.isSymbolicLink()
      ? "link"
      : stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : undefined;
    if (!kind) throw new Error(`Unsupported filesystem object: ${file}`);
    const signature = `${kind}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (kind === "directory") return { kind, signature };
    if (stat.size > 16 * 1024 * 1024)
      throw new Error(`File exceeds the 16 MiB workspace-edit limit: ${file}`);
    if (kind === "link")
      return { kind, signature: `${signature}:${await fs.readlink(file)}` };
    return { kind, signature, content: await fs.readFile(file, "utf8") };
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/** Enumerates lazily and refuses oversized trees before a rename or recursive delete. */
export async function directoryFiles(
  directory: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const files: string[] = [];
  let visited = 0;
  const visit = async (current: string): Promise<void> => {
    signal?.throwIfAborted();
    const handle = await fs.opendir(current);
    for await (const item of handle) {
      signal?.throwIfAborted();
      if (++visited > 10000)
        throw new Error(
          "Directory traversal exceeds 10000 entries; use smaller targets",
        );
      const file = path.join(current, item.name);
      if (item.isDirectory()) await visit(file);
      else if (item.isFile() || item.isSymbolicLink()) {
        files.push(file);
        if (files.length > 1000)
          throw new Error(
            "Directory contains more than 1000 files; rename in smaller batches",
          );
      } else throw new Error(`Unsupported filesystem object: ${file}`);
    }
  };
  await visit(directory);
  return files.sort();
}

/** Builds a virtual-filesystem plan without writing disk and captures originals for the locked recheck. */
async function plan(
  edit: unknown,
  options: EditOptions,
): Promise<{ changes: PlannedChange[]; originals: Map<string, Entry | null> }> {
  const originals = new Map<string, Entry | null>();
  const virtual = new Map<string, Entry | null>();
  const changes: PlannedChange[] = [];
  let snapshotBytes = 0;
  const load = async (file: string): Promise<Entry | null> => {
    if (virtual.has(file)) return virtual.get(file) ?? null;
    const value = await entry(file);
    originals.set(file, value);
    if (value?.content) snapshotBytes += Buffer.byteLength(value.content);
    if (snapshotBytes > 64 * 1024 * 1024)
      throw new Error(
        "Workspace edit snapshots exceed 64 MiB; use smaller changes",
      );
    virtual.set(file, value);
    return value;
  };
  const tree = async (file: string): Promise<string[]> => {
    const value = await load(file);
    if (value?.kind !== "directory") return value ? [file] : [];
    // Include empty directories: they affect nonrecursive deletion and subtree locking.
    if (originals.get(file)?.kind === "directory") {
      let visited = 0;
      let fileCount = 0;
      const visit = async (directory: string): Promise<void> => {
        const handle = await fs.opendir(directory);
        for await (const item of handle) {
          options.signal?.throwIfAborted();
          if (++visited > 10000)
            throw new Error(
              "Resource operation exceeds 10000 directory entries",
            );
          const child = path.join(directory, item.name);
          await load(child);
          if (item.isDirectory()) await visit(child);
          else if (++fileCount > 1000)
            throw new Error(
              "Resource operation exceeds 1000 files; use smaller changes",
            );
        }
      };
      await visit(file);
    }
    return [...virtual.entries()]
      .filter(([candidate, item]) => item && within(candidate, file))
      .map(([candidate]) => candidate);
  };
  const parents = async (file: string): Promise<void> => {
    let parent = path.dirname(file);
    const absent: string[] = [];
    while (parent !== path.dirname(parent)) {
      const value = await load(parent);
      if (value) {
        if (value.kind !== "directory" && value.kind !== "link")
          throw new Error(`Parent is not a directory: ${parent}`);
        break;
      }
      absent.push(parent);
      parent = path.dirname(parent);
    }
    for (const candidate of absent)
      virtual.set(candidate, { kind: "directory", signature: "created" });
  };
  const canonicalNames = new Map<string, string>();
  for (const op of operations(edit)) {
    options.signal?.throwIfAborted();
    if (op.kind === "text") {
      const documentFile = op.file;
      await load(documentFile);
      try {
        op.file = await fs.realpath(documentFile);
      } catch (error) {
        if (!missing(error) || !virtual.get(documentFile)) throw error;
      }
      const priorName = canonicalNames.get(op.file);
      if (priorName && priorName !== documentFile)
        throw new Error(
          `Workspace edit addresses one file through conflicting aliases: ${priorName}, ${documentFile}`,
        );
      canonicalNames.set(op.file, documentFile);
      if (op.file !== documentFile) op.documentFile = documentFile;
    }
    const before = await load(op.file);
    const label = path.relative(options.cwd, op.file) || op.file;
    if (op.kind === "text") {
      if (op.edits.length === 0) continue;
      if (before?.kind !== "file" || before.content === undefined)
        throw new Error(`Text edit target is not a regular file: ${op.file}`);
      const snapshot = options.documents?.get(op.documentFile ?? op.file);
      const live = options.document?.(op.documentFile ?? op.file);
      if (
        op.version !== null &&
        (!snapshot ||
          !live ||
          op.version !== snapshot.version ||
          op.version !== live.version)
      )
        throw new Error(`Stale or unknown document version for ${label}`);
      if (snapshot && originals.get(op.file)?.content !== snapshot.content)
        throw new Error(
          `File changed since the language-server request: ${label}`,
        );
      const after = applyTextEdits(before.content, op.edits);
      virtual.set(op.file, { ...before, content: after });
      if (after !== before.content)
        changes.push({
          op,
          files: op.documentFile ? [op.file, op.documentFile] : [op.file],
          before: before.content,
          after,
          summary: `Applied ${op.edits.length} edit(s) to ${label}`,
        });
    } else if (op.kind === "create") {
      if (before && !op.overwrite) {
        if (op.ignore) continue;
        throw new Error(`Create target already exists: ${label}`);
      }
      if (before && before.kind !== "file")
        throw new Error(
          `Create cannot overwrite a directory or symlink: ${label}`,
        );
      await parents(op.file);
      virtual.set(op.file, { kind: "file", signature: "created", content: "" });
      changes.push({ op, files: [op.file], summary: `Created ${label}` });
    } else if (op.kind === "delete") {
      if (!before) {
        if (op.ignore) continue;
        throw new Error(`Delete target does not exist: ${label}`);
      }
      const subtree = await tree(op.file);
      if (before.kind === "directory" && !op.recursive && subtree.length > 1)
        throw new Error(`Delete target is a nonempty directory: ${label}`);
      const files = subtree.filter(
        (file) => virtual.get(file)?.kind !== "directory",
      );
      for (const file of subtree) virtual.set(file, null);
      changes.push({ op, files, summary: `Deleted ${label}` });
    } else {
      if (!before) throw new Error(`Rename source does not exist: ${label}`);
      if (
        op.file === op.newFile ||
        within(op.newFile, op.file) ||
        within(op.file, op.newFile)
      )
        throw new Error(
          "Rename source and destination must be distinct, non-nested paths",
        );
      const target = await load(op.newFile);
      if (target && !op.overwrite) {
        if (op.ignore) continue;
        throw new Error(`Rename destination already exists: ${op.newFile}`);
      }
      const sourceTree = await tree(op.file);
      const files = sourceTree.filter(
        (file) => virtual.get(file)?.kind !== "directory",
      );
      const targetTree = await tree(op.newFile);
      const removedFiles = targetTree.filter(
        (file) => virtual.get(file)?.kind !== "directory",
      );
      await parents(op.newFile);
      for (const candidate of targetTree) virtual.set(candidate, null);
      for (const candidate of sourceTree) {
        const destination = path.join(
          op.newFile,
          path.relative(op.file, candidate),
        );
        await load(destination);
        virtual.set(destination, virtual.get(candidate) ?? null);
        virtual.set(candidate, null);
      }
      changes.push({
        op,
        files,
        removedFiles,
        summary: `Renamed ${label} → ${path.relative(options.cwd, op.newFile) || op.newFile}`,
      });
    }
  }
  return { changes, originals };
}

async function lockPaths<T>(
  files: readonly string[],
  work: () => Promise<T>,
): Promise<T> {
  const canonical = new Set<string>();
  for (const file of files) {
    try {
      canonical.add(await fs.realpath(file));
    } catch (error) {
      if (missing(error)) canonical.add(path.resolve(file));
      else throw error;
    }
  }
  const keys = [...canonical].sort();
  const acquire = (index: number): Promise<T> => {
    const key = keys[index];
    return key === undefined
      ? work()
      : withFileMutationQueue(key, () => acquire(index + 1));
  };
  return acquire(0);
}

async function renameWithRestore(
  source: string,
  destination: string,
  overwrite: boolean,
): Promise<void> {
  let displaced: { directory: string; file: string } | undefined;
  if (overwrite && (await entry(destination))) {
    const directory = await fs.mkdtemp(
      path.join(path.dirname(destination), ".pi-lsp-displaced-"),
    );
    const file = path.join(directory, "original");
    try {
      await fs.rename(destination, file);
      displaced = { directory, file };
    } catch (error) {
      await fs.rmdir(directory);
      throw error;
    }
  }
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (displaced) {
      try {
        await fs.rename(displaced.file, destination);
        await fs.rmdir(displaced.directory);
      } catch (restoreError) {
        throw new Error(
          `Rename failed: ${message(error)}; destination restore failed: ${message(restoreError)}. Original retained at ${displaced.file}`,
        );
      }
    }
    throw error;
  }
  if (displaced) {
    try {
      await fs.rm(displaced.directory, { recursive: true });
    } catch (error) {
      throw new Error(
        `Rename committed, but displaced destination cleanup failed at ${displaced.directory}: ${message(error)}`,
      );
    }
  }
}

/**
 * Validates a raw workspace edit before mutation, then rechecks under Pi's shared file locks.
 * Preview and validation failures never write. A later failure can include committed changes;
 * callers must reconcile those changes even when applied is false.
 */
export async function applyWorkspaceEdit(
  edit: unknown,
  options: EditOptions,
): Promise<EditResult> {
  const result: EditResult = { applied: false, summary: [], changes: [] };
  try {
    const planned = await plan(edit, options);
    if (options.preview)
      return {
        applied: true,
        summary: planned.changes.map((change) =>
          change.summary
            .replace(/^Applied /, "Would apply ")
            .replace(/^Created /, "Would create ")
            .replace(/^Deleted /, "Would delete ")
            .replace(/^Renamed /, "Would rename "),
        ),
        changes: [],
      };
    await lockPaths([...planned.originals.keys()], async () => {
      options.signal?.throwIfAborted();
      for (const [file, original] of planned.originals) {
        const current = await entry(file);
        if (
          original?.signature !== current?.signature ||
          original?.content !== current?.content
        )
          throw new Error(
            `File changed while waiting to apply workspace edit: ${file}`,
          );
      }
      for (const change of planned.changes) {
        const { op } = change;
        options.signal?.throwIfAborted();
        try {
          if (op.kind === "text") {
            const live = options.document?.(op.documentFile ?? op.file);
            if (op.version !== null && live?.version !== op.version)
              throw new Error(
                `Document version changed before mutation: ${op.file}`,
              );
            await fs.writeFile(op.file, change.after ?? "", "utf8");
          } else if (op.kind === "create") {
            await fs.mkdir(path.dirname(op.file), { recursive: true });
            await fs.writeFile(op.file, "", {
              flag: op.overwrite ? "w" : "wx",
            });
          } else if (op.kind === "delete") {
            const stat = await fs.lstat(op.file);
            if (stat.isDirectory() && !op.recursive) await fs.rmdir(op.file);
            else await fs.rm(op.file, { recursive: op.recursive });
          } else {
            await fs.mkdir(path.dirname(op.newFile), { recursive: true });
            try {
              await renameWithRestore(op.file, op.newFile, op.overwrite);
            } catch (error) {
              if (
                options.rollbackTextOnRenameFailure &&
                result.changes.every((previous) => previous.kind === "edit") &&
                (await entry(op.file))
              ) {
                const failures: string[] = [];
                for (const previous of [
                  ...planned.changes.slice(0, result.changes.length),
                ].reverse()) {
                  if (
                    previous.op.kind !== "text" ||
                    previous.before === undefined
                  )
                    continue;
                  try {
                    if (
                      (await fs.readFile(previous.op.file, "utf8")) !==
                      previous.after
                    )
                      throw new Error("content changed after edit");
                    await fs.writeFile(
                      previous.op.file,
                      previous.before,
                      "utf8",
                    );
                  } catch (rollbackError) {
                    failures.push(
                      `${previous.op.file}: ${message(rollbackError)}`,
                    );
                  }
                }
                if (failures.length === 0) {
                  result.changes = [];
                  result.summary = [
                    "Reference edits rolled back after rename failure.",
                  ];
                } else
                  result.summary.push(
                    `Rollback failures: ${failures.join("; ")}`,
                  );
              } else if (!(await entry(op.file)) && (await entry(op.newFile))) {
                result.changes.push({
                  kind: "rename",
                  file: op.file,
                  newFile: op.newFile,
                  files: change.files,
                  ...(change.removedFiles
                    ? { removedFiles: change.removedFiles }
                    : {}),
                });
                result.summary.push(change.summary);
              }
              throw error;
            }
          }
        } catch (error) {
          // A rejected filesystem call can still truncate a file or partially remove a tree.
          // Report those effects too, so document reconciliation never assumes the failed call was atomic.
          if (op.kind === "text" || op.kind === "create") {
            const current = await entry(op.file);
            const before =
              op.kind === "text"
                ? change.before
                : planned.originals.get(op.file)?.content;
            if (current?.content !== before) {
              result.changes.push({
                kind: op.kind === "text" ? "edit" : "create",
                file: op.file,
                files: [op.file],
              });
              result.summary.push(
                `Partially changed ${op.file} before filesystem failure`,
              );
            }
          } else if (op.kind === "delete") {
            const removed: string[] = [];
            for (const file of change.files)
              if (!(await entry(file))) removed.push(file);
            if (removed.length) {
              result.changes.push({
                kind: "delete",
                file: op.file,
                files: removed,
              });
              result.summary.push(
                `Partially deleted ${removed.length} file(s) before filesystem failure`,
              );
            }
          } else if (
            (await entry(op.file)) &&
            !(await entry(op.newFile)) &&
            planned.originals.get(op.newFile)
          ) {
            result.changes.push({
              kind: "delete",
              file: op.newFile,
              files: change.removedFiles ?? [op.newFile],
            });
          }
          throw error;
        }
        result.changes.push({
          kind: op.kind === "text" ? "edit" : op.kind,
          file: op.file,
          ...(op.kind === "rename" ? { newFile: op.newFile } : {}),
          files: change.files,
          ...(change.removedFiles ? { removedFiles: change.removedFiles } : {}),
        });
        result.summary.push(change.summary);
      }
    });
    result.applied = true;
  } catch (error) {
    result.failureReason = `${message(error)}${result.changes.length > 0 ? ` (${result.changes.length} earlier operation(s) already committed; not rolled back)` : ""}`;
  }
  return result;
}
