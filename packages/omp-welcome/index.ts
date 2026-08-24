import { fileURLToPath } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionContext,
  InteractiveMode,
  SessionManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  collectWelcomeExtensions,
  effectiveQuietStartup,
  getAgentDir,
  welcomeSessions,
} from "./data.ts";
import { installResourceInventoryOverride } from "./resource-inventory.ts";
import { pickStartupTip, WelcomeHeader } from "./welcome.ts";

interface WelcomeProcessState {
  introPlayed: boolean;
  selectedTip?: string;
  inventoryWarningShown?: boolean;
}

const PROCESS_STATE = Symbol.for("pi-agent.extensions.omp-welcome.state");

function processState(): WelcomeProcessState {
  const root = globalThis as typeof globalThis & {
    [PROCESS_STATE]?: WelcomeProcessState;
  };
  root[PROCESS_STATE] ??= { introPlayed: false };
  return root[PROCESS_STATE];
}

async function startupSessions(ctx: ExtensionContext) {
  try {
    const sessions = await SessionManager.list(
      ctx.cwd,
      ctx.sessionManager.getSessionDir(),
    );
    return welcomeSessions(sessions);
  } catch {
    return [];
  }
}

export default function welcome(pi: ExtensionAPI): void {
  let header: WelcomeHeader | undefined;
  let lifecycle = 0;
  const inventoryOverride = installResourceInventoryOverride(
    VERSION,
    InteractiveMode,
  );

  pi.on("session_start", async (event, ctx) => {
    const start = ++lifecycle;
    if (ctx.mode !== "tui") return;

    const trusted = ctx.isProjectTrusted();
    if (effectiveQuietStartup(ctx.cwd, getAgentDir(), trusted)) {
      header?.dispose();
      header = undefined;
      ctx.ui.setHeader(undefined);
      return;
    }
    const state = processState();
    if (!inventoryOverride.supported && !state.inventoryWarningShown) {
      state.inventoryWarningShown = true;
      ctx.ui.notify(
        `Welcome could not suppress Pi's startup resource inventory: ${inventoryOverride.reason ?? "unsupported host implementation"}.`,
        "warning",
      );
    }

    const [extensions, sessions] = await Promise.all([
      collectWelcomeExtensions({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        projectTrusted: trusted,
        welcomePath: fileURLToPath(import.meta.url),
      }),
      startupSessions(ctx),
    ]);
    if (start !== lifecycle) return;

    state.selectedTip ??= pickStartupTip();
    const selectedTip = state.selectedTip;
    const playIntro = event.reason === "startup" && !state.introPlayed;
    if (playIntro) state.introPlayed = true;

    // Pi owns replacement disposal: setting a header disposes the preceding
    // custom header before this factory creates the next welcome component.
    ctx.ui.setHeader((tui, theme) => {
      header = new WelcomeHeader({
        version: VERSION,
        extensions,
        recentSessions: sessions,
        selectedTip,
        theme,
        requestRender: () => tui.requestRender(),
        terminalRows: () => tui.terminal.rows,
        playIntro,
      });
      return header;
    });
  });

  pi.on("session_shutdown", () => {
    lifecycle++;
    header?.dispose();
    header = undefined;
    inventoryOverride.release();
  });
}
