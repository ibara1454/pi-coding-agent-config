import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as packageEntry from "./index.ts";

describe("extensionManager", () => {
  test("should export only the default Pi extension factory", () => {
    expect(Object.keys(packageEntry)).toEqual(["default"]);
    expect(typeof packageEntry.default).toBe("function");
  });

  test("should register the extensions command through the command module when invoked", () => {
    const commands: { readonly name: string; readonly description: string }[] =
      [];
    const events: string[] = [];
    const pi = {
      on(event: string) {
        events.push(event);
      },
      registerCommand(name: string, options: { description: string }) {
        commands.push({ name, description: options.description });
      },
    } as unknown as ExtensionAPI;

    packageEntry.default(pi);

    expect(commands).toEqual([
      {
        name: "extensions",
        description: "Manage persistent Extensions and Skills",
      },
    ]);
    expect(events).toEqual(["session_shutdown"]);
  });
});
