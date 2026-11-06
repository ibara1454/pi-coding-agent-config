import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { collectWelcomeExtensions } from "./data.ts";

const temporaryRoots: string[] = [];

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-welcome-")));
  temporaryRoots.push(directory);
  return directory;
}

function write(filePath: string, content = "export default () => {};\n"): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("collectWelcomeExtensions", () => {
  it("should honor root entries, ignored files, and symlink targets exactly once", () => {
    const root = temporaryDirectory();
    const extensions = join(root, "extensions");
    write(join(extensions, "first.ts"));
    write(join(extensions, ".hidden.ts"));
    write(join(extensions, "node_modules", "ignored.ts"));
    write(join(extensions, "ignored-by-rule.ts"));
    write(join(extensions, ".gitignore"), "ignored-by-rule.ts\n");
    const linked = join(root, "linked");
    write(join(linked, "index.js"));
    symlinkSync(linked, join(extensions, "linked"), "dir");
    symlinkSync(join(extensions, "first.ts"), join(extensions, "alias.ts"));

    const discovered = () =>
      collectWelcomeExtensions({
        cwd: join(root, "project"),
        agentDir: root,
        projectTrusted: false,
      })
        .flatMap((row) =>
          row.path ? [relative(root, realpathSync(row.path))] : [],
        )
        .sort();

    expect(discovered()).toEqual(["extensions/first.ts", "linked/index.js"]);

    write(join(extensions, "index.ts"));
    expect(discovered()).toEqual(["extensions/index.ts"]);
  });
});
