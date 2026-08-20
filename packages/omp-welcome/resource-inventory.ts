const SUPPORTED_PI_MINOR = /^0\.84\.\d+(?:[-+].*)?$/;
const PATCH_REGISTRY = Symbol.for("pi-agent.extensions.omp-welcome.resource-inventory-patches");

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
  getQuietStartup(): boolean;
}

interface InteractiveModeLike {
  settingsManager?: QuietStartupManager;
}

type ShowLoadedResources = (this: InteractiveModeLike, options?: ResourceOptions) => unknown;

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
  release(): void;
}

function patchRegistry(): PatchRegistry {
  const existing = Reflect.get(globalThis, PATCH_REGISTRY) as PatchRegistry | undefined;
  if (existing) return existing;
  const created: PatchRegistry = { patches: new WeakMap() };
  Reflect.set(globalThis, PATCH_REGISTRY, created);
  return created;
}

function unsupported(reason: string): ResourceInventoryOverride {
  return { supported: false, reason, release() {} };
}

function acquiredPatch(prototype: object, state: PatchState, registry: PatchRegistry): ResourceInventoryOverride {
  let released = false;
  return {
    supported: true,
    release() {
      if (released) return;
      released = true;
      state.owners--;
      if (state.owners > 0) return;

      if (Reflect.get(prototype, "showLoadedResources") === state.wrapper) {
        Object.defineProperty(prototype, "showLoadedResources", state.descriptor);
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
  constructor: InteractiveModeConstructorLike,
): ResourceInventoryOverride {
  if (!SUPPORTED_PI_MINOR.test(version)) {
    return unsupported(`unsupported pi-coding-agent version ${version}`);
  }

  const prototype = constructor.prototype;
  const registry = patchRegistry();
  const existing = registry.patches.get(prototype);
  if (existing) {
    if (Reflect.get(prototype, "showLoadedResources") !== existing.wrapper) {
      return unsupported("showLoadedResources was replaced by another extension");
    }
    existing.owners++;
    return acquiredPatch(prototype, existing, registry);
  }

  const descriptor = Object.getOwnPropertyDescriptor(prototype, "showLoadedResources");
  if (!descriptor || typeof descriptor.value !== "function") {
    return unsupported("showLoadedResources is unavailable");
  }

  const original = descriptor.value as ShowLoadedResources;
  const source = Function.prototype.toString.call(original);
  if (METHOD_ANCHORS.some(anchor => !source.includes(anchor))) {
    return unsupported("showLoadedResources no longer matches the reviewed Pi 0.84.x implementation");
  }

  const wrapper: ShowLoadedResources = function (options) {
    const manager = this.settingsManager;
    if (!manager || typeof manager.getQuietStartup !== "function") {
      return original.call(this, options);
    }

    const ownDescriptor = Object.getOwnPropertyDescriptor(manager, "getQuietStartup");
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
        Reflect.deleteProperty(manager, "getQuietStartup");
      }
    }
  };

  const state: PatchState = { descriptor, original, wrapper, owners: 1 };
  try {
    Object.defineProperty(prototype, "showLoadedResources", { ...descriptor, value: wrapper });
  } catch {
    return unsupported("showLoadedResources cannot be wrapped");
  }
  registry.patches.set(prototype, state);
  return acquiredPatch(prototype, state, registry);
}
