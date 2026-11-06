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
  // biome-ignore lint/complexity/noExcessiveLinesPerFunction: This case owns both overlapping activation lifetimes through failed cleanup.
  it("should publish retired gateway recovery facts without replacing a newer activation when gateway cleanup fails", async () => {
    const f = adapterRuntimeFixture();
    const owner = registerSandbox(f.pi);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let closing: Promise<unknown> = Promise.resolve();
    let cleanupSpy: { mockRestore: () => void } | undefined;
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
      cleanupSpy = spyOn(
        previous.effects.host.filesystem,
        "rm",
      ).mockRejectedValue(new Error("PRIVATE_GATEWAY_CLEANUP"));
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
      try {
        await closing;
        await session(f, "session_shutdown");
      } finally {
        cleanupSpy?.mockRestore();
        f.restore();
      }
    }
  });
});
