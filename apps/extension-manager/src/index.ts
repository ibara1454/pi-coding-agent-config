import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionManager } from "./pi";

export default function extensionManager(pi: ExtensionAPI): void {
  registerExtensionManager(pi);
}
