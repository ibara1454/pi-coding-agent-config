import { describe, expect, test as it } from "bun:test";
import {
  array,
  freeze,
  invalid,
  object,
  SandboxConfigurationError,
  text,
} from "./values.ts";

describe("SandboxConfigurationError.constructor", () => {
  it("should retain safe guidance and an explicit failure code when constructed with one", () => {
    const error = new SandboxConfigurationError(
      "safe field",
      "configuration-read-failed",
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "SandboxConfigurationError",
      message: "safe field",
      safeMessage: "safe field",
      code: "configuration-read-failed",
    });
  });

  it("should identify invalid configuration when no failure code is supplied", () => {
    expect(new SandboxConfigurationError("safe field").code).toBe(
      "configuration-invalid",
    );
  });
});

describe("invalid", () => {
  it("should report only the offending field when rejecting configuration", () => {
    expect(() => invalid("providers.credentialsFromEnv")).toThrow(
      "Invalid OpenShell configuration at providers.credentialsFromEnv",
    );
  });
});

describe("object", () => {
  it("should retain a permitted mapping when its keys are allowed", () => {
    const source = { image: "dev" };
    expect(object(source, "settings", ["image"])).toBe(source);
  });

  it.each([
    // biome-ignore lint/plugin/biome-rules/use-undefined: Explicit JSON null is invalid where a configuration mapping is required.
    ["null", null],
    ["an array", []],
    ["a primitive", "image"],
  ])("should reject %s when a mapping is required", (_condition, value) => {
    expect(() => object(value, "settings")).toThrow(
      "Invalid OpenShell configuration at settings",
    );
  });

  it("should reject unknown keys when an allowlist is supplied", () => {
    expect(() =>
      object({ image: "dev", enabled: false }, "settings", ["image"]),
    ).toThrow("Invalid OpenShell configuration at settings");
  });
});

describe("text", () => {
  it("should preserve ordinary configuration text when it is valid", () => {
    expect(text("work-provider", "providers.name")).toBe("work-provider");
  });

  it.each([
    ["an empty string", ""],
    ["a boolean", true],
    ["a newline", "secret\nnext"],
    ["a terminal escape", "secret\u001b[31m"],
  ])("should reject %s when validating text", (_condition, value) => {
    expect(() => text(value, "providers.name")).toThrow(
      "Invalid OpenShell configuration at providers.name",
    );
  });
});

describe("array", () => {
  it("should preserve an explicit empty array when it overrides inherited values", () => {
    const value: unknown[] = [];
    expect(array(value, "providers")).toBe(value);
  });

  it.each([
    // biome-ignore lint/plugin/biome-rules/use-undefined: Explicit JSON null is invalid where a configuration array is required.
    ["null", null],
    ["an object", {}],
    ["a string", ""],
  ])("should reject %s when an array is required", (_condition, value) => {
    expect(() => array(value, "providers")).toThrow(
      "Invalid OpenShell configuration at providers",
    );
  });
});

describe("freeze", () => {
  it("should prevent nested mutations while preserving the source graph", () => {
    const credentials = { ["TOKEN"]: "SOURCE" };
    const source = {
      providers: [{ credentialsFromEnv: credentials }],
    };
    const result = freeze(source);
    expect(result).toBe(source);
    expect(Object.isFrozen(result.providers)).toBe(true);
    expect(Object.isFrozen(credentials)).toBe(true);
    expect(() => {
      credentials.TOKEN = "OTHER";
    }).toThrow();
    expect(credentials.TOKEN).toBe("SOURCE");
  });

  it("should retain primitive values and previously frozen objects", () => {
    const source = Object.freeze({ enabled: true });
    expect(freeze(source)).toBe(source);
    expect(freeze("value")).toBe("value");
    // biome-ignore lint/plugin/biome-rules/use-undefined: Freezing a configuration graph must preserve explicit JSON null leaves.
    expect(freeze(null)).toBeNull();
  });
});
