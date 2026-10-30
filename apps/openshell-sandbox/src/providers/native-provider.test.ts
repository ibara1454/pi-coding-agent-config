import { describe, expect, test as it, spyOn } from "bun:test";
import { createNativeProvider } from "./native-provider.ts";
import { gateway } from "./test/provisioning.helper.ts";

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
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

  it("should reject a mismatched created profile and retain ownership for cleanup", async () => {
    const { handle, calls, capture, owned } = gateway();
    const { createProvider } = handle.client.raw;
    let credentials: Record<string, string> | undefined;
    spyOn(handle.client.raw, "createProvider").mockImplementation(
      async (request, options) => {
        credentials = request.provider?.credentials;
        const response = await createProvider(request, options);
        if (!response.provider) {
          throw new Error("Fixture provider acknowledgment is missing.");
        }
        response.provider.type = "unexpected";
        return response;
      },
    );
    try {
      await expect(
        createNativeProvider(
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
        ),
      ).rejects.toThrow("Explicit provider creation failed");
      expect(credentials).toEqual({});
      expect(calls).not.toContain("get");
      expect(calls).not.toContain("delete");
    } finally {
      await Promise.all(owned.map((resource) => resource.release()));
    }
    expect(calls).toContain("delete");
  });
});
