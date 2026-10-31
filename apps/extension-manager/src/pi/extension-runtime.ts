import { fileURLToPath } from "node:url";
import {
  type ExtensionCommandContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { CatalogCommitter, ExtensionCatalog } from "../catalog/catalog.ts";
import type { CatalogSeed } from "../catalog/types.ts";
import { discoverCatalog } from "../discovery/discovery.ts";
import { ExtensionManagerPanel, type PanelResult } from "../panel/panel.ts";
import { commitSettings } from "../settings/persistence.ts";

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

/**
 * Creates Pi bindings whose panels are released on closure or explicit disposal.
 * @returns Runtime using the declared package entry for self-disable identity.
 * @example
 * const runtime = createDefaultRuntime();
 * runtime.dispose(); // Releases every panel opened by this runtime.
 */
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
    // Self-disable detection compares against Pi's entry module, not this one.
    selfPath: fileURLToPath(new URL("../index.ts", import.meta.url)),
    dispose() {
      for (const panel of activePanels) {
        panel.dispose();
      }
      activePanels.clear();
    },
  };
}
