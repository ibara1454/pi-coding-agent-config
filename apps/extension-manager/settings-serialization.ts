import type { JsonObject } from "./types.ts";

export function serializeSettings(
  settings: JsonObject,
  previousContent: string | undefined,
): string {
  const indent = previousContent?.match(/\n([ \t]+)\S/)?.[1] ?? "  ";
  const trailingNewline =
    previousContent === undefined || previousContent.endsWith("\n");
  return `${JSON.stringify(settings, null, indent)}${trailingNewline ? "\n" : ""}`;
}
