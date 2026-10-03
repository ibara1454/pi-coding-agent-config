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
});
