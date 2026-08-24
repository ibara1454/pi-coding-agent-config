import { describe, expect, test } from "bun:test";
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
      const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
      const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
      calls.push({ showListing: Boolean(showListing), showDiagnostics });
    }

    loadedResourcesContainer = { clear() {} };
    options = { verbose: false };
  }

  return { InteractiveMode, calls, manager };
}

describe("native resource inventory override", () => {
  test("suppresses routine startup and reload inventory but preserves diagnostics", () => {
    const { InteractiveMode, calls, manager } = host();
    const original = InteractiveMode.prototype.showLoadedResources;
    const override = installResourceInventoryOverride("0.84.9", InteractiveMode);
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

  test("retains explicit forced and verbose listings", () => {
    const forced = host();
    const forcedOverride = installResourceInventoryOverride("0.84.1", forced.InteractiveMode);
    new forced.InteractiveMode().showLoadedResources({ force: true, showDiagnosticsWhenQuiet: true });
    expect(forced.calls).toEqual([{ showListing: true, showDiagnostics: true }]);
    forcedOverride.release();

    const verbose = host();
    const mode = new verbose.InteractiveMode();
    mode.options.verbose = true;
    const verboseOverride = installResourceInventoryOverride("0.84.1", verbose.InteractiveMode);
    mode.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
    expect(verbose.calls).toEqual([{ showListing: true, showDiagnostics: true }]);
    verboseOverride.release();
  });

  test("is reference-counted across extension reloads", () => {
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
    new InteractiveMode().showLoadedResources({ showDiagnosticsWhenQuiet: true });
    expect(calls.at(-1)).toEqual({ showListing: false, showDiagnostics: true });

    second.release();
    expect(InteractiveMode.prototype.showLoadedResources).toBe(original);
  });

  test("fails open for unsupported versions and changed method structure", () => {
    const unsupportedVersion = host();
    const original = unsupportedVersion.InteractiveMode.prototype.showLoadedResources;
    const versionResult = installResourceInventoryOverride("0.85.0", unsupportedVersion.InteractiveMode);
    expect(versionResult.supported).toBe(false);
    expect(unsupportedVersion.InteractiveMode.prototype.showLoadedResources).toBe(original);

    class ChangedHost {
      showLoadedResources() {}
    }
    const structureResult = installResourceInventoryOverride("0.84.1", ChangedHost);
    expect(structureResult.supported).toBe(false);
    expect(structureResult.reason).toContain("no longer matches");
  });

  test("fails open when the settings-manager seam is unavailable", () => {
    const calls: HostOptions[] = [];
    class MissingManager {
      showLoadedResources(options?: HostOptions) {
        this.loadedResourcesContainer.clear();
        const quiet = this.settingsManager.getQuietStartup();
        if (options?.showDiagnosticsWhenQuiet === true || !quiet) calls.push(options ?? {});
      }
      loadedResourcesContainer = { clear() {} };
      // Declaration-only by design: this fixture exercises an unavailable runtime settings-manager seam.
      declare settingsManager: { getQuietStartup(): boolean };
    }

    const override = installResourceInventoryOverride("0.84.1", MissingManager);
    expect(override.supported).toBe(true);
    expect(() => new MissingManager().showLoadedResources({ showDiagnosticsWhenQuiet: true })).toThrow();
    override.release();
  });
});
