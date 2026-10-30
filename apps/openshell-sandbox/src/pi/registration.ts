import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerModelBash } from "./bash.ts";
import { registerSandboxStatus } from "./commands/index.ts";
import { AdapterSession } from "./session/index.ts";

/** Registers model-only routing before loading SDK implementation or configuration.
 * Each factory owns independent session state; user Bash retains Pi's normal path.
 * @param pi Pi registration API receiving fail-closed model Bash, /sandbox and lifecycle handlers.
 * @returns The independent session owner also captured by the registered commands and handlers.
 * @example Reload may begin fresh even after a previous runtime reports failed cleanup.
 */
export function registerSandbox(pi: ExtensionAPI): AdapterSession {
  const session = new AdapterSession(pi);
  registerModelBash(pi, () => session.activation);
  pi.on("session_start", (_event, context) => session.start(context));
  pi.on("session_shutdown", () => session.shutdown());
  registerSandboxStatus(pi, session);
  return session;
}
