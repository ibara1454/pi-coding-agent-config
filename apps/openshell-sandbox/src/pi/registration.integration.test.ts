import { describe, expect, test as it, spyOn } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSandbox } from "./registration.ts";
import {
  adapterRuntimeFixture,
  executeRegisteredBash,
} from "./test/lifecycle.helper.ts";

/** Drives the registered host event, never a private adapter method.
 * @example await session(f, "session_shutdown") releases the fixture's active runtime.
 */
async function session(
  f: {
    events: ReadonlyMap<
      string,
      (event: unknown, context: ExtensionContext) => Promise<void>
    >;
    context: ExtensionContext;
  },
  event: "session_start" | "session_shutdown",
) {
  const handler = f.events.get(event);
  if (!handler) {
    throw new Error("Missing session handler");
  }
  await handler({}, f.context);
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("registerSandbox", () => {
  it("should show cached blocked status and allow shutdown before a session exists", async () => {
    const f = adapterRuntimeFixture();
    registerSandbox(f.pi);
    await f.commands.get("sandbox")?.("", f.context);
    expect(f.notify.mock.calls[0]?.[1]).toBe("warning");
    await session(f, "session_shutdown");
    await expect(executeRegisteredBash(f)).rejects.toBeInstanceOf(Error);
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("should admit a fresh activation without waiting for superseded cleanup", async () => {
    const f = adapterRuntimeFixture();
    const sessionOwner = registerSandbox(f.pi);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const retired = Promise.withResolvers<void>();
    try {
      await session(f, "session_start");
      await executeRegisteredBash(f);
      const [previous] = f.runtimes;
      if (!previous) {
        throw new Error("Missing previous runtime");
      }
      previous.sdk.beforeDelete = () => {
        entered.resolve();
        return release.promise;
      };
      const oldRuntime = sessionOwner.activation?.runtime;
      if (!oldRuntime) {
        throw new Error("Missing previous activation runtime");
      }
      const originalDispose = oldRuntime.dispose.bind(oldRuntime);
      spyOn(oldRuntime, "dispose").mockImplementation(async () => {
        try {
          await originalDispose();
        } finally {
          retired.resolve();
        }
      });
      await session(f, "session_start");
      await entered.promise;
      const result = await executeRegisteredBash(f);
      expect(result.content).toEqual([{ type: "text", text: "MODEL_RESULT" }]);
      expect(f.runtimes).toHaveLength(2);
      expect(f.runtimes[1]?.native.sandboxPresent).toBe(true);
      release.resolve();
      await retired.promise;
      expect(previous.native.sandboxPresent).toBe(false);
      expect(previous.native.networkPresent).toBe(false);
    } finally {
      release.resolve();
      await session(f, "session_shutdown");
    }
  });
  it("should publish retired gateway recovery facts without replacing a newer activation when gateway cleanup fails", async () => {
    const f = adapterRuntimeFixture();
    const owner = registerSandbox(f.pi);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let closing: Promise<unknown> = Promise.resolve();
    try {
      await session(f, "session_start");
      await executeRegisteredBash(f);
      const [previous] = f.runtimes;
      const oldActivation = owner.activation;
      const oldRuntime = oldActivation?.runtime;
      const recovery = oldRuntime?.getStatus().recovery;
      if (!(previous && oldRuntime && recovery)) {
        throw new Error("Missing ready activation recovery facts");
      }
      previous.sdk.beforeDelete = () => {
        entered.resolve();
        return release.promise;
      };
      spyOn(previous.effects.host.filesystem, "rm").mockRejectedValue(
        new Error("PRIVATE_GATEWAY_CLEANUP"),
      );
      closing = session(f, "session_shutdown").catch((error: unknown) => error);
      await entered.promise;
      await session(f, "session_start");
      await executeRegisteredBash(f);
      const current = owner.activation;
      const currentStatus = current?.runtime?.getStatus();
      const publications = f.setStatus.mock.calls.length;
      release.resolve();
      expect(await closing).toBeInstanceOf(Error);
      expect(previous.native.sandboxPresent).toBe(false);
      expect(oldActivation?.runtime).toBeUndefined();
      expect(owner.activation).toBe(current);
      expect(current?.runtime?.getStatus()).toEqual(currentStatus);
      expect(f.setStatus).toHaveBeenCalledTimes(publications);
      const transcript = f.sendMessage.mock.calls[0]?.[0].content ?? "";
      for (const coordinate of Object.values(recovery)) {
        expect(transcript).toContain(coordinate);
      }
      expect(transcript).not.toContain("PRIVATE_GATEWAY_CLEANUP");
      await f.commands.get("sandbox")?.("", f.context);
      const statusMessage = f.notify.mock.calls.at(-1)?.[0] ?? "";
      expect(statusMessage).toContain(
        currentStatus?.recovery?.sandboxName ?? "",
      );
      expect(statusMessage).not.toContain(recovery.sandboxName);
      expect((await executeRegisteredBash(f)).content).toEqual([
        { type: "text", text: "MODEL_RESULT" },
      ]);
    } finally {
      release.resolve();
      await closing;
      await session(f, "session_shutdown");
    }
  });
  it("should preserve the new activation when an older shutdown finishes later", async () => {
    const f = adapterRuntimeFixture();
    registerSandbox(f.pi);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let closing = Promise.resolve();
    try {
      await session(f, "session_start");
      await executeRegisteredBash(f);
      const [previous] = f.runtimes;
      if (!previous) {
        throw new Error("Missing previous runtime");
      }
      previous.sdk.beforeDelete = () => {
        entered.resolve();
        return release.promise;
      };
      closing = session(f, "session_shutdown");
      await entered.promise;
      await session(f, "session_start");
      release.resolve();
      await closing;
      expect((await executeRegisteredBash(f)).content).toEqual([
        { type: "text", text: "MODEL_RESULT" },
      ]);
    } finally {
      release.resolve();
      await closing;
      await session(f, "session_shutdown");
    }
  });

  it("should remain closed after successful disposal when clearing the footer throws", async () => {
    const f = adapterRuntimeFixture();
    registerSandbox(f.pi);
    await session(f, "session_start");
    await executeRegisteredBash(f);
    f.setStatus.mockImplementation(() => {
      throw new Error("closed footer");
    });
    await session(f, "session_shutdown");
    await expect(executeRegisteredBash(f)).rejects.toBeInstanceOf(Error);
    expect(f.runtimes[0]?.native.sandboxPresent).toBe(false);
    expect(f.runtimes[0]?.native.networkPresent).toBe(false);
  });
});
