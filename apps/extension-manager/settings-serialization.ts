import type { JsonObject } from "./types.ts";

const SETTINGS_INDENT = /\n([ \t]+)\S/;

/**
 * Serializes settings while retaining the prior document's indentation and final newline.
 * @param settings JSON settings; existing external JSON values are preserved.
 * @param previousContent Prior document text, or undefined for a new document.
 * @returns Serialized JSON without modifying the supplied settings.
 * @example serializeSettings({ quietStartup: true }, undefined) // '{\n  "quietStartup": true\n}\n'
 */
export function serializeSettings(
  settings: JsonObject,
  previousContent: string | undefined,
): string {
  const indent = previousContent?.match(SETTINGS_INDENT)?.[1] ?? "  ";
  const trailingNewline =
    previousContent === undefined || previousContent.endsWith("\n");
  return `${JSON.stringify(settings, undefined, indent)}${trailingNewline ? "\n" : ""}`;
}
