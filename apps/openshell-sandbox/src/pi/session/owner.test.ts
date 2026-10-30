import { describe, expect, test as it, mock, spyOn } from "bun:test";
import { adapterFixture } from "../test/index.helper.ts";
import { AdapterActivation } from "./activation.ts";
import { AdapterSession } from "./owner.ts";

/** Supplies only teardown and footer effects; no native or filesystem work starts.
 * @example fixture.session.shutdown() clears the matching pointer and records one footer clear.
 */
function closingSession(dispose: () => Promise<void>) {
  const f = adapterFixture();
  const activation = new AdapterActivation(f.context);
  activation.dispose = mock(dispose);
  const session = new AdapterSession(f.pi);
  session.activation = activation;
  return { ...f, session, activation };
}

describe("AdapterSession.shutdown", () => {
  it("should clear the current pointer and footer together when its teardown settles", async () => {
    const f = closingSession(() => Promise.resolve());
    await f.session.shutdown();
    expect(f.session.activation).toBeUndefined();
    expect(f.setStatus.mock.calls).toEqual([["openshell-sandbox", undefined]]);
  });

  it("should preserve the newer pointer and footer when older teardown finishes", async () => {
    const release = Promise.withResolvers<void>();
    const f = closingSession(() => release.promise);
    const next = closingSession(() => Promise.resolve());
    const closing = f.session.shutdown();
    f.session.activation = next.activation;
    next.setStatus("openshell-sandbox", "OpenShell · ready");
    release.resolve();
    await closing;
    expect(f.session.activation).toBe(next.activation);
    expect(f.setStatus).not.toHaveBeenCalled();
    expect(next.setStatus.mock.calls).toEqual([
      ["openshell-sandbox", "OpenShell · ready"],
    ]);
    await f.session.shutdown();
  });

  it("should produce no additional footer clear when the pointer is already empty", async () => {
    const f = closingSession(() => Promise.resolve());
    await f.session.shutdown();
    f.setStatus.mockClear();
    await f.session.shutdown();
    expect(f.session.activation).toBeUndefined();
    expect(f.setStatus).not.toHaveBeenCalled();
  });
});

describe("AdapterSession.start", () => {
  it("should replace its pointer without awaiting obsolete teardown", async () => {
    const release = Promise.withResolvers<void>();
    const f = closingSession(() => release.promise);
    const prepare = spyOn(
      AdapterActivation.prototype,
      "prepare",
    ).mockResolvedValue(undefined);
    try {
      await f.session.start(f.context);
      expect(f.session.activation).toBeInstanceOf(AdapterActivation);
      expect(f.session.activation).not.toBe(f.activation);
      expect(f.activation.dispose).toHaveBeenCalledTimes(1);
      expect(f.setStatus).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      try {
        await f.session.shutdown();
      } finally {
        prepare.mockRestore();
      }
    }
  });

  it("should absorb obsolete teardown rejection while preparing the replacement", async () => {
    const f = closingSession(() =>
      Promise.reject(new Error("obsolete teardown")),
    );
    const ready = Promise.withResolvers<void>();
    const prepare = spyOn(
      AdapterActivation.prototype,
      "prepare",
    ).mockReturnValue(ready.promise);
    const starting = f.session.start(f.context);
    try {
      expect(f.session.activation).toBeInstanceOf(AdapterActivation);
      expect(f.session.activation).not.toBe(f.activation);
      ready.resolve();
      await starting;
      expect(f.session.activation?.current).toBe(true);
      expect(f.activation.dispose).toHaveBeenCalledTimes(1);
    } finally {
      ready.resolve();
      try {
        await starting;
        await f.session.shutdown();
      } finally {
        prepare.mockRestore();
      }
    }
  });
});
