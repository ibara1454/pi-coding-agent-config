import type { HostCaptureEffects } from "../host";
import type { RuntimeNativeCapabilities } from "../runtime";

/** Native readers and adapters acquired separately for each session activation.
 * @example Each activation captures fresh host facts from the supplied readers.
 */
export interface PiNativeCapabilities {
  readonly capture?: HostCaptureEffects;
  readonly agentDirectory?: () => string;
  readonly runtime?: RuntimeNativeCapabilities;
}
