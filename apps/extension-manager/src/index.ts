import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionManager } from "./pi/extension-command.ts";

export default function extensionManager(pi: ExtensionAPI): void {
  registerExtensionManager(pi);
}
