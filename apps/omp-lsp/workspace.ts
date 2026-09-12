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

/** One trusted Pi session owns its lazy language servers, diagnostics and mutation hooks. */
export class LspWorkspace {
  readonly #options: WorkspaceOptions;
  #config: LspConfig;
  #pool: LanguageServerPool;
  readonly #lifetime = new AbortController();
  readonly #jobs = new Set<Promise<unknown>>();
  readonly #knownFiles = new Set<string>();
  readonly #hooks = new Map<string, AbortController>();
  readonly #diagnosticFingerprints = new Map<
    string,
    { fingerprint: string; hadFindings: boolean; unverified: boolean }
  >();
  #disposePromise: Promise<void> | undefined;

  private constructor(options: WorkspaceOptions, config: LspConfig) {
    this.#options = { ...options, cwd: path.resolve(options.cwd) };
    this.#config = config;
    this.#pool = this.#createPool(config);
  }

  /** Keeps server-requested edits inside the workspace's trust gate and tracked job lifetime. */
  #createPool(config: LspConfig): LanguageServerPool {
    return new LanguageServerPool({
      cwd: this.#options.cwd,
      ...(config.idleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: config.idleTimeoutMs }),
      onApplyEdit: async (edit, server) => {
        if (
          !this.#options.trusted ||
          !this.settings.enabled ||
          this.#lifetime.signal.aborted
        )
          return {
            applied: false,
            failureReason: "LSP workspace is untrusted, disabled, or disposed",
          };
        const job = this.#apply(
          edit,
          server,
          this.#snapshots(server),
          this.#lifetime.signal,
        );
        this.#jobs.add(job);
        try {
          const result = await job;
          return {
            applied: result.applied,
            ...(result.failureReason === undefined
              ? {}
              : { failureReason: result.failureReason }),
          };
        } finally {
          this.#jobs.delete(job);
        }
      },
    });
  }

  /** Loads Pi configuration and optionally warms servers; the caller must dispose the workspace. */
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
      const notes = await concurrent(workspace.#servers(), async (config) => {
        try {
          await workspace.#pool.get(config, workspace.#lifetime.signal);
          return "";
        } catch (error) {
          return `${config.name}: eager startup failed: ${errorText(error)}`;
        }
      });
      workspace.#config.warnings.push(...notes.filter(Boolean));
    }
    return workspace;
  }

  get settings(): LspSettings {
    return this.#config.settings;
  }
  get warnings(): readonly string[] {
    return this.#config.warnings;
  }

  /** Executes one deadline-bound action and reports failures without escaping the tool result. */
  execute(params: LspParams, signal?: AbortSignal): Promise<LspResult> {
    const job = this.#execute(params, signal);
    this.#jobs.add(job);
    void job.finally(() => this.#jobs.delete(job)).catch(() => {});
    return job;
  }

  async #execute(
    params: LspParams,
    callerSignal?: AbortSignal,
  ): Promise<LspResult> {
    if (!this.#options.trusted)
      return this.#result(
        params,
        "LSP is available only in trusted projects.",
        false,
      );
    if (this.#lifetime.signal.aborted)
      return this.#result(params, "LSP workspace has been disposed.", false);
    if (
      !this.settings.enabled &&
      params.action !== "status" &&
      params.action !== "reload"
    )
      return this.#result(params, "LSP is disabled in settings.", false);
    const requestedTimeout = params.timeout ?? 20;
    if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0)
      return this.#result(
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
      this.#lifetime.signal,
      deadline.signal,
      ...(callerSignal ? [callerSignal] : []),
    ]);
    try {
      signal.throwIfAborted();
      return await this.#dispatch(params, signal);
    } catch (error) {
      return this.#result(
        params,
        `LSP error: ${errorText(signal.aborted ? signal.reason : error)}`,
        false,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  #result(
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

  #servers(file?: string): ServerConfig[] {
    const configured = file
      ? serversForFile(this.#config, file)
      : this.#config.servers.filter(
          (server) => !server.disabled && server.resolvedCommand,
        );
    return configured.filter((server) => !isCliLinter(server));
  }

  async #server(
    file: string | undefined,
    signal: AbortSignal,
  ): Promise<LanguageServer> {
    const config = this.#servers(file)[0];
    if (!config)
      throw new Error(
        file
          ? `No language server found for ${path.relative(this.#options.cwd, file)}`
          : "No language servers configured and available",
      );
    return this.#pool.get(config, signal);
  }

  async #open(
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
    this.#knownFiles.add(file);
    return content;
  }

  #snapshots(server: LanguageServer): Map<string, DocumentSnapshot> {
    const snapshots = new Map<string, DocumentSnapshot>();
    for (const file of this.#knownFiles) {
      const document = server.document(file);
      if (document) snapshots.set(file, { ...document });
    }
    return snapshots;
  }

  /** Reports cached configuration and process state without starting servers. */
  #status(params: LspParams): LspResult {
    const clients = this.#pool.clients();
    const lines = [
      `LSP: ${this.settings.enabled ? "enabled" : "disabled"}; ${this.settings.lazy ? "lazy" : "eager"}; session-owned servers`,
    ];
    for (const server of this.#config.servers) {
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
    if (this.#config.servers.length === 0)
      lines.push("No language servers configured");
    if (this.warnings.length)
      lines.push("Configuration warnings:", ...this.warnings);
    return this.#result(params, lines.join("\n"));
  }
  /** Starts matching servers to report their negotiated, effective capabilities. */
  async #capabilities(
    params: LspParams,
    signal: AbortSignal,
  ): Promise<LspResult> {
    const configs = this.#servers(
      params.file && params.file !== "*"
        ? path.resolve(this.#options.cwd, params.file)
        : undefined,
    );
    if (configs.length === 0)
      return this.#result(
        params,
        "No language servers configured for this target",
        false,
      );
    const responses = await concurrent(configs, async (config) => {
      try {
        const server = await this.#pool.get(config, signal);
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
    return this.#result(
      params,
      responses.map((item) => item.text).join("\n\n"),
      responses.some((item) => item.success),
      configs.map((config) => config.name).join(", "),
    );
  }
  /** Handles workspace actions before opening a document for position-based actions. */
  async #dispatch(params: LspParams, signal: AbortSignal): Promise<LspResult> {
    if (params.action === "status") return this.#status(params);
    if (params.action === "capabilities")
      return this.#capabilities(params, signal);
    if (params.action === "request") return this.#request(params, signal);
    if (params.action === "reload") return this.#reload(params, signal);
    if (params.action === "rename_file")
      return this.#renameFile(params, signal);
    if (!params.file)
      throw new Error(
        "file parameter required. Use '*' for supported workspace actions.",
      );
    if (params.action === "diagnostics")
      return this.#diagnostics(params, signal);
    if (params.file === "*") {
      if (params.action !== "symbols")
        throw new Error(`${params.action} requires a concrete file`);
      return this.#workspaceSymbols(params, signal);
    }
    const file = path.resolve(this.#options.cwd, params.file);
    const server = await this.#server(file, signal);
    const content = await this.#open(server, file, signal);
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
          params.action === "type_definition"
            ? "type definition"
            : params.action;
        if (found.length === 0)
          return this.#result(
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
              context = (await fs.readFile(location.file, "utf8")).split(
                /\r?\n/,
              );
            } catch (error) {
              context = [`Context unavailable: ${errorText(error)}`];
            }
            contexts.set(location.file, context);
          }
          const text = context[location.range.start.line]?.trim();
          lines.push(
            `${path.relative(this.#options.cwd, location.file) || location.file}:${location.range.start.line + 1}:${location.range.start.character + 1}${text ? `  ${text.slice(0, 500)}` : ""}`,
          );
        }
        return this.#result(
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
        return this.#result(
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
        return this.#result(
          params,
          found.length
            ? `Symbols in ${params.file}:\n${this.#symbolLines(found).join("\n")}`
            : "No symbols found",
          true,
          server.config.name,
        );
      }
      case "rename": {
        if (!params.new_name?.trim())
          throw new Error("new_name parameter required for rename");
        const snapshots = this.#snapshots(server);
        const edit = await server.request<WorkspaceEdit | null>(
          "textDocument/rename",
          { ...target, newName: params.new_name },
          signal,
        );
        if (edit === null)
          return this.#result(
            params,
            "Rename returned no edits",
            true,
            server.config.name,
          );
        const result = await this.#apply(
          edit,
          server,
          snapshots,
          signal,
          params.apply === false,
        );
        return this.#editResult(
          params,
          result,
          params.apply === false ? "Rename preview" : "Applied rename",
          server.config.name,
        );
      }
      case "code_actions":
        return this.#codeActions(params, server, file, position, signal);
      default:
        throw new Error(`Unsupported LSP action: ${String(params.action)}`);
    }
  }

  async #request(params: LspParams, signal: AbortSignal): Promise<LspResult> {
    const method = params.query?.trim();
    if (!method) throw new Error("query must contain the raw LSP method name");
    const file =
      params.file && params.file !== "*"
        ? path.resolve(this.#options.cwd, params.file)
        : undefined;
    let payload: unknown;
    if (params.payload !== undefined) {
      try {
        payload = JSON.parse(params.payload);
      } catch (error) {
        throw new Error(`Invalid JSON in payload: ${errorText(error)}`);
      }
    }
    const server = await this.#server(file, signal);
    const content = file ? await this.#open(server, file, signal) : undefined;
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
      return this.#result(
        params,
        `${server.config.name} ← ${method}:\n${typeof result === "string" ? result : JSON.stringify(result ?? null, null, 2)}`,
        true,
        server.config.name,
      );
    } catch (error) {
      return this.#result(
        params,
        `LSP error from ${server.config.name} on ${method}: ${errorText(error)}\n  params: ${JSON.stringify(payload ?? null).slice(0, 400)}`,
        false,
        server.config.name,
      );
    }
  }

  async #collectDiagnostics(
    file: string,
    signal: AbortSignal,
    timeoutMs = 10000,
  ): Promise<DiagnosticReport> {
    const configs = serversForFile(this.#config, file);
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
          const server = await this.#pool.get(config, signal);
          await this.#open(server, file, signal);
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

  async #diagnostics(
    params: LspParams,
    signal: AbortSignal,
  ): Promise<LspResult> {
    if (params.file === "*") {
      const result = await runWorkspaceDiagnostics(
        this.#options.cwd,
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
      this.#options.cwd,
      signal,
    );
    if (targets.files.length === 0)
      return this.#result(params, `No files matched pattern: ${params.file}`);
    const reports = await concurrent(targets.files, (file) =>
      this.#collectDiagnostics(
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
            this.#options.cwd,
            report.unverifiedSources,
          ),
        );
      else
        lines.push(
          `${path.relative(this.#options.cwd, report.file)}: all language servers failed; diagnostics unavailable`,
        );
      if (report.failures.length)
        lines.push(`Server failures:\n${report.failures.join("\n")}`);
    }
    if (targets.truncated)
      lines.push(
        "…diagnostics limited to 20 matched files; narrow the glob for remaining targets…",
      );
    return this.#result(
      params,
      lines.join("\n\n"),
      reports.some((report) => report.responders > 0),
    );
  }

  #symbolLines(found: readonly DisplaySymbol[]): string[] {
    const lines = found
      .slice(0, 200)
      .map(
        (symbol) =>
          `${"  ".repeat(symbol.depth)}${symbol.name}${symbol.container ? ` (${symbol.container})` : ""} [kind ${symbol.kind}] ${path.relative(this.#options.cwd, symbol.file) || symbol.file}${symbol.position ? `:${symbol.position.line + 1}:${symbol.position.character + 1}` : " (location unresolved)"}`,
      );
    if (found.length > 200)
      lines.push(`…${found.length - 200} symbols elided…`);
    return lines;
  }

  async #workspaceSymbols(
    params: LspParams,
    signal: AbortSignal,
  ): Promise<LspResult> {
    const query = params.query?.trim();
    if (!query)
      throw new Error("query parameter required for workspace symbols");
    const configs = this.#servers();
    if (configs.length === 0)
      throw new Error("No language servers configured and available");
    const responses = await concurrent(configs, async (config) => {
      try {
        const server = await this.#pool.get(config, signal);
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
          ...this.#symbolLines(found),
        ]
      : [`No symbols matching "${query}"`];
    if (failures.length) lines.push("Server failures:", ...failures);
    return this.#result(
      params,
      lines.join("\n"),
      responses.some((response) => !response.failure),
      configs.map((config) => config.name).join(", "),
    );
  }

  /** Lists validated actions, or resolves one explicitly selected action before applying it. */
  async #codeActions(
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
    const snapshots = this.#snapshots(server);
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
      return this.#result(
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
      return this.#result(
        params,
        `${actions.length} action(s):\n${list}`,
        true,
        server.config.name,
      );
    const query = params.query?.trim();
    if (!query)
      return this.#result(
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
      return this.#result(
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
      throw new Error(
        `Resolved code action disabled: ${action.disabledReason}`,
      );
    return this.#runCodeAction(
      params,
      action,
      server,
      snapshots,
      signal,
      diagnosticWarning,
    );
  }

  /**
   * Commits the validated action's edit before executing its command.
   * A command failure reports prior commits rather than implying an atomic rollback.
   */
  async #runCodeAction(
    params: LspParams,
    action: ParsedCodeAction,
    server: LanguageServer,
    snapshots: ReadonlyMap<string, DocumentSnapshot>,
    signal: AbortSignal,
    diagnosticWarning: string,
  ): Promise<LspResult> {
    const summary: string[] = [];
    if (action.edit !== undefined) {
      const result = await this.#apply(action.edit, server, snapshots, signal);
      summary.push(...result.summary);
      if (!result.applied)
        return this.#editResult(
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
        return this.#result(
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
    return this.#result(
      params,
      `${text}${diagnosticWarning ? `\n${diagnosticWarning}` : ""}`,
      true,
      server.config.name,
    );
  }

  /** Applies raw edits and reconciles committed paths, including partial-failure results. */
  async #apply(
    edit: unknown,
    server: LanguageServer | undefined,
    snapshots: ReadonlyMap<string, DocumentSnapshot>,
    signal: AbortSignal,
    preview = false,
    rollbackTextOnRenameFailure = false,
  ): Promise<EditResult> {
    signal.throwIfAborted();
    const result = await applyWorkspaceEdit(edit, {
      cwd: this.#options.cwd,
      documents: snapshots,
      ...(server ? { document: (file: string) => server.document(file) } : {}),
      signal,
      preview,
      rollbackTextOnRenameFailure,
    });
    if (!preview && result.changes.length > 0) {
      const failures = await this.#reconcile(result.changes);
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

  #editResult(
    params: LspParams,
    result: EditResult,
    label: string,
    serverName?: string,
  ): LspResult {
    return this.#result(
      params,
      `${label}:\n${result.summary.length ? result.summary.join("\n") : "No file changes"}${result.failureReason ? `\nError: ${result.failureReason}` : ""}`,
      result.applied,
      serverName,
    );
  }

  async #reconcile(changes: readonly ExecutedChange[]): Promise<string[]> {
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
      this.#knownFiles.delete(file);
      this.#diagnosticFingerprints.delete(file);
      this.#hooks.get(file)?.abort(new Error("File was removed or renamed"));
    }
    for (const file of changed) this.#knownFiles.add(file);
    await concurrent(this.#pool.clients(), async (server) => {
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
            this.#servers(file).some(
              (config) => config.name === server.config.name,
            )
          ) {
            await server.syncFile(file, undefined, this.#lifetime.signal);
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

  async #renameFile(
    params: LspParams,
    signal: AbortSignal,
  ): Promise<LspResult> {
    if (!params.file || !params.new_name?.trim())
      throw new Error(
        "rename_file requires file (source) and new_name (destination)",
      );
    const source = path.resolve(this.#options.cwd, params.file);
    const destination = path.resolve(this.#options.cwd, params.new_name);
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
        for (const config of this.#servers(file))
          configs.set(config.name, config);
    const buckets = new Map<
      string,
      Array<{ edit: TextEdit; server: string }>
    >();
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
        server = await this.#pool.get(config, signal);
      } catch (error) {
        signal.throwIfAborted();
        notes.push(`${config.name}: failed to start: ${errorText(error)}`);
        continue;
      }
      try {
        for (const file of files)
          if (
            this.#servers(file).some(
              (candidate) => candidate.name === config.name,
            )
          )
            await this.#open(server, file, signal);
        const serverSnapshots = this.#snapshots(server);
        for (const [file, document] of serverSnapshots) {
          const prior = snapshots.get(file);
          if (prior && prior.content !== document.content)
            throw new Error(
              `Servers disagree about current content of ${file}`,
            );
          snapshots.set(file, document);
        }
        const response = await server.request<WorkspaceEdit | null>(
          "workspace/willRenameFiles",
          { files: pairs },
          signal,
        );
        if (response === null) continue;
        const validated = await applyWorkspaceEdit(response, {
          cwd: this.#options.cwd,
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
      return this.#result(
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
    const result = await this.#apply(
      { documentChanges, changeAnnotations: annotations },
      undefined,
      snapshots,
      signal,
      params.apply === false,
      true,
    );
    if (notes.length) result.summary.push("Server notes:", ...notes);
    return this.#editResult(
      params,
      result,
      `${params.apply === false ? "Rename preview" : "Rename"}: ${params.file} → ${params.new_name} (${files.length} file(s))`,
    );
  }

  async #reload(params: LspParams, signal: AbortSignal): Promise<LspResult> {
    for (const hook of this.#hooks.values())
      hook.abort(new Error("LSP configuration reloaded"));
    this.#diagnosticFingerprints.clear();
    const previous = this.#config;
    const next = await loadLspConfig(
      this.#options.cwd,
      this.#options.agentDir,
      this.#options.trusted,
    );
    signal.throwIfAborted();
    this.#config = next;
    if (previous.idleTimeoutMs !== next.idleTimeoutMs) {
      await this.#pool.dispose();
      this.#pool = this.#createPool(next);
    }
    const concrete =
      params.file && params.file !== "*"
        ? path.resolve(this.#options.cwd, params.file)
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
      const selected = this.#servers(concrete)[0];
      if (selected) changed.push(selected.name);
    }
    if (!next.settings.enabled) {
      await this.#pool.stop();
      return this.#result(
        params,
        "LSP configuration reloaded; LSP is disabled.",
      );
    }
    if (changed.length) await this.#pool.stop([...new Set(changed)]);
    const configs = concrete
      ? this.#servers(concrete).slice(0, 1)
      : this.#servers();
    if (configs.length === 0)
      return this.#result(
        params,
        `LSP configuration reloaded; no language servers available.${this.warnings.length ? `\n${this.warnings.join("\n")}` : ""}`,
        false,
      );
    const results = await concurrent(configs, async (config) => {
      try {
        const server = await this.#pool.get(config, signal);
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
          await this.#pool.stop([config.name]);
          await this.#pool.get(config, signal);
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
    return this.#result(
      params,
      [...results.map((result) => result.text), ...this.warnings].join("\n"),
      results.some((result) => result.success),
      configs.map((config) => config.name).join(", "),
    );
  }

  /**
   * Synchronizes successful host writes and edits; only writes can trigger formatting.
   * Optional feedback is bounded and never changes the already-committed host result.
   */
  afterMutation(
    paths: readonly string[],
    source: "write" | "edit",
    signal?: AbortSignal,
  ): Promise<LspResult | undefined> {
    if (
      !this.#options.trusted ||
      !this.settings.enabled ||
      this.#lifetime.signal.aborted
    )
      return Promise.resolve(undefined);
    const deadline = new AbortController();
    const combined = AbortSignal.any([
      deadline.signal,
      ...(signal ? [signal] : []),
    ]);
    const job = this.#afterMutation(paths, source, combined);
    this.#jobs.add(job);
    void job.finally(() => this.#jobs.delete(job)).catch(() => {});
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

  /** Supersedes older feedback per file while unrelated files run with bounded concurrency. */
  async #afterMutation(
    paths: readonly string[],
    source: "write" | "edit",
    callerSignal?: AbortSignal,
  ): Promise<LspResult | undefined> {
    const files = [
      ...new Set(paths.map((file) => path.resolve(this.#options.cwd, file))),
    ];
    const targets = files.map((file) => {
      this.#hooks
        .get(file)
        ?.abort(new Error("Superseded by a newer file mutation"));
      const controller = new AbortController();
      this.#hooks.set(file, controller);
      return { file, controller };
    });
    const feedback = await concurrent(targets, async ({ file, controller }) => {
      if (this.#hooks.get(file) !== controller) return "";
      const timer = setTimeout(
        () =>
          controller.abort(
            new Error("LSP mutation feedback timed out after 15s"),
          ),
        15000,
      );
      const signal = AbortSignal.any([
        this.#lifetime.signal,
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
          const failures = await this.#reconcile([
            { kind: "delete", file, files: [file] },
          ]);
          return failures.length ? failures.join("\n") : "";
        }
        this.#knownFiles.add(file);
        const relevant = serversForFile(this.#config, file).length > 0;
        for (const server of this.#pool.clients())
          if (
            server.isAlive &&
            (server.document(file) ||
              this.#servers(file).some(
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
        if (relevant && source === "write" && this.settings.formatOnWrite) {
          try {
            notes.push(...(await this.#format(file, signal)));
          } catch (error) {
            notes.push(`Formatting failed: ${errorText(error)}`);
          }
        }
        if (
          relevant &&
          (source === "write"
            ? this.settings.diagnosticsOnWrite
            : this.settings.diagnosticsOnEdit)
        ) {
          const report = await this.#collectDiagnostics(file, signal);
          if (this.#hooks.get(file) !== controller) return "";
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
          const previous = this.#diagnosticFingerprints.get(file);
          if (report.responders > 0) {
            const hasFeedback =
              report.diagnostics.length > 0 ||
              unverified ||
              previous?.hadFindings ||
              previous?.unverified;
            if (
              (!this.settings.diagnosticsDeduplicate ||
                previous?.fingerprint !== fingerprint) &&
              hasFeedback
            )
              notes.push(
                diagnosticsText(
                  file,
                  report.diagnostics,
                  this.#options.cwd,
                  report.unverifiedSources,
                ),
              );
            this.#diagnosticFingerprints.set(file, {
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
          this.#hooks.get(file) !== controller ||
          this.#lifetime.signal.aborted ||
          callerSignal?.aborted
        )
          return "";
        return notes.join("\n");
      } catch (error) {
        if (
          this.#hooks.get(file) !== controller ||
          this.#lifetime.signal.aborted ||
          callerSignal?.aborted
        )
          return "";
        return `${path.relative(this.#options.cwd, file)}: LSP feedback unavailable (${errorText(signal.aborted ? signal.reason : error)}). The host ${source} already succeeded.`;
      } finally {
        clearTimeout(timer);
        if (this.#hooks.get(file) === controller) this.#hooks.delete(file);
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

  /** Computes formatting first, then applies it only if the original document is still current. */
  async #format(file: string, signal: AbortSignal): Promise<string[]> {
    const configs = serversForFile(this.#config, file);
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
      const result = await this.#apply(
        edit,
        undefined,
        new Map([[file, { version: 0, content }]]),
        signal,
      );
      if (!result.applied)
        throw new Error(result.failureReason ?? "Formatting edit failed");
      return [
        `Formatted ${path.relative(this.#options.cwd, file)} with ${cli.name}`,
      ];
    }
    for (const config of configs.filter(
      (candidate) => !isCliLinter(candidate),
    )) {
      const server = await this.#pool.get(config, signal);
      if (!server.capabilities.documentFormattingProvider) continue;
      if ((await this.#open(server, file, signal)) !== content)
        throw new Error(
          "File changed before formatting; stale formatter result discarded",
        );
      const snapshots = this.#snapshots(server);
      const response = await server.request<TextEdit[] | null>(
        "textDocument/formatting",
        {
          textDocument: { uri: fileToUri(file) },
          options: await formattingOptions(file, content, this.#options.cwd),
        },
        signal,
      );
      if (response === null) return [];
      const result = await this.#apply(
        { changes: { [fileToUri(file)]: response } },
        server,
        snapshots,
        signal,
      );
      if (!result.applied)
        throw new Error(result.failureReason ?? "Formatting edit failed");
      return result.changes.length
        ? [
            `Formatted ${path.relative(this.#options.cwd, file)} with ${config.name}`,
          ]
        : [];
    }
    return [
      "Formatting unavailable: no matching formatting-capable server is installed",
    ];
  }

  /** Idempotently cancels feedback, disposes servers, and waits for tracked jobs to settle. */
  dispose(): Promise<void> {
    if (!this.#disposePromise) {
      this.#lifetime.abort(new Error("LSP workspace disposed"));
      for (const hook of this.#hooks.values())
        hook.abort(new Error("LSP workspace disposed"));
      this.#disposePromise = (async () => {
        await this.#pool.dispose();
        await Promise.allSettled([...this.#jobs]);
        this.#hooks.clear();
        this.#knownFiles.clear();
        this.#diagnosticFingerprints.clear();
      })();
    }
    return this.#disposePromise;
  }
}
