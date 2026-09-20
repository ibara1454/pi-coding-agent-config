import type { JsonObject } from "./types.ts";

const SETTINGS_INDENT = /\n([ \t]+)\S/;

export function serializeSettings(
  settings: JsonObject,
  previousContent: string | undefined,
): string {
  const indent = previousContent?.match(SETTINGS_INDENT)?.[1] ?? "  ";
  const trailingNewline =
    previousContent === undefined || previousContent.endsWith("\n");
  return `${JSON.stringify(settings, null, indent)}${trailingNewline ? "\n" : ""}`;
}
