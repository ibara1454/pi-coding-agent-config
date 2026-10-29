import { describe, expect, test as it, spyOn } from "bun:test";
import { createNativeProvider } from "./native-provider.ts";
import { gateway } from "./test/provisioning.helper.ts";

describe("createNativeProvider", () => {
  it("should retain credentials until the create RPC settles and erase them before identity readback", async () => {
    const { handle, capture, owned } = gateway();
    const { createProvider, getProvider } = handle.client.raw;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let credentials: Record<string, string> | undefined;
    let atReadback: Record<string, string> | undefined;
    spyOn(handle.client.raw, "createProvider").mockImplementation(
      async (request) => {
        credentials = request.provider?.credentials;
        started.resolve();
        await release.promise;
        return createProvider(request);
      },
    );
    spyOn(handle.client.raw, "getProvider").mockImplementation(
      (request, options) => {
        atReadback = { ...credentials };
        return getProvider(request, options);
      },
    );
    const creating = createNativeProvider(
      handle,
      {
        provider: {
          name: "registry",
          profile: "registry",
          credentialMode: "explicit",
          credentialsFromEnv: { ["TOKEN"]: "EXPLICIT_TOKEN" },
        },
        name: "owned-provider",
      },
      () => "PRIVATE_VALUE",
      capture,
    );
    try {
      await started.promise;
      expect(credentials).toEqual({ ["TOKEN"]: "PRIVATE_VALUE" });
      release.resolve();
      await creating;
      expect(atReadback).toEqual({});
      expect(credentials).toEqual({});
    } finally {
      release.resolve();
      await creating.catch(() => undefined);
      await Promise.all(owned.map((resource) => resource.release()));
    }
  });
});
