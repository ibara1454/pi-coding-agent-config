import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
  quietStartup?: boolean;
  packages?: Array<string | PackageSource>;
  extensions?: string[];
}

interface RawSettings {
  quietStartup?: unknown;
  packages?: unknown;
  extensions?: unknown;
}

interface SnapshotResource {
  path: string;
  scope: ExtensionScope;
  enabled: boolean;
  rank: number;
  source: string;
  origin: "package" | "top-level";
  baseDir?: string;
  insertion: number;
}

interface PackageEntry {
  source: string;
  filter?: PackageSource;
  scope: ExtensionScope;
}

export interface WelcomeSnapshotOptions {
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
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizePiPath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  if (input.startsWith("file://")) {
    try {
      return fileURLToPath(input);
    } catch {
      return input;
    }
  }
  return input;
}

function resolvePiPath(input: string, baseDir: string, trim = false): string {
  const normalized = normalizePiPath(trim ? input.trim() : input);
  return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(normalizePiPath(baseDir), normalized);
}

/** Pi's public agent-directory resolution, including PI_CODING_AGENT_DIR expansion. */
export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR;
  return configured ? normalizePiPath(configured) : path.join(os.homedir(), ".pi", "agent");
}

function cleanSettings(settings: Record<string, unknown>): PiSettings {
  const packages = Array.isArray(settings.packages)
    ? settings.packages.reduce<Array<string | PackageSource>>((result, entry) => {
      if (typeof entry === "string") {
        result.push(entry);
        return result;
      }
      if (entry === null || typeof entry !== "object" || Array.isArray(entry) || !("source" in entry) || typeof entry.source !== "string") return result;
      result.push({
        source: entry.source,
        autoload: "autoload" in entry && typeof entry.autoload === "boolean" ? entry.autoload : undefined,
        extensions: "extensions" in entry && Array.isArray(entry.extensions)
          ? entry.extensions.filter((value): value is string => typeof value === "string")
          : undefined,
      });
      return result;
    }, [])
    : undefined;
  return {
    quietStartup: typeof settings.quietStartup === "boolean" ? settings.quietStartup : undefined,
    packages,
    extensions: Array.isArray(settings.extensions) ? settings.extensions.filter((entry): entry is string => typeof entry === "string") : undefined,
  };
}

function scopedSettings(cwd: string, agentDir: string, projectTrusted: boolean): { user: PiSettings; project: PiSettings } {
  return {
    user: cleanSettings(readJson(path.join(agentDir, "settings.json"))),
    project: projectTrusted ? cleanSettings(readJson(path.join(cwd, ".pi", "settings.json"))) : {},
  };
}

/** Mirrors Pi's effective quiet setting, including the public --verbose override. */
export function effectiveQuietStartup(cwd: string, agentDir = getAgentDir(), projectTrusted = false, argv = process.argv): boolean {
  if (argv.includes("--verbose")) return false;
  const settings = scopedSettings(cwd, agentDir, projectTrusted);
  return settings.project.quietStartup ?? settings.user.quietStartup ?? false;
}

function isExtensionFile(filePath: string): boolean {
  return filePath.endsWith(".ts") || filePath.endsWith(".js");
}

function toPosixPath(filePath: string): string {
  return filePath.replaceAll(path.sep, "/");
}

function canonicalPath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function extensionNameFromPath(extensionPath: string): string {
  const base = path.basename(extensionPath);
  if (base === "index.ts" || base === "index.js") return path.basename(path.dirname(extensionPath));
  return base;
}

function globPattern(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index] ?? "";
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      while (pattern[index + 1] === "*") index++;
      if (pattern[index + 1] === "/") {
        source += "(?:.*/)?";
        index++;
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function matchesPattern(filePath: string, patterns: readonly string[], baseDir: string): boolean {
  const relative = toPosixPath(path.relative(baseDir, filePath));
  const basename = path.basename(filePath);
  const absolute = toPosixPath(path.resolve(filePath));
  return patterns.some(pattern => {
    const normalized = toPosixPath(pattern).replace(/^\.\//, "");
    const matcher = globPattern(normalized);
    return matcher.test(relative) || matcher.test(basename) || matcher.test(absolute);
  });
}

function matchesExactPath(filePath: string, patterns: readonly string[], baseDir: string): boolean {
  const relative = toPosixPath(path.relative(baseDir, filePath));
  const absolute = toPosixPath(path.resolve(filePath));
  return patterns.some(pattern => {
    const normalized = toPosixPath(pattern).replace(/^\.\//, "");
    return normalized === relative || normalized === absolute;
  });
}

function discoveryIgnored(directory: string): (relativePath: string) => boolean {
  const rules: Array<{ pattern: string; negated: boolean }> = [];
  for (const filename of [".gitignore", ".ignore", ".fdignore"]) {
    try {
      for (const line of fs.readFileSync(path.join(directory, filename), "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) continue;
        const negated = trimmed.startsWith("!") && !trimmed.startsWith("\\!");
        const pattern = (negated ? trimmed.slice(1) : trimmed.replace(/^\\([#!])/, "$1")).replace(/^\//, "");
        if (pattern) rules.push({ pattern, negated });
      }
    } catch {
      // Pi ignores unreadable ignore files during discovery.
    }
  }
  return relativePath => {
    let ignored = false;
    for (const rule of rules) {
      if (globPattern(rule.pattern).test(relativePath) || globPattern(rule.pattern).test(relativePath.replace(/\/$/, ""))) ignored = !rule.negated;
    }
    return ignored;
  };
}

function manifestExtensionEntries(directory: string): string[] | undefined {
  const manifest = readJson(path.join(directory, "package.json"));
  const pi = manifest.pi;
  if (pi === null || typeof pi !== "object" || Array.isArray(pi) || !("extensions" in pi) || !Array.isArray(pi.extensions)) return undefined;
  const entries = pi.extensions
    .filter((entry): entry is string => typeof entry === "string")
    .map(entry => resolvePiPath(entry, directory))
    .filter(entry => fs.existsSync(entry));
  return entries.length > 0 ? entries : undefined;
}

function resolveExtensionEntries(directory: string): string[] | undefined {
  const manifestEntries = manifestExtensionEntries(directory);
  if (manifestEntries) return manifestEntries;
  for (const name of ["index.ts", "index.js"]) {
    const entry = path.join(directory, name);
    if (fs.existsSync(entry)) return [entry];
  }
  return undefined;
}

/** Pi's one-level auto-discovery, including root entry handling and symlink targets. */
export function discoverExtensionFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const rootEntries = resolveExtensionEntries(directory);
  if (rootEntries) return rootEntries;

  const ignored = discoveryIgnored(directory);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const discovered: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const entryPath = path.join(directory, entry.name);
    let isFile = entry.isFile();
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        const stats = fs.statSync(entryPath);
        isFile = stats.isFile();
        isDirectory = stats.isDirectory();
      } catch {
        continue;
      }
    }
    const relative = toPosixPath(path.relative(directory, entryPath));
    if (ignored(isDirectory ? `${relative}/` : relative)) continue;
    if (isFile && isExtensionFile(entry.name)) {
      discovered.push(entryPath);
    } else if (isDirectory) {
      const nestedEntries = resolveExtensionEntries(entryPath);
      if (nestedEntries) discovered.push(...nestedEntries);
    }
  }
  return discovered;
}

function isPattern(value: string): boolean {
  return value.startsWith("!") || value.startsWith("+") || value.startsWith("-") || value.includes("*") || value.includes("?");
}

function applyPatterns(files: readonly string[], patterns: readonly string[], baseDir: string): Set<string> {
  const includes: string[] = [];
  const excludes: string[] = [];
  const forceIncludes: string[] = [];
  const forceExcludes: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("+")) forceIncludes.push(pattern.slice(1));
    else if (pattern.startsWith("-")) forceExcludes.push(pattern.slice(1));
    else if (pattern.startsWith("!")) excludes.push(pattern.slice(1));
    else includes.push(pattern);
  }
  let enabled = includes.length === 0 ? [...files] : files.filter(file => matchesPattern(file, includes, baseDir));
  if (excludes.length > 0) enabled = enabled.filter(file => !matchesPattern(file, excludes, baseDir));
  for (const file of files) {
    if (!enabled.includes(file) && matchesExactPath(file, forceIncludes, baseDir)) enabled.push(file);
  }
  return new Set(enabled.filter(file => !matchesExactPath(file, forceExcludes, baseDir)));
}

function applyAutoloadDisabledPatterns(files: readonly string[], patterns: readonly string[], baseDir: string): Map<string, boolean> {
  const enabled = new Map<string, boolean>();
  for (const pattern of patterns) {
    const target = pattern.slice(pattern.startsWith("+") || pattern.startsWith("-") || pattern.startsWith("!") ? 1 : 0);
    const exact = pattern.startsWith("+") || pattern.startsWith("-");
    for (const file of files) {
      if (exact ? matchesExactPath(file, [target], baseDir) : matchesPattern(file, [target], baseDir)) {
        enabled.set(file, !pattern.startsWith("-") && !pattern.startsWith("!"));
      }
    }
  }
  return enabled;
}

function autoExtensionEnabled(filePath: string, overrides: readonly string[] | undefined, baseDir: string): boolean {
  const patterns = (overrides ?? []).filter(pattern => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));
  const excludes = patterns.filter(pattern => pattern.startsWith("!")).map(pattern => pattern.slice(1));
  const forceIncludes = patterns.filter(pattern => pattern.startsWith("+")).map(pattern => pattern.slice(1));
  const forceExcludes = patterns.filter(pattern => pattern.startsWith("-")).map(pattern => pattern.slice(1));
  if (matchesPattern(filePath, excludes, baseDir)) return matchesExactPath(filePath, forceIncludes, baseDir) && !matchesExactPath(filePath, forceExcludes, baseDir);
  return !matchesExactPath(filePath, forceExcludes, baseDir);
}

function configuredExtensions(entries: readonly string[] | undefined, baseDir: string): Array<{ path: string; enabled: boolean }> {
  if (!entries) return [];
  const plain = entries.filter(entry => !isPattern(entry));
  const patterns = entries.filter(isPattern);
  const files = plain.flatMap(entry => {
    const resolved = resolvePiPath(entry, baseDir, true);
    try {
      const stats = fs.statSync(resolved);
      if (stats.isFile()) return [resolved];
      return stats.isDirectory() ? discoverExtensionFiles(resolved) : [];
    } catch {
      return [];
    }
  });
  const enabled = applyPatterns(files, patterns, baseDir);
  return files.map(file => ({ path: file, enabled: enabled.has(file) }));
}

function packageSourceString(value: string | PackageSource): string {
  return typeof value === "string" ? value : value.source;
}

function isGitPackageSource(source: string): boolean {
  const trimmed = source.trim();
  return trimmed.startsWith("git:") || /^(https?|ssh|git):\/\//.test(trimmed);
}

function gitPackagePath(source: string): string | undefined {
  let raw = source.trim();
  if (raw.startsWith("git:")) raw = raw.slice("git:".length).trim();

  const hosted = /^(github|gitlab|bitbucket):(.+)$/.exec(raw);
  if (hosted) {
    const domain = hosted[1] === "github" ? "github.com" : hosted[1] === "gitlab" ? "gitlab.com" : "bitbucket.org";
    raw = `${domain}/${hosted[2]}`;
  }

  const cleanPath = (value: string) => {
    const ref = value.indexOf("@");
    return (ref < 0 ? value : value.slice(0, ref)).replace(/^\/+/, "").replace(/\.git$/, "");
  };
  const scp = /^git@([^:]+):(.+)$/.exec(raw);
  if (scp) {
    const packagePath = cleanPath(scp[2] ?? "");
    return packagePath ? `${scp[1]}/${packagePath}` : undefined;
  }
  try {
    const url = new URL(raw);
    const packagePath = cleanPath(url.pathname);
    return packagePath ? `${url.hostname}/${packagePath}` : undefined;
  } catch {
    const slash = raw.indexOf("/");
    if (slash < 0) return undefined;
    const host = raw.slice(0, slash);
    const packagePath = cleanPath(raw.slice(slash + 1));
    if (!packagePath) return undefined;
    return host.includes(".") || host === "localhost"
      ? `${host}/${packagePath}`
      : `github.com/${cleanPath(raw)}`;
  }
}

function packageIdentity(source: string, scope: ExtensionScope, agentDir: string, projectDir: string): string {
  if (source.startsWith("npm:")) {
    const spec = source.slice("npm:".length).trim();
    const name = /^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/.exec(spec)?.[1] ?? spec;
    return `npm:${name}`;
  }
  if (isGitPackageSource(source)) return `git:${gitPackagePath(source) ?? source.trim()}`;
  const baseDir = scope === "project" ? projectDir : agentDir;
  return `local:${resolvePiPath(source, baseDir, true)}`;
}

function dedupePackages(user: readonly (string | PackageSource)[] | undefined, project: readonly (string | PackageSource)[] | undefined, agentDir: string, projectDir: string): PackageEntry[] {
  const entries: PackageEntry[] = [
    ...(project ?? []).map(value => ({ source: packageSourceString(value), filter: typeof value === "string" ? undefined : value, scope: "project" as const })),
    ...(user ?? []).map(value => ({ source: packageSourceString(value), filter: typeof value === "string" ? undefined : value, scope: "user" as const })),
  ];
  const result: PackageEntry[] = [];
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const identity = packageIdentity(entry.source, entry.scope, agentDir, projectDir);
    const index = seen.get(identity);
    if (index === undefined) {
      seen.set(identity, result.length);
      result.push(entry);
      continue;
    }
    const existing = result[index];
    if (existing?.scope === "project" && entry.scope === "user") {
      if (existing.filter?.autoload === false) result.push(entry);
    } else if (entry.scope === "project") {
      result[index] = entry;
    }
  }
  return result;
}

function packageRoot(source: string, scope: ExtensionScope, agentDir: string, projectDir: string): string | undefined {
  const baseDir = scope === "project" ? projectDir : agentDir;
  if (source.startsWith("npm:")) {
    const spec = source.slice("npm:".length).trim();
    const name = /^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/.exec(spec)?.[1];
    return name ? path.join(baseDir, "npm", "node_modules", name) : undefined;
  }
  if (isGitPackageSource(source)) {
    const identity = packageIdentity(source, scope, agentDir, projectDir).slice("git:".length);
    const slash = identity.indexOf("/");
    return slash >= 0 ? path.join(baseDir, "git", identity.slice(0, slash), identity.slice(slash + 1)) : undefined;
  }
  return resolvePiPath(source, baseDir, true);
}

function packageEntryPaths(entry: string, root: string): string[] {
  const pattern = toPosixPath(entry).replace(/^\.\//, "");
  if (!pattern.includes("*") && !pattern.includes("?")) return [resolvePiPath(pattern, root)];

  const wildcard = pattern.search(/[*?]/);
  const prefix = pattern.slice(0, wildcard);
  const start = path.resolve(root, prefix.slice(0, prefix.lastIndexOf("/") + 1));
  const matcher = globPattern(pattern);
  const absolute = path.isAbsolute(pattern);
  const matches: string[] = [];
  const visitedDirectories = new Set<string>();
  const visit = (directory: string) => {
    const canonical = canonicalPath(directory);
    if (visitedDirectories.has(canonical)) return;
    visitedDirectories.add(canonical);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of entries) {
      if (child.name.startsWith(".")) continue;
      const childPath = path.join(directory, child.name);
      const candidate = absolute ? toPosixPath(childPath) : toPosixPath(path.relative(root, childPath));
      if (matcher.test(candidate)) matches.push(childPath);
      let isDirectory = child.isDirectory();
      if (child.isSymbolicLink()) {
        try {
          isDirectory = fs.statSync(childPath).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDirectory) visit(childPath);
    }
  };
  visit(start);
  return matches;
}

function packageExtensionFiles(entries: readonly string[], root: string): string[] {
  const files: string[] = [];
  for (const entry of entries) {
    for (const candidate of packageEntryPaths(entry, root)) {
      try {
        const stats = fs.statSync(candidate);
        if (stats.isFile()) files.push(candidate);
        else if (stats.isDirectory()) files.push(...discoverExtensionFiles(candidate));
      } catch {
        // Pi ignores unavailable package manifest entries.
      }
    }
  }
  return files;
}

type PackageCollectionMode = "package" | "default" | "filter";

function packageFiles(root: string, mode: PackageCollectionMode): { files: string[]; hasPackageResources: boolean } {
  const manifest = readJson(path.join(root, "package.json"));
  const pi = manifest.pi;
  const hasPiManifest = pi !== null && typeof pi === "object" && !Array.isArray(pi);
  const extensions = hasPiManifest && "extensions" in pi && Array.isArray(pi.extensions)
    ? pi.extensions.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const convention = () => {
    const extensionsDir = path.join(root, "extensions");
    return fs.existsSync(extensionsDir)
      ? { files: discoverExtensionFiles(extensionsDir), hasPackageResources: true }
      : { files: [], hasPackageResources: false };
  };
  const fromManifest = (entries: readonly string[]) => {
    const files = packageExtensionFiles(entries.filter(entry => !entry.startsWith("!") && !entry.startsWith("+") && !entry.startsWith("-")), root);
    const overrides = entries.filter(entry => entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-"));
    return { files: overrides.length === 0 ? files : files.filter(file => applyPatterns(files, overrides, root).has(file)), hasPackageResources: true };
  };

  // Object filters use Pi's collectManifestFiles path: an absent or empty
  // extension manifest falls back to the convention directory. Default package
  // loading treats any pi manifest as authoritative, even when it lists no
  // extensions.
  if (mode === "filter") return extensions && extensions.length > 0 ? fromManifest(extensions) : convention();
  if (extensions !== undefined) return fromManifest(extensions);
  return mode === "default" || !hasPiManifest ? convention() : { files: [], hasPackageResources: true };
}

function compactPackageSourceLabel(source: string): string {
  if (source.startsWith("npm:")) return source;
  if (!source.startsWith("git:")) return source;
  const raw = source.slice("git:".length).trim();
  const scpPath = /^git@[^:]+:(.+)$/.exec(raw)?.[1];
  if (scpPath) return `git:${scpPath.replace(/@[^/]+$/, "").replace(/\.git$/, "") || raw}`;
  try {
    const compact = new URL(raw).pathname.replace(/^\/+/, "").replace(/@[^/]+$/, "").replace(/\.git$/, "");
    return `git:${compact || raw}`;
  } catch {
    const slash = raw.indexOf("/");
    const compact = (slash < 0 ? raw : raw.slice(slash + 1)).replace(/@[^/]+$/, "").replace(/\.git$/, "");
    return `git:${compact || raw}`;
  }
}

function packageExtensionName(resource: SnapshotResource): string {
  const sourceLabel = compactPackageSourceLabel(resource.source);
  const shortPath = resource.baseDir ? toPosixPath(path.relative(resource.baseDir, resource.path)) : toPosixPath(resource.path);
  const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
  const parsed = path.posix.parse(packagePath);
  if (parsed.name === "index") return !parsed.dir || parsed.dir === "." ? sourceLabel : `${sourceLabel}:${parsed.dir}`;
  const extensionName = parsed.dir && parsed.dir !== "." ? `${parsed.dir}/${parsed.name}` : parsed.name;
  return `${sourceLabel}:${extensionName}`;
}

function localNameSuffix(parts: readonly string[], count: number): string {
  const suffix = parts.slice(-count);
  const last = suffix.at(-1);
  if (last) suffix[suffix.length - 1] = last.replace(/\.(?:ts|js)$/, "");
  return suffix.join("/");
}

function extensionNames(resources: readonly SnapshotResource[]): Map<SnapshotResource, string> {
  const local = resources.filter(resource => !(resource.origin === "package" && (resource.source.startsWith("npm:") || resource.source.startsWith("git:"))));
  const segments = new Map<SnapshotResource, string[]>();
  for (const resource of local) {
    const displayPath = toPosixPath(resource.path);
    const home = toPosixPath(os.homedir());
    const parts = (displayPath.startsWith(`${home}/`) ? `~${displayPath.slice(home.length)}` : displayPath).split("/").filter(segment => segment.length > 0 && segment !== "~");
    if (parts.at(-1) === "index.ts" || parts.at(-1) === "index.js") parts.pop();
    segments.set(resource, parts);
  }
  const names = new Map<SnapshotResource, string>();
  for (const resource of resources) {
    if (resource.origin === "package" && (resource.source.startsWith("npm:") || resource.source.startsWith("git:"))) {
      names.set(resource, packageExtensionName(resource));
      continue;
    }
    const parts = segments.get(resource) ?? [];
    let name = extensionNameFromPath(resource.path);
    for (let count = 1; count <= parts.length; count++) {
      const candidate = localNameSuffix(parts, count);
      if (local.every(other => {
        if (other === resource || other.scope !== resource.scope) return true;
        return localNameSuffix(segments.get(other) ?? [], count) !== candidate;
      })) {
        name = candidate;
        break;
      }
    }
    names.set(resource, name);
  }
  return names;
}

/**
 * Captures Pi's enabled startup extension set without loading or installing
 * anything again. It mirrors Pi 0.84.1's trust gate, scope precedence,
 * package-object filters, auto-discovery, symlink handling, and local overrides.
 */
export function collectWelcomeExtensions(options: WelcomeSnapshotOptions): WelcomeExtension[] {
  const agentDir = options.agentDir ?? getAgentDir();
  const cwd = path.resolve(options.cwd);
  const projectDir = path.join(cwd, ".pi");
  const settings = scopedSettings(cwd, agentDir, options.projectTrusted);
  const byPath = new Map<string, SnapshotResource>();
  let insertion = 0;

  const add = (resource: Omit<SnapshotResource, "insertion">) => {
    if (!byPath.has(resource.path)) byPath.set(resource.path, { ...resource, insertion: insertion++ });
  };

  const packages = dedupePackages(settings.user.packages, settings.project.packages, agentDir, projectDir);
  for (const entry of packages) {
    const deltaBase = entry.scope === "project" && entry.filter?.autoload === false
      ? packages.find(candidate => candidate.scope === "user" && packageIdentity(candidate.source, "user", agentDir, projectDir) === packageIdentity(entry.source, "project", agentDir, projectDir))
      : undefined;
    const root = packageRoot(deltaBase?.source ?? entry.source, deltaBase?.scope ?? entry.scope, agentDir, projectDir);
    if (!root || !fs.existsSync(root)) continue;
    let stats: fs.Stats;
    try {
      stats = fs.statSync(root);
    } catch {
      continue;
    }
    if (stats.isFile()) {
      add({ path: root, scope: entry.scope, enabled: true, rank: 4, source: entry.source, origin: "package", baseDir: path.dirname(root) });
      continue;
    }
    if (!stats.isDirectory()) continue;

    const collectionMode: PackageCollectionMode = entry.filter === undefined
      ? "package"
      : entry.filter.autoload === false || entry.filter.extensions !== undefined
        ? "filter"
        : "default";
    const collected = packageFiles(root, collectionMode);
    if (collected.files.length === 0 && !collected.hasPackageResources && !entry.source.startsWith("npm:") && !entry.source.startsWith("git:")) {
      add({ path: root, scope: entry.scope, enabled: true, rank: 4, source: entry.source, origin: "package", baseDir: root });
      continue;
    }
    if (entry.filter?.autoload === false) {
      for (const [file, enabled] of applyAutoloadDisabledPatterns(collected.files, entry.filter.extensions ?? [], root)) {
        add({ path: file, scope: entry.scope, enabled, rank: 4, source: entry.source, origin: "package", baseDir: root });
      }
      continue;
    }
    const enabled = entry.filter?.extensions === undefined
      ? new Set(collected.files)
      : entry.filter.extensions.length === 0
        ? new Set<string>()
        : applyPatterns(collected.files, entry.filter.extensions, root);
    for (const file of collected.files) {
      add({ path: file, scope: entry.scope, enabled: enabled.has(file), rank: 4, source: entry.source, origin: "package", baseDir: root });
    }
  }

  const addConfigured = (scope: ExtensionScope, entries: readonly string[] | undefined, baseDir: string, rank: number) => {
    for (const resource of configuredExtensions(entries, baseDir)) {
      add({ path: resource.path, scope, enabled: resource.enabled, rank, source: "local", origin: "top-level", baseDir });
    }
  };
  const addAutoDiscovered = (scope: ExtensionScope, entries: readonly string[] | undefined, baseDir: string, rank: number) => {
    for (const file of discoverExtensionFiles(path.join(baseDir, "extensions"))) {
      add({ path: file, scope, enabled: autoExtensionEnabled(file, entries, baseDir), rank, source: "auto", origin: "top-level", baseDir });
    }
  };

  if (options.projectTrusted) {
    addConfigured("project", settings.project.extensions, projectDir, 0);
    addAutoDiscovered("project", settings.project.extensions, projectDir, 1);
  }
  addConfigured("user", settings.user.extensions, agentDir, 2);
  addAutoDiscovered("user", settings.user.extensions, agentDir, 3);

  const seen = new Set<string>();
  const resolved = [...byPath.values()]
    .sort((left, right) => left.rank - right.rank || left.insertion - right.insertion)
    .filter(resource => {
      const canonical = canonicalPath(resource.path);
      if (seen.has(canonical)) return false;
      seen.add(canonical);
      return true;
    })
    .filter(resource => resource.enabled);
  const names = extensionNames(resolved);
  const items: WelcomeExtension[] = resolved.map(resource => ({
    name: names.get(resource) ?? extensionNameFromPath(resource.path),
    scope: resource.scope,
    path: resource.path,
    packageSource: resource.origin === "package" ? resource.source : undefined,
  }));

  if (options.welcomePath && !seen.has(canonicalPath(options.welcomePath))) {
    items.push({ name: extensionNameFromPath(options.welcomePath), scope: "user", path: options.welcomePath });
  }

  return items.sort((left, right) => {
    if (left.scope !== right.scope) return left.scope === "project" ? -1 : 1;
    const byName = left.name.localeCompare(right.name);
    return byName || (left.path ?? left.packageSource ?? "").localeCompare(right.path ?? right.packageSource ?? "");
  });
}

function sanitizeSessionText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const firstLine = value.split(/\r?\n/)[0] ?? "";
  const cleaned = firstLine.replace(/[\x00-\x1F\x7F]/g, "").trim();
  return cleaned || undefined;
}

export interface SessionInfoLike {
  name?: string;
  firstMessage: string;
  created: Date;
  modified: Date;
}

/** OMP's compact relative age wording. */
export function formatSessionAge(date: Date, now = Date.now()): string {
  const difference = now - date.getTime();
  const minutes = Math.floor(difference / 60_000);
  const hours = Math.floor(difference / 3_600_000);
  const days = Math.floor(difference / 86_400_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

/** OMP's explicit-name → first-prompt → untitled label precedence. */
export function sessionLabel(session: SessionInfoLike): string {
  const explicit = sanitizeSessionText(session.name);
  if (explicit) return explicit;
  const first = session.firstMessage === "(no messages)" ? undefined : sanitizeSessionText(session.firstMessage);
  if (first) return first;
  const timestamp = Number.isFinite(session.created.getTime()) ? session.created : session.modified;
  const time = timestamp.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `Untitled · ${time}`;
}

export function welcomeSessions(sessions: readonly SessionInfoLike[], now = Date.now()): WelcomeSession[] {
  return [...sessions]
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())
    .slice(0, 4)
    .map(session => ({ name: sessionLabel(session), timeAgo: formatSessionAge(session.modified, now) }));
}
