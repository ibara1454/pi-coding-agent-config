export type LspAction =
  | "diagnostics"
  | "definition"
  | "references"
  | "hover"
  | "symbols"
  | "rename"
  | "rename_file"
  | "code_actions"
  | "type_definition"
  | "implementation"
  | "status"
  | "reload"
  | "capabilities"
  | "request";

export interface LspParams {
  action: LspAction;
  file?: string;
  line?: number;
  symbol?: string;
  query?: string;
  // biome-ignore lint/style/useNamingConvention: LSP protocol exposes the external new_name argument.
  new_name?: string;
  apply?: boolean;
  timeout?: number;
  payload?: string;
}

export interface LspResult {
  text: string;
  isError?: boolean;
  details?: Record<string, unknown>;
}

export interface LspSettings {
  enabled: boolean;
  lazy: boolean;
  formatOnWrite: boolean;
  diagnosticsOnWrite: boolean;
  diagnosticsOnEdit: boolean;
  diagnosticsDeduplicate: boolean;
}

export interface ServerConfig {
  name: string;
  command: string;
  args: string[];
  fileTypes: string[];
  rootMarkers: string[];
  root: string;
  resolvedCommand?: string;
  languageId?: string;
  extensionToLanguage?: Record<string, string>;
  initOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  env?: Record<string, string>;
  capabilities?: Record<string, unknown>;
  disabled?: boolean;
  isLinter?: boolean;
  warmupTimeoutMs?: number;
  workspaceReadyTimings?: {
    timeoutMs?: number;
    pollMs?: number;
    settleMs?: number;
    statusRequestTimeoutMs?: number;
  };
}

export interface LspConfig {
  servers: ServerConfig[];
  settings: LspSettings;
  warnings: string[];
  idleTimeoutMs?: number;
}
