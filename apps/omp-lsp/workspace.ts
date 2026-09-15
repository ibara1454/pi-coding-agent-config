import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  Command,
  type Diagnostic,
  type Position,
  type TextEdit,
  type WorkspaceEdit,
} from "vscode-languageserver-protocol";
import { isCliLinter, loadLspConfig, serversForFile } from "./config";
import {
  applyWorkspaceEdit,
  type DocumentSnapshot,
  directoryFiles,
  type EditResult,
  type ExecutedChange,
  fileToUri,
  uriToFile,
} from "./edits";
import { formatWithCli, lintWithCli } from "./linters";
import {
  type DisplaySymbol,
  diagnosticsText,
  diagnosticTargets,
  formattingOptions,
  hoverText,
  locations,
  normalizeDiagnostics,
  object,
  resolvePosition,
  symbols,
} from "./operations";
import { type LanguageServer, LanguageServerPool } from "./runtime";
import type {
  LspConfig,
  LspParams,
  LspResult,
  LspSettings,
  ServerConfig,
} from "./types";
import { runWorkspaceDiagnostics } from "./workspace-diagnostics";

interface WorkspaceOptions {
  cwd: string;
  agentDir: string;
  trusted: boolean;
}

interface DiagnosticReport {
  file: string;
  diagnostics: Diagnostic[];
  failures: string[];
  unverifiedSources: string[];
  responders: number;
}

interface ParsedCodeAction {
  raw: unknown;
  title: string;
  kind: string;
  isPreferred: boolean;
  isCommand: boolean;
  disabledReason: string | undefined;
  edit: unknown;
  command: Command | undefined;
}

/**
 * Validates metadata and commands before an action can mutate files.
 * Keeps the original resolve payload; workspace-edit validation belongs to the edit applier.
 */
function parseCodeAction(value: unknown): ParsedCodeAction {
  const { title, kind, isPreferred, disabled, edit, command } = object(
    value,
    "code action",
  );
  if (
    typeof title !== "string" ||
    (kind !== undefined && typeof kind !== "string") ||
    (isPreferred !== undefined && typeof isPreferred !== "boolean")
  )
    throw new Error("Invalid code action metadata");
  let disabledReason: string | undefined;
  if (disabled !== undefined) {
    const { reason } = object(disabled, "disabled code action");
    if (typeof reason !== "string")
      throw new Error("Invalid disabled code action reason");
    disabledReason = reason;
  }
  const candidate = typeof command === "string" ? value : command;
  let executable: Command | undefined;
  if (candidate !== undefined) {
    if (
      !Command.is(candidate) ||
      (candidate.arguments !== undefined && !Array.isArray(candidate.arguments))
    )
      throw new Error("Invalid code action command");
    executable = candidate;
  }
  return {
    raw: value,
    title,
    kind: kind ?? "action",
    isPreferred: isPreferred === true,
    isCommand: typeof command === "string",
    disabledReason,
    edit,
    command: executable,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function methodNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === -32601
  );
}

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function concurrent<T, U>(
  items: readonly T[],
  work: (item: T) => Promise<U>,
  concurrency = 3,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        if (item !== undefined) results[index] = await work(item);
      }
    }),
  );
  return results;
}

interface WorkspaceState {
  readonly options: WorkspaceOptions;
  config: LspConfig;
  pool: LanguageServerPool;
  readonly lifetime: AbortController;
  readonly jobs: Set<Promise<unknown>>;
  readonly knownFiles: Set<string>;
  readonly hooks: Map<string, AbortController>;
  readonly diagnosticFingerprints: Map<
    string,
    { fingerprint: string; hadFindings: boolean; unverified: boolean }
  >;
  disposePromise: Promise<void> | undefined;
}

/**
 * Creates a session-owned pool with the configured idle policy and edit handler.
 * @param cwd - Absolute workspace root.
 * @param idleTimeoutMs - Optional idle timeout passed through to the pool.
 * @param onApplyEdit - Trust-gated handler for server-requested workspace edits.
 * @returns A pool that the workspace must dispose or replace on reload.
 * @example
 * ```ts
 * const pool = createPool("/project", 60_000, async () => ({ applied: false }));
 * // Idle clients are eligible for shutdown after 60 seconds without work.
 * await pool.dispose(); // Stops acquired clients and clears the idle sweep timer.
 * ```
 */
function createPool(
  cwd: string,
  idleTimeoutMs: number | undefined,
  onApplyEdit: (
    edit: WorkspaceEdit,
    server: LanguageServer,
  ) => Promise<{ applied: boolean; failureReason?: string }>,
): LanguageServerPool {
  return new LanguageServerPool({
    cwd,
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    onApplyEdit,
  });
}

/**
 * Applies server-requested edits only inside the trust gate and tracked lifetime.
 * @param state - Session-owned mutable configuration, jobs, and server state.
 * @param edit - Untrusted workspace edit to validate before committing.
 * @param server - Requesting server whose document snapshots guard the edit.
 * @returns Protocol application status, preserving any partial-failure reason.
 * @throws If edit processing rejects; the tracked job is removed in either case.
 * @example In an untrusted workspace, an empty edit returns applied: false without changing files.
 */
async function applyServerEdit(
  state: WorkspaceState,
  edit: WorkspaceEdit,
  server: LanguageServer,
): Promise<{ applied: boolean; failureReason?: string }> {
  if (
    !state.options.trusted ||
    !state.config.settings.enabled ||
    state.lifetime.signal.aborted
  )
    return {
      applied: false,
      failureReason: "LSP workspace untrusted, disabled, or disposed",
    };
  const job = applyEdit(
    state,
    edit,
    server,
    documentSnapshots(state.knownFiles, server),
    state.lifetime.signal,
  );
  state.jobs.add(job);
  try {
    const result = await job;
    return {
      applied: result.applied,
      ...(result.failureReason === undefined
        ? {}
        : { failureReason: result.failureReason }),
    };
  } finally {
    state.jobs.delete(job);
  }
}

/**
 * Executes one trust-gated, deadline-bound action and reports operational failures.
 * @param state - Session-owned state whose lifetime participates in cancellation.
 * @param params - Requested LSP action and optional timeout in seconds.
 * @param callerSignal - Optional caller cancellation, combined with the session and deadline.
 * @returns Tool result; trust, disabled, disposed, timeout, and action failures remain observable.
 * @example With trusted: false, action "hover" returns an error result without starting a server.
 */
async function executeAction(
  state: WorkspaceState,
  params: LspParams,
  callerSignal?: AbortSignal,
): Promise<LspResult> {
  if (!state.options.trusted)
    return workspaceResult(
      params,
      "LSP is available only in trusted projects.",
      false,
    );
  if (state.lifetime.signal.aborted)
    return workspaceResult(params, "LSP workspace has been disposed.", false);
  if (
    !state.config.settings.enabled &&
    params.action !== "status" &&
    params.action !== "reload"
  )
    return workspaceResult(params, "LSP is disabled in settings.", false);
  const requestedTimeout = params.timeout ?? 20;
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0)
    return workspaceResult(
      params,
      "timeout must be a positive number of seconds.",
      false,
    );
  const timeout = Math.min(300, Math.max(5, requestedTimeout));
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new Error(`LSP ${params.action} timed out after ${timeout}s`),
      ),
    timeout * 1000,
  );
  const signal = AbortSignal.any([
    state.lifetime.signal,
    deadline.signal,
    ...(callerSignal ? [callerSignal] : []),
  ]);
  try {
    signal.throwIfAborted();
    return await dispatchAction(state, params, signal);
  } catch (error) {
    return workspaceResult(
      params,
      `LSP error: ${errorText(signal.aborted ? signal.reason : error)}`,
      false,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounds tool text while retaining the original request and success metadata.
 * @param params - Original tool request.
 * @param text - Human-readable output, limited to 60000 characters.
 * @param success - Whether the operation succeeded; defaults to true.
 * @param serverName - Optional server attribution.
 * @returns Tool output with isError only for failure.
 * @example workspaceResult({ action: "status" }, "Ready", false) returns isError: true.
 */
function workspaceResult(
  params: LspParams,
  text: string,
  success = true,
  serverName?: string,
): LspResult {
  const bounded =
    text.length > 60000
      ? `${text.slice(0, 60000)}\n…output truncated at 60000 characters…`
      : text;
  return {
    text: bounded,
    ...(!success ? { isError: true } : {}),
    details: {
      action: params.action,
      success,
      request: params,
      ...(serverName ? { serverName } : {}),
    },
  };
}

/**
 * Selects available language servers without starting them or including CLI linters.
 * @param config - Effective server configuration.
 * @param file - Optional absolute file path used to filter matching servers.
 * @returns Eligible servers in configured order.
 * @example
 * With installed .ts servers "typescript-native", disabled "eslint", and CLI linter
 * "biome", plus "pyright" matching only .py, selectedServers(config, "/project/a.ts")
 * selects only "typescript-native"; omitting the file also selects "pyright".
 */
function selectedServers(config: LspConfig, file?: string): ServerConfig[] {
  const configured = file
    ? serversForFile(config, file)
    : config.servers.filter(
        (server) => !server.disabled && server.resolvedCommand,
      );
  return configured.filter((server) => !isCliLinter(server));
}

/**
 * Obtains the first eligible language server through the session-owned pool.
 * @param state - Session configuration, root, and shared server pool.
 * @param file - Optional absolute target file; omitted for workspace requests.
 * @param signal - Cancellation for this caller’s startup wait.
 * @returns The selected shared language-server instance.
 * @throws If no server is available or startup is canceled or fails.
 * @example With no available servers, requesting "/project/a.ts" fails rather than reporting successful navigation.
 */
async function languageServerFor(
  state: WorkspaceState,
  file: string | undefined,
  signal: AbortSignal,
): Promise<LanguageServer> {
  const config = selectedServers(state.config, file)[0];
  if (!config)
    throw new Error(
      file
        ? `No language server found for ${path.relative(state.options.cwd, file)}`
        : "No language servers configured and available",
    );
  return state.pool.get(config, signal);
}

/**
 * Reads a bounded regular file, synchronizes it, and remembers the opened path.
 * @param knownFiles - Workspace-owned set updated only after synchronization succeeds.
 * @param server - Server that owns the synchronized document.
 * @param file - Absolute file path to read.
 * @param signal - Cancellation for file synchronization.
 * @returns The UTF-8 file content sent to the server.
 * @throws If canceled, filesystem access fails, the target is not a file, it exceeds 16 MiB, or synchronization fails.
 * @example Opening "/project/a.ts" containing "let x = 1;" returns that text and records its path.
 */
async function openDocument(
  knownFiles: Set<string>,
  server: LanguageServer,
  file: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`Expected a file: ${file}`);
  if (stat.size > 16 * 1024 * 1024)
    throw new Error(`LSP document exceeds 16 MiB: ${file}`);
  const content = await fs.readFile(file, "utf8");
  await server.syncFile(file, content, signal);
  knownFiles.add(file);
  return content;
}

/**
 * Copies known documents from the requesting server for later edit validation.
 * @param knownFiles - Absolute paths known to this workspace.
 * @param server - Server supplying detached document versions and content.
 * @returns Snapshots only for paths currently open in that server.
 * @example
 * With "/project/open.ts" open at version 3 containing "let x = 1;" and
 * "/project/closed.ts" closed in server:
 * ```ts
 * documentSnapshots(new Set(["/project/open.ts", "/project/closed.ts"]), server);
 * // Map { "/project/open.ts" => { version: 3, content: "let x = 1;" } }
 * ```
 */
function documentSnapshots(
  knownFiles: ReadonlySet<string>,
  server: LanguageServer,
): Map<string, DocumentSnapshot> {
  const snapshots = new Map<string, DocumentSnapshot>();
  for (const file of knownFiles) {
    const document = server.document(file);
    if (document) snapshots.set(file, { ...document });
  }
  return snapshots;
}

/**
 * Reports cached configuration and process state without starting servers.
 * @param config - Effective settings, server definitions, and warnings.
 * @param pool - Session pool whose existing clients are inspected.
 * @param params - Original status request retained in result metadata.
 * @returns Status output including unavailable servers and configuration warnings.
 * @example With enabled: false, the first status line begins "LSP: disabled".
 */
function workspaceStatus(
  config: LspConfig,
  pool: LanguageServerPool,
  params: LspParams,
): LspResult {
  const clients = pool.clients();
  const lines = [
    `LSP: ${config.settings.enabled ? "enabled" : "disabled"}; ${config.settings.lazy ? "lazy" : "eager"}; session-owned servers`,
  ];
  for (const server of config.servers) {
    const client = clients.find(
      (candidate) => candidate.config.name === server.name,
    );
    const state = server.disabled
      ? "disabled"
      : !server.resolvedCommand
        ? "unavailable (executable not installed)"
        : isCliLinter(server)
          ? "CLI linter (runs on demand)"
          : client?.isAlive
            ? "running"
            : "configured, not started";
    lines.push(
      `${server.name}: ${state}; root=${server.root}; command=${server.resolvedCommand ?? server.command}`,
    );
  }
  if (config.servers.length === 0) lines.push("No language servers configured");
  if (config.warnings.length)
    lines.push("Configuration warnings:", ...config.warnings);
  return workspaceResult(params, lines.join("\n"));
}

/**
 * Starts matching servers and reports their negotiated capabilities and failures.
 * @param state - Session-owned configuration, root, and server pool.
 * @param params - Capabilities request, optionally restricted to a file.
 * @param signal - Cancellation for each server startup.
 * @returns A successful result if any server responds; individual failures remain listed.
 * @example With no matching servers, a capabilities request returns an error result.
 */
async function serverCapabilities(
  state: WorkspaceState,
  params: LspParams,
  signal: AbortSignal,
): Promise<LspResult> {
  const configs = selectedServers(
    state.config,
    params.file && params.file !== "*"
      ? path.resolve(state.options.cwd, params.file)
      : undefined,
  );
  if (configs.length === 0)
    return workspaceResult(
      params,
      "No language servers configured for this target",
      false,
    );
  const responses = await concurrent(configs, async (config) => {
    try {
      const server = await state.pool.get(config, signal);
      return {
        success: true,
        text: `${config.name}:\n${JSON.stringify(server.capabilities, null, 2)}`,
      };
    } catch (error) {
      return {
        success: false,
        text: `${config.name}: failed to start (${errorText(error)})`,
      };
    }
  });
  return workspaceResult(
    params,
    responses.map((item) => item.text).join("\n\n"),
    responses.some((item) => item.success),
    configs.map((config) => config.name).join(", "),
  );
}

/**
 * Routes workspace actions before opening documents for position-based operations.
 * @param state - Session-owned configuration, document tracking, and server lifetime.
 * @param params - Action and target supplied by the tool caller.
 * @param signal - Combined caller, session, and deadline cancellation.
 * @returns Navigation, inspection, diagnostic, or mutation result for the requested action.
 * @throws If parameters, peer responses, file access, server requests, or cancellation prevent the action.
 * @example A status request inspects existing state without opening a document or starting a server.
 */
async function dispatchAction(
  state: WorkspaceState,
  params: LspParams,
  signal: AbortSignal,
): Promise<LspResult> {
  if (params.action === "status")
    return workspaceStatus(state.config, state.pool, params);
  if (params.action === "capabilities")
    return serverCapabilities(state, params, signal);
  if (params.action === "request") return rawRequest(state, params, signal);
  if (params.action === "reload") return reloadWorkspace(state, params, signal);
  if (params.action === "rename_file") return renameFile(state, params, signal);
  if (!params.file)
    throw new Error(
      "file parameter required. Use '*' for supported workspace actions.",
    );
  if (params.action === "diagnostics")
    return diagnosticsResult(state, params, signal);
  if (params.file === "*") {
    if (params.action !== "symbols")
      throw new Error(`${params.action} requires a concrete file`);
    return workspaceSymbols(state, params, signal);
  }
  const file = path.resolve(state.options.cwd, params.file);
  const server = await languageServerFor(state, file, signal);
  const content = await openDocument(state.knownFiles, server, file, signal);
  const uri = fileToUri(file);
  if (
    !server.config.isLinter &&
    params.line !== undefined &&
    !params.symbol &&
    ["definition", "references", "rename"].includes(params.action)
  )
    throw new Error(
      `symbol is required for project-aware ${params.action}; pass the name, optionally symbol#N for repeated occurrences`,
    );
  const position =
    params.action === "symbols"
      ? { line: 0, character: 0 }
      : resolvePosition(content, params.line, params.symbol);
  const target = { textDocument: { uri }, position };
  switch (params.action) {
    case "definition":
    case "type_definition":
    case "implementation":
    case "references": {
      const methods = {
        definition: "textDocument/definition",
        type_definition: "textDocument/typeDefinition",
        implementation: "textDocument/implementation",
        references: "textDocument/references",
      };
      const request = {
        ...target,
        ...(params.action === "references"
          ? { context: { includeDeclaration: true } }
          : {}),
      };
      let found = locations(
        await server.request(methods[params.action], request, signal),
      );
      if (params.action === "references" && !server.config.isLinter) {
        for (
          let attempt = 0;
          attempt < 2 &&
          (found.length === 0 ||
            (found.length === 1 &&
              found[0]?.file === file &&
              found[0].range.start.line === position.line));
          attempt++
        ) {
          await delay(250, undefined, { signal });
          found = locations(
            await server.request(methods[params.action], request, signal),
          );
        }
      }
      const label =
        params.action === "type_definition" ? "type definition" : params.action;
      if (found.length === 0)
        return workspaceResult(
          params,
          `No ${label} found`,
          true,
          server.config.name,
        );
      const limit = params.action === "references" ? 50 : 200;
      const contexts = new Map<string, string[]>();
      const lines: string[] = [];
      for (const location of found.slice(0, limit)) {
        signal.throwIfAborted();
        let context = contexts.get(location.file);
        if (!context) {
          try {
            if ((await fs.stat(location.file)).size > 16 * 1024 * 1024)
              throw new Error("file exceeds context limit");
            context = (await fs.readFile(location.file, "utf8")).split(/\r?\n/);
          } catch (error) {
            context = [`Context unavailable: ${errorText(error)}`];
          }
          contexts.set(location.file, context);
        }
        const text = context[location.range.start.line]?.trim();
        lines.push(
          `${path.relative(state.options.cwd, location.file) || location.file}:${location.range.start.line + 1}:${location.range.start.character + 1}${text ? `  ${text.slice(0, 500)}` : ""}`,
        );
      }
      return workspaceResult(
        params,
        `${found.length} ${params.action === "references" ? "reference(s)" : `${label} location(s)`}:\n${lines.join("\n")}${found.length > limit ? `\n…${found.length - limit} locations elided…` : ""}`,
        true,
        server.config.name,
      );
    }
    case "hover": {
      const text = hoverText(
        await server.request("textDocument/hover", target, signal),
      );
      return workspaceResult(
        params,
        text || "No hover information",
        true,
        server.config.name,
      );
    }
    case "symbols": {
      const found = symbols(
        await server.request(
          "textDocument/documentSymbol",
          { textDocument: { uri } },
          signal,
        ),
        file,
      );
      return workspaceResult(
        params,
        found.length
          ? `Symbols in ${params.file}:\n${symbolLines(state.options.cwd, found).join("\n")}`
          : "No symbols found",
        true,
        server.config.name,
      );
    }
    case "rename": {
      if (!params.new_name?.trim())
        throw new Error("new_name parameter required for rename");
      const snapshots = documentSnapshots(state.knownFiles, server);
      const edit = await server.request<WorkspaceEdit | null>(
        "textDocument/rename",
        { ...target, newName: params.new_name },
        signal,
      );
      if (edit === null)
        return workspaceResult(
          params,
          "Rename returned no edits",
          true,
          server.config.name,
        );
      const result = await applyEdit(
        state,
        edit,
        server,
        snapshots,
        signal,
        params.apply === false,
      );
      return editResult(
        params,
        result,
        params.apply === false ? "Rename preview" : "Applied rename",
        server.config.name,
      );
    }
    case "code_actions":
      return codeActions(state, params, server, file, position, signal);
    default:
      throw new Error(`Unsupported LSP action: ${String(params.action)}`);
  }
}

/**
 * Sends a raw protocol request with parsed JSON or a derived document target.
 * @param state - Session root, server pool, and known documents.
 * @param params - Request whose query names the method and payload optionally supplies JSON.
 * @param signal - Cancellation for document synchronization and the request.
 * @returns Serialized server output or an attributed protocol error.
 * @throws If the method, JSON, document, position, or server startup is invalid or unavailable.
 * @example
 * In a workspace with an available language server, a request with action "request",
 * query "workspace/symbol", and payload '{"query":"Widget"}' sends
 * workspace/symbol with { query: "Widget" }, not the JSON string.
 */
async function rawRequest(
  state: WorkspaceState,
  params: LspParams,
  signal: AbortSignal,
): Promise<LspResult> {
  const method = params.query?.trim();
  if (!method) throw new Error("query must contain the raw LSP method name");
  const file =
    params.file && params.file !== "*"
      ? path.resolve(state.options.cwd, params.file)
      : undefined;
  let payload: unknown;
  if (params.payload !== undefined) {
    try {
      payload = JSON.parse(params.payload);
    } catch (error) {
      throw new Error(`Invalid JSON in payload: ${errorText(error)}`);
    }
  }
  const server = await languageServerFor(state, file, signal);
  const content = file
    ? await openDocument(state.knownFiles, server, file, signal)
    : undefined;
  if (params.payload === undefined)
    payload = file
      ? {
          textDocument: { uri: fileToUri(file) },
          ...(params.line !== undefined
            ? {
                position: resolvePosition(
                  content ?? "",
                  params.line,
                  params.symbol,
                ),
              }
            : {}),
        }
      : {};
  try {
    const result = await server.request(method, payload, signal);
    return workspaceResult(
      params,
      `${server.config.name} ← ${method}:\n${typeof result === "string" ? result : JSON.stringify(result ?? null, null, 2)}`,
      true,
      server.config.name,
    );
  } catch (error) {
    return workspaceResult(
      params,
      `LSP error from ${server.config.name} on ${method}: ${errorText(error)}\n  params: ${JSON.stringify(payload ?? null).slice(0, 400)}`,
      false,
      server.config.name,
    );
  }
}

/**
 * Collects diagnostics across eligible servers while rejecting changed-file results.
 * @param state - Session configuration, pool, and tracked document paths.
 * @param file - Absolute regular file path, limited to 16 MiB.
 * @param signal - Cancellation shared across diagnostic sources.
 * @param timeoutMs - Per-source wait; linter servers are capped at 3000 ms.
 * @returns Normalized findings, responder count, source failures, and unverified sources.
 * @throws If canceled, file access fails, the target is oversized or invalid, or its contents change during collection.
 * @example With no matching servers, the report has responders: 0 and a failure rather than claiming a clean file.
 */
async function collectDiagnostics(
  state: WorkspaceState,
  file: string,
  signal: AbortSignal,
  timeoutMs = 10000,
): Promise<DiagnosticReport> {
  const configs = serversForFile(state.config, file);
  if (configs.length === 0)
    return {
      file,
      diagnostics: [],
      failures: ["No language server found for file"],
      unverifiedSources: [],
      responders: 0,
    };
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
    throw new Error(
      `Diagnostics target is not a regular file below 16 MiB: ${file}`,
    );
  const original = await fs.readFile(file, "utf8");
  const findings: Diagnostic[] = [];
  const failures: string[] = [];
  const unverifiedSources: string[] = [];
  let responders = 0;
  await concurrent(configs, async (config) => {
    try {
      signal.throwIfAborted();
      let diagnostics: Diagnostic[];
      if (isCliLinter(config))
        diagnostics = normalizeDiagnostics(
          await lintWithCli(config, file, signal),
        );
      else {
        const server = await state.pool.get(config, signal);
        await openDocument(state.knownFiles, server, file, signal);
        const report = await server.diagnostics(
          file,
          signal,
          config.isLinter ? Math.min(3000, timeoutMs) : timeoutMs,
        );
        diagnostics = normalizeDiagnostics(report.items);
        if (report.freshness === "unversioned")
          unverifiedSources.push(config.name);
      }
      findings.push(...diagnostics);
      responders++;
    } catch (error) {
      failures.push(`${config.name}: ${errorText(error)}`);
    }
  });
  signal.throwIfAborted();
  if ((await fs.readFile(file, "utf8")) !== original)
    throw new Error(
      `File changed during diagnostics; result discarded: ${file}`,
    );
  return {
    file,
    diagnostics: normalizeDiagnostics(findings),
    failures,
    unverifiedSources: unverifiedSources.sort(),
    responders,
  };
}

/**
 * Runs workspace checks or bounded file diagnostics without treating unavailable sources as clean.
 * @param state - Session root, configuration, and diagnostic resources.
 * @param params - Diagnostic target; "*" selects workspace checkers.
 * @param signal - Combined cancellation for checks and target collection.
 * @returns Diagnostic text with freshness and failure reporting; at least one file responder is required for success.
 * @throws If no file targets exist, collection fails, or the request is canceled.
 * @example A file target with no responding server returns an error result, not verified-clean output.
 */
async function diagnosticsResult(
  state: WorkspaceState,
  params: LspParams,
  signal: AbortSignal,
): Promise<LspResult> {
  if (params.file === "*") {
    const result = await runWorkspaceDiagnostics(
      state.options.cwd,
      signal,
      Math.min(300, Math.max(5, params.timeout ?? 20)) * 1000,
    );
    return {
      ...result,
      details: {
        ...result.details,
        action: params.action,
        request: params,
        success: !result.isError,
      },
    };
  }
  const targets = await diagnosticTargets(
    params.file ?? "",
    state.options.cwd,
    signal,
  );
  if (targets.files.length === 0)
    return workspaceResult(params, `No files matched pattern: ${params.file}`);
  const reports = await concurrent(targets.files, (file) =>
    collectDiagnostics(
      state,
      file,
      signal,
      targets.files.length > 1 ? 400 : 10000,
    ),
  );
  const lines: string[] = [];
  for (const report of reports) {
    if (report.responders > 0)
      lines.push(
        diagnosticsText(
          report.file,
          report.diagnostics,
          state.options.cwd,
          report.unverifiedSources,
        ),
      );
    else
      lines.push(
        `${path.relative(state.options.cwd, report.file)}: all language servers failed; diagnostics unavailable`,
      );
    if (report.failures.length)
      lines.push(`Server failures:\n${report.failures.join("\n")}`);
  }
  if (targets.truncated)
    lines.push(
      "…diagnostics limited to 20 matched files; narrow the glob for remaining targets…",
    );
  return workspaceResult(
    params,
    lines.join("\n\n"),
    reports.some((report) => report.responders > 0),
  );
}

/**
 * Formats a bounded list of symbols with relative paths and one-based positions.
 * @param cwd - Workspace root used to shorten display paths.
 * @param found - Normalized symbols in display order.
 * @returns At most 200 symbol rows followed by an overflow notice when necessary.
 * @example
 * ```ts
 * symbolLines("/project", [{
 *   name: "Widget", kind: 5, container: "", file: "/project/src/widget.ts",
 *   position: { line: 0, character: 6 }, depth: 0,
 * }]);
 * // ["Widget [kind 5] src/widget.ts:1:7"]
 * ```
 */
function symbolLines(cwd: string, found: readonly DisplaySymbol[]): string[] {
  const lines = found
    .slice(0, 200)
    .map(
      (symbol) =>
        `${"  ".repeat(symbol.depth)}${symbol.name}${symbol.container ? ` (${symbol.container})` : ""} [kind ${symbol.kind}] ${path.relative(cwd, symbol.file) || symbol.file}${symbol.position ? `:${symbol.position.line + 1}:${symbol.position.character + 1}` : " (location unresolved)"}`,
    );
  if (found.length > 200) lines.push(`…${found.length - 200} symbols elided…`);
  return lines;
}

/**
 * Searches available servers, filters and deduplicates symbols, and retains source failures.
 * @param state - Session configuration, root, and shared pool.
 * @param params - Workspace-symbol request with a nonempty query.
 * @param signal - Cancellation for server startup and search.
 * @returns Matching symbols with success when at least one server responds.
 * @throws If the query is empty or no language server is configured and available.
 * @example Searching for "Widget" also matches "widget" and emits duplicate cross-server locations only once.
 */
async function workspaceSymbols(
  state: WorkspaceState,
  params: LspParams,
  signal: AbortSignal,
): Promise<LspResult> {
  const query = params.query?.trim();
  if (!query) throw new Error("query parameter required for workspace symbols");
  const configs = selectedServers(state.config);
  if (configs.length === 0)
    throw new Error("No language servers configured and available");
  const responses = await concurrent(configs, async (config) => {
    try {
      const server = await state.pool.get(config, signal);
      return {
        symbols: symbols(
          await server.request("workspace/symbol", { query }, signal),
        ),
        failure: "",
      };
    } catch (error) {
      return { symbols: [], failure: `${config.name}: ${errorText(error)}` };
    }
  });
  const unique = new Map<string, DisplaySymbol>();
  const needle = query.toLowerCase();
  for (const response of responses)
    for (const symbol of response.symbols) {
      if (
        ![symbol.name, symbol.container, symbol.file].some((field) =>
          field.toLowerCase().includes(needle),
        )
      )
        continue;
      unique.set(
        JSON.stringify([
          symbol.name,
          symbol.container,
          symbol.kind,
          symbol.file,
          symbol.position,
        ]),
        symbol,
      );
    }
  const found = [...unique.values()];
  const failures = responses
    .map((response) => response.failure)
    .filter(Boolean);
  const lines = found.length
    ? [
        `${found.length} workspace symbol(s) matching "${query}":`,
        ...symbolLines(state.options.cwd, found),
      ]
    : [`No symbols matching "${query}"`];
  if (failures.length) lines.push("Server failures:", ...failures);
  return workspaceResult(
    params,
    lines.join("\n"),
    responses.some((response) => !response.failure),
    configs.map((config) => config.name).join(", "),
  );
}

/**
 * Lists validated actions or resolves one explicitly selected action before applying it.
 * @param state - Session state used for snapshots, edits, and reconciliation.
 * @param params - Action request; apply requires a title match or numeric query.
 * @param server - Server providing diagnostics and code actions.
 * @param file - Absolute file used for the action context.
 * @param position - Zero-based position for the empty selection range.
 * @param signal - Cancellation for diagnostic context, resolution, and application.
 * @returns Action list, selection feedback, or the selected action’s application result.
 * @throws If peer action metadata is invalid, an action is disabled, or a request fails or is canceled.
 * @example With apply: true and query "0", only the action at index zero is selected.
 */
async function codeActions(
  state: WorkspaceState,
  params: LspParams,
  server: LanguageServer,
  file: string,
  position: Position,
  signal: AbortSignal,
): Promise<LspResult> {
  let diagnostics: Diagnostic[] = [];
  let diagnosticWarning = "";
  let diagnosticContextFailed = false;
  try {
    const report = await server.diagnostics(file, signal, 10000);
    diagnostics = normalizeDiagnostics(report.items);
    if (report.freshness === "unversioned")
      diagnosticWarning = `Diagnostic context freshness-unverified from ${server.config.name}: unversioned diagnostics may be stale.`;
  } catch (error) {
    signal.throwIfAborted();
    diagnosticContextFailed = true;
    diagnosticWarning = `Diagnostic context unavailable: ${errorText(error)}`;
  }
  const snapshots = documentSnapshots(state.knownFiles, server);
  const response = await server.request(
    "textDocument/codeAction",
    {
      textDocument: { uri: fileToUri(file) },
      range: { start: position, end: position },
      context: {
        diagnostics,
        triggerKind: 1,
        ...(params.apply !== true && params.query
          ? { only: [params.query] }
          : {}),
      },
    },
    signal,
  );
  if (response !== null && !Array.isArray(response))
    throw new Error("Invalid code action response");
  const actions = response === null ? [] : response.map(parseCodeAction);
  if (actions.length === 0)
    return workspaceResult(
      params,
      `No code actions available${diagnosticWarning ? `\n${diagnosticWarning}` : ""}`,
      !diagnosticContextFailed,
      server.config.name,
    );
  const list =
    actions
      .map(
        (action, index) =>
          `${index}: [${action.kind}] ${action.title}${action.isPreferred ? " (preferred)" : ""}${action.disabledReason !== undefined ? ` (disabled: ${action.disabledReason})` : ""}`,
      )
      .join("\n") + (diagnosticWarning ? `\n${diagnosticWarning}` : "");
  if (params.apply !== true)
    return workspaceResult(
      params,
      `${actions.length} action(s):\n${list}`,
      true,
      server.config.name,
    );
  const query = params.query?.trim();
  if (!query)
    return workspaceResult(
      params,
      `query parameter required to select one action when apply=true. Available actions:\n${list}`,
      false,
      server.config.name,
    );
  const selected = /^\d+$/.test(query)
    ? actions.filter((_action, index) => index === Number(query))
    : actions.filter((action) =>
        action.title.toLowerCase().includes(query.toLowerCase()),
      );
  let action = selected[0];
  if (!action || selected.length !== 1)
    return workspaceResult(
      params,
      `${selected.length === 0 ? "No" : "Multiple"} code actions match "${query}". Select an exact numeric index:\n${list}`,
      false,
      server.config.name,
    );
  if (action.disabledReason !== undefined)
    throw new Error(`Code action disabled: ${action.disabledReason}`);
  if (
    !action.isCommand &&
    action.edit === undefined &&
    typeof server.capabilities.codeActionProvider === "object" &&
    server.capabilities.codeActionProvider.resolveProvider
  ) {
    action = parseCodeAction(
      await server.request("codeAction/resolve", action.raw, signal),
    );
  }
  if (action.disabledReason !== undefined)
    throw new Error(`Resolved code action disabled: ${action.disabledReason}`);
  return runCodeAction(
    state,
    params,
    action,
    server,
    snapshots,
    signal,
    diagnosticWarning,
  );
}

/**
 * Commits a validated action’s edit before its command, preserving prior commits on command failure.
 * @param state - Workspace state used to apply and reconcile edits.
 * @param params - Original action request.
 * @param action - Validated action and optional command.
 * @param server - Server executing the command and owning document versions.
 * @param snapshots - Observed content and versions guarding the edit.
 * @param signal - Cancellation for edit and command execution.
 * @param diagnosticWarning - Optional freshness or availability warning appended to success output.
 * @returns Action result; command failure includes any already-committed edit summary.
 * @throws If edit processing rejects before an application result is available.
 * @example If an edit succeeds but its command rejects, files stay changed and the result reports both the commit and failure.
 */
async function runCodeAction(
  state: WorkspaceState,
  params: LspParams,
  action: ParsedCodeAction,
  server: LanguageServer,
  snapshots: ReadonlyMap<string, DocumentSnapshot>,
  signal: AbortSignal,
  diagnosticWarning: string,
): Promise<LspResult> {
  const summary: string[] = [];
  if (action.edit !== undefined) {
    const result = await applyEdit(
      state,
      action.edit,
      server,
      snapshots,
      signal,
    );
    summary.push(...result.summary);
    if (!result.applied)
      return editResult(
        params,
        result,
        `Code action "${action.title}" failed`,
        server.config.name,
      );
  }
  const { command } = action;
  if (command) {
    try {
      await server.request(
        "workspace/executeCommand",
        { command: command.command, arguments: command.arguments ?? [] },
        signal,
      );
      summary.push(`Executed command: ${command.command}`);
    } catch (error) {
      return workspaceResult(
        params,
        `Code action command failed: ${errorText(error)}${summary.length ? `\nAlready applied:\n${summary.join("\n")}` : ""}`,
        false,
        server.config.name,
      );
    }
  }
  const text = summary.length
    ? `Applied code action "${action.title}":\n${summary.join("\n")}`
    : `Code action "${action.title}" has no edits or commands`;
  return workspaceResult(
    params,
    `${text}${diagnosticWarning ? `\n${diagnosticWarning}` : ""}`,
    true,
    server.config.name,
  );
}

/**
 * Applies validated workspace edits and reconciles every committed path, including partial failures.
 * @param state - Session root, server state, hooks, and diagnostics tracking.
 * @param edit - Untrusted workspace edit passed to the shared validator and applier.
 * @param server - Optional requesting server supplying current document versions.
 * @param snapshots - Observed documents guarding against stale edits.
 * @param signal - Cancellation checked before application.
 * @param preview - Whether to validate and summarize without committing.
 * @param rollbackTextOnRenameFailure - Whether the applier rolls back text edits if the final rename fails.
 * @returns Application result, marked failed if committed paths cannot be synchronized.
 * @throws If cancellation or the edit applier rejects.
 * @example With preview: true, a rename is summarized without filesystem changes or server reconciliation.
 */
async function applyEdit(
  state: WorkspaceState,
  edit: unknown,
  server: LanguageServer | undefined,
  snapshots: ReadonlyMap<string, DocumentSnapshot>,
  signal: AbortSignal,
  preview = false,
  rollbackTextOnRenameFailure = false,
): Promise<EditResult> {
  signal.throwIfAborted();
  const result = await applyWorkspaceEdit(edit, {
    cwd: state.options.cwd,
    documents: snapshots,
    ...(server ? { document: (file: string) => server.document(file) } : {}),
    signal,
    preview,
    rollbackTextOnRenameFailure,
  });
  if (!preview && result.changes.length > 0) {
    const failures = await reconcileChanges(state, result.changes);
    if (failures.length) {
      result.summary.push(
        "Filesystem changes committed, but server synchronization failed:",
        ...failures,
      );
      result.failureReason = [result.failureReason, ...failures]
        .filter(Boolean)
        .join("; ");
      result.applied = false;
    }
  }
  return result;
}

/**
 * Formats edit summaries without concealing partial-application failures.
 * @param params - Original tool request.
 * @param result - Application outcome, including any committed changes and failure reason.
 * @param label - Heading describing the edit operation.
 * @param serverName - Optional attribution for the requesting server.
 * @returns Bounded tool output whose success matches result.applied.
 * @example An unapplied edit with failureReason "stale" produces an error result containing "Error: stale".
 */
function editResult(
  params: LspParams,
  result: EditResult,
  label: string,
  serverName?: string,
): LspResult {
  return workspaceResult(
    params,
    `${label}:\n${result.summary.length ? result.summary.join("\n") : "No file changes"}${result.failureReason ? `\nError: ${result.failureReason}` : ""}`,
    result.applied,
    serverName,
  );
}

/**
 * Synchronizes committed changes across live servers and invalidates deleted-path feedback.
 * @param state - Workspace-owned documents, hooks, fingerprints, pool, and lifetime.
 * @param changes - Executed filesystem changes in commit order, including partial results.
 * @returns Per-server synchronization failures; committed filesystem changes are not rolled back.
 * @example Deleting "/project/a.ts" removes its tracked diagnostics and closes it in live servers.
 */
async function reconcileChanges(
  state: WorkspaceState,
  changes: readonly ExecutedChange[],
): Promise<string[]> {
  const failures: string[] = [];
  const changed = new Set<string>();
  const deleted = new Set<string>();
  const renamed: Array<{ oldUri: string; newUri: string }> = [];
  for (const change of changes) {
    for (const file of change.removedFiles ?? []) {
      deleted.add(file);
      changed.delete(file);
    }
    if (change.kind === "rename" && change.newFile) {
      for (const file of change.files) {
        const newFile = path.join(
          change.newFile,
          path.relative(change.file, file),
        );
        deleted.add(file);
        changed.delete(file);
        changed.add(newFile);
        deleted.delete(newFile);
        renamed.push({ oldUri: fileToUri(file), newUri: fileToUri(newFile) });
      }
    } else if (change.kind === "delete") {
      for (const file of change.files) {
        deleted.add(file);
        changed.delete(file);
      }
    } else {
      for (const file of change.files) {
        changed.add(file);
        deleted.delete(file);
      }
    }
  }
  for (const file of deleted) {
    state.knownFiles.delete(file);
    state.diagnosticFingerprints.delete(file);
    state.hooks.get(file)?.abort(new Error("File was removed or renamed"));
  }
  for (const file of changed) state.knownFiles.add(file);
  await concurrent(state.pool.clients(), async (server) => {
    if (!server.isAlive) return;
    const reopen = new Set<string>();
    for (const pair of renamed)
      if (server.document(uriToFile(pair.oldUri))) {
        let final = pair.newUri;
        for (const next of renamed)
          if (next.oldUri === final) final = next.newUri;
        if (!deleted.has(uriToFile(final))) reopen.add(uriToFile(final));
      }
    try {
      for (const file of deleted) await server.closeFile(file);
      for (const file of changed) {
        if (
          server.document(file) ||
          reopen.has(file) ||
          selectedServers(state.config, file).some(
            (config) => config.name === server.config.name,
          )
        ) {
          await server.syncFile(file, undefined, state.lifetime.signal);
          await server.saved(file);
        }
      }
      const watched = [...deleted].map((file) => ({
        uri: fileToUri(file),
        type: 3,
      }));
      watched.push(
        ...[...changed].map((file) => ({
          uri: fileToUri(file),
          type:
            changes.some(
              (change) => change.kind === "create" && change.file === file,
            ) || reopen.has(file)
              ? 1
              : 2,
        })),
      );
      if (watched.length)
        await server.notify("workspace/didChangeWatchedFiles", {
          changes: watched,
        });
      if (renamed.length)
        await server.notify("workspace/didRenameFiles", { files: renamed });
    } catch (error) {
      failures.push(`${server.config.name}: ${errorText(error)}`);
    }
  });
  return failures;
}

/**
 * Coordinates server rename edits before committing a file or directory move.
 * @param state - Session root, available servers, observed documents, and edit lifetime.
 * @param params - Source file, new_name destination, and optional apply: false preview.
 * @param signal - Cancellation for discovery, server requests, and application.
 * @returns Rename summary, preserving server notes, validation failures, and partial-application errors.
 * @throws If paths are invalid, the destination exists, documents disagree, directory contents change, or required work fails or is canceled.
 * @example With file "a.ts", new_name "b.ts", and apply: false, the move is previewed without changing either path.
 */
async function renameFile(
  state: WorkspaceState,
  params: LspParams,
  signal: AbortSignal,
): Promise<LspResult> {
  if (!params.file || !params.new_name?.trim())
    throw new Error(
      "rename_file requires file (source) and new_name (destination)",
    );
  const source = path.resolve(state.options.cwd, params.file);
  const destination = path.resolve(state.options.cwd, params.new_name);
  if (source === destination)
    throw new Error("Source and destination paths are identical");
  const sourceStat = await fs.lstat(source);
  try {
    await fs.lstat(destination);
    throw new Error(`Destination already exists: ${destination}`);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const files = sourceStat.isDirectory()
    ? await directoryFiles(source, signal)
    : [source];
  if (files.length === 0) throw new Error("No files to rename");
  const pairs = files.map((file) => ({
    oldUri: fileToUri(file),
    newUri: fileToUri(path.join(destination, path.relative(source, file))),
  }));
  const configs = new Map<string, ServerConfig>();
  for (const pair of pairs)
    for (const file of [uriToFile(pair.oldUri), uriToFile(pair.newUri)])
      for (const config of selectedServers(state.config, file))
        configs.set(config.name, config);
  const buckets = new Map<string, Array<{ edit: TextEdit; server: string }>>();
  const documentChanges: NonNullable<WorkspaceEdit["documentChanges"]> = [];
  const annotations: NonNullable<WorkspaceEdit["changeAnnotations"]> = {};
  const snapshots = new Map<string, DocumentSnapshot>();
  const notes: string[] = [];
  const failures: string[] = [];
  const flush = (): void => {
    for (const [uri, values] of buckets)
      documentChanges.push({
        textDocument: { uri, version: null },
        edits: values.map((value) => value.edit),
      });
    buckets.clear();
  };
  // Semantic servers precede linters. Preserve nonoverlapping contributions, but never apply two servers' conflicting replacements.
  const selected = [...configs.values()].sort(
    (a, b) => Number(Boolean(a.isLinter)) - Number(Boolean(b.isLinter)),
  );
  for (const config of selected) {
    signal.throwIfAborted();
    let server: LanguageServer;
    try {
      server = await state.pool.get(config, signal);
    } catch (error) {
      signal.throwIfAborted();
      notes.push(`${config.name}: failed to start: ${errorText(error)}`);
      continue;
    }
    try {
      for (const file of files)
        if (
          selectedServers(state.config, file).some(
            (candidate) => candidate.name === config.name,
          )
        )
          await openDocument(state.knownFiles, server, file, signal);
      const serverSnapshots = documentSnapshots(state.knownFiles, server);
      for (const [file, document] of serverSnapshots) {
        const prior = snapshots.get(file);
        if (prior && prior.content !== document.content)
          throw new Error(`Servers disagree about current content of ${file}`);
        snapshots.set(file, document);
      }
      const response = await server.request<WorkspaceEdit | null>(
        "workspace/willRenameFiles",
        { files: pairs },
        signal,
      );
      if (response === null) continue;
      const validated = await applyWorkspaceEdit(response, {
        cwd: state.options.cwd,
        documents: serverSnapshots,
        document: (file) => server.document(file),
        signal,
        preview: true,
      });
      if (!validated.applied)
        throw new Error(
          validated.failureReason ?? "Invalid willRenameFiles workspace edit",
        );
      for (const [id, annotation] of Object.entries(
        response.changeAnnotations ?? {},
      ))
        annotations[`${config.name}:${id}`] = annotation;
      const annotate = <T extends object>(value: T): T =>
        "annotationId" in value
          ? {
              ...value,
              annotationId: `${config.name}:${String(value.annotationId)}`,
            }
          : value;
      const add = (uri: string, incoming: readonly TextEdit[]): void => {
        const previous = buckets.get(uri) ?? [];
        let discarded = 0;
        for (const raw of incoming) {
          const edit = annotate(raw);
          const compare = (a: Position, b: Position): number =>
            a.line - b.line || a.character - b.character;
          const conflict = previous.find(
            (value) =>
              value.server !== config.name &&
              ((compare(value.edit.range.start, edit.range.end) < 0 &&
                compare(edit.range.start, value.edit.range.end) < 0) ||
                (JSON.stringify(value.edit.range) ===
                  JSON.stringify(edit.range) &&
                  value.edit.newText === edit.newText)),
          );
          if (conflict) discarded++;
          else previous.push({ edit, server: config.name });
        }
        if (discarded)
          notes.push(
            `${config.name}: discarded ${discarded} overlapping/duplicate reference edit(s) for ${uriToFile(uri)}; earlier semantic server takes precedence`,
          );
        buckets.set(uri, previous);
      };
      if (response.documentChanges !== undefined) {
        for (const change of response.documentChanges) {
          if ("textDocument" in change)
            add(change.textDocument.uri, change.edits as TextEdit[]);
          else {
            flush();
            documentChanges.push(annotate(change));
          }
        }
      } else
        for (const [uri, edits] of Object.entries(response.changes ?? {}))
          add(uri, edits);
    } catch (error) {
      signal.throwIfAborted();
      if (methodNotFound(error))
        notes.push(`${config.name}: willRenameFiles is not supported`);
      else failures.push(`${config.name}: ${errorText(error)}`);
    }
  }
  signal.throwIfAborted();
  if (failures.length)
    return workspaceResult(
      params,
      `Aborted rename: workspace/willRenameFiles failed. No files moved.\n${failures.join("\n")}${notes.length ? `\nServer notes:\n${notes.join("\n")}` : ""}`,
      false,
    );
  if (sourceStat.isDirectory()) {
    const current = await directoryFiles(source, signal);
    if (JSON.stringify(current) !== JSON.stringify(files))
      throw new Error(
        "Directory contents changed while computing rename references; no files moved",
      );
  }
  flush();
  documentChanges.push({
    kind: "rename",
    oldUri: fileToUri(source),
    newUri: fileToUri(destination),
  });
  const result = await applyEdit(
    state,
    { documentChanges, changeAnnotations: annotations },
    undefined,
    snapshots,
    signal,
    params.apply === false,
    true,
  );
  if (notes.length) result.summary.push("Server notes:", ...notes);
  return editResult(
    params,
    result,
    `${params.apply === false ? "Rename preview" : "Rename"}: ${params.file} → ${params.new_name} (${files.length} file(s))`,
  );
}

/**
 * Reloads configuration, invalidates feedback, and restarts only affected server lifetimes.
 * @param state - Mutable session configuration, pool, hooks, and diagnostic fingerprints.
 * @param params - Reload request; a concrete file selects its first matching server.
 * @param signal - Cancellation for loading and server reload operations.
 * @returns Reload results and configuration warnings, including unavailable-server failures.
 * @throws If loading configuration, stopping pools, or cancellation prevents completion.
 * @example Changing idleTimeoutMs from 60000 to 120000 disposes the old pool and installs one with the new idle policy.
 */
async function reloadWorkspace(
  state: WorkspaceState,
  params: LspParams,
  signal: AbortSignal,
): Promise<LspResult> {
  for (const hook of state.hooks.values())
    hook.abort(new Error("LSP configuration reloaded"));
  state.diagnosticFingerprints.clear();
  const previous = state.config;
  const next = await loadLspConfig(
    state.options.cwd,
    state.options.agentDir,
    state.options.trusted,
  );
  signal.throwIfAborted();
  state.config = next;
  if (previous.idleTimeoutMs !== next.idleTimeoutMs) {
    await state.pool.dispose();
    state.pool = createPool(
      state.options.cwd,
      next.idleTimeoutMs,
      (edit, server) => applyServerEdit(state, edit, server),
    );
  }
  const concrete =
    params.file && params.file !== "*"
      ? path.resolve(state.options.cwd, params.file)
      : undefined;
  const changed = previous.servers
    .filter(
      (old) =>
        !next.servers.some(
          (server) =>
            server.name === old.name &&
            JSON.stringify(server) === JSON.stringify(old),
        ),
    )
    .map((server) => server.name);
  if (concrete) {
    const selected = selectedServers(state.config, concrete)[0];
    if (selected) changed.push(selected.name);
  }
  if (!next.settings.enabled) {
    await state.pool.stop();
    return workspaceResult(
      params,
      "LSP configuration reloaded; LSP is disabled.",
    );
  }
  if (changed.length) await state.pool.stop([...new Set(changed)]);
  const configs = concrete
    ? selectedServers(state.config, concrete).slice(0, 1)
    : selectedServers(state.config);
  if (configs.length === 0)
    return workspaceResult(
      params,
      `LSP configuration reloaded; no language servers available.${state.config.warnings.length ? `\n${state.config.warnings.join("\n")}` : ""}`,
      false,
    );
  const results = await concurrent(configs, async (config) => {
    try {
      const server = await state.pool.get(config, signal);
      if (
        config.name === "rust-analyzer" ||
        path.basename(config.command) === "rust-analyzer"
      ) {
        try {
          await server.request("rust-analyzer/reloadWorkspace", null, signal);
        } catch (error) {
          if (!methodNotFound(error)) throw error;
        }
      }
      try {
        await server.notify("workspace/didChangeConfiguration", {
          settings: config.settings ?? {},
        });
      } catch (error) {
        signal.throwIfAborted();
        await state.pool.stop([config.name]);
        await state.pool.get(config, signal);
        return {
          success: true,
          text: `${config.name}: restarted after configuration notification failed (${errorText(error)})`,
        };
      }
      return { success: true, text: `${config.name}: reloaded` };
    } catch (error) {
      return {
        success: false,
        text: `${config.name}: reload failed: ${errorText(error)}`,
      };
    }
  });
  return workspaceResult(
    params,
    [...results.map((result) => result.text), ...state.config.warnings].join(
      "\n",
    ),
    results.some((result) => result.success),
    configs.map((config) => config.name).join(", "),
  );
}

/**
 * Supersedes older per-file feedback while unrelated files run with bounded concurrency.
 * @param state - Session-owned hooks, diagnostics history, documents, and pool.
 * @param paths - Host-mutated paths resolved relative to the workspace root.
 * @param source - Successful host operation; only "write" permits formatting.
 * @param callerSignal - Optional cancellation for this feedback request.
 * @returns Bounded optional feedback; stale or canceled work is suppressed without changing the host result.
 * @example For the same file, a second write aborts the first pending feedback hook; an edit never triggers formatting.
 */
async function mutationFeedback(
  state: WorkspaceState,
  paths: readonly string[],
  source: "write" | "edit",
  callerSignal?: AbortSignal,
): Promise<LspResult | undefined> {
  const files = [
    ...new Set(paths.map((file) => path.resolve(state.options.cwd, file))),
  ];
  const targets = files.map((file) => {
    state.hooks
      .get(file)
      ?.abort(new Error("Superseded by a newer file mutation"));
    const controller = new AbortController();
    state.hooks.set(file, controller);
    return { file, controller };
  });
  const feedback = await concurrent(targets, async ({ file, controller }) => {
    if (state.hooks.get(file) !== controller) return "";
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error("LSP mutation feedback timed out after 15s"),
        ),
      15000,
    );
    const signal = AbortSignal.any([
      state.lifetime.signal,
      controller.signal,
      ...(callerSignal ? [callerSignal] : []),
    ]);
    try {
      signal.throwIfAborted();
      const notes: string[] = [];
      let exists = true;
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) return "";
      } catch (error) {
        if (missing(error)) exists = false;
        else throw error;
      }
      if (!exists) {
        const failures = await reconcileChanges(state, [
          { kind: "delete", file, files: [file] },
        ]);
        return failures.length ? failures.join("\n") : "";
      }
      state.knownFiles.add(file);
      const relevant = serversForFile(state.config, file).length > 0;
      for (const server of state.pool.clients())
        if (
          server.isAlive &&
          (server.document(file) ||
            selectedServers(state.config, file).some(
              (config) => config.name === server.config.name,
            ))
        ) {
          try {
            await server.syncFile(file, undefined, signal);
            await server.saved(file);
          } catch (error) {
            notes.push(
              `${server.config.name}: synchronization failed: ${errorText(error)}`,
            );
          }
        }
      if (
        relevant &&
        source === "write" &&
        state.config.settings.formatOnWrite
      ) {
        try {
          notes.push(...(await formatDocument(state, file, signal)));
        } catch (error) {
          notes.push(`Formatting failed: ${errorText(error)}`);
        }
      }
      if (
        relevant &&
        (source === "write"
          ? state.config.settings.diagnosticsOnWrite
          : state.config.settings.diagnosticsOnEdit)
      ) {
        const report = await collectDiagnostics(state, file, signal);
        if (state.hooks.get(file) !== controller) return "";
        signal.throwIfAborted();
        const unverified = report.unverifiedSources.length > 0;
        const fingerprint = JSON.stringify([
          report.unverifiedSources,
          report.diagnostics.map((item) => [
            item.range,
            item.severity,
            item.message,
          ]),
        ]);
        const previous = state.diagnosticFingerprints.get(file);
        if (report.responders > 0) {
          const hasFeedback =
            report.diagnostics.length > 0 ||
            unverified ||
            previous?.hadFindings ||
            previous?.unverified;
          if (
            (!state.config.settings.diagnosticsDeduplicate ||
              previous?.fingerprint !== fingerprint) &&
            hasFeedback
          )
            notes.push(
              diagnosticsText(
                file,
                report.diagnostics,
                state.options.cwd,
                report.unverifiedSources,
              ),
            );
          state.diagnosticFingerprints.set(file, {
            fingerprint,
            hadFindings: report.diagnostics.length > 0,
            unverified,
          });
        }
        if (report.failures.length)
          notes.push(
            `Diagnostics ${report.responders ? "partially unavailable" : "unavailable"}:\n${report.failures.join("\n")}`,
          );
      }
      if (
        state.hooks.get(file) !== controller ||
        state.lifetime.signal.aborted ||
        callerSignal?.aborted
      )
        return "";
      return notes.join("\n");
    } catch (error) {
      if (
        state.hooks.get(file) !== controller ||
        state.lifetime.signal.aborted ||
        callerSignal?.aborted
      )
        return "";
      return `${path.relative(state.options.cwd, file)}: LSP feedback unavailable (${errorText(signal.aborted ? signal.reason : error)}). The host ${source} already succeeded.`;
    } finally {
      clearTimeout(timer);
      if (state.hooks.get(file) === controller) state.hooks.delete(file);
    }
  });
  const text = feedback.filter(Boolean).join("\n\n");
  return text
    ? {
        text:
          text.length > 20000
            ? `${text.slice(0, 20000)}\n…LSP feedback truncated…`
            : text,
        details: { action: "afterMutation", source },
      }
    : undefined;
}

/**
 * Computes formatting before applying it only to an unchanged original document.
 * @param state - Session configuration, root, server pool, and tracked snapshots.
 * @param file - Absolute file path to format after a successful host write.
 * @param signal - Cancellation for formatting and guarded application.
 * @returns Formatting notes, no notes for unchanged content, or an unavailable-formatter explanation.
 * @throws If file access, formatting, cancellation, or guarded edit application fails.
 * @example If a formatter returns the original file contents, no edit is applied and the result is [].
 */
async function formatDocument(
  state: WorkspaceState,
  file: string,
  signal: AbortSignal,
): Promise<string[]> {
  const configs = serversForFile(state.config, file);
  const content = await fs.readFile(file, "utf8");
  const cli = configs.find(
    (config) => isCliLinter(config) && !/swiftlint/i.test(config.command),
  );
  if (cli) {
    const formatted = await formatWithCli(cli, file, content, signal);
    signal.throwIfAborted();
    if (formatted === content) return [];
    const lines = content.split(/\r\n|\r|\n/);
    const last = lines[lines.length - 1] ?? "";
    const edit: WorkspaceEdit = {
      changes: {
        [fileToUri(file)]: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: lines.length - 1, character: last.length },
            },
            newText: formatted,
          },
        ],
      },
    };
    const result = await applyEdit(
      state,
      edit,
      undefined,
      new Map([[file, { version: 0, content }]]),
      signal,
    );
    if (!result.applied)
      throw new Error(result.failureReason ?? "Formatting edit failed");
    return [
      `Formatted ${path.relative(state.options.cwd, file)} with ${cli.name}`,
    ];
  }
  for (const config of configs.filter((candidate) => !isCliLinter(candidate))) {
    const server = await state.pool.get(config, signal);
    if (!server.capabilities.documentFormattingProvider) continue;
    if (
      (await openDocument(state.knownFiles, server, file, signal)) !== content
    )
      throw new Error(
        "File changed before formatting; stale formatter result discarded",
      );
    const snapshots = documentSnapshots(state.knownFiles, server);
    const response = await server.request<TextEdit[] | null>(
      "textDocument/formatting",
      {
        textDocument: { uri: fileToUri(file) },
        options: await formattingOptions(file, content, state.options.cwd),
      },
      signal,
    );
    if (response === null) return [];
    const result = await applyEdit(
      state,
      { changes: { [fileToUri(file)]: response } },
      server,
      snapshots,
      signal,
    );
    if (!result.applied)
      throw new Error(result.failureReason ?? "Formatting edit failed");
    return result.changes.length
      ? [
          `Formatted ${path.relative(state.options.cwd, file)} with ${config.name}`,
        ]
      : [];
  }
  return [
    "Formatting unavailable: no matching formatting-capable server is installed",
  ];
}

/** One trusted Pi session owns its lazy language servers, diagnostics and mutation hooks. */
export class LspWorkspace {
  readonly #state: WorkspaceState;

  /**
   * Initializes one private state record and its session-owned language-server pool.
   * @param options - Trust decision and configuration roots for this session.
   * @param config - Already-loaded effective LSP configuration.
   * @example A cwd of "." is resolved before constructing the pool; no server starts here.
   */
  private constructor(options: WorkspaceOptions, config: LspConfig) {
    const normalizedOptions = { ...options, cwd: path.resolve(options.cwd) };
    const state: WorkspaceState = {
      options: normalizedOptions,
      config,
      lifetime: new AbortController(),
      jobs: new Set(),
      knownFiles: new Set(),
      hooks: new Map(),
      diagnosticFingerprints: new Map(),
      disposePromise: undefined,
      pool: createPool(
        normalizedOptions.cwd,
        config.idleTimeoutMs,
        (edit, server) => applyServerEdit(state, edit, server),
      ),
    };
    this.#state = state;
  }

  /**
   * Loads configuration and optionally warms servers; the caller owns disposal.
   * @param options - Workspace root, agent configuration directory, and trust decision.
   * @returns One session-owned workspace with eager-startup failures retained as warnings.
   * @throws If configuration loading or workspace initialization fails.
   * @example With trusted: false, create({ cwd: "/project", agentDir: "/agent", trusted: false }) starts no servers.
   */
  static async create(options: WorkspaceOptions): Promise<LspWorkspace> {
    const workspace = new LspWorkspace(
      options,
      await loadLspConfig(options.cwd, options.agentDir, options.trusted),
    );
    if (
      options.trusted &&
      workspace.settings.enabled &&
      !workspace.settings.lazy
    ) {
      const notes = await concurrent(
        selectedServers(workspace.#state.config),
        async (config) => {
          try {
            await workspace.#state.pool.get(
              config,
              workspace.#state.lifetime.signal,
            );
            return "";
          } catch (error) {
            return `${config.name}: eager startup failed: ${errorText(error)}`;
          }
        },
      );
      workspace.#state.config.warnings.push(...notes.filter(Boolean));
    }
    return workspace;
  }

  /**
   * Exposes the current effective settings, including configuration reloads.
   * @returns The settings object owned by the current configuration.
   * @example After reloading enabled: false, settings.enabled is false.
   */
  get settings(): LspSettings {
    return this.#state.config.settings;
  }

  /**
   * Exposes configuration and eager-startup warnings without starting servers.
   * @returns Current warnings in their recorded order.
   * @example
   * With lazy: false, if "typescript-native" startup rejects with Error("not found"),
   * workspace.warnings includes "typescript-native: eager startup failed: not found".
   */
  get warnings(): readonly string[] {
    return this.#state.config.warnings;
  }

  /**
   * Tracks one deadline-bound tool action until it settles.
   * @param params - Requested action and optional deadline in seconds.
   * @param signal - Optional caller cancellation.
   * @returns Tool result with operational failures reported as errors rather than thrown.
   * @example execute({ action: "status" }) reports configured and existing server state without starting a server.
   */
  execute(params: LspParams, signal?: AbortSignal): Promise<LspResult> {
    const state = this.#state;
    const job = executeAction(state, params, signal);
    state.jobs.add(job);
    void job.finally(() => state.jobs.delete(job)).catch(() => {});
    return job;
  }

  /**
   * Synchronizes successful host mutations with bounded optional feedback; only writes can format.
   * @param paths - Paths actually committed by the host write or edit.
   * @param source - Successful host operation.
   * @param signal - Optional cancellation of feedback without reverting the host operation.
   * @returns Optional diagnostic/formatting feedback, bounded by a 16-second outer timeout.
   * @example afterMutation(["a.ts"], "edit") can synchronize and diagnose a.ts but never format it.
   */
  afterMutation(
    paths: readonly string[],
    source: "write" | "edit",
    signal?: AbortSignal,
  ): Promise<LspResult | undefined> {
    const state = this.#state;
    if (
      !state.options.trusted ||
      !state.config.settings.enabled ||
      state.lifetime.signal.aborted
    )
      return Promise.resolve(undefined);
    const deadline = new AbortController();
    const combined = AbortSignal.any([
      deadline.signal,
      ...(signal ? [signal] : []),
    ]);
    const job = mutationFeedback(state, paths, source, combined);
    state.jobs.add(job);
    void job.finally(() => state.jobs.delete(job)).catch(() => {});
    const timeout = new Promise<LspResult>((resolve) => {
      const timer = setTimeout(() => {
        deadline.abort(new Error("LSP mutation feedback timed out"));
        resolve({
          text: `LSP feedback timed out; the host ${source} already succeeded. Cancellation was requested for pending LSP work.`,
          details: { action: "afterMutation", source },
        });
      }, 16000);
      void job.finally(() => clearTimeout(timer)).catch(() => {});
    });
    return Promise.race([job, timeout]);
  }

  /**
   * Idempotently cancels feedback, disposes servers, and waits for tracked jobs.
   * @returns The same disposal promise on repeated calls; completion clears tracked session state.
   * @throws If the owned server pool cannot finish disposal.
   * @example Calling dispose() twice requests cancellation once and returns the same promise.
   */
  dispose(): Promise<void> {
    const state = this.#state;
    if (!state.disposePromise) {
      state.lifetime.abort(new Error("LSP workspace disposed"));
      for (const hook of state.hooks.values())
        hook.abort(new Error("LSP workspace disposed"));
      state.disposePromise = (async () => {
        await state.pool.dispose();
        await Promise.allSettled([...state.jobs]);
        state.hooks.clear();
        state.knownFiles.clear();
        state.diagnosticFingerprints.clear();
      })();
    }
    return state.disposePromise;
  }
}
