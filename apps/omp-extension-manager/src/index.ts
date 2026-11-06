import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionManager } from "./pi/index.ts";

export default function extensionManager(pi: ExtensionAPI): void {
  registerExtensionManager(pi);
}
