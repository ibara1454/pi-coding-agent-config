import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLsp } from "./pi/registration.ts";

/**
 * Registers the session-owned LSP tool and host feedback through Pi's package entrypoint.
 * @param pi - Host API whose session events own workspace creation and cleanup.
 * @example lsp(pi) registers the "lsp" tool without starting a server.
 */
export default function lsp(pi: ExtensionAPI): void {
  registerLsp(pi);
}
