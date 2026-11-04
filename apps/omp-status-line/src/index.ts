import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerStatusLine } from "./pi/registration.ts";

/**
 * Registers the status line with session-owned rendering and cleanup.
 * @param pi Host API whose session events install and release the UI resources.
 * @example ompStatusLine(pi); // Installs the status line on session_start in TUI mode.
 */
export default function ompStatusLine(pi: ExtensionAPI): void {
  registerStatusLine(pi);
}
