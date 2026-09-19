import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ResourceScope } from "./types.ts";

const GIT_URL_SCHEME = /^(?:https?|ssh|git):\/\//i;
const GIT_PROVIDER = /^(?:github|gitlab|bitbucket):/i;
const PROVIDER_PATH = /:(.+)/;
const SCP_GIT_URL = /^git@([^:]+):(.+)$/;
const LEADING_SLASHES = /^\/+/;
const GIT_SUFFIX = /\.git$/;

function npmPackageName(spec: string): string {
  if (spec.startsWith("@")) {
    const separator = spec.indexOf("@", spec.indexOf("/") + 1);
    return separator === -1 ? spec : spec.slice(0, separator);
  }
  const separator = spec.indexOf("@");
  return separator === -1 ? spec : spec.slice(0, separator);
}

function gitPackageIdentity(source: string): string | undefined {
  const trimmed = source.trim();
  const hasGitPrefix = trimmed.startsWith("git:");
  let candidate = hasGitPrefix ? trimmed.slice("git:".length).trim() : trimmed;
  if (!hasGitPrefix && !GIT_URL_SCHEME.test(candidate)) {
    return undefined;
  }
  if (GIT_PROVIDER.test(candidate)) {
    const [provider, path] = candidate.split(PROVIDER_PATH, 2);
    const host =
      provider?.toLowerCase() === "github"
        ? "github.com"
        : provider?.toLowerCase() === "gitlab"
          ? "gitlab.com"
          : "bitbucket.org";
    candidate = `${host}/${path ?? ""}`;
  }

  const scp = candidate.match(SCP_GIT_URL);
  let host: string;
  let path: string;
  if (scp !== null) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else if (candidate.includes("://")) {
    try {
      const parsed = new URL(candidate);
      host = parsed.hostname;
      path = parsed.pathname.replace(LEADING_SLASHES, "");
    } catch {
      return undefined;
    }
  } else {
    const slash = candidate.indexOf("/");
    if (slash < 0) {
      return undefined;
    }
    host = candidate.slice(0, slash);
    path = candidate.slice(slash + 1);
  }
  path = path.split("@", 1)[0]?.replace(GIT_SUFFIX, "") ?? "";
  return host === "" || path === ""
    ? undefined
    : `git:${host.toLowerCase()}/${path.toLowerCase()}`;
}

export function packageIdentity(
  source: string,
  scope: ResourceScope,
  cwd: string,
  agentDir: string,
): string {
  if (source.startsWith("npm:")) {
    return `npm:${npmPackageName(source.slice("npm:".length).trim())}`;
  }
  const gitIdentity = gitPackageIdentity(source);
  if (gitIdentity !== undefined) {
    return gitIdentity;
  }
  const baseDir = scope === "global" ? agentDir : join(cwd, ".pi");
  const localSource = source.startsWith("~/")
    ? join(homedir(), source.slice(2))
    : source;
  return `local:${resolve(baseDir, localSource)}`;
}
