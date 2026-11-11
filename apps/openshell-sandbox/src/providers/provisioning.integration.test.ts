import { describe, expect, test as it, spyOn } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  CreateProviderRequestSchema,
  ProviderProfileResponseSchema,
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups the retained native-boundary contracts.
describe("provisionProviders", () => {
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
});
