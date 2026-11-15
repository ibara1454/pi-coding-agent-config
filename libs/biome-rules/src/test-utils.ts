import { readFileSync } from "node:fs";
import { MemoryFileSystem, main, Workspace } from "@biomejs/wasm-nodejs";

main();

/**
 * Runs one packaged GritQL rule against TypeScript source using Biome's WASM API.
 * Each call uses an isolated in-memory workspace that is disposed before
 * returning or throwing; no input file or Biome CLI subprocess is created.
 * Resolves the package manifest so qualified suppressions behave as in the CLI.
 *
 * @param rule - Exported rule name, matching its filename without `.grit`.
 * @param source - Complete TypeScript source text to lint.
 * @returns Syntax and rule diagnostics with `category`, `severity`, and `source`.
 * The returned `source` is the highlighted snippet, not the complete input or
 * method declaration. It is `undefined` when a diagnostic has no span.
 * Returns an empty array when there are no diagnostics.
 * @throws If package files cannot be read or the workspace cannot be configured.
 *
 * @example
 * ```ts
 * import { expect, it } from "bun:test";
 * import { lintRule } from "./test-utils";
 *
 * it("should highlight private methods and allow public methods", () => {
 *   const invalid = "class Example { private méthode() {} }";
 *   expect(lintRule("no-private-methods", invalid)).toEqual([
 *     { category: "plugin", severity: "error", source: "méthode" },
 *   ]);
 *
 *   const valid = "class Example { work() {} }";
 *   expect(lintRule("no-private-methods", valid)).toEqual([]);
 * });
 * ```
 */
export function lintRule(rule: string, source: string) {
  using files = new MemoryFileSystem();
  const packagePath = "/project/node_modules/biome-rules";
  for (const filename of ["package.json", "biome-manifest.json"]) {
    files.insert(
      `${packagePath}/${filename}`,
      readFileSync(new URL(`../${filename}`, import.meta.url)),
    );
  }
  files.insert(
    `${packagePath}/src/${rule}.grit`,
    readFileSync(new URL(`${rule}.grit`, import.meta.url)),
  );
  using workspace = Workspace.withFileSystem(files);
  const { projectKey } = workspace.openProject({
    path: "/project",
    openUninitialized: true,
  });
  const settings = workspace.updateSettings({
    projectKey,
    workspaceDirectory: "/project",
    configuration: { plugins: [`biome-rules/${rule}`] },
  });
  if (settings.diagnostics.length > 0) {
    throw new Error(JSON.stringify(settings.diagnostics));
  }
  workspace.openFile({
    projectKey,
    path: "/project/input.ts",
    content: { type: "fromClient", content: source, version: 0 },
  });
  const { diagnostics } = workspace.pullDiagnostics({
    projectKey,
    path: "/project/input.ts",
    categories: ["syntax", "lint"],
    only: ["plugin"],
  });
  if (diagnostics.length === 0) {
    return [];
  }
  // A diagnostic span is [start, end) byte offsets into the UTF-8 input:
  // start is included and end is excluded. The rule chooses the range;
  // span=$name, for example, highlights a method name rather than its body.
  // JavaScript string indices count UTF-16 code units, so slice bytes instead.
  const bytes = Buffer.from(source);
  return diagnostics.map(({ category, severity, location }) => ({
    category,
    severity,
    source: location.span
      ? bytes.subarray(...location.span).toString("utf8")
      : undefined,
  }));
}
