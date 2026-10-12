export function isObjectRecord(
  value: unknown,
): value is Record<string, unknown> {
  // biome-ignore lint/plugin/use-undefined: typeof null is object; reject external null before reading fields.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
