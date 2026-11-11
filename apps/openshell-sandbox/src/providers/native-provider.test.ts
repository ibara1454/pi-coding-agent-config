import { describe, expect, test as it, spyOn } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ProviderResponseSchema } from "@nvidia/openshell-sdk/raw";
import type { OwnedResource } from "../host/index.ts";
import { createNativeProvider } from "./native-provider.ts";
import { gateway } from "./test/provisioning.helper.ts";

const selection = {
  provider: {
    name: "registry",
    profile: "registry",
    credentialMode: "explicit" as const,
    credentialsFromEnv: { ["TOKEN"]: "EXPLICIT_TOKEN" },
  },
  name: "owned-provider",
};

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("createNativeProvider", () => {
  it("should retain credentials until the create RPC settles and erase them before identity readback", async () => {
    const { handle, capture, owned } = gateway();
    const { createProvider, getProvider } = handle.client.raw;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let credentials: Record<string, string> | undefined;
    let atReadback: Record<string, string> | undefined;
    const creatingRpc = spyOn(
      handle.client.raw,
      "createProvider",
    ).mockImplementation(async (request) => {
      credentials = request.provider?.credentials;
      started.resolve();
      await release.promise;
      return createProvider(request);
    });
    const readback = spyOn(handle.client.raw, "getProvider").mockImplementation(
      (request, options) => {
        atReadback = { ...credentials };
        return getProvider(request, options);
      },
    );
    const creating = createNativeProvider(
      handle,
      selection,
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
      try {
        await Promise.all(owned.map((resource) => resource.release()));
      } finally {
        creatingRpc.mockRestore();
        readback.mockRestore();
      }
    }
  });

  it("should reject a mismatched created profile and retain ownership for cleanup", async () => {
    const { handle, calls, capture, owned } = gateway();
    const { createProvider } = handle.client.raw;
    let credentials: Record<string, string> | undefined;
    const creatingRpc = spyOn(
      handle.client.raw,
      "createProvider",
    ).mockImplementation(async (request, options) => {
      credentials = request.provider?.credentials;
      const response = await createProvider(request, options);
      if (!response.provider) {
        throw new Error("Fixture provider acknowledgment is missing.");
      }
      response.provider.type = "unexpected";
      return response;
    });
    try {
      await expect(
        createNativeProvider(handle, selection, () => "PRIVATE_VALUE", capture),
      ).rejects.toThrow("Explicit provider creation failed");
      expect(credentials).toEqual({});
      expect(calls).not.toContain("get");
      expect(calls).not.toContain("delete");
    } finally {
      try {
        await Promise.all(owned.map((resource) => resource.release()));
      } finally {
        creatingRpc.mockRestore();
      }
    }
    expect(calls).toContain("delete");
  });
  it("should refuse credential lookup and creation when gateway activity is cancelled", async () => {
    const { handle, calls, capture } = gateway();
    const controller = new AbortController();
    controller.abort();
    Object.assign(handle, { signal: controller.signal });
    const credentialReads: string[] = [];
    await expect(
      createNativeProvider(
        handle,
        selection,
        (name) => {
          credentialReads.push(name);
          return "PRIVATE_VALUE";
        },
        capture,
      ),
    ).rejects.toThrow("Explicit provider creation failed");
    expect(credentialReads).toEqual([]);
    expect(calls).not.toContain("create");
  });
  it("should sanitize capture failure and skip native creation when ownership registration throws after credential lookup", async () => {
    const { handle, calls } = gateway();
    const credentialReads: string[] = [];
    const failure = createNativeProvider(
      handle,
      selection,
      (name) => {
        credentialReads.push(name);
        return "PRIVATE_VALUE";
      },
      () => {
        throw new Error("PRIVATE_CAPTURE_FAILURE");
      },
    );
    await expect(failure).rejects.toThrow("Explicit provider creation failed");
    await expect(failure).rejects.not.toThrow("PRIVATE_CAPTURE_FAILURE");
    expect(credentialReads).toEqual(["EXPLICIT_TOKEN"]);
    expect(calls).not.toContain("create");
    expect(calls).not.toContain("get");
  });
  it.each(["TOKEN", "__proto__"])(
    "should erase inline credentials and sanitize native creation rejection when the selected key is %s",
    async (key) => {
      const { handle, capture } = gateway();
      let captured: Record<string, string> | undefined;
      let ownKeyBeforeRejection = false;
      Object.assign(handle.client.raw, {
        createProvider: (request: {
          provider: { credentials: Record<string, string> };
        }) => {
          captured = request.provider.credentials;
          ownKeyBeforeRejection = Object.hasOwn(captured, key);
          return Promise.reject(new Error("RAW-SECRET-IN-NATIVE-ERROR"));
        },
      });
      const failure = createNativeProvider(
        handle,
        {
          ...selection,
          provider: {
            ...selection.provider,
            credentialsFromEnv: Object.fromEntries([[key, "EXPLICIT_TOKEN"]]),
          },
        },
        () => "PRIVATE_VALUE",
        capture,
      );
      await expect(failure).rejects.toThrow(
        "Explicit provider creation failed",
      );
      await expect(failure).rejects.not.toThrow("RAW-SECRET-IN-NATIVE-ERROR");
      expect(ownKeyBeforeRejection).toBe(true);
      expect(Object.keys(captured ?? {})).toEqual([]);
      expect(Object.hasOwn(captured ?? {}, key)).toBe(false);
    },
  );
  it("should reject a mismatched native created identity and erase inline credentials", async () => {
    const { handle, capture } = gateway();
    let captured: Record<string, string> | undefined;
    Object.assign(handle.client.raw, {
      createProvider: (request: {
        provider: { credentials: Record<string, string> };
      }) => {
        captured = request.provider.credentials;
        return Promise.resolve(
          create(ProviderResponseSchema, {
            provider: {
              metadata: {
                name: "unexpected",
                id: "native-unexpected",
                workspace: "default",
              },
              type: "registry",
            },
          }),
        );
      },
    });
    await expect(
      createNativeProvider(handle, selection, () => "PRIVATE_VALUE", capture),
    ).rejects.toThrow("Explicit provider creation failed");
    expect(captured).toEqual({});
  });
  it("should retain an unacknowledged provider without deleting an unknown SDK identity", async () => {
    const { handle, calls } = gateway();
    const owned: OwnedResource[] = [];
    Object.assign(handle.client.raw, {
      createProvider: (request: { provider: { metadata: { name: string } } }) =>
        Promise.resolve(
          create(ProviderResponseSchema, {
            provider: {
              metadata: {
                name: request.provider.metadata.name,
                workspace: "default",
              },
              type: "registry",
            },
          }),
        ),
    });
    await expect(
      createNativeProvider(
        handle,
        selection,
        () => "PRIVATE_VALUE",
        (item) => owned.push(item),
      ),
    ).rejects.toThrow("Explicit provider creation failed");
    expect(owned).toHaveLength(1);
    await expect(owned[0]?.release()).rejects.toThrow("identity is unknown");
    expect(calls).not.toContain("delete");
  });
  it("should preserve a changed SDK provider identity instead of deleting its replacement", async () => {
    const { handle, calls } = gateway({
      query: (name) =>
        Promise.resolve(
          create(ProviderResponseSchema, {
            provider: {
              metadata: { name, id: "replacement", workspace: "default" },
              type: "registry",
            },
          }),
        ),
    });
    const owned: OwnedResource[] = [];
    await expect(
      createNativeProvider(
        handle,
        selection,
        () => "secret",
        (resource) => owned.push(resource),
      ),
    ).rejects.toThrow("Explicit provider creation failed");
    expect(owned).toHaveLength(1);
    await expect(owned[0]?.release()).rejects.toThrow(
      "Native provider ownership or deletion failed",
    );
    expect(calls).not.toContain("delete");
  });
  it("should retain captured ownership after a transient SDK query failure", async () => {
    let queries = 0;
    const { handle, calls } = gateway({
      query: (name) => {
        queries += 1;
        return queries === 1
          ? Promise.reject(new Error("RAW-NATIVE-SECRET"))
          : Promise.resolve(
              create(ProviderResponseSchema, {
                provider: {
                  metadata: {
                    name,
                    id: `native-${name}`,
                    workspace: "default",
                  },
                  type: "registry",
                },
              }),
            );
      },
    });
    const owned: OwnedResource[] = [];
    const failure = createNativeProvider(
      handle,
      selection,
      () => "secret",
      (resource) => owned.push(resource),
    );
    await expect(failure).rejects.toThrow("Explicit provider creation failed");
    await expect(failure).rejects.not.toThrow("RAW-NATIVE-SECRET");
    expect(queries).toBe(1);
    await owned[0]?.release();
    expect(calls).toContain("delete");
  });
  it("should retry failed native deletion without exposing the SDK error or cause", async () => {
    const { handle, owned, capture } = gateway();
    await createNativeProvider(handle, selection, () => "secret", capture);
    let deletionAttempts = 0;
    Object.assign(handle.client.raw, {
      deleteProvider: () => {
        deletionAttempts += 1;
        return deletionAttempts === 1
          ? Promise.reject(new Error("RAW-NATIVE-SECRET"))
          : Promise.resolve({});
      },
    });
    const failure = owned[0]?.release();
    await expect(failure).rejects.toThrow(
      "Native provider ownership or deletion failed",
    );
    await expect(failure).rejects.not.toThrow("RAW-NATIVE-SECRET");
    expect(await failure?.catch((error: Error) => error.cause)).toBeUndefined();
    await owned[0]?.release();
    expect(deletionAttempts).toBe(2);
    await owned[0]?.release();
    expect(deletionAttempts).toBe(2);
  });
});
