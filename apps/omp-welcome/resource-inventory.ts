import { satisfies } from "semver";

const SUPPORTED_PI_RANGE = ">=0.84.0 <0.86.0";
const PATCH_REGISTRY = Symbol.for(
  "pi-agent.extensions.omp-welcome.resource-inventory-patches",
);

const METHOD_ANCHORS = [
  "loadedResourcesContainer.clear",
  "settingsManager.getQuietStartup",
  "showDiagnosticsWhenQuiet",
] as const;

interface ResourceOptions {
  force?: boolean;
  showDiagnosticsWhenQuiet?: boolean;
}

interface QuietStartupManager {
  getQuietStartup?: () => boolean;
}

interface InteractiveModeLike {
  settingsManager?: QuietStartupManager;
}

type ShowLoadedResources = (
  this: InteractiveModeLike,
  options?: ResourceOptions,
) => unknown;

interface InteractiveModeConstructorLike {
  prototype: object;
}

interface PatchState {
  descriptor: PropertyDescriptor;
  original: ShowLoadedResources;
  wrapper: ShowLoadedResources;
  owners: number;
}

interface PatchRegistry {
  patches: WeakMap<object, PatchState>;
}

export interface ResourceInventoryOverride {
  supported: boolean;
  reason?: string;
  release: () => void;
}

function patchRegistry(): PatchRegistry {
  const globalScope = globalThis as Record<PropertyKey, unknown>;
  const existing = globalScope[PATCH_REGISTRY] as PatchRegistry | undefined;
  if (existing) {
    return existing;
  }
  const created: PatchRegistry = { patches: new WeakMap() };
  globalScope[PATCH_REGISTRY] = created;
  return created;
}

function unsupported(reason: string): ResourceInventoryOverride {
  return {
    supported: false,
    reason,
    release() {
      // Unsupported hosts acquire no resources.
    },
  };
}

function acquiredPatch(
  prototype: object,
  state: PatchState,
  registry: PatchRegistry,
): ResourceInventoryOverride {
  let released = false;
  return {
    supported: true,
    release() {
      if (released) {
        return;
      }
      released = true;
      state.owners--;
      if (state.owners > 0) {
        return;
      }

      if (
        Object.getOwnPropertyDescriptor(prototype, "showLoadedResources")
          ?.value === state.wrapper
      ) {
        Object.defineProperty(
          prototype,
          "showLoadedResources",
          state.descriptor,
        );
      }
      registry.patches.delete(prototype);
    },
  };
}

/**
 * Suppress Pi's routine startup resource inventory while retaining its native
 * diagnostic renderer. This intentionally guards and wraps a private Pi seam;
 * any unreviewed host change fails open.
 */
export function installResourceInventoryOverride(
  version: string,
  interactiveMode: InteractiveModeConstructorLike,
): ResourceInventoryOverride {
  if (!satisfies(version, SUPPORTED_PI_RANGE)) {
    return unsupported(
      `unsupported pi-coding-agent version ${version}; supported range ${SUPPORTED_PI_RANGE}`,
    );
  }

  const { prototype } = interactiveMode;
  const registry = patchRegistry();
  const existing = registry.patches.get(prototype);
  if (existing) {
    if (
      Object.getOwnPropertyDescriptor(prototype, "showLoadedResources")
        ?.value !== existing.wrapper
    ) {
      return unsupported(
        "showLoadedResources was replaced by another extension",
      );
    }
    existing.owners++;
    return acquiredPatch(prototype, existing, registry);
  }

  const descriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "showLoadedResources",
  );
  if (!descriptor || typeof descriptor.value !== "function") {
    return unsupported("showLoadedResources is unavailable");
  }

  const original = descriptor.value as ShowLoadedResources;
  const source = Function.prototype.toString.call(original);
  if (METHOD_ANCHORS.some((anchor) => !source.includes(anchor))) {
    return unsupported(
      "showLoadedResources no longer matches the reviewed implementation",
    );
  }

  const wrapper: ShowLoadedResources = function (options) {
    const manager = this.settingsManager;
    if (!manager || typeof manager.getQuietStartup !== "function") {
      return original.call(this, options);
    }

    const ownDescriptor = Object.getOwnPropertyDescriptor(
      manager,
      "getQuietStartup",
    );
    try {
      Object.defineProperty(manager, "getQuietStartup", {
        configurable: true,
        value: () => true,
      });
    } catch {
      return original.call(this, options);
    }

    try {
      return original.call(this, options);
    } finally {
      if (ownDescriptor) {
        Object.defineProperty(manager, "getQuietStartup", ownDescriptor);
      } else {
        // biome-ignore lint/performance/noDelete: Assigning undefined would shadow the inherited method, and repository policy prohibits Reflect.
        delete manager.getQuietStartup;
      }
    }
  };

  const state: PatchState = { descriptor, original, wrapper, owners: 1 };
  try {
    Object.defineProperty(prototype, "showLoadedResources", {
      ...descriptor,
      value: wrapper,
    });
  } catch {
    return unsupported("showLoadedResources cannot be wrapped");
  }
  registry.patches.set(prototype, state);
  return acquiredPatch(prototype, state, registry);
}
