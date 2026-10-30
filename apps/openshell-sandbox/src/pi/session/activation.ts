import { readFile } from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SandboxEnvironment } from "../../configuration/index.ts";
import {
  captureHostContext,
  HostProcessError,
  type ManagedProcess,
} from "../../host/index.ts";
import type { RuntimeEffects, SandboxRuntime } from "../../runtime/index.ts";
import type { PiNativeCapabilities } from "../index.ts";
import { createRuntimeObserver, publishFailure } from "./ui.ts";

/** Owns one adapter lifetime; no native ownership or failed-disposal result is inherited.
 * @example A new AdapterActivation for resume begins without any previous runtime handle.
 */
export class AdapterActivation {
  readonly controller = new AbortController();
  readonly context: ExtensionContext;
  private readonly native: PiNativeCapabilities | undefined;
  private preflight: Promise<RuntimeEffects> | undefined;
  private prerequisiteChild: ManagedProcess | undefined;
  private disposal: Promise<void> | undefined;
  current: boolean;
  runtime: SandboxRuntime | undefined;
  failure = new Error(
    "OpenShell preparation has not completed; model Bash is blocked.",
  );

  /** Retains raw readers without acquiring native resources or reusing an old host identity.
   * @param native Host readers are captured afresh only when this activation starts its runtime.
   * @example new AdapterActivation(context, native) performs no filesystem/process work.
   */
  constructor(context: ExtensionContext, native?: PiNativeCapabilities) {
    this.context = context;
    this.native = native;
    this.current = true;
  }

  /** Reads the selected snapshot and starts observed background native preparation.
   * A late completed initialization is disposed instead of adopted by another activation.
   * @example await activation.prepare(pi) never awaits a prior activation's teardown.
   */
  async prepare(pi: ExtensionAPI): Promise<void> {
    try {
      // SDK-dependent modules load only after the fail-closed Bash route is registered.
      const { loadSandboxEnvironment } = await import(
        "../../configuration/index.ts"
      );
      const environment = await loadSandboxEnvironment(
        {
          agentDir: (this.native?.agentDirectory ?? getAgentDir)(),
          cwd: this.context.cwd,
          projectTrusted: this.context.isProjectTrusted(),
        },
        { readFile: this.native?.capture?.filesystem.readFile ?? readFile },
      );
      if (this.current) {
        await this.startRuntime(pi, environment);
      }
    } catch (error) {
      if (this.current) {
        this.failure = publishFailure(pi, this.context, error, {
          operation: "preparation",
        });
        try {
          this.context.ui.setStatus("openshell-sandbox", "OpenShell · error");
        } catch {
          /* Persistent diagnostics do not depend on footer visibility. */
        }
      }
    }
  }

  /** Starts native preparation and retains a failed prerequisite child before sanitization.
   * A retired activation cleans up its late child or runtime, never transferring ownership.
   * @param pi - Transcript target for failed retired cleanup; no stale UI publication.
   * @param environment - Validated policy and workspace for this activation.
   * @returns Once preflight and any retired cleanup or runtime handoff settle.
   * @throws The preparation failure after any uncertain child has been retained.
   * @example Retirement during Docker discovery still owns that discovery child's close.
   */
  async startRuntime(
    pi: ExtensionAPI,
    environment: SandboxEnvironment,
  ): Promise<void> {
    // Static runtime imports would load SDK code before fail-closed host registration.
    const { createSandboxRuntime, createRuntimeEffects } = await import(
      "../../runtime/index.ts"
    );
    if (!this.current) {
      return;
    }
    const preflight = createRuntimeEffects(
      this.controller,
      captureHostContext(this.native?.capture),
      this.native?.runtime,
    ).catch((error: unknown) => {
      if (error instanceof HostProcessError && error.process) {
        const child = error.process;
        this.prerequisiteChild = child;
        child.closed.then(() => {
          if (this.prerequisiteChild === child) {
            this.prerequisiteChild = undefined;
          }
        });
      }
      throw error;
    });
    this.preflight = preflight;
    let effects: RuntimeEffects;
    try {
      effects = await preflight;
    } catch (error) {
      if (!this.current && this.prerequisiteChild) {
        await this.dispose(pi).catch(() => undefined);
      }
      throw error;
    } finally {
      this.preflight = undefined;
    }
    if (!this.current) {
      return;
    }
    const created = await createSandboxRuntime(
      environment,
      effects,
      createRuntimeObserver(pi, this.context),
    );
    if (!this.current) {
      try {
        await created.dispose();
      } catch (error) {
        publishFailure(pi, undefined, error, {
          operation: "retired activation cleanup",
          status: created.getStatus(),
        });
      }
      return;
    }
    this.runtime = created;
  }

  /** Prevents stale publication and aborts this activation's effects before disposal.
   * @example retire() makes every late observer callback inert.
   */
  retire(): void {
    this.current = false;
    this.controller.abort();
  }

  /** Retires this activation and shares its in-flight bounded teardown.
   * Raw preflight remains owned after its bounded caller wait expires.
   * A late failed child is still terminated and retained until raw close is observed.
   * @param pi - Transcript target for cleanup failures.
   * @returns Fulfillment only after owned resource teardown is confirmed.
   * @throws A transcript-only safe failure when owned teardown remains uncertain.
   * @example shutdown during Docker discovery cleans up its late failed child.
   */
  async dispose(pi: ExtensionAPI): Promise<void> {
    this.retire();
    if (!this.disposal) {
      this.disposal = (async () => {
        try {
          const { preflight } = this;
          if (preflight) {
            // Static runtime imports would load SDK code before fail-closed registration.
            const { CLEANUP_TIMEOUT_MS, deadline, waitBounded } = await import(
              "../../runtime/index.ts"
            );
            const limit = deadline(
              this.native?.runtime?.execution ?? {
                setTimer: setTimeout,
                clearTimer: clearTimeout as RuntimeEffects["clearTimer"],
              },
              CLEANUP_TIMEOUT_MS,
            );
            try {
              await waitBounded(
                preflight.catch(() => undefined),
                limit.signal,
              );
            } finally {
              limit.close();
            }
          }
          await this.prerequisiteChild?.terminate();
          await this.runtime?.dispose();
        } catch (error) {
          throw publishFailure(pi, undefined, error, {
            operation: "shutdown",
            status: this.runtime?.getStatus(),
          });
        } finally {
          this.runtime = undefined;
        }
      })();
    }
    const { disposal } = this;
    try {
      await disposal;
    } finally {
      if (this.disposal === disposal) {
        this.disposal = undefined;
      }
    }
  }
}
