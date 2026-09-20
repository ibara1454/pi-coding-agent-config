import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve } from "node:path";
import process from "node:process";
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
import { spawnProcess, stopProcess } from "./process.ts";
import type { ServerConfig } from "./types.ts";

export interface DiagnosticReport {
  items: Diagnostic[];
  freshness: "versioned" | "pull" | "unversioned";
}

export interface LanguageServer {
  readonly config: ServerConfig;
  readonly capabilities: ServerCapabilities;
  readonly isAlive: boolean;
  /** Sends bounded RPC; result type does not replace validation peer data. */
  request: <T = unknown>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
  ) => Promise<T>;
  notify: (method: string, params: unknown) => Promise<void>;
  /** Opens or updates an absolute-path document in per-file order using UTF-16 positions. */
  syncFile: (
    file: string,
    content?: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  saved: (file: string) => Promise<void>;
  closeFile: (file: string) => Promise<void>;
  /** Reports diagnostic provenance; silence or an unversioned report is not verified clean state. */
  diagnostics: (
    file: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ) => Promise<DiagnosticReport>;
  /** Returns detached snapshot validating later edits against observed document. */
  document: (file: string) => { version: number; content: string } | undefined;
  /** Idempotently cancels outstanding work and releases owned process transport. */
  shutdown: () => Promise<void>;
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
const WRITE_TIMEOUT_MS = 5000;
const DIAGNOSTIC_TIMEOUT_MS = 10_000;
const DIAGNOSTIC_SETTLE_MS = 250;

const CONTAINER_FILENAME = /^(dockerfile|containerfile)(\.|$)/;
const CONTENT_LENGTH_HEADER = /^content-length:/i;
const CONTENT_LENGTH_VALUE = /^content-length:\s*(\d+)\s*$/i;
const RUST_ANALYZER_COMMAND = /^rust-analyzer(?:\.exe)?$/;
const FILE_OPERATION_METHOD = /\/(will|did)(Create|Rename|Delete)Files$/;

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
  if (signal?.aborted) {
    throw aborted(signal);
  }
}

function duration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(value, 2_147_483_647)
    : fallback;
}

/**
 * Bounds a caller's wait without transferring ownership of shared work.
 * @param work - Shared operation whose result remains observed after cancellation.
 * @param signals - Caller and owner lifetimes that may cancel this wait.
 * @param options - Optional timeout, error label, and cancellation callback.
 * @returns The work result, or a rejection after cancellation or timeout.
 * @example bounded(startup, [signal], { timeoutMs: 1000 }) cancels only this wait.
 */
function bounded<T>(
  work: Promise<T>,
  signals: readonly (AbortSignal | undefined)[],
  options: {
    timeoutMs?: number;
    label?: string;
    onCancel?: () => void;
  } = {},
): Promise<T> {
  const { timeoutMs, label = "LSP operation", onCancel } = options;
  return new Promise<T>((resolvePromise, reject) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
    const finish = (): boolean => {
      if (done) {
        return false;
      }
      done = true;
      clearTimeout(timer);
      for (const entry of listeners) {
        entry.signal.removeEventListener("abort", entry.listener);
      }
      return true;
    };
    const cancel = (error: Error) => {
      if (done) {
        return;
      }
      try {
        onCancel?.();
      } catch (cleanupError) {
        if (finish()) {
          reject(new AggregateError([error, cleanupError], error.message));
        }
        return;
      }
      if (finish()) {
        reject(error);
      }
    };
    work.then(
      (value) => {
        if (finish()) {
          resolvePromise(value);
        }
      },
      (error: unknown) => {
        if (finish()) {
          reject(asError(error));
        }
      },
    );
    for (const signal of signals) {
      if (!signal) {
        continue;
      }
      if (signal.aborted) {
        cancel(aborted(signal));
        return;
      }
      const listener = () => cancel(aborted(signal));
      listeners.push({ signal, listener });
      signal.addEventListener("abort", listener, { once: true });
    }
    if (timeoutMs !== undefined) {
      timer = setTimeout(
        () => cancel(new Error(`${label} timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
    }
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
  if (!isAbsolute(file)) {
    throw new Error(`LSP requires an absolute file path: ${file}`);
  }
  const normalized = resolve(file);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function diagnosticItems(value: unknown): Diagnostic[] {
  if (
    !(
      Array.isArray(value) &&
      value.every(
        (item: unknown): item is Diagnostic =>
          Diagnostic.is(item) && typeof item.message === "string",
      )
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
  if (explicit) {
    return explicit;
  }
  const name = basename(file).toLowerCase();
  if (CONTAINER_FILENAME.test(name)) {
    return "dockerfile";
  }
  if (name === "cmakelists.txt") {
    return "cmake";
  }
  if (["gemfile", "rakefile", "guardfile"].includes(name)) {
    return "ruby";
  }
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
          if (this.headerBytes === this.header.length) {
            throw new Error("LSP header exceeds 16 KiB");
          }
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
        if (!complete) {
          continue;
        }
        const header = this.header.subarray(0, this.headerBytes);
        const lengths = header
          .toString("ascii")
          .split("\r\n")
          .filter((line) => CONTENT_LENGTH_HEADER.test(line));
        const rawLength =
          lengths.length === 1
            ? lengths[0]?.match(CONTENT_LENGTH_VALUE)?.[1]
            : undefined;
        const length = rawLength === undefined ? Number.NaN : Number(rawLength);
        if (!Number.isSafeInteger(length) || length <= 0) {
          throw new Error("Invalid LSP Content-Length header");
        }
        if (length > 16 * 1024 * 1024) {
          throw new Error("LSP message exceeds 16 MiB");
        }
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

  /**
   * Rejects end-of-stream when an LSP header or body is incomplete.
   * @param callback - Receives the framing error, or no error at a message boundary.
   * @example Ending after a partial header reports an incomplete message.
   */
  override _flush(callback: TransformCallback): void {
    callback(
      this.headerBytes > 0 || this.bodyRemaining > 0
        ? new Error("LSP transport ended with an incomplete message")
        : undefined,
    );
  }
}

interface ServerState {
  readonly lifetime: AbortController;
  readonly documents: Map<string, DocumentSnapshot>;
  readonly publications: Map<string, PublishedDiagnostics>;
  readonly diagnosticErrors: Map<string, Error>;
  readonly queues: Map<string, Promise<void>>;
  readonly registrations: Map<string, Registration>;
  readonly cancellationTimers: Set<NodeJS.Timeout>;
  readonly progress: Set<string | number>;
  baseCapabilities: ServerCapabilities;
  effectiveCapabilities: ServerCapabilities;
  version: number;
  initialized: boolean;
  shutdownPromise: Promise<void> | undefined;
  failure: Error | undefined;
  stderr: string;
  activity: number;
  busy: number;
}

class StdioLanguageServer implements LanguageServer {
  readonly config: ServerConfig;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly input = new BoundedLspInput();
  readonly options: PoolOptions;
  readonly connection: MessageConnection;
  readonly state: ServerState = {
    lifetime: new AbortController(),
    documents: new Map(),
    publications: new Map(),
    diagnosticErrors: new Map(),
    queues: new Map(),
    registrations: new Map(),
    cancellationTimers: new Set(),
    progress: new Set(),
    baseCapabilities: {},
    effectiveCapabilities: {},
    version: 0,
    initialized: false,
    shutdownPromise: undefined,
    failure: undefined,
    stderr: "",
    activity: Date.now(),
    busy: 0,
  };

  /**
   * Starts one stdio server and installs the stable listeners owned by its shutdown lifecycle.
   * @param config - Resolved command, arguments, environment, and protocol configuration.
   * @param options - Workspace root and workspace-edit callback retained by this client.
   * @throws If process creation or transport setup fails.
   * @example
   * With config.command "typescript-language-server", args ["--stdio"], and root
   * "/project", new StdioLanguageServer(config, options) launches that command in
   * /project; it sends no initialize request until initialize() is called.
   */
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
      fail(
        this.state,
        this,
        new Error(
          `LSP ${config.name} closed its transport${stderrSuffix(this.state.stderr)}`,
        ),
      ),
    );
    this.connection.onError(([error]) => fail(this.state, this, error));
    this.connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: unknown) => publish(this.state, this, params),
    );
    this.connection.onNotification("$/progress", (params: unknown) => {
      if (!record(params)) {
        return;
      }
      const { value, token } = params;
      if (
        !record(value) ||
        (typeof token !== "string" && typeof token !== "number")
      ) {
        return;
      }
      const { kind } = value;
      if (kind === "begin") {
        this.state.progress.add(token);
      }
      if (kind === "end") {
        this.state.progress.delete(token);
      }
    });
    this.connection.onRequest((method: string, params: unknown) =>
      serverRequest(this, method, params),
    );
    this.connection.listen();
    this.child.stdout.pipe(this.input);
  }

  /**
   * Exposes the current initialization capabilities with dynamic registrations overlaid.
   * @returns The current effective capability object, not a detached copy.
   * @example
   * server.capabilities.hoverProvider; // Reflects an active textDocument/hover registration.
   */
  get capabilities(): ServerCapabilities {
    return this.state.effectiveCapabilities;
  }
  /**
   * Checks that neither lifetime cancellation nor process termination has occurred.
   * @returns Whether the client can still accept work.
   * @example
   * server.isAlive; // Returns false after shutdown aborts the lifetime.
   */
  get isAlive(): boolean {
    return (
      !this.state.lifetime.signal.aborted &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }

  /**
   * Records activity using wall-clock milliseconds for pool idle expiry.
   * @example
   * server.touch(); // Restarts the idle interval after acquiring this client.
   */
  touch(): void {
    this.state.activity = Date.now();
  }
  /**
   * Reports idle time only when no tracked operation is active.
   * @param now - Current wall-clock timestamp in milliseconds.
   * @returns Milliseconds since activity, or zero while busy.
   * @example
   * server.idleFor(Date.now()); // Returns 0 during an active request.
   */
  idleFor(now: number): number {
    return this.state.busy === 0 ? now - this.state.activity : 0;
  }

  /**
   * Retains the most recent 16,384 stderr characters using one stable stream listener.
   * @param data - Stderr bytes or decoded text appended to the retained failure detail.
   * @example
   * child.stderr.emit("data", "denied\n"); // Later failures include "denied".
   */
  private readonly onStderr = (data: Buffer | string): void => {
    this.state.stderr = (this.state.stderr + String(data)).slice(-16_384);
  };
  /**
   * Routes process and stream errors into owned shutdown using one stable listener identity.
   * @param error - Original process or transport failure propagated to pending operations.
   * @example
   * child.emit("error", new Error("broken pipe")); // Cancels work and begins cleanup.
   */
  private readonly onProcessError = (error: Error): void => {
    fail(this.state, this, error);
  };
  /**
   * Converts process exit into a failure carrying its signal/code and retained stderr.
   * @param code - Numeric exit status, or null when a signal ended the process.
   * @param signal - Terminating signal, preferred over the numeric code when present.
   * @example
   * child.emit("exit", 1, null); // Pending work fails with an exit-status-1 message.
   */
  private readonly onExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    fail(
      this.state,
      this,
      new Error(
        `LSP ${this.config.name} exited (${signal ?? code ?? "unknown"})${stderrSuffix(this.state.stderr)}`,
      ),
    );
  };

  /**
   * Negotiates UTF-16 capabilities, sends initial settings, and waits for workspace readiness.
   * @param signal - Startup owner's cancellation; cancellation does not belong to an individual pool waiter.
   * @returns Completion after the initialized notification, configuration, and readiness checks.
   * @throws On cancellation, protocol/encoding validation failure, or readiness/request failure.
   * @example
   * If the peer's initialize response selects positionEncoding: "utf-8",
   * server.initialize(new AbortController().signal) rejects rather than accepting
   * positions that this UTF-16 client would interpret incorrectly.
   */
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
    if (!record(result)) {
      throw new Error(
        `LSP ${this.config.name} returned an invalid initialize result`,
      );
    }
    const { capabilities } = result;
    if (!record(capabilities)) {
      throw new Error(
        `LSP ${this.config.name} returned an invalid initialize result`,
      );
    }
    const { positionEncoding, textDocumentSync: sync } = capabilities;
    if (positionEncoding !== undefined && positionEncoding !== "utf-16") {
      throw new Error(
        `LSP ${this.config.name} selected unsupported position encoding: ${String(positionEncoding)}`,
      );
    }
    if (
      sync !== undefined &&
      !(typeof sync === "number" && [0, 1, 2].includes(sync)) &&
      !record(sync)
    ) {
      throw new Error(
        `LSP ${this.config.name} returned invalid text synchronization capabilities`,
      );
    }
    if (record(sync)) {
      const { change, openClose, save } = sync;
      if (
        (change !== undefined &&
          (typeof change !== "number" || ![0, 1, 2].includes(change))) ||
        (openClose !== undefined && typeof openClose !== "boolean") ||
        (save !== undefined && typeof save !== "boolean" && !record(save))
      ) {
        throw new Error(
          `LSP ${this.config.name} returned invalid text synchronization options`,
        );
      }
    }
    this.state.baseCapabilities = capabilities as ServerCapabilities;
    this.state.effectiveCapabilities = registeredCapabilities(
      this.state.baseCapabilities,
      this.state.registrations.values(),
    );
    check(signal);
    await this.notify("initialized", {});
    this.state.initialized = true;
    await this.notify("workspace/didChangeConfiguration", {
      settings: this.config.settings ?? {},
    });
    await waitForWorkspace(this.state, this, signal);
    check(signal);
    assertAlive(this, this.state.failure);
  }

  /**
   * Sends a request while tracking activity and including workspace readiness in its deadline.
   * @param method - Protocol request method; analyzerStatus avoids recursive readiness checks.
   * @param params - Payload sent to the peer.
   * @param signal - Optional cancellation for this caller's request.
   * @param timeoutMs - Total wait in milliseconds, defaulting to 30,000.
   * @returns The unvalidated response; callers still validate its protocol shape.
   * @throws On cancellation, timeout, a stopped server, or peer request failure.
   * @example
   * With a.ts already synchronized and the peer returning { contents: "value: number" }:
   * ```ts
   * await server.request("textDocument/hover", {
   *   textDocument: { uri: "file:///project/a.ts" },
   *   position: { line: 0, character: 6 },
   * });
   * // { contents: "value: number" }; positions are sent unchanged, without one-based conversion.
   * ```
   */
  request<T = unknown>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<T> {
    return active(this.state, this, async () => {
      const timeout = duration(timeoutMs, REQUEST_TIMEOUT_MS);
      const deadline = Date.now() + timeout;
      if (
        this.state.initialized &&
        this.state.progress.size > 0 &&
        method !== "rust-analyzer/analyzerStatus"
      ) {
        await waitForWorkspace(this.state, this, signal, timeout);
      }
      return rpc<T>(this, method, params, {
        signal,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
    });
  }

  /**
   * Sends a notification under the write deadline, failing the server if transport writing fails.
   * @param method - Protocol notification method.
   * @param params - Notification payload sent to the peer.
   * @returns Completion after the transport write settles.
   * @throws On a stopped server, write failure, cancellation, or the 5,000 ms write deadline.
   * @example
   * ```ts
   * await server.notify("workspace/didChangeConfiguration", {
   *   settings: { typescript: { preferences: { quotePreference: "single" } } },
   * });
   * // Resolves after writing the settings notification, without waiting for a peer response.
   * ```
   */
  notify(method: string, params: unknown): Promise<void> {
    return active(this.state, this, async () => {
      try {
        await bounded(
          this.connection.sendNotification(method, params),
          [this.state.lifetime.signal],
          {
            timeoutMs: WRITE_TIMEOUT_MS,
            label: `LSP ${this.config.name} ${method}`,
          },
        );
      } catch (error) {
        fail(this.state, this, asError(error));
        throw error;
      }
    });
  }

  /**
   * Opens or updates a document in per-file order, preserving UTF-16 ranges and versioned diagnostics.
   * @param file - Absolute path of the document to synchronize.
   * @param content - Text to synchronize, or undefined to read the current file with cancellation.
   * @param signal - Optional cancellation for this synchronization operation.
   * @returns Completion after supported open/change notifications, or immediately for unchanged text.
   * @throws On invalid paths, canceled/failed reads, unsupported changes, or transport errors.
   * @example
   * With openClose: true and a.ts not yet open:
   * ```ts
   * await server.syncFile("/project/a.ts", "const value = 1;\n"); // Sends didOpen.
   * await server.syncFile("/project/a.ts", "const value = 1;\n"); // No notification or version bump.
   * ```
   */
  syncFile(
    file: string,
    content?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return queue(this, file, signal, async () => {
      const key = fileKey(file);
      let text = content;
      if (text === undefined) {
        const readController = new AbortController();
        const readSignal = AbortSignal.any([
          readController.signal,
          this.state.lifetime.signal,
          ...(signal ? [signal] : []),
        ]);
        text = await bounded(
          readFile(file, { encoding: "utf8", signal: readSignal }),
          [readSignal],
          {
            timeoutMs: WRITE_TIMEOUT_MS,
            label: `Reading ${file}`,
            onCancel: () => readController.abort(),
          },
        );
      }
      check(signal);
      const prior = this.state.documents.get(key);
      if (prior?.content === text) {
        return;
      }
      const sync = syncOptions(this.capabilities.textDocumentSync);
      if (prior && !sync.change && !sync.openClose) {
        throw new Error(
          `LSP ${this.config.name} cannot synchronize changes to ${file}`,
        );
      }
      const snapshot: DocumentSnapshot = {
        version: ++this.state.version,
        content: text,
      };
      this.state.documents.set(key, snapshot);
      this.state.publications.delete(key);
      this.state.diagnosticErrors.delete(key);
      const uri = pathToFileURL(file).href;
      if (!(prior && sync.change)) {
        if (prior && sync.openClose) {
          await this.notify("textDocument/didClose", { textDocument: { uri } });
        }
        if (sync.openClose) {
          await this.notify("textDocument/didOpen", {
            textDocument: {
              uri,
              languageId: languageId(this.config, file),
              version: snapshot.version,
              text,
            },
          });
        }
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
              if (char === 13 && prior.content.charCodeAt(index + 1) === 10) {
                index++;
              }
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

  /**
   * Queues supported save and watched-file notifications after earlier operations on the file.
   * @param file - Absolute path whose current snapshot supplies optional saved text.
   * @returns Completion after applicable notifications are written.
   * @throws On invalid paths, stopped lifetime, or notification failure.
   * @example
   * With a.ts synchronized to "let x = 1;" and textDocumentSync.save.includeText true,
   * await server.saved("/project/a.ts") sends didSave with text: "let x = 1;".
   * After closeFile("/project/a.ts"), saved("/project/a.ts") sends no didSave.
   */
  saved(file: string): Promise<void> {
    return queue(this, file, undefined, async () => {
      const { documents } = this.state;
      const snapshot = documents.get(fileKey(file));
      const { save } = syncOptions(this.capabilities.textDocumentSync);
      const uri = pathToFileURL(file).href;
      if (snapshot && save) {
        await this.notify("textDocument/didSave", {
          textDocument: { uri },
          ...(typeof save === "object" && save.includeText
            ? { text: snapshot.content }
            : {}),
        });
      }
      if (
        [...this.state.registrations.values()].some(
          (registration) =>
            registration.method === "workspace/didChangeWatchedFiles",
        )
      ) {
        await this.notify("workspace/didChangeWatchedFiles", {
          changes: [{ uri, type: 2 }],
        });
      }
    });
  }

  /**
   * Removes a file's document and diagnostic state in order, notifying supported open/close peers.
   * @param file - Absolute path of the document to close.
   * @returns Completion after any required didClose notification.
   * @throws On invalid paths, stopped lifetime, or notification failure.
   * @example
   * await server.closeFile("/project/a.ts"); // A later document(a.ts) lookup returns undefined.
   */
  closeFile(file: string): Promise<void> {
    return queue(this, file, undefined, async () => {
      const key = fileKey(file);
      const existed = this.state.documents.delete(key);
      this.state.publications.delete(key);
      this.state.diagnosticErrors.delete(key);
      if (
        existed &&
        syncOptions(this.capabilities.textDocumentSync).openClose
      ) {
        await this.notify("textDocument/didClose", {
          textDocument: { uri: pathToFileURL(file).href },
        });
      }
    });
  }

  /**
   * Returns a detached snapshot for checking edits against the last synchronized text and version.
   * @param file - Absolute path used to look up the normalized document key.
   * @returns A copied snapshot, or undefined when the document is not open.
   * @throws If the file path is not absolute.
   * @example
   * server.document("/project/a.ts"); // Returns undefined before a.ts is synchronized.
   */
  document(file: string): DocumentSnapshot | undefined {
    const snapshot = this.state.documents.get(fileKey(file));
    return snapshot ? { ...snapshot } : undefined;
  }

  /**
   * Synchronizes a file and waits for a current pull or published diagnostic report with provenance.
   * @param file - Absolute path whose synchronized version must remain current throughout the wait.
   * @param signal - Optional caller cancellation, combined with lifetime and diagnostic timeout.
   * @param timeoutMs - Total diagnostic deadline in milliseconds, defaulting to 10,000.
   * @returns Diagnostic items labeled pull, versioned, or unversioned; silence is never a clean report.
   * @throws On cancellation, timeout, invalid reports, changed/closed documents, or transport failure.
   * @example
   * await server.diagnostics("/project/a.ts", undefined, 1000);
   * // Rejects after 1,000 ms if no usable report arrives instead of reporting a clean file.
   */
  diagnostics(
    file: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<DiagnosticReport> {
    const controller = new AbortController();
    const operationSignal = AbortSignal.any([
      controller.signal,
      this.state.lifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    const timeout = duration(timeoutMs, DIAGNOSTIC_TIMEOUT_MS);
    const timeoutError = new Error(
      `LSP ${this.config.name} diagnostics timed out for ${file}; clean state is unverified`,
    );
    const timer = setTimeout(() => controller.abort(timeoutError), timeout);
    return active<DiagnosticReport>(this.state, this, async () => {
      check(operationSignal);
      const deadline = Date.now() + timeout;
      await this.syncFile(file, undefined, operationSignal);
      const key = fileKey(file);
      const snapshot = this.state.documents.get(key);
      if (!snapshot) {
        throw new Error(
          `LSP document closed while requesting diagnostics: ${file}`,
        );
      }
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
        if (this.state.documents.get(key) !== snapshot) {
          throw new Error(`LSP diagnostics superseded by changes to ${file}`);
        }
        if (!record(report)) {
          throw new Error(
            `LSP ${this.config.name} returned no complete diagnostic report for ${file}`,
          );
        }
        const { kind, items } = report;
        if (kind !== "full") {
          throw new Error(
            `LSP ${this.config.name} returned no complete diagnostic report for ${file}`,
          );
        }
        return { items: diagnosticItems(items), freshness: "pull" };
      }
      while (Date.now() < deadline) {
        check(operationSignal);
        assertAlive(this, this.state.failure);
        if (this.state.documents.get(key) !== snapshot) {
          throw new Error(`LSP diagnostics superseded by changes to ${file}`);
        }
        const error = this.state.diagnosticErrors.get(key);
        if (error) {
          throw error;
        }
        const published = this.state.publications.get(key);
        if (
          published?.version === snapshot.version &&
          (published.versioned ||
            Date.now() - published.received >= DIAGNOSTIC_SETTLE_MS) &&
          this.state.progress.size === 0
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

  /**
   * Cancels work, attempts graceful shutdown, then releases transports, listeners, timers, and process ownership.
   * @returns The cached shutdown promise; repeated calls reuse it idempotently.
   * The first completion promise is reused while pending and after settlement,
   * including rejection; shutdown never retries.
   * @throws If forced process cleanup fails; listener and document cleanup still runs.
   * @example
   * await server.shutdown(); await server.shutdown(); // Stops the owned process only once.
   */
  shutdown(): Promise<void> {
    if (this.state.shutdownPromise !== undefined) {
      return this.state.shutdownPromise;
    }
    const graceful =
      !this.state.lifetime.signal.aborted && this.state.initialized;
    this.state.lifetime.abort(
      this.state.failure ?? new Error(`LSP ${this.config.name} stopped`),
    );
    this.state.shutdownPromise = (async () => {
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
            await rpc(this, "shutdown", null, {
              timeoutMs: 1000,
              stopping: true,
            });
            await bounded(this.connection.sendNotification("exit"), [], {
              timeoutMs: 500,
              label: "LSP exit",
            });
            await bounded(exited, [], {
              timeoutMs: 500,
              label: "LSP graceful exit",
            });
          } catch {
            /* A dead or non-cooperating server still gets process-group termination. */
          } finally {
            if (exitListener) {
              this.child.off("exit", exitListener);
            }
          }
        }
      } finally {
        for (const timer of this.state.cancellationTimers) {
          clearTimeout(timer);
        }
        this.state.cancellationTimers.clear();
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
          this.state.documents.clear();
          this.state.publications.clear();
          this.state.diagnosticErrors.clear();
          this.state.registrations.clear();
          this.state.progress.clear();
          this.state.queues.clear();
        }
      }
    })();
    return this.state.shutdownPromise;
  }
}

/**
 * Formats the retained stderr tail for a server failure message.
 * @param stderr - Raw recent process output; surrounding whitespace is omitted.
 * @returns A colon-prefixed detail, or an empty string for whitespace-only output.
 * @example
 * stderrSuffix(" denied\n"); // Returns ": denied".
 */
function stderrSuffix(stderr: string): string {
  return stderr.trim() ? `: ${stderr.trim()}` : "";
}

/**
 * Records the first transport failure, cancels outstanding work, and starts owned cleanup.
 * @param state - Lifetime and failure state; repeated failures after abort are ignored.
 * @param server - Owner whose idempotent shutdown releases transport and process resources.
 * @param error - Initial failure, retained alongside any later cleanup failure.
 * @example
 * fail(state, server, new Error("broken pipe")); // Aborts pending work and starts shutdown.
 */
function fail(state: ServerState, server: LanguageServer, error: Error): void {
  if (state.lifetime.signal.aborted) {
    return;
  }
  state.failure = error;
  state.lifetime.abort(error);
  server.shutdown().catch((cleanupError: unknown) => {
    state.failure = new AggregateError(
      [error, cleanupError],
      `LSP ${server.config.name} cleanup failed`,
    );
  });
}

/**
 * Rejects work against a terminated or canceled server using its recorded failure.
 * @param server - Server whose lifetime and process status determine liveness.
 * @param failure - Original failure to rethrow, if available.
 * @throws The recorded failure, or a stopped-server error when the server is not alive.
 * @example
 * assertAlive(stoppedServer, new Error("broken pipe")); // Throws "broken pipe".
 */
function assertAlive(server: LanguageServer, failure: Error | undefined): void {
  if (!server.isAlive) {
    throw failure ?? new Error(`LSP ${server.config.name} is stopped`);
  }
}

/**
 * Keeps the server non-idle while work runs and updates activity on both entry and completion.
 * @param state - Shared active-operation count and failure state.
 * @param server - Liveness and activity owner.
 * @param work - Operation invoked only after the liveness check succeeds.
 * @returns The operation's result without changing its rejection.
 * @throws If the server is stopped or the operation rejects.
 * @example
 * On a live server with no other work, active(state, server, async () => {
 * throw new Error("denied"); }) rejects with "denied" but still releases its busy
 * count, so subsequent idleFor(now) calls can measure idle time again.
 */
async function active<T>(
  state: ServerState,
  server: StdioLanguageServer,
  work: () => Promise<T>,
): Promise<T> {
  assertAlive(server, state.failure);
  state.busy++;
  server.touch();
  try {
    return await work();
  } finally {
    state.busy--;
    server.touch();
  }
}

/**
 * Waits for quiet progress, also requiring a loaded workspace for rust-analyzer.
 * @param state - Shared progress tokens and lifetime cancellation.
 * @param server - Configuration and request owner used for readiness polling.
 * @param signal - Optional caller cancellation, independent of server lifetime.
 * @param timeoutMs - Maximum caller wait in milliseconds, capped by configured readiness timing.
 * @returns Completion once the configured quiet/settle interval has passed.
 * @throws On cancellation, timeout, or an invalid rust-analyzer status response.
 * @example
 * With a non-rust server whose progress token remains active throughout the wait,
 * await waitForWorkspace(state, server, undefined, 500) rejects with a workspace
 * readiness timeout instead of proceeding while indexing is still active.
 */
async function waitForWorkspace(
  state: ServerState,
  server: LanguageServer,
  signal?: AbortSignal,
  timeoutMs = 10_000,
): Promise<void> {
  const rust = [server.config.command, server.config.resolvedCommand].some(
    (command) =>
      command !== undefined && RUST_ANALYZER_COMMAND.test(basename(command)),
  );
  const timings = server.config.workspaceReadyTimings;
  const start = Date.now();
  let quietSince = start;
  const deadline =
    start + Math.min(duration(timings?.timeoutMs, 10_000), timeoutMs);
  while (Date.now() < deadline) {
    check(signal);
    if (rust) {
      const status = await server.request<unknown>(
        "rust-analyzer/analyzerStatus",
        {},
        signal,
        Math.min(
          duration(timings?.statusRequestTimeoutMs, 1000),
          Math.max(1, deadline - Date.now()),
        ),
      );
      if (typeof status !== "string") {
        throw new Error("rust-analyzer returned an invalid workspace status");
      }
      if (
        !status.startsWith("No workspaces") &&
        state.progress.size === 0 &&
        Date.now() - start >= duration(timings?.settleMs, 2000)
      ) {
        return;
      }
    } else if (state.progress.size > 0) {
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= duration(timings?.settleMs, 100)) {
      return;
    }
    await pause(
      Math.min(
        duration(timings?.pollMs, 100),
        Math.max(1, deadline - Date.now()),
      ),
      [signal, state.lifetime.signal],
    );
  }
  throw new Error(`LSP ${server.config.name} workspace readiness timed out`);
}

/**
 * Sends one bounded RPC, canceling its token on timeout and stopping peers that ignore cancellation.
 * @param server - Owner of the connection, lifetime, failure state, and cleanup timers.
 * @param method - Protocol request method.
 * @param params - Request payload; the caller validates returned peer data.
 * @param options - Request cancellation, deadline, and graceful-shutdown mode.
 * @returns The unvalidated peer result.
 * @throws On stopped transport, cancellation, timeout, or peer request failure.
 * @example
 * await rpc(server, "shutdown", null, { timeoutMs: 1000, stopping: true });
 * // Allows the graceful shutdown request despite an already-aborted server lifetime.
 */
async function rpc<T>(
  server: StdioLanguageServer,
  method: string,
  params: unknown,
  options: {
    signal?: AbortSignal | undefined;
    timeoutMs: number;
    stopping?: boolean;
  },
): Promise<T> {
  const { signal, timeoutMs, stopping = false } = options;
  const { state, connection } = server;
  check(signal);
  if (!stopping) {
    assertAlive(server, state.failure);
  }
  const source = new CancellationTokenSource();
  let settled = false;
  let cleanupTimer: NodeJS.Timeout | undefined;
  let work: Promise<T>;
  try {
    work = connection.sendRequest<T>(method, params, source.token);
  } catch (error) {
    source.dispose();
    throw error;
  }
  const settle = () => {
    settled = true;
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
      state.cancellationTimers.delete(cleanupTimer);
    }
    source.dispose();
  };
  work.then(settle, settle);
  return await bounded(
    work,
    [signal, ...(stopping ? [] : [state.lifetime.signal])],
    {
      timeoutMs,
      label: `LSP ${server.config.name} ${method}`,
      onCancel: () => {
        source.cancel();
        // jsonrpc retains canceled response slots until a reply. Kill a server that ignores cancellation rather than leak them forever.
        if (!(settled || state.lifetime.signal.aborted || stopping)) {
          cleanupTimer = setTimeout(() => {
            if (cleanupTimer) {
              state.cancellationTimers.delete(cleanupTimer);
            }
            if (!settled) {
              fail(
                state,
                server,
                new Error(
                  `LSP ${server.config.name} ignored cancellation of ${method}`,
                ),
              );
            }
          }, 1000);
          state.cancellationTimers.add(cleanupTimer);
        }
      },
    },
  );
}

/**
 * Normalizes numeric synchronization capabilities without copying an existing options object.
 * @param sync - Server-advertised synchronization kind or options; undefined means unsupported.
 * @returns Options with numeric kinds expanded into change and open/close support.
 * @example
 * syncOptions(2); // Returns { openClose: true, change: 2 }.
 */
function syncOptions(
  sync: ServerCapabilities["textDocumentSync"],
): TextDocumentSyncOptions {
  if (typeof sync === "number") {
    return { openClose: sync !== 0, change: sync };
  }
  return sync ?? {};
}

/**
 * Serializes operations for one normalized file while keeping later work usable after rejection.
 * @param server - Owner kept active while the queued operation runs.
 * @param file - Absolute path whose normalized key identifies the queue.
 * @param signal - Caller cancellation; canceling the wait does not remove its shared barrier.
 * @param work - Operation started after the previous operation settles and cancellation is checked.
 * @returns A bounded wait for this operation; the barrier is removed only if still current.
 * @throws For invalid paths, cancellation, a stopped server, or an operation failure.
 * @example
 * If an earlier syncFile("/project/a.ts") fails to read the file, but the server
 * remains alive, queue(server, "/project/a.ts", undefined, async () => "next")
 * still resolves to "next" after that failure; the file's queue is not poisoned.
 */
function queue<T>(
  server: StdioLanguageServer,
  file: string,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const { state } = server;
  const key = fileKey(file);
  const prior = state.queues.get(key) ?? Promise.resolve();
  const result = prior.then(() => {
    check(signal);
    return active(state, server, work);
  });
  const barrier = result.then(
    () => undefined,
    () => undefined,
  );
  state.queues.set(key, barrier);
  barrier.then(() => {
    if (state.queues.get(key) === barrier) {
      state.queues.delete(key);
    }
  });
  return bounded(result, [signal, state.lifetime.signal]);
}

/**
 * Validates and caches diagnostics only for the currently open document version.
 * @param state - Document snapshots, publication provenance, and per-document validation errors.
 * @param server - Owner stopped when a publication has no usable document URI field.
 * @param params - Untrusted publishDiagnostics payload; invalid file URIs and stale versions are ignored.
 * @example
 * publish(state, server, { uri: "file:///project/a.ts", version: 2, diagnostics: [] });
 * // Records a versioned empty report only when the open document is version 2.
 */
function publish(
  state: ServerState,
  server: LanguageServer,
  params: unknown,
): void {
  if (!record(params)) {
    fail(
      state,
      server,
      new Error("Language server published diagnostics without a document URI"),
    );
    return;
  }
  const { uri, version, diagnostics } = params;
  if (typeof uri !== "string") {
    fail(
      state,
      server,
      new Error("Language server published diagnostics without a document URI"),
    );
    return;
  }
  let key: string;
  try {
    key = fileKey(fileURLToPath(uri));
  } catch {
    return;
  }
  const document = state.documents.get(key);
  if (!document) {
    return;
  }
  if (
    version !== undefined &&
    version !== null &&
    (!Number.isInteger(version) || version !== document.version)
  ) {
    return;
  }
  try {
    state.publications.set(key, {
      version: document.version,
      items: diagnosticItems(diagnostics),
      received: Date.now(),
      versioned: version === document.version,
    });
    state.diagnosticErrors.delete(key);
  } catch (error) {
    state.publications.delete(key);
    state.diagnosticErrors.set(key, asError(error));
  }
}

/**
 * Overlays dynamic registrations on initialization capabilities without mutating the base snapshot.
 * @param baseCapabilities - Capabilities returned during initialization.
 * @param registrations - Current registrations in insertion order; later matching registrations win.
 * @returns A new effective capability object, including diagnostic and file-operation registrations.
 * @example
 * registeredCapabilities({}, [{ id: "hover", method: "textDocument/hover", options: {} }]);
 * // Returns { hoverProvider: {} }.
 */
function registeredCapabilities(
  baseCapabilities: ServerCapabilities,
  registrations: Iterable<Registration>,
): ServerCapabilities {
  const capabilities = { ...baseCapabilities };
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
  for (const registration of registrations) {
    if (registration.method === "textDocument/diagnostic") {
      capabilities.diagnosticProvider = {
        interFileDependencies: false,
        workspaceDiagnostics: false,
        ...registration.options,
      };
    } else if (
      registration.method.startsWith("workspace/") &&
      FILE_OPERATION_METHOD.test(registration.method)
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
      if (name) {
        Object.assign(capabilities, { [name]: registration.options });
      }
    }
  }
  return capabilities;
}

/**
 * Validates and handles server-to-client requests using this client's configuration and registrations.
 * @param server - Owner of the shared state, workspace options, and edit callback.
 * @param method - Incoming protocol request method.
 * @param params - Untrusted peer parameters validated for the selected method.
 * @returns The protocol response, including explicit unsupported edit/document outcomes.
 * @throws For stopped servers, invalid parameters, or unsupported request methods.
 * @example
 * await serverRequest(server, "window/showDocument", {});
 * // Returns { success: false } without opening a document.
 */
async function serverRequest(
  server: StdioLanguageServer,
  method: string,
  params: unknown,
): Promise<unknown> {
  const { state, options } = server;
  assertAlive(server, state.failure);
  switch (method) {
    case "workspace/configuration": {
      if (!record(params)) {
        throw new ResponseError(
          ErrorCodes.InvalidParams,
          "Expected configuration items",
        );
      }
      const { items } = params;
      if (!Array.isArray(items)) {
        throw new ResponseError(
          ErrorCodes.InvalidParams,
          "Expected configuration items",
        );
      }
      return items.map((item: unknown) => {
        if (!record(item)) {
          throw new ResponseError(
            ErrorCodes.InvalidParams,
            "Invalid configuration item",
          );
        }
        const { section } = item;
        if (section !== undefined && typeof section !== "string") {
          throw new ResponseError(
            ErrorCodes.InvalidParams,
            "Invalid configuration item",
          );
        }
        let value: unknown = server.config.settings ?? {};
        if (typeof section === "string" && section) {
          if (record(value) && Object.hasOwn(value, section)) {
            return value[section];
          }
          for (const part of section.split(".")) {
            value =
              record(value) && Object.hasOwn(value, part)
                ? value[part]
                : undefined;
          }
        }
        return value ?? null;
      });
    }
    case "workspace/workspaceFolders": {
      const root = server.config.root || options.cwd;
      return [
        {
          uri: pathToFileURL(root).href,
          name: basename(root) || "workspace",
        },
      ];
    }
    case "workspace/applyEdit": {
      if (!record(params)) {
        return { applied: false, failureReason: "Invalid workspace edit" };
      }
      const { edit } = params;
      if (!record(edit)) {
        return { applied: false, failureReason: "Invalid workspace edit" };
      }
      try {
        return await options.onApplyEdit(edit as WorkspaceEdit, server);
      } catch (error) {
        return { applied: false, failureReason: asError(error).message };
      }
    }
    case "client/registerCapability": {
      if (!record(params)) {
        throw new ResponseError(
          ErrorCodes.InvalidParams,
          "Expected registrations",
        );
      }
      const { registrations } = params;
      if (!Array.isArray(registrations)) {
        throw new ResponseError(
          ErrorCodes.InvalidParams,
          "Expected registrations",
        );
      }
      const additions: Registration[] = registrations.map((value: unknown) => {
        if (!record(value)) {
          throw new ResponseError(
            ErrorCodes.InvalidParams,
            "Invalid capability registration",
          );
        }
        const { id, method: registrationMethod, registerOptions } = value;
        if (
          typeof id !== "string" ||
          typeof registrationMethod !== "string" ||
          (registerOptions !== undefined && !record(registerOptions))
        ) {
          throw new ResponseError(
            ErrorCodes.InvalidParams,
            "Invalid capability registration",
          );
        }
        return {
          id,
          method: registrationMethod,
          options: registerOptions ?? {},
        };
      });
      for (const entry of additions) {
        state.registrations.set(entry.id, entry);
      }
      state.effectiveCapabilities = registeredCapabilities(
        state.baseCapabilities,
        state.registrations.values(),
      );
      return null;
    }
    case "client/unregisterCapability": {
      if (!record(params)) {
        throw new ResponseError(
          ErrorCodes.InvalidParams,
          "Expected unregistrations",
        );
      }
      const { unregisterations, unregistrations } = params;
      const entries = unregisterations ?? unregistrations;
      if (
        !(
          Array.isArray(entries) &&
          entries.every((entry: unknown) => {
            if (!record(entry)) {
              return false;
            }
            const { id } = entry;
            return typeof id === "string";
          })
        )
      ) {
        throw new ResponseError(
          ErrorCodes.InvalidParams,
          "Invalid capability unregistration",
        );
      }
      for (const entry of entries as Array<{ id: string }>) {
        state.registrations.delete(entry.id);
      }
      state.effectiveCapabilities = registeredCapabilities(
        state.baseCapabilities,
        state.registrations.values(),
      );
      return null;
    }
    case "window/workDoneProgress/create":
      return null;
    case "window/showMessageRequest":
      return null;
    case "window/showDocument":
      return { success: false };
    case "workspace/diagnostic/refresh":
      state.publications.clear();
      state.diagnosticErrors.clear();
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
  // `!== false` guards work around Biome's mutable-boolean false positive:
  // https://github.com/biomejs/biome/issues/11174
  // Unlike `=== true`, they also avoid TypeScript's TS2367 after `await`.
  private disposed = false;

  /**
   * Owns shared server entries and an optional unreferenced idle-expiry timer.
   * @param options - Workspace, edit callback, and optional idle timeout in milliseconds.
   * @example
   * Constructing a pool with idleTimeoutMs: 60_000 starts no server. After pool.get(config),
   * an initialized client idle for at least 60 seconds is stopped on an idle sweep;
   * an active request prevents expiry. await pool.dispose() also clears the sweep timer.
   */
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
            ) {
              stopEntry(this.entries, key, entry).catch(() => {
                // The retained stopping promise exposes cleanup failures to stop/dispose.
              });
            }
          }
        },
        Math.min(timeout, 1000),
      );
      this.idleTimer.unref();
    }
  }

  /**
   * Reuses startup by effective configuration without transferring its cancellation to one caller.
   * @param config - Effective server configuration used as the shared-entry identity.
   * @param signal - Cancels only this caller's wait; stop and dispose own shared startup cancellation.
   * @returns An initialized live client after any previous stopping entry has completed cleanup.
   * @throws On canceled acquisition, disabled/disposed configuration, or startup/cleanup failure.
   * @example
   * For an installed server configuration and a pool that has not been disposed:
   * ```ts
   * const first = await pool.get(config);
   * const second = await pool.get(config);
   * // first === second while that client remains alive and has not begun stopping.
   * ```
   */
  async get(
    config: ServerConfig,
    signal?: AbortSignal,
  ): Promise<LanguageServer> {
    check(signal);
    if (this.disposed !== false) {
      throw new Error("LSP pool is disposed");
    }
    if (config.disabled) {
      throw new Error(`LSP ${config.name} is disabled`);
    }
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
      await bounded(stopEntry(this.entries, key, entry), [signal]);
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
          if (
            this.disposed !== false ||
            current.stopping ||
            controller.signal.aborted
          ) {
            throw new Error(`LSP ${config.name} startup was stopped`);
          }
          current.initialized = true;
          server.touch();
          return server;
        })
        .catch(async (error: unknown) => {
          try {
            await server.shutdown();
          } catch (cleanupError) {
            // biome-ignore lint/style/useErrorCause: AggregateError retains both failures; Biome 2.5.14 does not recognize its constructor signature.
            throw new AggregateError(
              [error, cleanupError],
              `LSP ${config.name} startup and cleanup failed`,
            );
          }
          if (this.entries.get(key) === current && !current.stopping) {
            this.entries.delete(key);
          }
          throw error;
        });
    }
    entry.server.touch();
    const server = await bounded(entry.ready, [signal]);
    check(signal);
    if (this.disposed !== false || entry.stopping || !server.isAlive) {
      throw new Error(
        `LSP ${config.name} was stopped before acquisition completed`,
      );
    }
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

  /**
   * Stops selected shared entries and reports every process-shutdown failure together.
   * @param names - Server names to stop, or undefined to stop every entry.
   * @returns Completion after all selected entries finish their shared stop attempts.
   * @throws An AggregateError if any selected server shutdown fails.
   * @example
   * await pool.stop(["typescript-native"]); // Stops only entries configured with that name.
   */
  async stop(names?: readonly string[]): Promise<void> {
    const results = await Promise.allSettled(
      [...this.entries]
        .filter(
          ([, entry]) =>
            names === undefined || names.includes(entry.server.config.name),
        )
        .map(([key, entry]) => stopEntry(this.entries, key, entry)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to stop language servers");
    }
  }

  /**
   * Prevents new acquisitions, clears idle polling, and stops every owned server.
   * The first call starts shutdown; later calls reuse that promise while pending
   * and after settlement, including rejection.
   * @returns Completion after all owned server shutdown attempts settle.
   * @throws An AggregateError if one or more owned server shutdowns fail.
   * @example
   * const first = pool.dispose();
   * pool.dispose() === first; // Reuses the first shutdown attempt.
   */
  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) {
      return this.disposePromise;
    }
    this.disposed = true;
    clearInterval(this.idleTimer);
    this.disposePromise = this.stop();
    return this.disposePromise;
  }
}

/**
 * Cancels shared startup and retains the entry until startup and process shutdown both settle.
 * @param entries - Owning pool map; only this exact entry may be removed on successful shutdown.
 * @param key - Effective-configuration key identifying the entry.
 * @param entry - Entry whose first stopping promise is reused while pending and
 *   after settlement, including rejection; failed stops are not retried.
 * @returns Shared shutdown completion; a failed shutdown leaves the entry retained for the pool.
 * @throws If server shutdown fails; startup rejection alone does not fail the stop.
 * @example
 * If entries.get("typescript:/project") is entry and its startup is still pending,
 * stopEntry(entries, "typescript:/project", entry) cancels startup and stops its process.
 * A second call reuses the same promise; successful cleanup removes that entry.
 */
function stopEntry(
  entries: Map<string, PoolEntry>,
  key: string,
  entry: PoolEntry,
): Promise<void> {
  if (entry.stopping !== undefined) {
    return entry.stopping;
  }
  entry.controller.abort(
    new Error(`LSP ${entry.server.config.name} startup was stopped`),
  );
  entry.stopping = (async () => {
    const [shutdown] = await Promise.allSettled([
      entry.server.shutdown(),
      entry.ready,
    ]);
    if (shutdown?.status === "rejected") {
      throw shutdown.reason;
    }
    if (entries.get(key) === entry) {
      entries.delete(key);
    }
  })();
  return entry.stopping;
}
