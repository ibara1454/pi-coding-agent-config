import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { AdapterActivation } from "./activation.ts";

/** Owns the current activation pointer; retired activations retain their own teardown.
 * @example An old shutdown finishing after a replacement leaves the new activation installed.
 */
export class AdapterSession {
  readonly pi: ExtensionAPI;
  activation: AdapterActivation | undefined;

  /** Captures host publication effects without starting an activation or native work.
   * @example new AdapterSession(pi) has no current activation until session_start.
   */
  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  /** Replaces the activation without awaiting its retired native teardown.
   * The previous activation owns its disposal and cannot publish into this session.
   * @example A new session_start prepares independently while old cleanup is pending.
   */
  async start(context: ExtensionContext): Promise<void> {
    this.activation?.dispose(this.pi).catch(() => undefined);
    const activation = new AdapterActivation(context);
    this.activation = activation;
    await activation.prepare(this.pi);
  }

  /** Disposes the captured activation and clears only its matching pointer/footer.
   * @example A late old shutdown cannot clear the footer of a replacement activation.
   */
  async shutdown(): Promise<void> {
    const closing = this.activation;
    if (!closing) {
      return;
    }
    try {
      await closing.dispose(this.pi);
    } finally {
      if (this.activation === closing) {
        this.activation = undefined;
        try {
          closing.context.ui.setStatus("openshell-sandbox", undefined);
        } catch {
          /* Persistent failure messages survive unavailable footer UI. */
        }
      }
    }
  }
}
