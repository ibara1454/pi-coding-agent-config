import { describe, expect, test as it } from "bun:test";
import openshellSandbox from "./src/index.ts";
import {
  adapterRuntimeFixture,
  executeRegisteredBash,
} from "./src/pi/test/index.helper.ts";

describe("openshellSandbox", () => {
  it("should block model Bash before reading settings or acquiring native resources", async () => {
    const f = adapterRuntimeFixture();
    openshellSandbox(f.pi);
    await expect(
      executeRegisteredBash(f, "printf unexpected-host"),
    ).rejects.toBeInstanceOf(Error);
    expect([...f.commands.keys()]).toEqual(["sandbox"]);
    expect(f.readSettings).not.toHaveBeenCalled();
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.events.has("user_bash")).toBe(false);
  });
});
