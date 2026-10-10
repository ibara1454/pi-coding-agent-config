import { describe, expect, mock, test } from "bun:test";
import { installResourceInventoryOverride } from "./resource-inventory.ts";

interface HostOptions {
  force?: boolean;
  showDiagnosticsWhenQuiet?: boolean;
}

function host() {
  const manager = {
    quiet: false,
    getQuietStartup() {
      return this.quiet;
    },
  };
  const calls: Array<{ showListing: boolean; showDiagnostics: boolean }> = [];

  class InteractiveMode {
    settingsManager = manager;

    showLoadedResources(options?: HostOptions) {
      this.loadedResourcesContainer.clear();
      const showListing =
        options?.force ||
        this.options.verbose ||
        !this.settingsManager.getQuietStartup();
      const showDiagnostics =
        showListing || options?.showDiagnosticsWhenQuiet === true;
      calls.push({ showListing: Boolean(showListing), showDiagnostics });
    }

    loadedResourcesContainer = {
      clear() {
        // The fixture has no rendered inventory to clear.
      },
    };
    options = { verbose: false };
  }

  return {
    // biome-ignore lint/style/useNamingConvention: fixture constructor mirrors host identity
    InteractiveMode,
    calls,
    manager,
  };
}

describe("installResourceInventoryOverride", () => {
  test("should suppress routine startup and reload inventory but preserve diagnostics", () => {
    const { InteractiveMode, calls, manager } = host();
    const original = InteractiveMode.prototype.showLoadedResources;
    const override = installResourceInventoryOverride(
      "0.85.1",
      InteractiveMode,
    );
    const mode = new InteractiveMode();

    expect(override.supported).toBe(true);
    mode.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
    mode.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });

    expect(calls).toEqual([
      { showListing: false, showDiagnostics: true },
      { showListing: false, showDiagnostics: true },
    ]);
    expect(manager.getQuietStartup()).toBe(false);

    override.release();
    expect(InteractiveMode.prototype.showLoadedResources).toBe(original);
    mode.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
    expect(calls.at(-1)).toEqual({ showListing: true, showDiagnostics: true });
  });

  test("should retain explicit forced and verbose listings", () => {
    const forced = host();
    const forcedOverride = installResourceInventoryOverride(
      "0.84.1",
      forced.InteractiveMode,
    );
    new forced.InteractiveMode().showLoadedResources({
      force: true,
      showDiagnosticsWhenQuiet: true,
    });
    expect(forced.calls).toEqual([
      { showListing: true, showDiagnostics: true },
    ]);
    forcedOverride.release();

    const verbose = host();
    const mode = new verbose.InteractiveMode();
    mode.options.verbose = true;
    const verboseOverride = installResourceInventoryOverride(
      "0.84.1",
      verbose.InteractiveMode,
    );
    mode.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
    expect(verbose.calls).toEqual([
      { showListing: true, showDiagnostics: true },
    ]);
    verboseOverride.release();
  });

  test("should be reference-counted across extension reloads", () => {
    const { InteractiveMode, calls } = host();
    const original = InteractiveMode.prototype.showLoadedResources;
    const first = installResourceInventoryOverride("0.84.1", InteractiveMode);
    const wrapper = InteractiveMode.prototype.showLoadedResources;
    const second = installResourceInventoryOverride("0.84.2", InteractiveMode);

    expect(first.supported).toBe(true);
    expect(second.supported).toBe(true);
    expect(InteractiveMode.prototype.showLoadedResources).toBe(wrapper);

    first.release();
    expect(InteractiveMode.prototype.showLoadedResources).toBe(wrapper);
    new InteractiveMode().showLoadedResources({
      showDiagnosticsWhenQuiet: true,
    });
    expect(calls.at(-1)).toEqual({ showListing: false, showDiagnostics: true });

    second.release();
    expect(InteractiveMode.prototype.showLoadedResources).toBe(original);
  });

  test("should fail open for unsupported versions and changed method structure", () => {
    const unsupportedVersion = host();
    const original =
      unsupportedVersion.InteractiveMode.prototype.showLoadedResources;
    const versionResult = installResourceInventoryOverride(
      "0.86.0",
      unsupportedVersion.InteractiveMode,
    );
    expect(versionResult.supported).toBe(false);
    expect(
      unsupportedVersion.InteractiveMode.prototype.showLoadedResources,
    ).toBe(original);

    class ChangedHost {
      showLoadedResources() {
        // Deliberately lacks the reviewed private-host method anchors.
      }
    }
    const structureResult = installResourceInventoryOverride(
      "0.84.1",
      ChangedHost,
    );
    expect(structureResult.supported).toBe(false);
    expect(structureResult.reason).toContain("no longer matches");
  });

  test("should fail open when the settings-manager seam is unavailable", () => {
    const calls: HostOptions[] = [];
    class MissingManager {
      showLoadedResources(options?: HostOptions) {
        this.loadedResourcesContainer.clear();
        const quiet = this.settingsManager.getQuietStartup();
        if (options?.showDiagnosticsWhenQuiet === true || !quiet) {
          calls.push(options ?? {});
        }
      }
      loadedResourcesContainer = {
        clear() {
          // The fixture has no rendered inventory to clear.
        },
      };
      // Declaration-only by design: this fixture exercises an unavailable runtime settings-manager seam.
      declare settingsManager: { getQuietStartup: () => boolean };
    }

    const override = installResourceInventoryOverride("0.84.1", MissingManager);
    expect(override.supported).toBe(true);
    expect(() =>
      new MissingManager().showLoadedResources({
        showDiagnosticsWhenQuiet: true,
      }),
    ).toThrow();
    override.release();
  });

  test("should retain a replacement method when a patch owner releases after another extension changes the host", () => {
    const { InteractiveMode } = host();
    const override = installResourceInventoryOverride(
      "0.85.1",
      InteractiveMode,
    );
    const replacement = mock();
    InteractiveMode.prototype.showLoadedResources = replacement;
    const rejected = installResourceInventoryOverride(
      "0.85.1",
      InteractiveMode,
    );

    expect(rejected.supported).toBe(false);
    expect(rejected.reason).toContain("replaced by another extension");
    rejected.release();
    override.release();
    override.release();
    new InteractiveMode().showLoadedResources();
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["missing", {}],
    ["not callable", { showLoadedResources: true }],
  ])(
    "should fail open when the resource method is %s",
    (_condition, prototype) => {
      const override = installResourceInventoryOverride("0.85.1", {
        prototype,
      });
      expect(override.supported).toBe(false);
      expect(override.reason).toBe("showLoadedResources is unavailable");
      override.release();
    },
  );

  test("should keep native listing behavior when the quiet setting cannot be temporarily replaced", () => {
    const { InteractiveMode, manager, calls } = host();
    const descriptor = Object.getOwnPropertyDescriptor(
      manager,
      "getQuietStartup",
    );
    Object.defineProperty(manager, "getQuietStartup", {
      ...descriptor,
      configurable: false,
    });
    const override = installResourceInventoryOverride(
      "0.85.1",
      InteractiveMode,
    );
    try {
      new InteractiveMode().showLoadedResources({
        showDiagnosticsWhenQuiet: true,
      });
      expect(calls).toEqual([{ showListing: true, showDiagnostics: true }]);
      expect(manager.getQuietStartup()).toBe(false);
    } finally {
      override.release();
    }
  });

  test("should restore the quiet-setting descriptor when the native renderer throws", () => {
    const { InteractiveMode, manager } = host();
    const descriptor = Object.getOwnPropertyDescriptor(
      manager,
      "getQuietStartup",
    );
    const override = installResourceInventoryOverride(
      "0.85.1",
      InteractiveMode,
    );
    const mode = new InteractiveMode();
    mode.loadedResourcesContainer.clear = () => {
      throw new Error("render failed");
    };
    try {
      expect(() => mode.showLoadedResources()).toThrow("render failed");
      expect(
        Object.getOwnPropertyDescriptor(manager, "getQuietStartup"),
      ).toEqual(descriptor);
    } finally {
      override.release();
    }
  });

  test("should leave the original method callable when its descriptor cannot be wrapped", () => {
    const { InteractiveMode, calls } = host();
    Object.defineProperty(InteractiveMode.prototype, "showLoadedResources", {
      configurable: false,
      writable: false,
    });
    const override = installResourceInventoryOverride(
      "0.85.1",
      InteractiveMode,
    );
    expect(override.supported).toBe(false);
    expect(override.reason).toBe("showLoadedResources cannot be wrapped");
    new InteractiveMode().showLoadedResources();
    expect(calls).toEqual([{ showListing: true, showDiagnostics: true }]);
    override.release();
  });

  test("should remove the temporary quiet setting when the manager inherits its method", () => {
    const { InteractiveMode, manager, calls } = host();
    const inheritedManager = Object.create(manager) as typeof manager;
    const mode = new InteractiveMode();
    mode.settingsManager = inheritedManager;
    const override = installResourceInventoryOverride(
      "0.85.1",
      InteractiveMode,
    );
    try {
      mode.showLoadedResources({ showDiagnosticsWhenQuiet: true });
      expect(calls).toEqual([{ showListing: false, showDiagnostics: true }]);
      expect(Object.hasOwn(inheritedManager, "getQuietStartup")).toBe(false);
      expect(inheritedManager.getQuietStartup()).toBe(false);
    } finally {
      override.release();
    }
  });
});
