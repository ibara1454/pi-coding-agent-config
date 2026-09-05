import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ExtensionCatalog } from "./catalog.ts";
import { commitNotification } from "./commit-notification.ts";
import { PackageResolutionFailure } from "./discovery.ts";
import {
  createDefaultRuntime,
  type ExtensionManagerRuntime,
} from "./extension-runtime.ts";
import type { CatalogSeed } from "./types.ts";

export interface ExtensionManagerApi {
  on(event: "session_shutdown", handler: () => void): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    },
  ): void;
}

export function registerExtensionManager(
  pi: ExtensionManagerApi,
  runtime: ExtensionManagerRuntime = createDefaultRuntime(),
): void {
  let reloadPending = false;

  pi.on("session_shutdown", () => {
    runtime.dispose();
  });

  pi.registerCommand("extensions", {
    description: "Manage persistent Extensions and Skills",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/extensions is available only in TUI mode", "warning");
        return;
      }

      await ctx.waitForIdle();
      let seed: CatalogSeed;
      while (true) {
        try {
          seed = await runtime.discover({
            agentDir: runtime.agentDir(),
            cwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted(),
            reloadPending,
          });
          break;
        } catch (error) {
          if (!(error instanceof PackageResolutionFailure)) {
            ctx.ui.notify(
              error instanceof Error ? error.message : String(error),
              "error",
            );
            return;
          }
          const action = await ctx.ui.select(error.message, ["Retry", "Close"]);
          if (action !== "Retry") {
            return;
          }
        }
      }

      const catalog = new ExtensionCatalog(seed, runtime.commit);
      const result = await runtime.openPanel(ctx, catalog, runtime.selfPath);
      if (result.type !== "commit") {
        return;
      }
      reloadPending = true;
      const notification = commitNotification(result);
      ctx.ui.notify(notification.message, notification.level);
    },
  });
}
