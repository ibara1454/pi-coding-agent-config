import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProviderBaseUrlOverrides } from "./pi/registration.ts";

/**
 * Installs provider routing when PROVIDER_BASE_URL is valid at initialization.
 * @example Pi loads this factory before the session_start provider snapshot.
 */
export default function providerBaseUrlOverrides(pi: ExtensionAPI): void {
  registerProviderBaseUrlOverrides(pi);
}
