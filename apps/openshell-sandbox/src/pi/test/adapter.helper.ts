import { mock } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { SanitizedRuntimeStatus } from "../../runtime/index.ts";

type SessionHandler = (
  event: unknown,
  context: ExtensionContext,
) => Promise<void>;
type CommandHandler = (
  args: string,
  context: ExtensionCommandContext,
) => Promise<void>;

/** Captures host UI and registered entry points without loading settings or native resources.
 * @example await f.commands.get("sandbox")?.("", f.context) renders into f.notify.
 */
export function adapterFixture() {
  const events = new Map<string, SessionHandler>();
  const commands = new Map<string, CommandHandler>();
  const tools = new Map<string, ToolDefinition>();
  const notify = mock((_message: string, _level: string) => undefined);
  const setStatus = mock((_key: string, _text?: string) => undefined);
  const sendMessage = mock((_message: { content: string }) => undefined);
  const confirm = mock(async () => false);
  const context: ExtensionCommandContext = Object.assign(
    // biome-ignore lint/plugin/biome-rules/use-undefined: Object.create requires null for a prototype-free Pi context fixture.
    Object.create(null) as ExtensionCommandContext,
    {
      cwd: "/project",
      isProjectTrusted: () => true,
      ui: { notify, setStatus, confirm },
    },
  );
  context.hasUI = true;
  // biome-ignore lint/plugin/biome-rules/use-undefined: Object.create requires null for a prototype-free Pi API fixture.
  const pi = Object.assign(Object.create(null) as ExtensionAPI, {
    on: (name: string, handler: SessionHandler) => events.set(name, handler),
    registerCommand: (name: string, command: { handler: CommandHandler }) =>
      commands.set(name, command.handler),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    sendMessage,
  });
  return {
    pi,
    context,
    events,
    commands,
    tools,
    notify,
    setStatus,
    sendMessage,
    confirm,
  };
}

/** Supplies nonsecret cached status for public adapter/UI tests without a native runtime.
 * @example cachedStatus({ phase: "closed" }) describes a retired fixture.
 */
export function cachedStatus(
  changes: Partial<SanitizedRuntimeStatus> = {},
): SanitizedRuntimeStatus {
  return {
    phase: "ready",
    policyPath: "/project/policy.yaml",
    requiredNativeReadWritePaths: ["/project"],
    lastFailure: undefined,
    ...changes,
  };
}
