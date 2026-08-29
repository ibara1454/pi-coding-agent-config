import { fileURLToPath } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { type CatalogCommitter, ExtensionCatalog } from "./catalog.ts";
import { discoverCatalog, PackageResolutionFailure } from "./discovery.ts";
import { ExtensionManagerPanel, type PanelResult } from "./panel.ts";
import { commitSettings } from "./persistence.ts";
import type { CatalogSeed, ResourceScope } from "./types.ts";

interface DiscoverInput {
  readonly agentDir: string;
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly reloadPending: boolean;
}

export interface ExtensionManagerRuntime {
  readonly agentDir: () => string;
  readonly commit: CatalogCommitter;
  readonly discover: (input: DiscoverInput) => Promise<CatalogSeed>;
  readonly openPanel: (
    ctx: ExtensionCommandContext,
    catalog: ExtensionCatalog,
    selfPath: string,
  ) => Promise<PanelResult>;
  readonly selfPath: string;
  readonly dispose: () => void;
}

export function createDefaultRuntime(): ExtensionManagerRuntime {
  const activePanels = new Set<ExtensionManagerPanel>();
  async function openPanel(
    ctx: ExtensionCommandContext,
    catalog: ExtensionCatalog,
    selfPath: string,
  ): Promise<PanelResult> {
    let panel: ExtensionManagerPanel | undefined;
    try {
      return await ctx.ui.custom<PanelResult>(
        (tui, theme, _keybindings, done) => {
          panel = new ExtensionManagerPanel({
            catalog,
            done,
            selfPath,
            theme,
            tui,
          });
          activePanels.add(panel);
          return panel;
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "top-left",
            margin: 0,
            width: "100%",
            maxHeight: "100%",
          },
        },
      );
    } finally {
      if (panel !== undefined) {
        activePanels.delete(panel);
        panel.dispose();
      }
    }
  }

  return {
    agentDir: getAgentDir,
    commit: commitSettings,
    discover: discoverCatalog,
    openPanel,
    selfPath: fileURLToPath(import.meta.url),
    dispose() {
      for (const panel of activePanels) {
        panel.dispose();
      }
      activePanels.clear();
    },
  };
}

function scopeLabel(scope: ResourceScope): string {
  return scope === "global" ? "Global" : "Project";
}

function commitNotification(
  panelResult: Extract<PanelResult, { type: "commit" }>,
): { readonly message: string; readonly level: "info" | "warning" } {
  const result = panelResult.result;
  const parts = [
    `Saved ${result.committedScopes.map(scopeLabel).join(" and ")} settings.`,
  ];
  const failed = result.scopes.filter(
    (scope) => scope.status === "failed" || scope.status === "conflict",
  );
  if (failed.length > 0) {
    parts.push(
      failed
        .map(
          (scope) =>
            `${scopeLabel(scope.scope)} ${scope.status}: ${scope.message ?? "unknown error"}`,
        )
        .join(" "),
    );
  }
  if (panelResult.selfDisableCommitted) {
    parts.push(
      "Extension Manager will be disabled after reload; recover with `pi config` or edit settings.json.",
    );
  }
  parts.push("Run /reload to apply saved changes.");
  return {
    message: parts.join(" "),
    level: failed.length === 0 ? "info" : "warning",
  };
}

export function registerExtensionManager(
  pi: ExtensionAPI,
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

export default function extensionManager(pi: ExtensionAPI): void {
  registerExtensionManager(pi);
}
