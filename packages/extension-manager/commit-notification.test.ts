import { describe, expect, test } from "bun:test";
import { commitNotification } from "./commit-notification.ts";
import type { PanelResult } from "./panel.ts";
import type { CommitResult } from "./types.ts";

type CommitPanelResult = Extract<PanelResult, { type: "commit" }>;

interface ExpectedNotification {
  readonly message: string;
  readonly level: "info" | "warning";
}

type NotificationCase = readonly [
  name: string,
  panelResult: CommitPanelResult,
  expected: ExpectedNotification,
];

const RELOAD = "Run /reload to apply saved changes.";
const RECOVERY =
  "Extension Manager will be disabled after reload; recover with `pi config` or edit settings.json.";

function commitPanelResult(
  result: CommitResult,
  selfDisableCommitted = false,
): CommitPanelResult {
  return { type: "commit", result, selfDisableCommitted };
}

const cases: readonly NotificationCase[] = [
  [
    "single committed scope names the scope and asks for reload",
    commitPanelResult({
      scopes: [{ scope: "global", status: "committed" }],
      committedScopes: ["global"],
    }),
    { message: `Saved Global settings. ${RELOAD}`, level: "info" },
  ],
  [
    "both committed scopes join with and",
    commitPanelResult({
      scopes: [
        { scope: "global", status: "committed" },
        { scope: "project", status: "committed" },
      ],
      committedScopes: ["global", "project"],
    }),
    { message: `Saved Global and Project settings. ${RELOAD}`, level: "info" },
  ],
  [
    "unchanged scopes are reported neither as saved nor as failures",
    commitPanelResult({
      scopes: [
        { scope: "global", status: "committed" },
        { scope: "project", status: "unchanged" },
      ],
      committedScopes: ["global"],
    }),
    { message: `Saved Global settings. ${RELOAD}`, level: "info" },
  ],
  [
    "partial commit reports the failed scope and still asks for reload",
    commitPanelResult({
      scopes: [
        { scope: "global", status: "committed" },
        { scope: "project", status: "failed", message: "disk full" },
      ],
      committedScopes: ["global"],
    }),
    {
      message: `Saved Global settings. Project failed: disk full ${RELOAD}`,
      level: "warning",
    },
  ],
  [
    "conflict without a message falls back to unknown error",
    commitPanelResult({
      scopes: [
        { scope: "global", status: "conflict" },
        { scope: "project", status: "committed" },
      ],
      committedScopes: ["project"],
    }),
    {
      message: `Saved Project settings. Global conflict: unknown error ${RELOAD}`,
      level: "warning",
    },
  ],
  [
    "committed self disable adds recovery instructions before the reload request",
    commitPanelResult(
      {
        scopes: [{ scope: "global", status: "committed" }],
        committedScopes: ["global"],
      },
      true,
    ),
    { message: `Saved Global settings. ${RECOVERY} ${RELOAD}`, level: "info" },
  ],
  [
    "self disable with a failed scope keeps both the failure and the recovery instructions",
    commitPanelResult(
      {
        scopes: [
          { scope: "global", status: "committed" },
          { scope: "project", status: "failed", message: "read-only" },
        ],
        committedScopes: ["global"],
      },
      true,
    ),
    {
      message: `Saved Global settings. Project failed: read-only ${RECOVERY} ${RELOAD}`,
      level: "warning",
    },
  ],
];

describe("commitNotification", () => {
  test.each(cases)(
    "should return the expected notification for: %s",
    (_name, panelResult, expected) => {
      expect(commitNotification(panelResult)).toEqual(expected);
    },
  );
});
