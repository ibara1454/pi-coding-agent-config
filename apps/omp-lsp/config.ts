// Adapted from Oh My Pi's MIT-licensed LSP configuration; see LICENSE.
import { constants } from "node:fs";
import {
  access,
  type FileHandle,
  open,
  opendir,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Minimatch } from "minimatch";
import { parseDocument } from "yaml";
import type { LspConfig, LspSettings, ServerConfig } from "./types.ts";

const LEADING_DOT = /^\./;

const CONFIG_FILES = [
  "lsp.json",
  ".lsp.json",
  "lsp.yaml",
  ".lsp.yaml",
  "lsp.yml",
  ".lsp.yml",
];
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_ROOT_ENTRIES = 10_000;
const LOCAL_BIN_DIRS = [
  "node_modules/.bin",
  ".venv/bin",
  ".venv/Scripts",
  "venv/bin",
  "venv/Scripts",
  ".env/bin",
  ".env/Scripts",
  "vendor/bundle/bin",
  "bin",
];
const SETTING_DEFAULTS: Readonly<LspSettings> = {
  enabled: true,
  lazy: true,
  formatOnWrite: false,
  diagnosticsOnWrite: true,
  diagnosticsOnEdit: false,
  diagnosticsDeduplicate: true,
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absent(error: unknown): boolean {
  if (!record(error)) {
    return false;
  }
  const { code } = error;
  return code === "ENOENT" || code === "ENOTDIR";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (absent(error)) {
      return false;
    }
    throw error;
  }
}

async function readConfig(file: string): Promise<unknown> {
  let handle: FileHandle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if (absent(error)) {
      return undefined;
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error("expected a regular file");
    }
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new Error("configuration exceeds 1 MiB");
    }
    const bytes = Buffer.alloc(metadata.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (result.bytesRead === 0) {
        break;
      }
      length += result.bytesRead;
    }
    if (length > metadata.size) {
      throw new Error("configuration changed while being read; retry the load");
    }
    const text = bytes.toString("utf8", 0, length);
    if (path.extname(file).toLowerCase() === ".json") {
      return JSON.parse(text) as unknown;
    }
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new Error(document.errors.map((error) => error.message).join("; "));
    }
    if (document.warnings.length > 0) {
      throw new Error(
        document.warnings.map((warning) => warning.message).join("; "),
      );
    }
    return document.toJS({ maxAliasCount: 100 }) as unknown;
  } finally {
    await handle.close();
  }
}

function strings(value: unknown, name: string, allowEmpty = false): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        (!allowEmpty && item.trim().length === 0) ||
        item.includes("\0"),
    )
  ) {
    throw new Error(
      `${name} must be ${allowEmpty ? "an" : "a non-empty"} array of strings`,
    );
  }
  return value as string[];
}

function validateJsonPayload(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
): void {
  if (depth > 100) {
    throw new Error("server configuration payload exceeds 100 nesting levels");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return;
  }
  if (!Array.isArray(value) && !record(value)) {
    throw new Error(
      "server configuration payload must contain JSON-compatible values",
    );
  }
  if (ancestors.has(value)) {
    throw new Error(
      "server configuration payload contains a cyclic YAML alias",
    );
  }
  ancestors.add(value);
  for (const item of Object.values(value)) {
    validateJsonPayload(item, ancestors, depth + 1);
  }
  ancestors.delete(value);
}

function stringMap(value: unknown, name: string): Record<string, string> {
  if (
    !record(value) ||
    Object.entries(value).some(
      ([key, item]) =>
        !key ||
        key.includes("\0") ||
        typeof item !== "string" ||
        item.includes("\0"),
    )
  ) {
    throw new Error(`${name} must be an object with string values`);
  }
  return value as Record<string, string>;
}

function duration(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 2_147_483_647
  ) {
    throw new Error(
      `${name} must be a finite millisecond duration between 0 and 2147483647`,
    );
  }
  return value;
}

function normalizeServer(
  name: string,
  value: Record<string, unknown>,
  cwd: string,
): ServerConfig {
  const {
    command,
    extensionToLanguage: rawExtensionToLanguage,
    fileTypes: rawFileTypes,
    rootMarkers: rawRootMarkers,
    args,
    languageId,
    initializationOptions,
    env,
    warmupTimeoutMs,
    workspaceReadyTimings,
  } = value;
  if (
    typeof command !== "string" ||
    !command.trim() ||
    command.includes("\0")
  ) {
    throw new Error("command must be a non-empty string");
  }
  const extensionToLanguage =
    rawExtensionToLanguage === undefined
      ? undefined
      : stringMap(rawExtensionToLanguage, "extensionToLanguage");
  if (
    extensionToLanguage &&
    Object.values(extensionToLanguage).some((language) => !language.trim())
  ) {
    throw new Error(
      "extensionToLanguage language identifiers must not be empty",
    );
  }
  const fileTypes = strings(
    rawFileTypes === undefined
      ? extensionToLanguage
        ? Object.keys(extensionToLanguage)
        : undefined
      : rawFileTypes,
    "fileTypes",
  );
  const rootMarkers = strings(
    rawRootMarkers === undefined
      ? extensionToLanguage
        ? ["."]
        : undefined
      : rawRootMarkers,
    "rootMarkers",
    true,
  );
  if (rootMarkers.some((marker) => !marker.trim())) {
    throw new Error("rootMarkers must not contain empty markers");
  }
  const result: ServerConfig = {
    name,
    command,
    args: strings(args === undefined ? [] : args, "args", true),
    fileTypes,
    rootMarkers,
    root: cwd,
  };
  if (extensionToLanguage) {
    result.extensionToLanguage = extensionToLanguage;
  }
  if (languageId !== undefined) {
    if (typeof languageId !== "string" || !languageId.trim()) {
      throw new Error("languageId must be a non-empty string");
    }
    result.languageId = languageId;
  }
  for (const key of ["disabled", "isLinter"] as const) {
    if (value[key] === undefined) {
      continue;
    }
    if (typeof value[key] !== "boolean") {
      throw new Error(`${key} must be a boolean`);
    }
    result[key] = value[key];
  }
  for (const key of ["initOptions", "settings", "capabilities"] as const) {
    const item =
      key === "initOptions" && value[key] === undefined
        ? initializationOptions
        : value[key];
    if (item === undefined) {
      continue;
    }
    if (!record(item)) {
      throw new Error(`${key} must be an object`);
    }
    validateJsonPayload(item);
    result[key] = item;
  }
  if (env !== undefined) {
    result.env = stringMap(env, "env");
    if (Object.keys(result.env).some((key) => key.includes("="))) {
      throw new Error("environment variable names must not contain '='");
    }
  }
  if (warmupTimeoutMs !== undefined) {
    result.warmupTimeoutMs = duration(warmupTimeoutMs, "warmupTimeoutMs");
  }
  if (workspaceReadyTimings !== undefined) {
    const timings = workspaceReadyTimings;
    if (!record(timings)) {
      throw new Error("workspaceReadyTimings must be an object");
    }
    result.workspaceReadyTimings = {};
    for (const key of [
      "timeoutMs",
      "pollMs",
      "settleMs",
      "statusRequestTimeoutMs",
    ] as const) {
      if (timings[key] !== undefined) {
        result.workspaceReadyTimings[key] = duration(
          timings[key],
          `workspaceReadyTimings.${key}`,
        );
      }
    }
  }
  return result;
}

async function hasRootMarkers(
  cwd: string,
  markers: readonly string[],
): Promise<boolean> {
  if (markers.length === 0) {
    return true;
  }
  const patterns: Minimatch[] = [];
  for (const marker of markers) {
    const pattern = new Minimatch(marker, {
      dot: true,
      magicalBraces: true,
      nonegate: true,
      nocomment: true,
      braceExpandMax: 1000,
      maxGlobstarRecursion: 16,
    });
    if (pattern.hasMagic()) {
      patterns.push(pattern);
    } else if (await exists(path.resolve(cwd, marker))) {
      return true;
    }
  }
  if (patterns.length === 0) {
    return false;
  }
  const directory = await opendir(cwd);
  let count = 0;
  for await (const entry of directory) {
    if (++count > MAX_ROOT_ENTRIES) {
      throw new Error(
        `root-marker discovery exceeded ${MAX_ROOT_ENTRIES} entries in ${cwd}`,
      );
    }
    if (patterns.some((pattern) => pattern.match(entry.name))) {
      return true;
    }
  }
  return false;
}

async function executable(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) {
      return false;
    }
    await access(
      file,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch (error) {
    if (absent(error)) {
      return false;
    }
    if (record(error)) {
      const { code } = error;
      if (code === "EACCES") {
        return false;
      }
    }
    throw error;
  }
}

/**
 * Finds an installed executable after the caller establishes project trust.
 * @param command - Absolute/relative path or executable name to locate.
 * @param cwd - Project directory searched before PATH entries.
 * @param env - Optional environment overrides; absent PATH/PATHEXT use the host environment.
 * @returns An executable path, or undefined when none is installed.
 * @throws Unexpected filesystem errors rather than treating them as missing executables.
 * @example resolveCommand("tsc", "/project", {}) searches local bins and the host PATH.
 */
export async function resolveCommand(
  command: string,
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<string | undefined> {
  const { PATHEXT: pathExt, PATH: envPath } = env ?? {};
  const environment: Record<string, string | undefined> = process.env;
  const { PATHEXT: processPathExt, PATH: processPath } = environment;
  const extensions =
    process.platform === "win32"
      ? [
          "",
          ...(pathExt ?? processPathExt ?? ".EXE;.CMD;.BAT;.COM")
            .split(";")
            .filter(Boolean),
        ]
      : [""];
  const candidates =
    path.isAbsolute(command) || command.includes("/") || command.includes("\\")
      ? [path.resolve(cwd, command)]
      : [
          ...LOCAL_BIN_DIRS.map((directory) =>
            path.resolve(cwd, directory, command),
          ),
          ...(envPath ?? processPath ?? "")
            .split(path.delimiter)
            .map((directory) => path.resolve(cwd, directory, command)),
        ];
  for (const candidate of candidates) {
    for (const extension of extensions) {
      if (await executable(candidate + extension)) {
        return candidate + extension;
      }
    }
  }
  return undefined;
}

async function typescriptSpeaksLsp(command: string): Promise<boolean> {
  const resolved = await realpath(command);
  const binDir = path.dirname(command);
  const candidates = [
    ...(path.basename(path.dirname(resolved)) === "bin"
      ? [path.dirname(path.dirname(resolved))]
      : []),
    path.resolve(binDir, "..", "typescript"),
    path.resolve(binDir, "..", "@typescript", "native-preview"),
    path.join(binDir, "node_modules", "typescript"),
  ];
  for (const directory of candidates) {
    const manifest = await readConfig(path.join(directory, "package.json"));
    if (!record(manifest)) {
      continue;
    }
    const { name } = manifest;
    if (name !== "typescript" && name !== "@typescript/native-preview") {
      continue;
    }
    return !(await exists(path.join(directory, "lib", "tsserver.js")));
  }
  return false;
}

/**
 * Loads bundled and agent configuration, plus project configuration only when trusted.
 * @param projectDirectory - Project path, resolved without changing the caller's input.
 * @param agentDir - Agent configuration directory.
 * @param trusted - Permits reading project configuration and resolving project executables.
 * @returns Effective servers, settings, and configuration warnings.
 * @throws If bundled configuration is invalid or cannot be read.
 * @example loadLspConfig("/project", "/agent", false) does not read /project/.pi.
 */
export async function loadLspConfig(
  projectDirectory: string,
  agentDir: string,
  trusted: boolean,
): Promise<LspConfig> {
  const cwd = path.resolve(projectDirectory);
  const result: LspConfig = {
    servers: [],
    settings: { ...SETTING_DEFAULTS },
    warnings: [],
  };
  const merged = new Map<string, ServerConfig>();
  const customizedLaunchers = new Set<string>();
  const defaults = await readConfig(
    fileURLToPath(new URL("./defaults.json", import.meta.url)),
  );
  if (!record(defaults)) {
    throw new Error("LSP bundled defaults must contain a server map");
  }
  for (const [name, value] of Object.entries(defaults)) {
    if (!record(value)) {
      throw new Error(`Invalid bundled LSP preset ${name}`);
    }
    merged.set(name, normalizeServer(name, value, cwd));
  }
  const directories = trusted
    ? [path.resolve(agentDir), path.join(cwd, ".pi")]
    : [path.resolve(agentDir)];
  for (const directory of directories) {
    const settingsFile = path.join(directory, "settings.json");
    try {
      const settings = await readConfig(settingsFile);
      if (settings !== undefined) {
        if (!record(settings)) {
          throw new Error("settings must be an object");
        }
        const { lsp } = settings;
        if (lsp !== undefined) {
          if (!record(lsp)) {
            throw new Error("lsp settings must be an object");
          }
          for (const key of Object.keys(
            SETTING_DEFAULTS,
          ) as (keyof LspSettings)[]) {
            if (lsp[key] === undefined) {
              continue;
            }
            if (typeof lsp[key] !== "boolean") {
              result.warnings.push(
                `${settingsFile}: lsp.${key} must be a boolean; keeping previous value`,
              );
            } else {
              result.settings[key] = lsp[key];
            }
          }
        }
      }
    } catch (error) {
      result.warnings.push(
        `${settingsFile}: ${message(error)}; keeping previous settings`,
      );
    }
    // OMP's same-directory priority: visible JSON wins over hidden JSON, YAML, YML.
    for (const filename of [...CONFIG_FILES].reverse()) {
      const file = path.join(directory, filename);
      try {
        const document = await readConfig(file);
        if (document === undefined) {
          continue;
        }
        if (!record(document)) {
          throw new Error(
            "configuration must contain a server map or { servers }",
          );
        }
        const { servers, idleTimeoutMs } = document;
        const rawServers = Object.hasOwn(document, "servers")
          ? servers
          : Object.fromEntries(
              Object.entries(document).filter(
                ([key]) => key !== "idleTimeoutMs",
              ),
            );
        if (!record(rawServers)) {
          throw new Error("servers must be an object");
        }
        if (idleTimeoutMs !== undefined) {
          try {
            result.idleTimeoutMs = duration(idleTimeoutMs, "idleTimeoutMs");
          } catch (error) {
            result.warnings.push(
              `${file}: ${message(error)}; keeping previous idle timeout`,
            );
          }
        }
        for (const [name, override] of Object.entries(rawServers)) {
          try {
            if (!name.trim() || !record(override)) {
              throw new Error(
                "server definition must be an object with a non-empty name",
              );
            }
            const { initializationOptions } = override;
            const candidate: Record<string, unknown> & {
              initOptions?: unknown;
              fileTypes?: unknown;
            } = {
              ...merged.get(name),
              ...override,
            };
            if (
              Object.hasOwn(override, "initializationOptions") &&
              !Object.hasOwn(override, "initOptions")
            ) {
              candidate.initOptions = initializationOptions;
            }
            if (
              Object.hasOwn(override, "extensionToLanguage") &&
              !Object.hasOwn(override, "fileTypes")
            ) {
              candidate.fileTypes = undefined;
            }
            merged.set(name, normalizeServer(name, candidate, cwd));
            if (
              Object.hasOwn(override, "command") ||
              Object.hasOwn(override, "args")
            ) {
              customizedLaunchers.add(name);
            }
          } catch (error) {
            result.warnings.push(
              `${file}: server ${name}: ${message(error)}; keeping previous definition if present`,
            );
          }
        }
      } catch (error) {
        result.warnings.push(
          `${file}: ${message(error)}; keeping previous configuration`,
        );
      }
    }
  }
  if (!trusted) {
    result.warnings.push(
      "Project is not trusted: project LSP configuration, executable discovery, and language servers are disabled.",
    );
    return result;
  }
  for (const server of merged.values()) {
    try {
      if (!(await hasRootMarkers(cwd, server.rootMarkers))) {
        continue;
      }
      if (server.name === "omnisharp") {
        server.args = server.args.map((argument) =>
          argument === "$PID" ? String(process.pid) : argument,
        );
      }
      if (!server.disabled) {
        const command = await resolveCommand(server.command, cwd, server.env);
        if (command !== undefined) {
          server.resolvedCommand = command;
        }
      }
      result.servers.push(server);
    } catch (error) {
      result.warnings.push(`${server.name}: ${message(error)}`);
      result.servers.push(server);
    }
  }
  const native = result.servers.find(
    (server) => server.name === "typescript-native",
  );
  if (
    !customizedLaunchers.has("typescript-native") &&
    !customizedLaunchers.has("typescript-language-server")
  ) {
    try {
      const useNative =
        !!native?.resolvedCommand &&
        !native.disabled &&
        (await typescriptSpeaksLsp(native.resolvedCommand));
      result.servers = result.servers.filter(
        (server) =>
          server.name !==
          (useNative ? "typescript-language-server" : "typescript-native"),
      );
    } catch (error) {
      result.warnings.push(
        `TypeScript server selection: ${message(error)}; native support could not be verified`,
      );
      result.servers = result.servers.filter(
        (server) => server.name !== "typescript-native",
      );
    }
  }
  return result;
}

/** Selects enabled, installed servers by filename or extension, with semantic servers before linters. */
export function serversForFile(
  config: LspConfig,
  file: string,
): ServerConfig[] {
  const extension = path.extname(file).toLowerCase().replace(LEADING_DOT, "");
  const filename = path.basename(file).toLowerCase();
  return config.servers
    .filter(
      (server) =>
        !server.disabled &&
        server.resolvedCommand !== undefined &&
        server.fileTypes.some((type) => {
          const normalized = type.toLowerCase();
          return (
            normalized === filename ||
            normalized.replace(LEADING_DOT, "") === extension
          );
        }),
    )
    .sort((left, right) => Number(!!left.isLinter) - Number(!!right.isLinter));
}

export function isCliLinter(server: ServerConfig): boolean {
  return server.name === "biome" || server.name === "swiftlint";
}
