import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  DefaultPackageManager,
  type ResolvedResource,
  SettingsManager,
  type SettingsManagerCreateOptions,
} from "@earendil-works/pi-coding-agent";

const LINE_BREAK = /\r?\n/;
const LEADING_SLASHES = /^\/+/;
const GIT_SUFFIX = /\.git$/;
const SCP_GIT_PATH: RegExp = /^git@[^:]+:(.+)$/;
const GIT_REF_SUFFIX = /@[^/]+$/;
const EXTENSION_SUFFIX = /\.(?:ts|js)$/;
const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_HOUR = 3_600_000;
const MILLISECONDS_PER_DAY = 86_400_000;
const RELATIVE_AGE_DAY_LIMIT = 7;
const MAX_WELCOME_SESSIONS = 4;

export type ExtensionScope = "project" | "user";

export interface WelcomeExtension {
  name: string;
  scope: ExtensionScope;
  path?: string;
  packageSource?: string;
}

export interface WelcomeSession {
  name: string;
  timeAgo: string;
}

interface PackageSource {
  source: string;
  autoload?: boolean;
  extensions?: string[];
}

interface PiSettings {
  quietStartup?: boolean | "header";
  packages?: Array<string | PackageSource>;
  extensions?: string[];
  npmCommand?: string[];
}

interface WelcomeSnapshotOptions {
  cwd: string;
  agentDir?: string;
  projectTrusted: boolean;
  welcomePath?: string;
}

export const STARTUP_TIPS = [
  "Use /model to choose the active model.",
  "Use /scoped-models to inspect models available to this session.",
  "Use /resume to return to a saved session.",
  "Use /tree to browse the current session tree.",
  "Use /copy to copy recent output to your clipboard.",
  "Use /hotkeys to see available keyboard shortcuts.",
  "Use /reload after changing extensions.",
  "Use !! to run bash without adding it to context.",
  "Drop files into the editor to attach them.",
] as const;

function readJson(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizePiPath(input: string): string {
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/")) {
    return join(homedir(), input.slice(2));
  }
  if (input.startsWith("file://")) {
    try {
      return fileURLToPath(input);
    } catch {
      return input;
    }
  }
  return input;
}

/** Pi's public agent-directory resolution, including PI_CODING_AGENT_DIR expansion. */
export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const { PI_CODING_AGENT_DIR: configured } = env;
  return configured
    ? normalizePiPath(configured)
    : join(homedir(), ".pi", "agent");
}

/**
 * Filters untrusted settings metadata to the fields used by the welcome snapshot.
 * @param settings Parsed metadata; invalid fields and entries are ignored.
 * @returns Validated quiet mode, package sources, extension paths, and package-manager command.
 * @example cleanSettings({ quietStartup: "header" }) // { quietStartup: "header" }
 */
function cleanSettings(settings: Record<string, unknown>): PiSettings {
  const { packages: rawPackages } = settings;
  const packages = Array.isArray(rawPackages)
    ? rawPackages.reduce<Array<string | PackageSource>>((result, entry) => {
        if (typeof entry === "string") {
          result.push(entry);
          return result;
        }
        if (
          entry === null ||
          typeof entry !== "object" ||
          Array.isArray(entry)
        ) {
          return result;
        }
        const source = "source" in entry ? entry.source : undefined;
        if (typeof source !== "string") {
          return result;
        }
        const packageSource: PackageSource = { source };
        const autoload = "autoload" in entry ? entry.autoload : undefined;
        if (typeof autoload === "boolean") {
          packageSource.autoload = autoload;
        }
        const extensions = "extensions" in entry ? entry.extensions : undefined;
        if (Array.isArray(extensions)) {
          packageSource.extensions = extensions.filter(
            (value: unknown): value is string => typeof value === "string",
          );
        }
        result.push(packageSource);
        return result;
      }, [])
    : undefined;
  const cleaned: PiSettings = {};
  const { quietStartup } = settings;
  if (typeof quietStartup === "boolean" || quietStartup === "header") {
    cleaned.quietStartup = quietStartup;
  }
  if (packages !== undefined) {
    cleaned.packages = packages;
  }
  const { extensions } = settings;
  if (Array.isArray(extensions)) {
    cleaned.extensions = extensions.filter(
      (entry: unknown): entry is string => typeof entry === "string",
    );
  }
  const { npmCommand } = settings;
  if (
    Array.isArray(npmCommand) &&
    npmCommand.every((entry: unknown) => typeof entry === "string")
  ) {
    cleaned.npmCommand = npmCommand;
  }
  return cleaned;
}

function scopedSettings(
  cwd: string,
  agentDir: string,
  projectTrusted: boolean,
): { user: PiSettings; project: PiSettings } {
  return {
    user: cleanSettings(readJson(join(agentDir, "settings.json"))),
    project: projectTrusted
      ? cleanSettings(readJson(join(cwd, ".pi", "settings.json")))
      : {},
  };
}

/**
 * Resolves Pi's quiet startup mode without reading untrusted project settings.
 * @param cwd Project directory whose `.pi/settings.json` may override user settings.
 * @param agentDir User configuration directory; defaults to Pi's agent directory.
 * @param projectTrusted Whether project settings may be read.
 * @param argv Process arguments; `--verbose` disables quiet startup.
 * @returns The effective boolean or header-only mode; absent settings return false.
 * @example effectiveQuietStartup("/project", "/agent", false, ["pi", "--verbose"]) // false
 */
export function effectiveQuietStartup(
  cwd: string,
  agentDir = getAgentDir(),
  projectTrusted = false,
  argv = process.argv,
): boolean | "header" {
  if (argv.includes("--verbose")) {
    return false;
  }
  const settings = scopedSettings(cwd, agentDir, projectTrusted);
  return settings.project.quietStartup ?? settings.user.quietStartup ?? false;
}

function toPosixPath(filePath: string): string {
  return filePath.replaceAll(sep, "/");
}

function canonicalPath(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return resolve(filePath);
  }
}

function extensionNameFromPath(extensionPath: string): string {
  const base = basename(extensionPath);
  if (base === "index.ts" || base === "index.js") {
    return basename(dirname(extensionPath));
  }
  return base;
}

function compactPackageSourceLabel(source: string): string {
  if (source.startsWith("npm:")) {
    return source;
  }
  if (!source.startsWith("git:")) {
    return source;
  }
  const raw = source.slice("git:".length).trim();
  const scpPath = raw.match(SCP_GIT_PATH)?.[1];
  if (scpPath) {
    return `git:${scpPath.replace(GIT_REF_SUFFIX, "").replace(GIT_SUFFIX, "") || raw}`;
  }
  try {
    const compact = new URL(raw).pathname
      .replace(LEADING_SLASHES, "")
      .replace(GIT_REF_SUFFIX, "")
      .replace(GIT_SUFFIX, "");
    return `git:${compact || raw}`;
  } catch {
    const slash = raw.indexOf("/");
    const compact = (slash < 0 ? raw : raw.slice(slash + 1))
      .replace(GIT_REF_SUFFIX, "")
      .replace(GIT_SUFFIX, "");
    return `git:${compact || raw}`;
  }
}

/**
 * Formats a package-qualified label relative to Pi's resolved package base directory.
 * @param resource Native extension candidate carrying package provenance.
 * @returns A compact source label with the extension's relative name.
 * @example npm:tools plus /pkg/extensions/nested/index.ts becomes "npm:tools:nested".
 */
function packageExtensionName(resource: ResolvedResource): string {
  const sourceLabel = compactPackageSourceLabel(resource.metadata.source);
  const shortPath = resource.metadata.baseDir
    ? toPosixPath(relative(resource.metadata.baseDir, resource.path))
    : toPosixPath(resource.path);
  const packagePath = shortPath.startsWith("extensions/")
    ? shortPath.slice("extensions/".length)
    : shortPath;
  const parsed = posix.parse(packagePath);
  if (parsed.name === "index") {
    return !parsed.dir || parsed.dir === "."
      ? sourceLabel
      : `${sourceLabel}:${parsed.dir}`;
  }
  const extensionName =
    parsed.dir && parsed.dir !== "."
      ? `${parsed.dir}/${parsed.name}`
      : parsed.name;
  return `${sourceLabel}:${extensionName}`;
}

function localNameSuffix(parts: readonly string[], count: number): string {
  const suffix = parts.slice(-count);
  const last = suffix.at(-1);
  if (last) {
    suffix[suffix.length - 1] = last.replace(EXTENSION_SUFFIX, "");
  }
  return suffix.join("/");
}

/**
 * Assigns display names without changing Pi's resolved paths or provenance.
 * @param resources Enabled native extension candidates.
 * @returns Package-qualified labels or the shortest distinct local path suffix per scope.
 * @example /first/same.ts and /second/same.ts become "first/same" and "second/same".
 */
function extensionNames(
  resources: readonly ResolvedResource[],
): Map<ResolvedResource, string> {
  const local = resources.filter(
    (resource) =>
      !(
        resource.metadata.origin === "package" &&
        (resource.metadata.source.startsWith("npm:") ||
          resource.metadata.source.startsWith("git:"))
      ),
  );
  const segments = new Map<ResolvedResource, string[]>();
  for (const resource of local) {
    const displayPath = toPosixPath(resource.path);
    const home = toPosixPath(homedir());
    const parts = (
      displayPath.startsWith(`${home}/`)
        ? `~${displayPath.slice(home.length)}`
        : displayPath
    )
      .split("/")
      .filter((segment) => segment.length > 0 && segment !== "~");
    if (parts.at(-1) === "index.ts" || parts.at(-1) === "index.js") {
      parts.pop();
    }
    segments.set(resource, parts);
  }
  const names = new Map<ResolvedResource, string>();
  for (const resource of resources) {
    if (
      resource.metadata.origin === "package" &&
      (resource.metadata.source.startsWith("npm:") ||
        resource.metadata.source.startsWith("git:"))
    ) {
      names.set(resource, packageExtensionName(resource));
      continue;
    }
    const parts = segments.get(resource) ?? [];
    let name = extensionNameFromPath(resource.path);
    for (let count = 1; count <= parts.length; count++) {
      const candidate = localNameSuffix(parts, count);
      if (
        local.every((other) => {
          if (
            other === resource ||
            other.metadata.scope !== resource.metadata.scope
          ) {
            return true;
          }
          return (
            localNameSuffix(segments.get(other) ?? [], count) !== candidate
          );
        })
      ) {
        name = candidate;
        break;
      }
    }
    names.set(resource, name);
  }
  return names;
}

/**
 * Resolves enabled user/project extensions through Pi without loading code or installing packages.
 * The validated settings snapshot preserves welcome's tolerance for malformed settings.
 * Native Pi owns discovery, package filters, trust gating, precedence, and deduplication.
 * Resolution may query a local package manager for legacy global npm locations.
 * @param options Startup cwd, trust decision, and optional agent/welcome entrypoint paths.
 * @returns Display entries, project scope first, then by name; an undiscovered welcome
 * entrypoint is included as "omp-welcome" in user scope.
 * @throws Propagates native resolution errors; missing or mismatched packages are skipped.
 * @example await collectWelcomeExtensions({ cwd: "/work", projectTrusted: false });
 * // Returns user extension rows without reading untrusted project settings.
 */
export async function collectWelcomeExtensions(
  options: WelcomeSnapshotOptions,
): Promise<WelcomeExtension[]> {
  const agentDir = options.agentDir ?? getAgentDir();
  const cwd = resolve(options.cwd);
  const settings = scopedSettings(cwd, agentDir, options.projectTrusted);
  const serializedSettings: Record<"global" | "project", string> = {
    global: JSON.stringify(settings.user),
    project: JSON.stringify(settings.project),
  };
  const trustOptions: SettingsManagerCreateOptions = {
    projectTrusted: options.projectTrusted,
  };
  const settingsManager = SettingsManager.fromStorage(
    {
      /**
       * Keeps native settings transactions in the validated snapshot, never on disk.
       * @param scope Native global or trusted-project settings layer.
       * @param update A reader returns undefined; a writer replaces only the memory value.
       * @example withLock("global", (current) => current); // Leaves disk settings unchanged.
       */
      withLock(scope, update) {
        const next = update(serializedSettings[scope]);
        if (next !== undefined) {
          serializedSettings[scope] = next;
        }
      },
    },
    trustOptions,
  );
  const packageManagerOptions = { cwd, agentDir, settingsManager };
  const { extensions } = await new DefaultPackageManager(
    packageManagerOptions,
  ).resolve(async () => "skip");
  const resolved = extensions.filter((resource) => resource.enabled);
  const names = extensionNames(resolved);
  const items: WelcomeExtension[] = [];
  for (const resource of resolved) {
    const { scope, origin, source } = resource.metadata;
    if (scope === "temporary") {
      continue;
    }
    const item: WelcomeExtension = {
      name: names.get(resource) ?? extensionNameFromPath(resource.path),
      scope,
      path: resource.path,
    };
    if (origin === "package") {
      item.packageSource = source;
    }
    items.push(item);
  }

  if (options.welcomePath) {
    const welcomePath = canonicalPath(options.welcomePath);
    if (
      !extensions.some(
        (resource) => canonicalPath(resource.path) === welcomePath,
      )
    ) {
      items.push({
        name: "omp-welcome",
        scope: "user",
        path: options.welcomePath,
      });
    }
  }

  return items.sort((left, right) => {
    if (left.scope !== right.scope) {
      return left.scope === "project" ? -1 : 1;
    }
    const byName = left.name.localeCompare(right.name);
    return (
      byName ||
      (left.path ?? left.packageSource ?? "").localeCompare(
        right.path ?? right.packageSource ?? "",
      )
    );
  });
}

function sanitizeSessionText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const firstLine = value.split(LINE_BREAK)[0] ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Session text must strip ASCII control bytes.
  const cleaned = firstLine.replace(/[\x00-\x1F\x7F]/g, "").trim();
  return cleaned || undefined;
}

interface SessionInfoLike {
  name?: string;
  firstMessage: string;
  created: Date;
  modified: Date;
}

/**
 * Formats session age relative to a millisecond epoch clock.
 * @param date Modification time; future times are treated as "just now".
 * @param now Epoch milliseconds, defaulting to Date.now().
 * @returns Whole minutes/hours/days below seven days, otherwise a locale date.
 * @example formatSessionAge(new Date(0), 60000); // "1m ago"
 */
function formatSessionAge(date: Date, now = Date.now()): string {
  const difference = now - date.getTime();
  const minutes = Math.floor(difference / MILLISECONDS_PER_MINUTE);
  const hours = Math.floor(difference / MILLISECONDS_PER_HOUR);
  const days = Math.floor(difference / MILLISECONDS_PER_DAY);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  if (hours < 24) {
    return `${hours}h ago`;
  }
  if (days < RELATIVE_AGE_DAY_LIMIT) {
    return `${days}d ago`;
  }
  return date.toLocaleDateString();
}

/** OMP's explicit-name → first-prompt → untitled label precedence. */
function sessionLabel(session: SessionInfoLike): string {
  const explicit = sanitizeSessionText(session.name);
  if (explicit) {
    return explicit;
  }
  const first =
    session.firstMessage === "(no messages)"
      ? undefined
      : sanitizeSessionText(session.firstMessage);
  if (first) {
    return first;
  }
  const timestamp = Number.isFinite(session.created.getTime())
    ? session.created
    : session.modified;
  const time = timestamp.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Untitled · ${time}`;
}

/**
 * Selects the four most recently modified sessions without mutating the input.
 * Labels keep their first line and remove ASCII control bytes; terminal styling is not parsed here.
 * @param sessions Session metadata; labels prefer sanitized name, then first prompt.
 * @param now Epoch milliseconds for relative ages; defaults to the current clock.
 * @returns Display labels and ages; missing labels use a locale-time untitled label.
 * @example welcomeSessions([{ name: "Fix", firstMessage: "", created: new Date(0),
 * modified: new Date(0) }], 60000); // [{ name: "Fix", timeAgo: "1m ago" }]
 */
export function welcomeSessions(
  sessions: readonly SessionInfoLike[],
  now = Date.now(),
): WelcomeSession[] {
  return [...sessions]
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())
    .slice(0, MAX_WELCOME_SESSIONS)
    .map((session) => ({
      name: sessionLabel(session),
      timeAgo: formatSessionAge(session.modified, now),
    }));
}
