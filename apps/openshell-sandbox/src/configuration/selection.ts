import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderProfile, SandboxPolicy } from "@nvidia/openshell-sdk/raw";
import { decodeNativePolicy, decodeNativeProfiles } from "./native/index.ts";
import {
  normalizeProviders,
  type ProviderDeclaration,
  parseProviders,
} from "./providers.ts";
import {
  array,
  freeze,
  invalid,
  object,
  SandboxConfigurationError,
  text,
} from "./validation/index.ts";

export interface ProviderConfiguration {
  readonly name: string;
  readonly profile: string;
  readonly credentialMode: "explicit";
  readonly credentialsFromEnv: Readonly<Record<string, string>>;
}

export interface SandboxEnvironment {
  readonly projectRoot: string;
  readonly policy: Readonly<{ sourcePath: string; sdkPolicy: SandboxPolicy }>;
  readonly profiles: readonly Readonly<{
    sourcePath: string;
    sdkProfiles: ProviderProfile[];
  }>[];
  readonly image?: string;
  readonly providers: readonly ProviderConfiguration[];
}

export interface SettingsContext {
  readonly agentDir: string;
  readonly cwd: string;
  readonly projectTrusted: boolean;
}

export interface SettingsFilesystem {
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
}

interface PartialSettings {
  readonly policyPath?: string;
  readonly profilePaths?: readonly string[];
  readonly providers?: readonly ProviderDeclaration[];
  readonly image?: string;
}

interface SandboxSelection {
  readonly policyPath: string;
  readonly profilePaths: readonly string[];
  readonly providers: readonly ProviderConfiguration[];
  readonly image?: string;
}

/** Read only an authorized settings path; only ENOENT means an absent settings layer.
 * @throws Safe path diagnostics for malformed, unreadable, or non-object documents.
 * @example readSettings("/agent/settings.json", fs) returns undefined if that file is missing.
 */
async function readSettings(
  path: string,
  filesystem: SettingsFilesystem,
): Promise<unknown> {
  let contents: string | undefined;
  let readFailed = false;
  try {
    contents = await filesystem.readFile(path, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    readFailed = true;
  }
  if (readFailed) {
    throw new SandboxConfigurationError(
      `Cannot read OpenShell settings: ${path}`,
      "configuration-read-failed",
    );
  }
  let document: unknown;
  let invalidDocument = false;
  try {
    document = object(JSON.parse(contents ?? ""), "settings document");
  } catch {
    invalidDocument = true;
  }
  if (invalidDocument) {
    throw new SandboxConfigurationError(
      `Invalid OpenShell settings document: ${path}`,
    );
  }
  return document;
}

/** Resolve each supplied path using its declaring directory before applying overrides.
 * @example parseField({openShellSandbox:{profilePaths:["p.yaml"]}}, "/agent") retains /agent/p.yaml.
 */
function parseField(document: unknown, directory: string): PartialSettings {
  if (document === undefined) {
    return {};
  }
  const settings = object(document, "settings");
  if (!("openShellSandbox" in settings)) {
    return {};
  }
  const field = object(settings["openShellSandbox"], "openShellSandbox", [
    "policyPath",
    "profilePaths",
    "providers",
    "image",
  ]);
  return {
    ...("policyPath" in field
      ? {
          policyPath: resolve(
            directory,
            text(field["policyPath"], "policyPath"),
          ),
        }
      : {}),
    ...("profilePaths" in field
      ? {
          profilePaths: array(field["profilePaths"], "profilePaths").map(
            (path) => resolve(directory, text(path, "profilePaths")),
          ),
        }
      : {}),
    ...("providers" in field
      ? { providers: parseProviders(field["providers"]) }
      : {}),
    ...("image" in field ? { image: text(field["image"], "image") } : {}),
  };
}

/** Resolve trusted settings before reading selected native documents.
 * Trust gates project reads; mode validation occurs after whole-array replacement.
 * @throws Invalid present settings or effective unsupported credential modes.
 * @example A trusted project's providers: [] disables all inherited providers.
 */
async function loadSandboxSelection(
  context: SettingsContext,
  filesystem: SettingsFilesystem,
): Promise<SandboxSelection> {
  if (!(isAbsolute(context.agentDir) && isAbsolute(context.cwd))) {
    invalid("context paths (must be canonical absolute paths)");
  }
  const global = parseField(
    await readSettings(join(context.agentDir, "settings.json"), filesystem),
    context.agentDir,
  );
  const projectDirectory = join(context.cwd, ".pi");
  const project = context.projectTrusted
    ? parseField(
        await readSettings(join(projectDirectory, "settings.json"), filesystem),
        projectDirectory,
      )
    : {};
  const selected = {
    policyPath: fileURLToPath(
      new URL("../../assets/policy.yaml", import.meta.url),
    ),
    profilePaths: [],
    providers: [],
    ...global,
    ...project,
  };
  return freeze({
    ...selected,
    providers: normalizeProviders(selected.providers),
  });
}

/** Read a required selected document exactly once without leaking parser/source contents.
 * @example readNative("/agent/policy.yaml", fs) fails closed if that selected path is absent.
 */
async function readNative(
  path: string,
  filesystem: SettingsFilesystem,
): Promise<string> {
  let contents: string | undefined;
  try {
    contents = await filesystem.readFile(path, "utf8");
  } catch {
    // Source and filesystem error payloads must not survive this boundary.
  }
  if (contents === undefined) {
    throw new SandboxConfigurationError(
      `Cannot read selected OpenShell native document: ${path}`,
      "configuration-read-failed",
    );
  }
  return contents;
}

/** Snapshot trusted settings and selected native documents; never inspect credentials or acquire resources.
 * The returned graph is recursively frozen; subsequent file edits require another activation.
 * @throws Safe configuration errors before native preparation; raw YAML is not retained.
 * @example loadSandboxEnvironment({agentDir:"/agent",cwd:"/work",projectTrusted:false}, fs) never reads /work/.pi.
 */
export async function loadSandboxEnvironment(
  context: SettingsContext,
  filesystem: SettingsFilesystem,
): Promise<SandboxEnvironment> {
  const selected = await loadSandboxSelection(context, filesystem);
  const [sdkPolicy, profiles] = await Promise.all([
    readNative(selected.policyPath, filesystem).then((source) =>
      decodeNativePolicy(source, selected.policyPath),
    ),
    Promise.all(
      selected.profilePaths.map(async (sourcePath) => ({
        sourcePath,
        sdkProfiles: await decodeNativeProfiles(
          await readNative(sourcePath, filesystem),
          sourcePath,
        ),
      })),
    ),
  ]);
  const ids = profiles.flatMap((profile) =>
    profile.sdkProfiles.map((entry) => entry.id),
  );
  if (new Set(ids).size !== ids.length) {
    invalid("profilePaths (duplicate profile ids)");
  }
  return freeze({
    projectRoot: context.cwd,
    policy: { sourcePath: selected.policyPath, sdkPolicy },
    profiles,
    providers: selected.providers,
    ...(selected.image === undefined ? {} : { image: selected.image }),
  });
}
