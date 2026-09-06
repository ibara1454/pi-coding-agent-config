export type ResourceKind = "extension" | "skill";
export type ResourceField = "extensions" | "skills";
export type ResourceScope = "global" | "project";

export interface JsonObject {
  [key: string]: unknown;
  autoload?: unknown;
  extensions?: unknown;
  packages?: unknown;
  skills?: unknown;
  source?: unknown;
}

export interface SettingsDocument {
  readonly path: string;
  readonly scope: ResourceScope;
  readonly content: string | undefined;
  readonly value: JsonObject;
  readonly error?: string;
}

export interface ResourceOrigin {
  readonly label: string;
  readonly source: "auto" | "settings" | "package";
}

export interface CatalogDiagnostic {
  readonly scope?: ResourceScope;
  readonly message: string;
  readonly path?: string;
  readonly source?: string;
}

export interface CatalogRow {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly scope: ResourceScope;
  readonly name: string;
  readonly description?: string;
  readonly path: string;
  readonly canonicalPath: string;
  readonly source: string;
  readonly origins: readonly ResourceOrigin[];
  readonly filters: readonly string[];
  readonly configurationReason: string;
  readonly configured: boolean;
  readonly resolvedAfterReload: boolean;
  readonly resolutionParticipant: boolean;
  readonly resolutionCandidate: boolean;
  readonly resolutionOrder: number;
  readonly shadowedBy?: string;
  readonly diagnosticCount?: number;
  readonly preview?: string;
}

interface ToggleTargetBase {
  readonly id: string;
  readonly scope: ResourceScope;
  readonly kind: ResourceKind;
  readonly field: ResourceField;
  readonly canonicalPath: string;
  readonly resolvedPath: string;
  readonly filterPath: string;
  readonly allPaths: readonly string[];
}

export interface TopLevelToggleTarget extends ToggleTargetBase {
  readonly type: "top-level";
  readonly baseDir: string;
  readonly occurrencePaths: readonly string[];
}

export interface PackageLocator {
  readonly source: string;
  readonly occurrence: number;
}

export interface PackageToggleTarget extends ToggleTargetBase {
  readonly type: "package";
  readonly packageRoot: string;
  readonly canonicalPackageRoot: string;
  readonly packageSourcePath: string;
  readonly package: PackageLocator;
  readonly autoloadDelta: boolean;
  readonly participates: boolean;
  readonly participatesWhenEnabled: boolean;
  readonly hadFilterField: boolean;
  readonly participatesWhenDisabled: boolean;
  readonly packageIdentity: string;
}

export type ToggleTarget = TopLevelToggleTarget | PackageToggleTarget;

export interface CatalogSeed {
  readonly rows: readonly CatalogRow[];
  readonly targets: ReadonlyMap<string, ToggleTarget>;
  readonly settings: ReadonlyMap<ResourceScope, SettingsDocument>;
  readonly diagnostics: readonly CatalogDiagnostic[];
  readonly projectTrusted: boolean;
  readonly tuiMode: "regular" | "fullscreen";
  readonly reloadPending: boolean;
}

export interface CatalogView {
  readonly rows: readonly CatalogRow[];
  readonly diagnostics: readonly CatalogDiagnostic[];
  readonly projectTrusted: boolean;
  readonly reloadPending: boolean;
  readonly tuiMode: "regular" | "fullscreen";
  readonly stagedCount: number;
}

export interface RowInspection {
  readonly row: CatalogRow;
  readonly fields: readonly {
    readonly label: string;
    readonly value: string;
  }[];
  readonly diagnostics: readonly string[];
  readonly preview?: string;
}

export interface StagedToggle {
  readonly id: string;
  readonly enabled: boolean;
}

export interface ScopeCommitResult {
  readonly scope: ResourceScope;
  readonly status: "committed" | "conflict" | "failed" | "unchanged";
  readonly message?: string;
}

export interface CommitResult {
  readonly scopes: readonly ScopeCommitResult[];
  readonly committedScopes: readonly ResourceScope[];
}

export interface SettingsMutation {
  readonly scope: ResourceScope;
  readonly target: ToggleTarget;
  readonly enabled: boolean;
}

export interface CommitRequest {
  readonly documents: ReadonlyMap<ResourceScope, SettingsDocument>;
  readonly mutations: readonly SettingsMutation[];
}
