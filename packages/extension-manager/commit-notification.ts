import type { PanelResult } from "./panel.ts";
import type { ResourceScope } from "./types.ts";

function scopeLabel(scope: ResourceScope): string {
  return scope === "global" ? "Global" : "Project";
}

export function commitNotification(
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
