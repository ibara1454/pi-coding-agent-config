import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as fs from "node:fs/promises";
import * as config from "./config";
import * as processes from "./process";
import { runWorkspaceDiagnostics } from "./workspace-diagnostics";

beforeEach(() => {
  spyOn(fs, "access").mockImplementation(async (file) => {
    if (String(file) !== "/project/tsconfig.json") {
      throw Object.assign(new Error("missing marker"), { code: "ENOENT" });
    }
  });
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
});
