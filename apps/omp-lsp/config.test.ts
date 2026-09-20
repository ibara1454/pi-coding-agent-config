import { describe, expect, spyOn, test } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: Spies must intercept the loader's live named filesystem imports.
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLspConfig, serversForFile } from "./config.ts";

const cwd = "/project";
const agentDir = "/agent";
const installed = "/installed/language-server";
const projectConfig = join(cwd, ".pi", "lsp.json");

const filesystem: {
  access: (file: string) => Promise<void>;
  stat: (file: string) => Promise<{ isFile: () => boolean }>;
  open: (
    file: string,
    flags: string,
  ) => Promise<{
    stat: () => Promise<{ isFile: () => boolean; size: number }>;
    read: (
      buffer: Buffer,
      offset: number,
      length: number,
      position: null,
    ) => Promise<{ bytesRead: number }>;
    close: () => Promise<void>;
  }>;
} = fs;

function fixture(override?: unknown): void {
  const preset = {
    args: [],
    fileTypes: [".ts"],
    rootMarkers: ["package.json"],
  };
  const files = new Map([
    [
      fileURLToPath(new URL("./defaults.json", import.meta.url)),
      JSON.stringify({
        available: { ...preset, command: installed },
        optional: { ...preset, command: "/missing/language-server" },
      }),
    ],
  ]);
  if (override !== undefined) {
    files.set(projectConfig, JSON.stringify(override));
  }
  const missing = () =>
    Object.assign(new Error("Not found"), { code: "ENOENT" });
  spyOn(filesystem, "access").mockImplementation((file) => {
    if (file !== join(cwd, "package.json") && file !== installed) {
      return Promise.reject(missing());
    }
    return Promise.resolve();
  });
  spyOn(filesystem, "stat").mockImplementation((file) => {
    if (file !== installed) {
      return Promise.reject(missing());
    }
    return Promise.resolve({ isFile: () => true });
  });
  spyOn(filesystem, "open").mockImplementation((file) => {
    const text = files.get(file);
    if (text === undefined) {
      return Promise.reject(missing());
    }
    const content = Buffer.from(text);
    let position = 0;
    return Promise.resolve({
      stat: async () => ({ isFile: () => true, size: content.length }),
      read: (buffer, offset, length) => {
        const bytesRead = content.copy(
          buffer,
          offset,
          position,
          position + length,
        );
        position += bytesRead;
        return Promise.resolve({ bytesRead });
      },
      close: () => Promise.resolve(),
    });
  });
}

describe("loadLspConfig", () => {
  test("should select installed servers without warnings when optional executables are missing", async () => {
    fixture();
    const config = await loadLspConfig(cwd, agentDir, true);
    expect(config.warnings).toEqual([]);
    expect(
      serversForFile(config, join(cwd, "example.ts")).map(
        (server) => server.name,
      ),
    ).toEqual(["available"]);
  });

  test("should report invalid user overrides while retaining an available server", async () => {
    fixture({ servers: { available: { args: "--stdio" } } });
    const config = await loadLspConfig(cwd, agentDir, true);
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain(projectConfig);
    expect(config.warnings[0]).toContain("available");
    expect(
      serversForFile(config, join(cwd, "example.ts")).map(
        (server) => server.name,
      ),
    ).toEqual(["available"]);
  });
});
