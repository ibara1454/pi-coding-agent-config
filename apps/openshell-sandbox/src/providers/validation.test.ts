import { describe, expect, test as it } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  type ProviderProfile,
  ProviderProfileSchema,
} from "@nvidia/openshell-sdk/raw";
import type { ProviderConfiguration } from "../configuration/index.ts";
import { validateProvider } from "./validation.ts";

const provider: ProviderConfiguration = {
  name: "work",
  profile: "work-profile",
  credentialMode: "explicit",
  credentialsFromEnv: { ["TOKEN"]: "WORK_TOKEN" },
};

/** Select native credential declarations while keeping validation real. */
function profile(): ProviderProfile {
  return create(ProviderProfileSchema, {
    id: "work-profile",
    credentials: [{ name: "token", envVars: ["TOKEN"], required: true }],
  });
}

/** Fail immediately if a test fixture no longer declares the expected credential. */
function credential(native: ProviderProfile) {
  const [first] = native.credentials;
  if (!first) {
    throw new Error("Missing fixture credential");
  }
  return first;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: This suite groups one operation's cases.
describe("validateProvider", () => {
  it("should freeze selected native keys while omitting unselected optional credentials", () => {
    const native = profile();
    native.credentials.push({
      ...credential(native),
      name: "optional",
      envVars: ["OPTIONAL"],
      required: false,
    });
    const keys = validateProvider(native, provider);
    expect(keys).toEqual(["TOKEN"]);
    expect(Object.isFrozen(keys)).toBe(true);
  });

  it.each([
    ["an absent mapping", {}],
    ["an invalid environment key", { ["BAD-TOKEN"]: "WORK_TOKEN" }],
    ["an invalid host source name", { ["TOKEN"]: "BAD-NAME" }],
  ])(
    "should reject %s before selecting native credentials",
    (_condition, credentialsFromEnv) => {
      expect(() =>
        validateProvider(profile(), { ...provider, credentialsFromEnv }),
      ).toThrow();
    },
  );
  it("should reject undeclared keys rather than using a logical credential name as an alias", () => {
    expect(() =>
      validateProvider(profile(), {
        ...provider,
        credentialsFromEnv: { ["OTHER"]: "WORK_TOKEN" },
      }),
    ).toThrow("not uniquely declared");
  });

  it("should reject a native key declared by more than one credential", () => {
    const native = profile();
    native.credentials.push({ ...credential(native), name: "other" });
    expect(() => validateProvider(native, provider)).toThrow(
      "not uniquely declared",
    );
  });

  it("should reject a missing required mapping or two selected aliases for one credential", () => {
    const native = profile();
    native.credentials.push({
      ...credential(native),
      name: "required-other",
      envVars: ["OTHER"],
    });
    expect(() => validateProvider(native, provider)).toThrow("exactly one");
    native.credentials.pop();
    credential(native).envVars.push("ALIAS");
    expect(() =>
      validateProvider(native, {
        ...provider,
        credentialsFromEnv: {
          ["TOKEN"]: "WORK_TOKEN",
          ["ALIAS"]: "WORK_ALIAS",
        },
      }),
    ).toThrow("exactly one");
  });
});
