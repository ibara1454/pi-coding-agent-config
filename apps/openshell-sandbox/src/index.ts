import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSandbox } from "./pi/index.ts";

/** Installs model-only fail-closed routing before any configuration or SDK operation.
 * Read-only status remains available after failed native preparation.
 * @example Pi loads this factory without requiring a running Docker/OpenShell instance.
 */
export default function openshellSandbox(pi: ExtensionAPI): void {
  registerSandbox(pi);
}
