import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CancellationTokenSource,
  createMessageConnection,
  ErrorCodes,
  type MessageConnection,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
  type ClientCapabilities,
  Diagnostic,
  type InitializeParams,
  type ServerCapabilities,
  type TextDocumentSyncOptions,
  type WorkspaceEdit,
} from "vscode-languageserver-protocol";
import { spawnProcess, stopProcess } from "./process.js";
import type { ServerConfig } from "./types.js";

export interface DiagnosticReport {
  items: Diagnostic[];
  freshness: "versioned" | "pull" | "unversioned";
}

export interface LanguageServer {
  readonly config: ServerConfig;
  readonly capabilities: ServerCapabilities;
  readonly isAlive: boolean;
  /** Sends a bounded RPC; the result type does not replace validation of peer data. */
  request<T = unknown>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<T>;
  notify(method: string, params: unknown): Promise<void>;
  /** Opens or updates an absolute-path document in per-file order using UTF-16 positions. */
  syncFile(file: string, content?: string, signal?: AbortSignal): Promise<void>;
  saved(file: string): Promise<void>;
  closeFile(file: string): Promise<void>;
  /** Reports diagnostic provenance; silence or an unversioned report is not verified clean state. */
  diagnostics(
    file: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<DiagnosticReport>;
  /** Returns a detached snapshot for validating later edits against the observed document. */
  document(file: string): { version: number; content: string } | undefined;
  /** Idempotently cancels outstanding work and releases the owned process and transport. */
  shutdown(): Promise<void>;
}

interface PoolOptions {
  cwd: string;
  onApplyEdit: (
    edit: WorkspaceEdit,
    server: LanguageServer,
  ) => Promise<{ applied: boolean; failureReason?: string }>;
  idleTimeoutMs?: number;
}

interface DocumentSnapshot {
  version: number;
  content: string;
}

interface PublishedDiagnostics {
  version: number;
  items: Diagnostic[];
  received: number;
  versioned: boolean;
}

interface Registration {
  id: string;
  method: string;
  options: Record<string, unknown>;
}

const REQUEST_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 5_000;
const DIAGNOSTIC_TIMEOUT_MS = 10_000;
const DIAGNOSTIC_SETTLE_MS = 250;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("LSP operation aborted", "AbortError");
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted(signal);
}

function duration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(value, 2_147_483_647)
    : fallback;
}

/** Bounds a wait, without transferring ownership of a shared operation to its caller. */
function bounded<T>(
  work: Promise<T>,
  signals: readonly (AbortSignal | undefined)[],
  timeoutMs?: number,
  label = "LSP operation",
  onCancel?: () => void,
): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
    const finish = (): boolean => {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      for (const entry of listeners)
        entry.signal.removeEventListener("abort", entry.listener);
      return true;
    };
    const cancel = (error: Error) => {
      if (done) return;
      try {
        onCancel?.();
      } catch (cleanupError) {
        if (finish())
          reject(new AggregateError([error, cleanupError], error.message));
        return;
      }
      if (finish()) reject(error);
    };
    work.then(
      (value) => {
        if (finish()) resolvePromise(value);
      },
      (error: unknown) => {
        if (finish()) reject(asError(error));
      },
    );
    for (const signal of signals) {
      if (!signal) continue;
      if (signal.aborted) {
        cancel(aborted(signal));
        return;
      }
      const listener = () => cancel(aborted(signal));
      listeners.push({ signal, listener });
      signal.addEventListener("abort", listener, { once: true });
    }
    if (timeoutMs !== undefined)
      timer = setTimeout(
        () => cancel(new Error(`${label} timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
  });
}

function pause(
  ms: number,
  signals: readonly (AbortSignal | undefined)[],
): Promise<void> {
  let timer: NodeJS.Timeout;
  const work = new Promise<void>((resolvePromise) => {
    timer = setTimeout(resolvePromise, ms);
  });
  return bounded(work, signals).finally(() => clearTimeout(timer));
}

function fileKey(file: string): string {
  if (!isAbsolute(file))
    throw new Error(`LSP requires an absolute file path: ${file}`);
  const normalized = resolve(file);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function diagnosticItems(value: unknown): Diagnostic[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item: unknown): item is Diagnostic =>
        Diagnostic.is(item) && typeof item.message === "string",
    )
  ) {
    throw new Error("Language server returned malformed diagnostics");
  }
  return value;
}

const aliases: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  rs: "rust",
  py: "python",
  pyi: "python",
  rb: "ruby",
  gemspec: "ruby",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  ksh: "shellscript",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  h: "c",
  m: "objective-c",
  mm: "objective-cpp",
  cs: "csharp",
  fs: "fsharp",
  fsx: "fsharp",
  kt: "kotlin",
  kts: "kotlin",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  edn: "clojure",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hrl: "erlang",
  hs: "haskell",
  lhs: "haskell",
  ml: "ocaml",
  mli: "ocaml",
  pl: "perl",
  pm: "perl",
  r: "r",
  jl: "julia",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  htm: "html",
  xhtml: "html",
  tex: "latex",
  bib: "bibtex",
  tf: "terraform",
  tfvars: "terraform-vars",
  gql: "graphql",
  proto: "protobuf",
  tla: "tlaplus",
  nim: "nim",
  cr: "crystal",
  ps1: "powershell",
  psm1: "powershell",
  el: "elisp",
  sol: "solidity",
  sv: "systemverilog",
};
function languageId(config: ServerConfig, file: string): string {
  const extension = extname(file).toLowerCase();
  const explicit =
    config.extensionToLanguage?.[extension] ??
    config.extensionToLanguage?.[extension.slice(1)] ??
    config.languageId;
  if (explicit) return explicit;
  const name = basename(file).toLowerCase();
  if (/^(dockerfile|containerfile)(\.|$)/.test(name)) return "dockerfile";
  if (name === "cmakelists.txt") return "cmake";
  if (["gemfile", "rakefile", "guardfile"].includes(name)) return "ruby";
  return aliases[extension.slice(1)] ?? (extension.slice(1) || "plaintext");
}

function clientCapabilities(): ClientCapabilities {
  return {
    general: { positionEncodings: ["utf-16"] },
    workspace: {
      applyEdit: true,
      workspaceEdit: {
        documentChanges: true,
        resourceOperations: ["create", "rename", "delete"],
        failureHandling: "abort",
      },
      configuration: true,
      workspaceFolders: true,
      didChangeWatchedFiles: { dynamicRegistration: true },
      fileOperations: {
        dynamicRegistration: true,
        willCreate: true,
        didCreate: true,
        willRename: true,
        didRename: true,
        willDelete: true,
        didDelete: true,
      },
      symbol: { dynamicRegistration: true },
      diagnostics: { refreshSupport: true },
    },
    textDocument: {
      synchronization: {
        dynamicRegistration: false,
        didSave: true,
        willSave: false,
        willSaveWaitUntil: false,
      },
      hover: {
        dynamicRegistration: true,
        contentFormat: ["markdown", "plaintext"],
      },
      definition: { dynamicRegistration: true, linkSupport: true },
      typeDefinition: { dynamicRegistration: true, linkSupport: true },
      implementation: { dynamicRegistration: true, linkSupport: true },
      references: { dynamicRegistration: true },
      documentSymbol: {
        dynamicRegistration: true,
        hierarchicalDocumentSymbolSupport: true,
      },
      rename: { dynamicRegistration: true, prepareSupport: true },
      codeAction: {
        dynamicRegistration: true,
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: [
              "",
              "quickfix",
              "refactor",
              "refactor.extract",
              "refactor.inline",
              "refactor.rewrite",
              "source",
              "source.organizeImports",
              "source.fixAll",
            ],
          },
        },
        resolveSupport: { properties: ["edit"] },
      },
      formatting: { dynamicRegistration: true },
      rangeFormatting: { dynamicRegistration: true },
      publishDiagnostics: {
        relatedInformation: true,
        versionSupport: true,
        tagSupport: { valueSet: [1, 2] },
        codeDescriptionSupport: true,
        dataSupport: true,
      },
      diagnostic: { dynamicRegistration: true },
    },
    window: { workDoneProgress: true },
  };
}

/** Validate framing before vscode-jsonrpc can grow its message buffer. */
class BoundedLspInput extends Transform {
  private readonly header = Buffer.allocUnsafe(16 * 1024);
  private headerBytes = 0;
  private bodyRemaining = 0;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.bodyRemaining > 0) {
          const length = Math.min(this.bodyRemaining, chunk.length - offset);
          this.push(chunk.subarray(offset, offset + length));
          offset += length;
          this.bodyRemaining -= length;
          continue;
        }
        let complete = false;
        while (offset < chunk.length) {
          if (this.headerBytes === this.header.length)
            throw new Error("LSP header exceeds 16 KiB");
          this.header.writeUInt8(chunk.readUInt8(offset++), this.headerBytes++);
          const size = this.headerBytes;
          if (
            size >= 4 &&
            this.header[size - 4] === 13 &&
            this.header[size - 3] === 10 &&
            this.header[size - 2] === 13 &&
            this.header[size - 1] === 10
          ) {
            complete = true;
            break;
          }
        }
        if (!complete) continue;
        const header = this.header.subarray(0, this.headerBytes);
        const lengths = header
          .toString("ascii")
          .split("\r\n")
          .filter((line) => /^content-length:/i.test(line));
        const rawLength =
          lengths.length === 1
            ? lengths[0]?.match(/^content-length:\s*(\d+)\s*$/i)?.[1]
            : undefined;
        const length = rawLength === undefined ? NaN : Number(rawLength);
        if (!Number.isSafeInteger(length) || length <= 0)
          throw new Error("Invalid LSP Content-Length header");
        if (length > 16 * 1024 * 1024)
          throw new Error("LSP message exceeds 16 MiB");
        // The header storage is reused; the downstream reader owns this copy.
        this.push(Buffer.from(header));
        this.headerBytes = 0;
        this.bodyRemaining = length;
      }
      callback();
    } catch (error) {
      callback(asError(error));
    }
  }

  override _flush(callback: TransformCallback): void {
    callback(
      this.headerBytes || this.bodyRemaining
        ? new Error("LSP transport ended with an incomplete message")
        : undefined,
    );
  }
}

class StdioLanguageServer implements LanguageServer {
  readonly config: ServerConfig;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly input = new BoundedLspInput();
  private readonly options: PoolOptions;
  private readonly connection: MessageConnection;
  private readonly lifetime = new AbortController();
  private readonly documents = new Map<string, DocumentSnapshot>();
  private readonly publications = new Map<string, PublishedDiagnostics>();
  private readonly diagnosticErrors = new Map<string, Error>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly registrations = new Map<string, Registration>();
  private readonly cancellationTimers = new Set<NodeJS.Timeout>();
  private readonly progress = new Set<string | number>();
  private baseCapabilities: ServerCapabilities = {};
  private effectiveCapabilities: ServerCapabilities = {};
  private version = 0;
  private initialized = false;
  private shutdownPromise: Promise<void> | undefined;
  private failure: Error | undefined;
  private stderr = "";
  private activity = Date.now();
  private busy = 0;

  constructor(config: ServerConfig, options: PoolOptions) {
    this.config = config;
    this.options = options;
    this.child = spawnProcess(
      config.resolvedCommand ?? config.command,
      config.args,
      {
        cwd: config.root || options.cwd,
        ...(config.env ? { env: config.env } : {}),
      },
    );
    this.child.stderr.on("data", this.onStderr);
    this.child.stderr.on("error", this.onProcessError);
    this.child.on("error", this.onProcessError);
    this.child.once("exit", this.onExit);
    this.connection = createMessageConnection(
      new StreamMessageReader(this.input),
      new StreamMessageWriter(this.child.stdin),
    );
    this.input.on("error", this.onProcessError);
    this.child.stdout.on("error", this.onProcessError);
    this.connection.onClose(() =>
      this.fail(
        new Error(
          `LSP ${config.name} closed its transport${this.stderrSuffix()}`,
        ),
      ),
    );
    this.connection.onError(([error]) => this.fail(error));
    this.connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: unknown) => this.publish(params),
    );
    this.connection.onNotification("$/progress", (params: unknown) => {
      if (!record(params)) return;
      const { value, token } = params;
      if (
        !record(value) ||
        (typeof token !== "string" && typeof token !== "number")
      )
        return;
      const { kind } = value;
      if (kind === "begin") this.progress.add(token);
      if (kind === "end") this.progress.delete(token);
    });
    this.connection.onRequest((method: string, params: unknown) =>
      this.serverRequest(method, params),
    );
    this.connection.listen();
    this.child.stdout.pipe(this.input);
  }

  get capabilities(): ServerCapabilities {
    return this.effectiveCapabilities;
  }
  get isAlive(): boolean {
    return (
      !this.lifetime.signal.aborted &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }

  touch(): void {
    this.activity = Date.now();
  }
  idleFor(now: number): number {
    return this.busy === 0 ? now - this.activity : 0;
  }

  private readonly onStderr = (data: Buffer | string): void => {
    this.stderr = (this.stderr + String(data)).slice(-16_384);
  };
  private readonly onProcessError = (error: Error): void => {
    this.fail(error);
  };
  private readonly onExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    this.fail(
      new Error(
        `LSP ${this.config.name} exited (${signal ?? code ?? "unknown"})${this.stderrSuffix()}`,
      ),
    );
  };

  private stderrSuffix(): string {
    return this.stderr.trim() ? `: ${this.stderr.trim()}` : "";
  }

  private fail(error: Error): void {
    if (this.lifetime.signal.aborted) return;
    this.failure = error;
    this.lifetime.abort(error);
    void this.shutdown().catch((cleanupError: unknown) => {
      this.failure = new AggregateError(
        [error, cleanupError],
        `LSP ${this.config.name} cleanup failed`,
      );
    });
  }

  private assertAlive(): void {
    if (!this.isAlive)
      throw this.failure ?? new Error(`LSP ${this.config.name} is stopped`);
  }

  private async active<T>(work: () => Promise<T>): Promise<T> {
    this.assertAlive();
    this.busy++;
    this.touch();
    try {
      return await work();
    } finally {
      this.busy--;
      this.touch();
    }
  }

  async initialize(signal: AbortSignal): Promise<void> {
    const root = this.config.root || this.options.cwd;
    const params: InitializeParams = {
      processId: process.pid,
      clientInfo: { name: "pi-lsp", version: "1.0.0" },
      rootPath: root,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [
        { uri: pathToFileURL(root).href, name: basename(root) || "workspace" },
      ],
      capabilities: clientCapabilities(),
      initializationOptions: this.config.initOptions ?? {},
    };
    const result = await this.request<unknown>(
      "initialize",
      params,
      signal,
      duration(this.config.warmupTimeoutMs, REQUEST_TIMEOUT_MS),
    );
    if (!record(result))
      throw new Error(
        `LSP ${this.config.name} returned an invalid initialize result`,
      );
    const { capabilities } = result;
    if (!record(capabilities))
      throw new Error(
        `LSP ${this.config.name} returned an invalid initialize result`,
      );
    const { positionEncoding, textDocumentSync: sync } = capabilities;
    if (positionEncoding !== undefined && positionEncoding !== "utf-16")
      throw new Error(
        `LSP ${this.config.name} selected unsupported position encoding: ${String(positionEncoding)}`,
      );
    if (
      sync !== undefined &&
      !(typeof sync === "number" && [0, 1, 2].includes(sync)) &&
      !record(sync)
    )
      throw new Error(
        `LSP ${this.config.name} returned invalid text synchronization capabilities`,
      );
    if (record(sync)) {
      const { change, openClose, save } = sync;
      if (
        (change !== undefined &&
          (typeof change !== "number" || ![0, 1, 2].includes(change))) ||
        (openClose !== undefined && typeof openClose !== "boolean") ||
        (save !== undefined && typeof save !== "boolean" && !record(save))
      )
        throw new Error(
          `LSP ${this.config.name} returned invalid text synchronization options`,
        );
    }
    this.baseCapabilities = capabilities as ServerCapabilities;
    this.updateCapabilities();
    check(signal);
    await this.notify("initialized", {});
    this.initialized = true;
    await this.notify("workspace/didChangeConfiguration", {
      settings: this.config.settings ?? {},
    });
    await this.waitForWorkspace(signal);
    check(signal);
    this.assertAlive();
  }

  private async waitForWorkspace(
    signal?: AbortSignal,
    timeoutMs = 10_000,
  ): Promise<void> {
    const rust = [this.config.command, this.config.resolvedCommand].some(
      (command) =>
        command !== undefined &&
        /^rust-analyzer(?:\.exe)?$/.test(basename(command)),
    );
    const timings = this.config.workspaceReadyTimings;
    const start = Date.now();
    let quietSince = start;
    const deadline =
      start + Math.min(duration(timings?.timeoutMs, 10_000), timeoutMs);
    while (Date.now() < deadline) {
      check(signal);
      if (rust) {
        const status = await this.request<unknown>(
          "rust-analyzer/analyzerStatus",
          {},
          signal,
          Math.min(
            duration(timings?.statusRequestTimeoutMs, 1_000),
            Math.max(1, deadline - Date.now()),
          ),
        );
        if (typeof status !== "string")
          throw new Error("rust-analyzer returned an invalid workspace status");
        if (
          !status.startsWith("No workspaces") &&
          this.progress.size === 0 &&
          Date.now() - start >= duration(timings?.settleMs, 2_000)
        )
          return;
      } else if (this.progress.size > 0) {
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= duration(timings?.settleMs, 100))
        return;
      await pause(
        Math.min(
          duration(timings?.pollMs, 100),
          Math.max(1, deadline - Date.now()),
        ),
        [signal, this.lifetime.signal],
      );
    }
    throw new Error(`LSP ${this.config.name} workspace readiness timed out`);
  }

  private async rpc<T>(
    method: string,
    params: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    stopping = false,
  ): Promise<T> {
    check(signal);
    if (!stopping) this.assertAlive();
    const source = new CancellationTokenSource();
    let settled = false;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let work: Promise<T>;
    try {
      work = this.connection.sendRequest<T>(method, params, source.token);
    } catch (error) {
      source.dispose();
      throw error;
    }
    const settle = () => {
      settled = true;
      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        this.cancellationTimers.delete(cleanupTimer);
      }
      source.dispose();
    };
    void work.then(settle, settle);
    return bounded(
      work,
      [signal, ...(stopping ? [] : [this.lifetime.signal])],
      timeoutMs,
      `LSP ${this.config.name} ${method}`,
      () => {
        source.cancel();
        // jsonrpc retains canceled response slots until a reply. Kill a server that ignores cancellation rather than leak them forever.
        if (!settled && !this.lifetime.signal.aborted && !stopping) {
          cleanupTimer = setTimeout(() => {
            if (cleanupTimer) this.cancellationTimers.delete(cleanupTimer);
            if (!settled)
              this.fail(
                new Error(
                  `LSP ${this.config.name} ignored cancellation of ${method}`,
                ),
              );
          }, 1_000);
          this.cancellationTimers.add(cleanupTimer);
        }
      },
    );
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<T> {
    return this.active(async () => {
      const timeout = duration(timeoutMs, REQUEST_TIMEOUT_MS);
      const deadline = Date.now() + timeout;
      if (
        this.initialized &&
        this.progress.size > 0 &&
        method !== "rust-analyzer/analyzerStatus"
      )
        await this.waitForWorkspace(signal, timeout);
      return this.rpc<T>(
        method,
        params,
        signal,
        Math.max(1, deadline - Date.now()),
      );
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.active(async () => {
      try {
        await bounded(
          this.connection.sendNotification(method, params),
          [this.lifetime.signal],
          WRITE_TIMEOUT_MS,
          `LSP ${this.config.name} ${method}`,
        );
      } catch (error) {
        this.fail(asError(error));
        throw error;
      }
    });
  }

  private syncOptions(): TextDocumentSyncOptions {
    const sync = this.capabilities.textDocumentSync;
    if (typeof sync === "number")
      return { openClose: sync !== 0, change: sync };
    return sync ?? {};
  }

  private queue<T>(
    file: string,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = fileKey(file);
    const prior = this.queues.get(key) ?? Promise.resolve();
    const result = prior.then(() => {
      check(signal);
      return this.active(work);
    });
    const barrier = result.then(
      () => {},
      () => {},
    );
    this.queues.set(key, barrier);
    void barrier.then(() => {
      if (this.queues.get(key) === barrier) this.queues.delete(key);
    });
    return bounded(result, [signal, this.lifetime.signal]);
  }

  syncFile(
    file: string,
    content?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.queue(file, signal, async () => {
      const key = fileKey(file);
      let text = content;
      if (text === undefined) {
        const readController = new AbortController();
        const readSignal = AbortSignal.any([
          readController.signal,
          this.lifetime.signal,
          ...(signal ? [signal] : []),
        ]);
        text = await bounded(
          readFile(file, { encoding: "utf8", signal: readSignal }),
          [readSignal],
          WRITE_TIMEOUT_MS,
          `Reading ${file}`,
          () => readController.abort(),
        );
      }
      check(signal);
      const prior = this.documents.get(key);
      if (prior?.content === text) return;
      const sync = this.syncOptions();
      if (prior && !sync.change && !sync.openClose)
        throw new Error(
          `LSP ${this.config.name} cannot synchronize changes to ${file}`,
        );
      const snapshot: DocumentSnapshot = {
        version: ++this.version,
        content: text,
      };
      this.documents.set(key, snapshot);
      this.publications.delete(key);
      this.diagnosticErrors.delete(key);
      const uri = pathToFileURL(file).href;
      if (!prior || !sync.change) {
        if (prior && sync.openClose)
          await this.notify("textDocument/didClose", { textDocument: { uri } });
        if (sync.openClose)
          await this.notify("textDocument/didOpen", {
            textDocument: {
              uri,
              languageId: languageId(this.config, file),
              version: snapshot.version,
              text,
            },
          });
      } else {
        let change: {
          text: string;
          range?: {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
        } = { text };
        if (sync.change === 2) {
          let line = 0;
          let lineStart = 0;
          for (let index = 0; index < prior.content.length; index++) {
            const char = prior.content.charCodeAt(index);
            if (char === 13 || char === 10) {
              if (char === 13 && prior.content.charCodeAt(index + 1) === 10)
                index++;
              line++;
              lineStart = index + 1;
            }
          }
          change = {
            text,
            range: {
              start: { line: 0, character: 0 },
              end: { line, character: prior.content.length - lineStart },
            },
          };
        }
        await this.notify("textDocument/didChange", {
          textDocument: { uri, version: snapshot.version },
          contentChanges: [change],
        });
      }
    });
  }

  saved(file: string): Promise<void> {
    return this.queue(file, undefined, async () => {
      const snapshot = this.documents.get(fileKey(file));
      const save = this.syncOptions().save;
      const uri = pathToFileURL(file).href;
      if (snapshot && save)
        await this.notify("textDocument/didSave", {
          textDocument: { uri },
          ...(typeof save === "object" && save.includeText
            ? { text: snapshot.content }
            : {}),
        });
      if (
        [...this.registrations.values()].some(
          (registration) =>
            registration.method === "workspace/didChangeWatchedFiles",
        )
      )
        await this.notify("workspace/didChangeWatchedFiles", {
          changes: [{ uri, type: 2 }],
        });
    });
  }

  closeFile(file: string): Promise<void> {
    return this.queue(file, undefined, async () => {
      const key = fileKey(file);
      const existed = this.documents.delete(key);
      this.publications.delete(key);
      this.diagnosticErrors.delete(key);
      if (existed && this.syncOptions().openClose)
        await this.notify("textDocument/didClose", {
          textDocument: { uri: pathToFileURL(file).href },
        });
    });
  }

  document(file: string): DocumentSnapshot | undefined {
    const snapshot = this.documents.get(fileKey(file));
    return snapshot ? { ...snapshot } : undefined;
  }

  private publish(params: unknown): void {
    if (!record(params)) {
      this.fail(
        new Error(
          "Language server published diagnostics without a document URI",
        ),
      );
      return;
    }
    const { uri, version, diagnostics } = params;
    if (typeof uri !== "string") {
      this.fail(
        new Error(
          "Language server published diagnostics without a document URI",
        ),
      );
      return;
    }
    let key: string;
    try {
      key = fileKey(fileURLToPath(uri));
    } catch {
      return;
    }
    const document = this.documents.get(key);
    if (!document) return;
    if (
      version !== undefined &&
      version !== null &&
      (!Number.isInteger(version) || version !== document.version)
    )
      return;
    try {
      this.publications.set(key, {
        version: document.version,
        items: diagnosticItems(diagnostics),
        received: Date.now(),
        versioned: version === document.version,
      });
      this.diagnosticErrors.delete(key);
    } catch (error) {
      this.publications.delete(key);
      this.diagnosticErrors.set(key, asError(error));
    }
  }

  diagnostics(
    file: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<DiagnosticReport> {
    const controller = new AbortController();
    const operationSignal = AbortSignal.any([
      controller.signal,
      this.lifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    const timeout = duration(timeoutMs, DIAGNOSTIC_TIMEOUT_MS);
    const timeoutError = new Error(
      `LSP ${this.config.name} diagnostics timed out for ${file}; clean state is unverified`,
    );
    const timer = setTimeout(() => controller.abort(timeoutError), timeout);
    return this.active<DiagnosticReport>(async () => {
      check(operationSignal);
      const deadline = Date.now() + timeout;
      await this.syncFile(file, undefined, operationSignal);
      const key = fileKey(file);
      const snapshot = this.documents.get(key);
      if (!snapshot)
        throw new Error(
          `LSP document closed while requesting diagnostics: ${file}`,
        );
      check(operationSignal);
      if (this.capabilities.diagnosticProvider) {
        const provider = this.capabilities.diagnosticProvider;
        const report = await this.request<unknown>(
          "textDocument/diagnostic",
          {
            textDocument: { uri: pathToFileURL(file).href },
            ...(provider.identifier ? { identifier: provider.identifier } : {}),
          },
          operationSignal,
          Math.max(1, deadline - Date.now()),
        );
        if (this.documents.get(key) !== snapshot)
          throw new Error(`LSP diagnostics superseded by changes to ${file}`);
        if (!record(report))
          throw new Error(
            `LSP ${this.config.name} returned no complete diagnostic report for ${file}`,
          );
        const { kind, items } = report;
        if (kind !== "full")
          throw new Error(
            `LSP ${this.config.name} returned no complete diagnostic report for ${file}`,
          );
        return { items: diagnosticItems(items), freshness: "pull" };
      }
      while (Date.now() < deadline) {
        check(operationSignal);
        this.assertAlive();
        if (this.documents.get(key) !== snapshot)
          throw new Error(`LSP diagnostics superseded by changes to ${file}`);
        const error = this.diagnosticErrors.get(key);
        if (error) throw error;
        const published = this.publications.get(key);
        if (
          published?.version === snapshot.version &&
          (published.versioned ||
            Date.now() - published.received >= DIAGNOSTIC_SETTLE_MS) &&
          this.progress.size === 0
        ) {
          return {
            items: published.items,
            freshness: published.versioned ? "versioned" : "unversioned",
          };
        }
        await pause(Math.min(50, Math.max(1, deadline - Date.now())), [
          operationSignal,
        ]);
      }
      throw new Error(
        `LSP ${this.config.name} diagnostics timed out for ${file}; no fresh complete report (clean state is unverified)`,
      );
    }).finally(() => clearTimeout(timer));
  }

  private updateCapabilities(): void {
    const capabilities = { ...this.baseCapabilities };
    const names: Record<string, keyof ServerCapabilities> = {
      "textDocument/hover": "hoverProvider",
      "textDocument/definition": "definitionProvider",
      "textDocument/typeDefinition": "typeDefinitionProvider",
      "textDocument/implementation": "implementationProvider",
      "textDocument/references": "referencesProvider",
      "textDocument/documentSymbol": "documentSymbolProvider",
      "textDocument/rename": "renameProvider",
      "textDocument/codeAction": "codeActionProvider",
      "textDocument/formatting": "documentFormattingProvider",
      "textDocument/rangeFormatting": "documentRangeFormattingProvider",
      "workspace/symbol": "workspaceSymbolProvider",
      "workspace/executeCommand": "executeCommandProvider",
    };
    for (const registration of this.registrations.values()) {
      if (registration.method === "textDocument/diagnostic") {
        capabilities.diagnosticProvider = {
          interFileDependencies: false,
          workspaceDiagnostics: false,
          ...registration.options,
        };
      } else if (
        registration.method.startsWith("workspace/") &&
        /\/(will|did)(Create|Rename|Delete)Files$/.test(registration.method)
      ) {
        const operation = registration.method.slice("workspace/".length);
        capabilities.workspace = {
          ...capabilities.workspace,
          fileOperations: {
            ...capabilities.workspace?.fileOperations,
            [operation]: registration.options,
          },
        };
      } else {
        const name = names[registration.method];
        if (name) Object.assign(capabilities, { [name]: registration.options });
      }
    }
    this.effectiveCapabilities = capabilities;
  }

  private async serverRequest(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    this.assertAlive();
    switch (method) {
      case "workspace/configuration": {
        if (!record(params))
          throw new ResponseError(
            ErrorCodes.InvalidParams,
            "Expected configuration items",
          );
        const { items } = params;
        if (!Array.isArray(items))
          throw new ResponseError(
            ErrorCodes.InvalidParams,
            "Expected configuration items",
          );
        return items.map((item: unknown) => {
          if (!record(item))
            throw new ResponseError(
              ErrorCodes.InvalidParams,
              "Invalid configuration item",
            );
          const { section } = item;
          if (section !== undefined && typeof section !== "string")
            throw new ResponseError(
              ErrorCodes.InvalidParams,
              "Invalid configuration item",
            );
          let value: unknown = this.config.settings ?? {};
          if (typeof section === "string" && section) {
            if (record(value) && Object.hasOwn(value, section))
              return value[section];
            for (const part of section.split("."))
              value =
                record(value) && Object.hasOwn(value, part)
                  ? value[part]
                  : undefined;
          }
          return value ?? null;
        });
      }
      case "workspace/workspaceFolders": {
        const root = this.config.root || this.options.cwd;
        return [
          {
            uri: pathToFileURL(root).href,
            name: basename(root) || "workspace",
          },
        ];
      }
      case "workspace/applyEdit": {
        if (!record(params))
          return { applied: false, failureReason: "Invalid workspace edit" };
        const { edit } = params;
        if (!record(edit))
          return { applied: false, failureReason: "Invalid workspace edit" };
        try {
          return await this.options.onApplyEdit(edit as WorkspaceEdit, this);
        } catch (error) {
          return { applied: false, failureReason: asError(error).message };
        }
      }
      case "client/registerCapability": {
        if (!record(params))
          throw new ResponseError(
            ErrorCodes.InvalidParams,
            "Expected registrations",
          );
        const { registrations } = params;
        if (!Array.isArray(registrations))
          throw new ResponseError(
            ErrorCodes.InvalidParams,
            "Expected registrations",
          );
        const additions: Registration[] = registrations.map(
          (value: unknown) => {
            if (!record(value))
              throw new ResponseError(
                ErrorCodes.InvalidParams,
                "Invalid capability registration",
              );
            const { id, method, registerOptions } = value;
            if (
              typeof id !== "string" ||
              typeof method !== "string" ||
              (registerOptions !== undefined && !record(registerOptions))
            )
              throw new ResponseError(
                ErrorCodes.InvalidParams,
                "Invalid capability registration",
              );
            return {
              id,
              method,
              options: registerOptions ?? {},
            };
          },
        );
        for (const entry of additions) this.registrations.set(entry.id, entry);
        this.updateCapabilities();
        return null;
      }
      case "client/unregisterCapability": {
        if (!record(params))
          throw new ResponseError(
            ErrorCodes.InvalidParams,
            "Expected unregistrations",
          );
        const { unregisterations, unregistrations } = params;
        const entries = unregisterations ?? unregistrations;
        if (
          !Array.isArray(entries) ||
          !entries.every((entry: unknown) => {
            if (!record(entry)) return false;
            const { id } = entry;
            return typeof id === "string";
          })
        )
          throw new ResponseError(
            ErrorCodes.InvalidParams,
            "Invalid capability unregistration",
          );
        for (const entry of entries as Array<{ id: string }>)
          this.registrations.delete(entry.id);
        this.updateCapabilities();
        return null;
      }
      case "window/workDoneProgress/create":
        return null;
      case "window/showMessageRequest":
        return null;
      case "window/showDocument":
        return { success: false };
      case "workspace/diagnostic/refresh":
        this.publications.clear();
        this.diagnosticErrors.clear();
        return null;
      case "workspace/semanticTokens/refresh":
      case "workspace/inlayHint/refresh":
      case "workspace/codeLens/refresh":
      case "workspace/codeAction/refresh":
      case "workspace/inlineValue/refresh":
      case "workspace/foldingRange/refresh":
        return null;
      default:
        throw new ResponseError(
          ErrorCodes.MethodNotFound,
          `Unsupported client request: ${method}`,
        );
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const graceful = !this.lifetime.signal.aborted && this.initialized;
    this.lifetime.abort(
      this.failure ?? new Error(`LSP ${this.config.name} stopped`),
    );
    this.shutdownPromise = (async () => {
      try {
        if (
          graceful &&
          this.child.exitCode === null &&
          this.child.signalCode === null
        ) {
          let exitListener: (() => void) | undefined;
          const exited = new Promise<void>((resolvePromise) => {
            exitListener = resolvePromise;
            this.child.once("exit", resolvePromise);
          });
          try {
            await this.rpc("shutdown", null, undefined, 1_000, true);
            await bounded(
              this.connection.sendNotification("exit"),
              [],
              500,
              "LSP exit",
            );
            await bounded(exited, [], 500, "LSP graceful exit");
          } catch {
            /* A dead or non-cooperating server still gets process-group termination. */
          } finally {
            if (exitListener) this.child.off("exit", exitListener);
          }
        }
      } finally {
        for (const timer of this.cancellationTimers) clearTimeout(timer);
        this.cancellationTimers.clear();
        this.connection.dispose();
        this.child.stdout.unpipe(this.input);
        this.input.destroy();
        this.child.stdin.destroy();
        this.child.stdout.destroy();
        this.child.stderr.destroy();
        try {
          await stopProcess(this.child);
        } finally {
          this.input.off("error", this.onProcessError);
          this.child.stdout.off("error", this.onProcessError);
          this.child.stderr.off("data", this.onStderr);
          this.child.stderr.off("error", this.onProcessError);
          this.child.off("error", this.onProcessError);
          this.child.off("exit", this.onExit);
          this.documents.clear();
          this.publications.clear();
          this.diagnosticErrors.clear();
          this.registrations.clear();
          this.progress.clear();
          this.queues.clear();
        }
      }
    })();
    return this.shutdownPromise;
  }
}

interface PoolEntry {
  server: StdioLanguageServer;
  controller: AbortController;
  ready: Promise<LanguageServer>;
  stopping?: Promise<void>;
  initialized: boolean;
}

/** Owns a session's shared server startups, live processes, and optional idle timer. */
export class LanguageServerPool {
  private readonly options: PoolOptions;
  private readonly entries = new Map<string, PoolEntry>();
  private readonly idleTimer: NodeJS.Timeout | undefined;
  private disposePromise: Promise<void> | undefined;
  private disposed = false;

  constructor(options: PoolOptions) {
    this.options = options;
    if (options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0) {
      const timeout = duration(options.idleTimeoutMs, 60_000);
      this.idleTimer = setInterval(
        () => {
          for (const [key, entry] of this.entries) {
            if (
              entry.initialized &&
              !entry.stopping &&
              entry.server.idleFor(Date.now()) >= timeout
            )
              void this.stopEntry(key, entry).catch(() => {});
          }
        },
        Math.min(timeout, 1_000),
      );
      this.idleTimer.unref();
    }
  }

  /**
   * Reuses startup by effective configuration.
   * Canceling one caller's wait leaves shared startup alive; stop/dispose owns cancellation.
   */
  async get(
    config: ServerConfig,
    signal?: AbortSignal,
  ): Promise<LanguageServer> {
    check(signal);
    if (this.disposed) throw new Error("LSP pool is disposed");
    if (config.disabled) throw new Error(`LSP ${config.name} is disabled`);
    const key = JSON.stringify([
      config.name,
      config.root || this.options.cwd,
      config.resolvedCommand ?? config.command,
      config.args,
      config.env,
      config.initOptions,
      config.settings,
    ]);
    let entry = this.entries.get(key);
    if (entry && (entry.stopping || !entry.server.isAlive)) {
      await bounded(this.stopEntry(key, entry), [signal]);
      return this.get(config, signal);
    }
    if (!entry) {
      const server = new StdioLanguageServer(config, this.options);
      const controller = new AbortController();
      entry = {
        server,
        controller,
        ready: Promise.resolve(server),
        initialized: false,
      };
      const current = entry;
      this.entries.set(key, current);
      current.ready = server
        .initialize(controller.signal)
        .then(() => {
          if (this.disposed || current.stopping || controller.signal.aborted)
            throw new Error(`LSP ${config.name} startup was stopped`);
          current.initialized = true;
          server.touch();
          return server;
        })
        .catch(async (error: unknown) => {
          try {
            await server.shutdown();
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              `LSP ${config.name} startup and cleanup failed`,
            );
          }
          if (this.entries.get(key) === current && !current.stopping)
            this.entries.delete(key);
          throw error;
        });
    }
    entry.server.touch();
    const server = await bounded(entry.ready, [signal]);
    check(signal);
    if (this.disposed || entry.stopping || !server.isAlive)
      throw new Error(
        `LSP ${config.name} was stopped before acquisition completed`,
      );
    return server;
  }

  /** Returns initialized, live clients without starting any processes. */
  clients(): readonly LanguageServer[] {
    return [...this.entries.values()]
      .filter(
        (entry) => entry.initialized && !entry.stopping && entry.server.isAlive,
      )
      .map((entry) => entry.server);
  }

  private stopEntry(key: string, entry: PoolEntry): Promise<void> {
    if (entry.stopping) return entry.stopping;
    entry.controller.abort(
      new Error(`LSP ${entry.server.config.name} startup was stopped`),
    );
    entry.stopping = (async () => {
      const results = await Promise.allSettled([
        entry.server.shutdown(),
        entry.ready,
      ]);
      const shutdown = results[0];
      if (shutdown?.status === "rejected") throw shutdown.reason;
      if (this.entries.get(key) === entry) this.entries.delete(key);
    })();
    return entry.stopping;
  }

  /** Stops selected server names, or all servers, and reports aggregated shutdown failures. */
  async stop(names?: readonly string[]): Promise<void> {
    const results = await Promise.allSettled(
      [...this.entries]
        .filter(
          ([, entry]) =>
            names === undefined || names.includes(entry.server.config.name),
        )
        .map(([key, entry]) => this.stopEntry(key, entry)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Failed to stop language servers");
  }

  /** Idempotently prevents new acquisitions, clears idle polling, and stops every owned server. */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    clearInterval(this.idleTimer);
    this.disposePromise = this.stop();
    return this.disposePromise;
  }
}
