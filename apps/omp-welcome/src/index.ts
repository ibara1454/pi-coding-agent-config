import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWelcome } from "./pi/registration.ts";

/**
 * Installs the welcome UI; session shutdown releases its header and host override.
 * @example Pi loads this factory from the package's declared entrypoint.
 */
export default function welcome(pi: ExtensionAPI): void {
  registerWelcome(pi);
}
