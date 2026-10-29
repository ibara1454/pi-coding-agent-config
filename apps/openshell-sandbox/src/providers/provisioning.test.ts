import { describe, expect, test as it, spyOn } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  ImportProviderProfilesResponseSchema,
  type ProviderProfileResponse,
  ProviderProfileResponseSchema,
} from "@nvidia/openshell-sdk/raw";
import { provisionProviders } from "./provisioning.ts";
import { environment, gateway, profile } from "./test/provisioning.helper.ts";

const NATIVE_PROVIDER_NAME = /^po-[a-zA-Z0-9-]+-0$/;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("provisionProviders", () => {
  it("should provision only explicit credentials and return frozen configured-to-native names", async () => {
    const { handle, capture } = gateway();
    const accessed: string[] = [];
    const result = await provisionProviders(
      handle,
      environment(),
      (name) => {
        accessed.push(name);
        return "RAW-SECRET";
      },
      capture,
    );
    expect(accessed).toEqual(["EXPLICIT_TOKEN"]);
    expect(Object.keys(result)).toEqual(["registry"]);
    expect(result["registry"]).toMatch(NATIVE_PROVIDER_NAME);
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("RAW-SECRET");
  });

  it("should refuse credentials when native profile import is rejected", async () => {
    const { handle, calls, capture } = gateway({ imported: false });
    let lookedUp = false;
    await expect(
      provisionProviders(
        handle,
        environment(),
        () => {
          lookedUp = true;
          return "secret";
        },
        capture,
      ),
    ).rejects.toThrow("profile validation or import failed");
    expect(lookedUp).toBe(false);
    expect(calls).not.toContain("create");
  });
  it("should reject undeclared environment keys before reading credentials", async () => {
    const selected = profile();
    selected.credentials = selected.credentials.map((credential) => ({
      ...credential,
      envVars: ["OTHER_TOKEN"],
    }));
    const { handle, capture } = gateway({ selected });
    let lookedUp = false;
    await expect(
      provisionProviders(
        handle,
        environment(),
        () => {
          lookedUp = true;
          return "secret";
        },
        capture,
      ),
    ).rejects.toThrow();
    expect(lookedUp).toBe(false);
  });
  it("should expose failure without native payload or missing-credential fallback", async () => {
    const failing = gateway({ failCreate: () => true });
    const failure = provisionProviders(
      failing.handle,
      environment(),
      () => "RAW-SECRET-IN-NATIVE-ERROR",
      failing.capture,
    );
    await expect(failure).rejects.toThrow();
    await expect(failure).rejects.not.toThrow("RAW-SECRET");
    const missing = gateway();
    await expect(
      provisionProviders(
        missing.handle,
        environment(),
        () => undefined,
        missing.capture,
      ),
    ).rejects.toThrow();
    expect(missing.calls).not.toContain("create");
  });
  it("should await every profile lookup before reporting a sibling rejection", async () => {
    const pending = Promise.withResolvers<ProviderProfileResponse>();
    const secondStarted = Promise.withResolvers<void>();
    const { handle, calls, capture } = gateway({
      lookup: (id) => {
        if (id === "registry") {
          return Promise.reject(new Error("RAW-SECRET-IN-NATIVE-ERROR"));
        }
        secondStarted.resolve();
        return pending.promise;
      },
    });
    const base = environment();
    const setup = provisionProviders(
      handle,
      {
        ...base,
        profiles: [],
        providers: [
          ...base.providers,
          {
            name: "second",
            profile: "second",
            credentialMode: "explicit",
            credentialsFromEnv: { ["SECOND_TOKEN"]: "SECOND" },
          },
        ],
      },
      () => {
        throw new Error("credential lookup before all profiles settled");
      },
      capture,
    );
    let finished = false;
    const observed = setup.finally(() => {
      finished = true;
    });
    await secondStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    pending.resolve(
      create(ProviderProfileResponseSchema, {
        profile: profile("second", "SECOND_TOKEN"),
      }),
    );
    await expect(observed).rejects.toThrow();
    await expect(observed).rejects.not.toThrow("RAW-SECRET");
    expect(calls).not.toContain("create");
  });
  it("should preserve profile sources and bounded workspace options in a single import", async () => {
    const { handle, capture } = gateway();
    const selected = profile();
    const extra = profile("extra", "EXTRA_TOKEN");
    const configured = {
      ...environment(),
      profiles: [
        { sourcePath: "/profiles/selected.yaml", sdkProfiles: [selected] },
        { sourcePath: "/profiles/extra.yaml", sdkProfiles: [extra] },
      ],
    };
    const imported = spyOn(
      handle.client.raw,
      "importProviderProfiles",
    ).mockResolvedValue(
      create(ImportProviderProfilesResponseSchema, {
        imported: true,
        profiles: [selected, extra],
      }),
    );
    try {
      const result = await provisionProviders(
        handle,
        configured,
        () => "explicit-secret",
        capture,
      );
      const request = {
        profiles: [
          { profile: selected, source: "/profiles/selected.yaml" },
          { profile: extra, source: "/profiles/extra.yaml" },
        ],
        workspace: "default",
      };
      const options = { signal: handle.signal, timeoutMs: 30_000 };
      expect(imported).toHaveBeenCalledWith(request, options);
      expect(Object.keys(result)).toEqual(["registry"]);
    } finally {
      imported.mockRestore();
    }
  });
  it.each([
    ["missing imported identity", []],
    ["unexpected imported identity", [profile("other")]],
    ["duplicate imported identity", [profile(), profile()]],
  ])(
    "should reject %s before looking up any credentials",
    async (_condition, imported) => {
      const { handle, calls, capture } = gateway();
      Object.assign(handle.client.raw, {
        importProviderProfiles: () => {
          calls.push("import");
          return Promise.resolve(
            create(ImportProviderProfilesResponseSchema, {
              imported: true,
              profiles: imported,
            }),
          );
        },
      });
      let credentialReads = 0;
      await expect(
        provisionProviders(
          handle,
          environment(),
          () => {
            credentialReads += 1;
            return "secret";
          },
          capture,
        ),
      ).rejects.toThrow("profile validation or import failed");
      expect(credentialReads).toBe(0);
      expect(calls).not.toContain("create");
    },
  );

  it("should avoid native profile import when no custom profiles were selected", async () => {
    const { handle, calls, capture } = gateway();
    const base = environment();
    const result = await provisionProviders(
      handle,
      { ...base, profiles: [] },
      () => "secret",
      capture,
    );
    expect(Object.keys(result)).toEqual(["registry"]);
    expect(result["registry"]).toMatch(NATIVE_PROVIDER_NAME);
    expect(calls).toEqual(["create", "get"]);
  });
  it("should return empty selections without native calls when no profiles or providers are selected", async () => {
    const { handle, calls, capture } = gateway();
    const base = environment();
    const result = await provisionProviders(
      handle,
      {
        ...base,
        providers: [],
        profiles: [],
      },
      () => {
        throw new Error("unexpected credential access");
      },
      capture,
    );
    expect(result).toEqual({});
    expect(Object.isFrozen(result)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("should sanitize native import rejection before credential access", async () => {
    const { handle, calls, capture } = gateway();
    Object.assign(handle.client.raw, {
      importProviderProfiles: () =>
        Promise.reject(new Error("RAW-NATIVE-SECRET")),
    });
    let credentialReads = 0;
    await expect(
      provisionProviders(
        handle,
        environment(),
        () => {
          credentialReads += 1;
          return "secret";
        },
        capture,
      ),
    ).rejects.toThrow("profile validation or import failed");
    expect(credentialReads).toBe(0);
    expect(calls).not.toContain("create");
  });
  it("should reject a native profile identity mismatch before reading credentials", async () => {
    const { handle, calls, capture } = gateway({ selected: profile("other") });
    await expect(
      provisionProviders(
        handle,
        environment(),
        () => {
          throw new Error("unexpected credential access");
        },
        capture,
      ),
    ).rejects.toThrow(
      "Unable to validate the selected native provider profiles",
    );
    expect(calls).not.toContain("create");
  });

  it("should reject a missing native profile response without exposing its original failure", async () => {
    const { handle, calls, capture } = gateway({
      lookup: () => Promise.reject(new Error("RAW-NATIVE-SECRET")),
    });
    const failure = provisionProviders(
      handle,
      environment(),
      () => {
        throw new Error("unexpected credential access");
      },
      capture,
    );
    await expect(failure).rejects.toThrow(
      "Unable to validate the selected native provider profiles",
    );
    await expect(failure).rejects.not.toThrow("RAW-NATIVE-SECRET");
    expect(calls).not.toContain("create");
  });
  it("should reject duplicate workload keys across distinct selected providers before reading credentials", async () => {
    const { handle, calls, capture } = gateway({
      lookup: (id) =>
        Promise.resolve(
          create(ProviderProfileResponseSchema, {
            profile: profile(id),
          }),
        ),
    });
    const base = environment();
    await expect(
      provisionProviders(
        handle,
        {
          ...base,
          profiles: [],
          providers: [
            ...base.providers,
            ...base.providers.map((entry) => ({
              ...entry,
              name: "other",
            })),
          ],
        },
        () => {
          throw new Error("unexpected credential access");
        },
        capture,
      ),
    ).rejects.toThrow("environment keys must be unique");
    expect(calls).toEqual([]);
  });
});
