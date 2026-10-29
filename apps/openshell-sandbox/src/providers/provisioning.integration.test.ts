import { describe, expect, test as it, spyOn } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  CreateProviderRequestSchema,
  ProviderProfileResponseSchema,
  ProviderResponseSchema,
} from "@nvidia/openshell-sdk/raw";
import type { OwnedResource } from "../host/index.ts";
import { provisionProviders } from "./provisioning.ts";
import {
  environment,
  gateway,
  OTHER_PROVIDER,
  profile,
} from "./test/provisioning.helper.ts";

const PROTOTYPE_CREDENTIAL_ENVIRONMENT = {
  ...environment(),
  providers: [
    {
      name: "registry",
      profile: "registry",
      credentialMode: "explicit" as const,
      credentialsFromEnv: Object.fromEntries([["__proto__", "EXPLICIT_TOKEN"]]),
    },
  ],
  profiles: [
    {
      sourcePath: "/profiles/registry.yaml",
      sdkProfiles: [profile("registry", "__proto__")],
    },
  ],
};

const MAX_SANDBOX_ROUTABLE_NAME_LENGTH = 19;
const MAX_NATIVE_PROVIDER_NAME_LENGTH = 253;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("provisionProviders", () => {
  it("should erase credential values from the native request object after a successful RPC", async () => {
    const { handle, capture } = gateway();
    let captured: Record<string, string> | undefined;
    Object.assign(handle.client.raw, {
      createProvider: (request: {
        provider: {
          metadata: { name: string };
          credentials: Record<string, string>;
        };
      }) => {
        captured = request.provider.credentials;
        expect(captured).toEqual({ ["TOKEN"]: "PRIVATE_VALUE" });
        return Promise.resolve(
          create(ProviderResponseSchema, {
            provider: {
              metadata: {
                name: request.provider.metadata.name,
                id: `native-${request.provider.metadata.name}`,
                workspace: "default",
              },
              type: "registry",
            },
          }),
        );
      },
    });
    const result = await provisionProviders(
      handle,
      environment(),
      () => "PRIVATE_VALUE",
      capture,
    );
    expect(Object.keys(result)).toEqual(["registry"]);
    expect(captured).toEqual({});
    expect(Object.isFrozen(result)).toBe(true);
  });
  it("should preserve an explicitly selected __proto__ credential through outbound serialization and erase it after acknowledgement", async () => {
    const selected = profile("registry", "__proto__");
    const { handle, capture, owned } = gateway({ selected });
    const { createProvider } = handle.client.raw;
    let captured: Record<string, string> | undefined;
    let boundary: object | undefined;
    const rpc = spyOn(handle.client.raw, "createProvider").mockImplementation(
      (request, options) => {
        captured = request.provider?.credentials;
        const message = create(CreateProviderRequestSchema, request);
        boundary = {
          value: Object.getOwnPropertyDescriptor(captured ?? {}, "__proto__")
            ?.value,
          sdkValue: Object.getOwnPropertyDescriptor(
            message.provider?.credentials ?? {},
            "__proto__",
          )?.value,
          wire: new TextDecoder().decode(
            toBinary(CreateProviderRequestSchema, message),
          ),
          owned: owned.length,
        };
        return createProvider(request, options);
      },
    );
    try {
      await provisionProviders(
        handle,
        PROTOTYPE_CREDENTIAL_ENVIRONMENT,
        () => "PRIVATE_VALUE",
        capture,
      );
      expect(boundary).toEqual({
        value: "PRIVATE_VALUE",
        sdkValue: "PRIVATE_VALUE",
        wire: expect.stringContaining("__proto__"),
        owned: 1,
      });
      expect(boundary).toMatchObject({
        wire: expect.stringContaining("PRIVATE_VALUE"),
      });
      expect(Object.keys(captured ?? {})).toEqual([]);
      expect(Object.hasOwn(captured ?? {}, "__proto__")).toBe(false);
      await owned[0]?.release();
    } finally {
      rpc.mockRestore();
    }
  });
  it("should refuse credential lookup and creation when gateway activity is cancelled", async () => {
    const { handle, calls, capture } = gateway();
    const controller = new AbortController();
    controller.abort();
    Object.assign(handle, { signal: controller.signal });
    const base = environment();
    const credentialReads: string[] = [];
    await expect(
      provisionProviders(
        handle,
        { ...base, profiles: [] },
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
    const failure = provisionProviders(
      handle,
      environment(),
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
      const { handle, capture } = gateway({
        selected: profile("registry", key),
      });
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
      const base = environment();
      const failure = provisionProviders(
        handle,
        {
          ...base,
          providers: [
            {
              name: "registry",
              profile: "registry",
              credentialMode: "explicit",
              credentialsFromEnv: Object.fromEntries([[key, "EXPLICIT_TOKEN"]]),
            },
          ],
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
      provisionProviders(handle, environment(), () => "PRIVATE_VALUE", capture),
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
      provisionProviders(
        handle,
        environment(),
        () => "PRIVATE_VALUE",
        (item) => owned.push(item),
      ),
    ).rejects.toThrow("Explicit provider creation failed");
    expect(owned).toHaveLength(1);
    await expect(owned[0]?.release()).rejects.toThrow("identity is unknown");
    expect(calls).not.toContain("delete");
  });
  it("should await every provider creation before reporting sibling failure and release both inline credential maps", async () => {
    const pending = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const captured: Record<string, string>[] = [];
    const { handle, capture } = gateway({
      lookup: (id) =>
        Promise.resolve(
          create(ProviderProfileResponseSchema, {
            profile: profile(id, id === "other" ? "OTHER" : "TOKEN"),
          }),
        ),
    });
    Object.assign(handle.client.raw, {
      createProvider: async (request: {
        provider: {
          metadata: { name: string };
          credentials: Record<string, string>;
        };
      }) => {
        captured.push(request.provider.credentials);
        if (request.provider.metadata.name.endsWith("-0")) {
          throw new Error("RAW-NATIVE-SECRET");
        }
        secondStarted.resolve();
        await pending.promise;
        return create(ProviderResponseSchema, {
          provider: {
            metadata: {
              name: request.provider.metadata.name,
              id: `native-${request.provider.metadata.name}`,
              workspace: "default",
            },
            type: "other",
          },
        });
      },
    });
    const base = environment();
    const setup = provisionProviders(
      handle,
      {
        ...base,
        profiles: [],
        providers: [...base.providers, OTHER_PROVIDER],
      },
      () => "PRIVATE_VALUE",
      capture,
    );
    let finished = false;
    const observed = setup.finally(() => {
      finished = true;
    });
    try {
      await secondStarted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      pending.resolve();
      await expect(observed).rejects.toThrow(
        "Explicit provider creation failed",
      );
      expect(captured).toEqual([{}, {}]);
    } finally {
      pending.resolve();
      await observed.catch(() => undefined);
    }
  });
  it("should use distinct native provider names across activations sharing a gateway", async () => {
    const { handle, calls } = gateway();
    const owned: OwnedResource[] = [];
    const first = await provisionProviders(
      handle,
      environment(),
      () => "secret",
      (resource) => owned.push(resource),
    );
    const second = await provisionProviders(
      handle,
      environment(),
      () => "secret",
      (resource) => owned.push(resource),
    );
    expect(Object.keys(first)).toEqual(["registry"]);
    const firstName = first["registry"];
    if (!firstName) {
      throw new Error("Missing first native provider mapping.");
    }
    expect(firstName.length).toBeGreaterThan(MAX_SANDBOX_ROUTABLE_NAME_LENGTH);
    expect(firstName.length).toBeLessThanOrEqual(
      MAX_NATIVE_PROVIDER_NAME_LENGTH,
    );
    expect(Object.keys(second)).toEqual(["registry"]);
    expect(second["registry"]).not.toBe(first["registry"]);
    expect(first["registry"]).not.toBe("registry");
    await Promise.all(owned.map((resource) => resource.release()));
    expect(calls.filter((call) => call === "delete")).toHaveLength(2);
    await owned[0]?.release();
    expect(calls.filter((call) => call === "delete")).toHaveLength(2);
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
      provisionProviders(
        handle,
        environment(),
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
    const failure = provisionProviders(
      handle,
      environment(),
      () => "secret",
      (resource) => owned.push(resource),
    );
    await expect(failure).rejects.toThrow("Explicit provider creation failed");
    await expect(failure).rejects.not.toThrow("RAW-NATIVE-SECRET");
    expect(queries).toBe(1);
    await owned[0]?.release();
    expect(calls).toContain("delete");
  });
  it("should release acknowledged siblings but preserve uncertain creations on partial failure", async () => {
    const { handle, calls } = gateway({
      failCreate: (name) => name.endsWith("-1"),
      lookup: (id) =>
        Promise.resolve(
          create(ProviderProfileResponseSchema, {
            profile: profile(id, id === "other" ? "OTHER" : "TOKEN"),
          }),
        ),
    });
    const base = environment();
    const owned: OwnedResource[] = [];
    await expect(
      provisionProviders(
        handle,
        {
          ...base,
          profiles: [],
          providers: [...base.providers, OTHER_PROVIDER],
        },
        () => "secret",
        (resource) => owned.push(resource),
      ),
    ).rejects.toThrow("Explicit provider creation failed");
    expect(owned).toHaveLength(2);
    await owned[0]?.release();
    await expect(owned[1]?.release()).rejects.toThrow("identity is unknown");
    expect(calls.filter((call) => call === "delete")).toHaveLength(1);
  });
  it("should retry failed native deletion without exposing the SDK error or cause", async () => {
    const { handle, owned, capture } = gateway();
    await provisionProviders(handle, environment(), () => "secret", capture);
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
  });
});
