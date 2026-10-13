import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: Spies must intercept the compiler probe's live named filesystem imports.
import * as fs from "node:fs/promises";

// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace; copied named imports cannot intercept consumers.
import * as config from "./config.ts";
// biome-ignore lint/performance/noNamespaceImport: Bun spies require the live module namespace; copied named imports cannot intercept consumers.
import * as processes from "./process.ts";

import { runWorkspaceDiagnostics } from "./workspace-diagnostics.ts";

const UNSUPPORTED_TIMEOUT_MS = 2_147_483_648;
const DISCOVERY_START_MS = 1000;
const DISCOVERY_END_MS = 1002;

/**
 * Installs project marker probes without accessing the real filesystem.
 * @param names - Root-level marker names present under /project; other paths report ENOENT.
 * @example fixtureMarkers(["go.work"]) selects only the Go workspace checker.
 */
function fixtureMarkers(names: readonly string[]): void {
  const paths = new Set(names.map((name) => `/project/${name}`));
  spyOn(fs, "access").mockImplementation((file) => {
    if (!paths.has(String(file))) {
      return Promise.reject(
        Object.assign(new Error("missing marker"), { code: "ENOENT" }),
      );
    }
    return Promise.resolve();
  });
}

beforeEach(() => {
  fixtureMarkers(["tsconfig.json"]);
  spyOn(config, "resolveCommand").mockResolvedValue("/installed/tsc");
});

afterEach(() => mock.restore());

describe("runWorkspaceDiagnostics", () => {
  test("should return compiler findings without treating a diagnostic exit as a tool failure", async () => {
    spyOn(processes, "runCommand").mockResolvedValue({
      stdout:
        "main.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      stderr: "",
      exitCode: 2,
    });
    const result = await runWorkspaceDiagnostics("/project");
    expect(result.isError).not.toBe(true);
    expect(result.text).toContain("TS2322");
  });

  test("should reject a nonzero exit without output instead of claiming a clean workspace", async () => {
    spyOn(processes, "runCommand").mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 2,
    });
    const result = await runWorkspaceDiagnostics("/project");
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("No issues found");
  });

  test("should report an unverified workspace without running a process when both TypeScript compilers are unavailable", async () => {
    spyOn(config, "resolveCommand").mockResolvedValue(undefined);
    const run = spyOn(processes, "runCommand").mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const result = await runWorkspaceDiagnostics("/project");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("installed 'tsc' executable was not found");
    expect(config.resolveCommand).toHaveBeenCalledWith("tsc", "/project");
    expect(config.resolveCommand).toHaveBeenCalledWith("tsgo", "/project");
    expect(run).not.toHaveBeenCalled();
  });

  test.each([
    {
      condition: "invalid JSON",
      report: "{",
      message: "Failed to run go:",
    },
    {
      condition: "no workspace modules",
      report: '{"Use":[]}',
      message: "returned no workspace modules",
    },
    {
      condition: "a non-object module",
      report: '{"Use":[null]}',
      message: "returned an invalid module path",
    },
    {
      condition: "an empty module path",
      report: '{"Use":[{"DiskPath":""}]}',
      message: "returned an invalid module path",
    },
  ])(
    "should skip the build and report an error when the Go workspace report contains $condition",
    async ({ report, message }) => {
      fixtureMarkers(["go.work"]);
      const run = spyOn(processes, "runCommand").mockResolvedValue({
        stdout: report,
        stderr: "",
        exitCode: 0,
      });

      const result = await runWorkspaceDiagnostics("/project");
      expect(result.isError).toBe(true);
      expect(result.text).toContain(message);
      expect(run.mock.calls.map((call) => call[1])).toEqual([
        ["work", "edit", "-json"],
      ]);
    },
  );

  test("should aggregate clean checks, findings and failures when a workspace has multiple languages", async () => {
    fixtureMarkers([
      "Cargo.toml",
      "tsconfig.json",
      "go.work",
      "pyproject.toml",
    ]);
    spyOn(config, "resolveCommand").mockImplementation((command) =>
      Promise.resolve(`/installed/${command}`),
    );
    const run = spyOn(processes, "runCommand").mockImplementation(
      (command, args) => {
        if (args[0] === "work") {
          return Promise.resolve({
            stdout: `{"Use":[
              {"DiskPath":"."},
              {"DiskPath":"services/api\\\\"},
              {"DiskPath":"../shared/"},
              {"DiskPath":"services/api/"},
              {"DiskPath":"/libs/common/"}
            ]}`,
            stderr: "",
            exitCode: 0,
          });
        }
        if (command === "/installed/pyright") {
          return Promise.reject(new Error("checker permission denied"));
        }
        return Promise.resolve({
          stdout: command === "/installed/tsc" ? "main.ts: error TS2322" : "",
          stderr:
            command === "/installed/go" ? "api.go: undefined: missing" : "",
          exitCode: command === "/installed/cargo" ? 0 : 1,
        });
      },
    );

    const result = await runWorkspaceDiagnostics("/project");
    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      "=== Rust (cargo check) ===\nNo issues found",
    );
    expect(result.text).toContain("=== TypeScript (tsc --noEmit) ===");
    expect(result.text).toContain("TS2322");
    expect(result.text).toContain("=== Go workspace (go build) ===");
    expect(result.text).toContain("undefined: missing");
    expect(result.text).toContain("=== Python (pyright) ===");
    expect(result.text).toContain("checker permission denied");
    expect(result.details).toMatchObject({
      projectTypes: ["rust", "typescript", "go", "python"],
      checkers: [
        { isError: false, output: "No issues found" },
        { isError: false },
        { isError: false },
        { isError: true },
      ],
    });
    expect(run).toHaveBeenCalledWith(
      "/installed/go",
      [
        "build",
        "./...",
        "./services/api/...",
        "../shared/...",
        "/libs/common/...",
      ],
      expect.objectContaining({
        cwd: "/project",
        timeoutMs: expect.any(Number),
      }),
    );
  });

  test.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    UNSUPPORTED_TIMEOUT_MS,
  ])(
    "should skip marker probes and commands when the duration is invalid (%s milliseconds)",
    async (timeout) => {
      const access = spyOn(fs, "access");
      const run = spyOn(processes, "runCommand");
      const result = await runWorkspaceDiagnostics(
        "/project",
        undefined,
        timeout,
      );
      expect(result.isError).toBe(true);
      expect(result.text).toContain("positive, finite millisecond duration");
      expect(access).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    },
  );

  test("should report marker permission failures without launching a checker", async () => {
    spyOn(fs, "access").mockRejectedValue(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    const run = spyOn(processes, "runCommand");
    const result = await runWorkspaceDiagnostics("/project");
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "Workspace checker discovery failed: permission denied",
    );
    expect(run).not.toHaveBeenCalled();
  });

  test("should report an unverified workspace when no supported project markers exist", async () => {
    fixtureMarkers([]);
    const run = spyOn(processes, "runCommand");
    const result = await runWorkspaceDiagnostics("/project");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Cannot detect project type");
    expect(result.text).toContain("Workspace was not verified");
    expect(run).not.toHaveBeenCalled();
  });

  test.each([
    ["a non-object report", "null", "returned no workspace modules"],
    [
      "too many modules",
      `{"Use":[${Array.from({ length: 257 }, () => '{"DiskPath":"."}').join(",")}]}`,
      "exceeds 256 modules",
    ],
  ])(
    "should refuse a Go build when module discovery returns %s",
    async (_condition, stdout, message) => {
      fixtureMarkers(["go.work"]);
      const run = spyOn(processes, "runCommand").mockResolvedValue({
        stdout,
        stderr: "",
        exitCode: 0,
      });
      const result = await runWorkspaceDiagnostics("/project");
      expect(result.isError).toBe(true);
      expect(result.text).toContain(message);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[1]).toEqual(["work", "edit", "-json"]);
    },
  );

  test("should retain the Go discovery failure and skip the build when discovery exits nonzero", async () => {
    fixtureMarkers(["go.work"]);
    const run = spyOn(processes, "runCommand").mockResolvedValue({
      stdout: "",
      stderr: "go.work syntax error",
      exitCode: 1,
    });
    const result = await runWorkspaceDiagnostics("/project");
    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      "go work edit -json exited with code 1: go.work syntax error",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("should stop before resolving commands when marker discovery exhausts the shared deadline", async () => {
    spyOn(Date, "now")
      .mockReturnValueOnce(DISCOVERY_START_MS)
      .mockReturnValue(DISCOVERY_END_MS);
    const resolve = spyOn(config, "resolveCommand");
    const run = spyOn(processes, "runCommand");
    const result = await runWorkspaceDiagnostics("/project", undefined, 1);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("workspace diagnostics deadline exceeded");
    expect(resolve).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  test("should propagate caller cancellation instead of reporting completed diagnostics when a command aborts", async () => {
    const controller = new AbortController();
    const reason = new Error("caller canceled diagnostics");
    spyOn(processes, "runCommand").mockImplementation(
      (_command, _args, options) => {
        expect(options?.signal).toBe(controller.signal);
        controller.abort(reason);
        return Promise.reject(reason);
      },
    );
    await expect(
      runWorkspaceDiagnostics("/project", controller.signal),
    ).rejects.toBe(reason);
  });
});
