import { describe, expect, test as it, spyOn } from "bun:test";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { registerSandbox } from "./registration.ts";
import { AdapterActivation } from "./session/index.ts";
import { adapterFixture } from "./test/adapter.helper.ts";

const piCapabilities = await import("@earendil-works/pi-coding-agent");

describe("registerSandbox", () => {
  it("should keep model Bash fail-closed and read the live pointer across start and shutdown", async () => {
    const f = adapterFixture();
    const prepare = spyOn(
      AdapterActivation.prototype,
      "prepare",
    ).mockResolvedValue(undefined);
    const dispose = spyOn(
      AdapterActivation.prototype,
      "dispose",
    ).mockResolvedValue(undefined);
    const { createBashTool } = piCapabilities;
    let operations: BashOperations | undefined;
    const factory = spyOn(piCapabilities, "createBashTool").mockImplementation(
      (cwd, options) => {
        operations = options?.operations;
        return createBashTool(cwd, options);
      },
    );
    try {
      const session = registerSandbox(f.pi);
      if (!operations) {
        throw new Error("missing registered operations");
      }
      expect(prepare).not.toHaveBeenCalled();
      await expect(
        operations.exec("pwd", "/project", { onData: () => undefined }),
      ).rejects.toThrow("OpenShell has not started");
      await f.events.get("session_start")?.({}, f.context);
      expect(session.activation).toBeInstanceOf(AdapterActivation);
      await expect(
        operations.exec("pwd", "/project", { onData: () => undefined }),
      ).rejects.toBe(session.activation?.failure);
      await f.events.get("session_shutdown")?.({}, f.context);
      await expect(
        operations.exec("pwd", "/project", { onData: () => undefined }),
      ).rejects.toThrow("OpenShell has not started");
    } finally {
      try {
        await f.events.get("session_shutdown")?.({}, f.context);
      } finally {
        factory.mockRestore();
        dispose.mockRestore();
        prepare.mockRestore();
      }
    }
  });
});
