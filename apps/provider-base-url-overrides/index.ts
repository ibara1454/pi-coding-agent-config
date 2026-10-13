import { warn } from "node:console";
import process from "node:process";
import type {
  AnyModel,
  Api,
  Model,
  Provider,
  ProviderRequestOptions,
} from "@earendil-works/pi-ai";
import { isModelType } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRegistry,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

// biome-ignore lint/suspicious/noControlCharactersInRegex: Provider URLs must reject ASCII control bytes.
const ASCII_CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/u;
const HTTP_URL_PREFIX = /^https?:\/\/[^/?#]+(?:\/|$)/iu;
const TRAILING_SLASHES = /\/+$/u;
const AZURE_API = "azure-openai-responses";
const WARNING_PREFIX = "[provider-base-url-overrides]";
const PROVIDER_INSTALL_WARNING =
  "Skipping a provider override because registration failed.";

type TransportOptions = ProviderRequestOptions & {
  azureBaseUrl?: string;
};

interface ProviderRoutes {
  root: string;
  openAi: string;
  googleGenerative: string;
}

// ponytail: use optional spreads; keep getter reads single and ordered.
type NonNullRecord<T extends Record<string, unknown>> = {
  [K in keyof T as K extends string ? K : never]?: NonNullable<T[K]>;
};

interface ProviderOverrideApi {
  on: (
    event: "session_start",
    handler: (
      event: SessionStartEvent,
      context: {
        modelRegistry: Pick<ModelRegistry, "getAll" | "getProvider">;
        ui: Pick<ExtensionContext["ui"], "notify">;
      },
    ) => void,
  ) => () => void;
  registerProvider: (provider: Provider) => void;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function toNonNullRecord<T extends Record<string, unknown>>(
  record: T,
): NonNullRecord<T> {
  // entries/fromEntries lose the per-key value types. The assertion restores
  // them: retained values are unchanged, and the filter removes nullish values.
  return Object.fromEntries(
    Object.entries(record).filter(
      ([, value]) => value !== null && value !== undefined,
    ),
  ) as NonNullRecord<T>;
}

function readProviderBaseUrl(): string | undefined {
  const { PROVIDER_BASE_URL } = process.env;
  const value = PROVIDER_BASE_URL?.trim();
  if (!value) {
    return undefined;
  }

  if (!isValidProviderBaseUrl(value)) {
    warn(
      `${WARNING_PREFIX} Ignoring invalid PROVIDER_BASE_URL; expected an absolute HTTP(S) URL without control characters, query, or fragment.`,
    );
    return undefined;
  }

  return value;
}

function isValidProviderBaseUrl(value: string): boolean {
  if (ASCII_CONTROL_CHARACTER.test(value)) {
    return false;
  }
  if (!HTTP_URL_PREFIX.test(value)) {
    return false;
  }
  if (value.includes("?") || value.includes("#")) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * Builds API-specific routes while preserving the root for unmodified APIs.
 * @example createProviderRoutes("https://proxy.test/").openAi // "https://proxy.test/v1"
 */
function createProviderRoutes(root: string): ProviderRoutes {
  const suffixRoot = root.replace(TRAILING_SLASHES, "");
  return {
    root,
    openAi: `${suffixRoot}/v1`,
    googleGenerative: `${suffixRoot}/v1beta`,
  };
}

function routedBaseUrl(
  model: Pick<Model<Api>, "api" | "baseUrl">,
  routes: ProviderRoutes,
): string {
  switch (model.api) {
    case "anthropic-messages":
      return routes.root;
    case "google-generative-ai":
      return routes.googleGenerative;
    case "google-vertex":
      return routes.root;
    case "openai-completions":
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return routes.openAi;
    default:
      return model.baseUrl;
  }
}

function routeModel<ApiType extends Api>(
  model: Model<ApiType>,
  routes: ProviderRoutes,
): Model<ApiType> {
  const snapshot = { ...model };
  snapshot.baseUrl = routedBaseUrl(snapshot, routes);
  return snapshot;
}

function routeModels<ApiType extends Api>(
  models: readonly Model<ApiType>[],
  routes: ProviderRoutes,
): Model<ApiType>[] {
  const routedModels: Model<ApiType>[] = [];
  for (const model of models) {
    routedModels.push(routeModel(model, routes));
  }
  return routedModels;
}

/**
 * Route chat entries in a mixed provider catalog; other operations retain their endpoints.
 * @example routeAllModels([chatModel, imageModel], routes)[1] === imageModel // true
 */
function routeAllModels(
  models: readonly AnyModel[],
  routes: ProviderRoutes,
): readonly AnyModel[] {
  return models.map((model) =>
    isModelType(model, "chat") ? routeModel(model, routes) : model,
  );
}

function routeTransportOptions<OptionsType extends ProviderRequestOptions>(
  api: Api,
  routedModelBaseUrl: string,
  options: OptionsType | undefined,
): OptionsType | undefined;

function routeTransportOptions(
  api: Api,
  routedModelBaseUrl: string,
  options: ProviderRequestOptions | undefined,
): TransportOptions | undefined {
  if (api !== AZURE_API) {
    return options;
  }

  const optionsSnapshot: ProviderRequestOptions = { ...options };
  return {
    ...optionsSnapshot,
    azureBaseUrl: routedModelBaseUrl,
    env: {
      ...optionsSnapshot.env,
      // biome-ignore lint/style/useNamingConvention: preserve Azure OpenAI environment variable key
      AZURE_OPENAI_BASE_URL: routedModelBaseUrl,
    },
  };
}

function routeRequest<
  ApiType extends Api,
  OptionsType extends ProviderRequestOptions,
>(
  model: Model<ApiType>,
  routes: ProviderRoutes,
  options: OptionsType | undefined,
): { model: Model<ApiType>; options: OptionsType | undefined } {
  const routedModel = routeModel(model, routes);
  return {
    model: routedModel,
    options: routeTransportOptions(
      routedModel.api,
      routedModel.baseUrl,
      options,
    ),
  };
}

/**
 * Preserve provider capabilities and receivers while routing only supported chat APIs.
 * The wrapper owns no resources; original method failures propagate unchanged.
 * @example wrapProvider(provider, routes).getModels()[0]?.baseUrl // routed chat URL
 */
function wrapProvider(
  provider: Provider<Api>,
  routes: ProviderRoutes,
): Provider {
  const providerGetModels = provider.getModels;
  const providerStream = provider.stream;
  const providerStreamSimple = provider.streamSimple;

  const stream: Provider["stream"] = (model, context, options) => {
    const request = routeRequest(model, routes, options);
    return providerStream.call(
      provider,
      request.model,
      context,
      request.options,
    );
  };
  const streamSimple: Provider["streamSimple"] = (model, context, options) => {
    const request = routeRequest(model, routes, options);
    return providerStreamSimple.call(
      provider,
      request.model,
      context,
      request.options,
    );
  };

  const { refreshModels } = provider;
  const wrappedRefreshModels: Provider["refreshModels"] = refreshModels
    ? (context) => refreshModels.call(provider, context)
    : undefined;

  const { filterModels } = provider;
  const wrappedFilterModels: Provider["filterModels"] = filterModels
    ? (models, credential) => {
        const routedModels = routeModels(models, routes);
        const filteredModels = filterModels.call(
          provider,
          routedModels,
          credential,
        );
        return routeModels(filteredModels, routes);
      }
    : undefined;

  const { fetchDeferred } = provider;
  const wrappedFetchDeferred: Provider["fetchDeferred"] = fetchDeferred
    ? (model, handle, options) => {
        const request = routeRequest(model, routes, options);
        return fetchDeferred.call(
          provider,
          request.model,
          handle,
          request.options,
        );
      }
    : undefined;

  const { cancelDeferred } = provider;
  const wrappedCancelDeferred: Provider["cancelDeferred"] = cancelDeferred
    ? (model, handle, options) => {
        const request = routeRequest(model, routes, options);
        return cancelDeferred.call(
          provider,
          request.model,
          handle,
          request.options,
        );
      }
    : undefined;

  const { getAllModels, filterAllModels, generateImages, classify } = provider;
  const wrappedGetAllModels: Provider["getAllModels"] = getAllModels
    ? () => routeAllModels(getAllModels.call(provider), routes)
    : undefined;
  const wrappedFilterAllModels: Provider["filterAllModels"] = filterAllModels
    ? (models, credential) =>
        routeAllModels(
          filterAllModels.call(
            provider,
            routeAllModels(models, routes),
            credential,
          ),
          routes,
        )
    : undefined;
  const wrappedGenerateImages: Provider["generateImages"] = generateImages
    ? (model, context, options) =>
        generateImages.call(provider, model, context, options)
    : undefined;
  const wrappedClassify: Provider["classify"] = classify
    ? (model, context, options) =>
        classify.call(provider, model, context, options)
    : undefined;

  return {
    id: provider.id,
    name: provider.name,
    baseUrl: routes.root,
    auth: provider.auth,
    getModels() {
      return routeModels(providerGetModels.call(provider), routes);
    },
    stream,
    streamSimple,
    ...toNonNullRecord({
      headers: provider.headers,
      refreshModels: wrappedRefreshModels,
      filterModels: wrappedFilterModels,
      fetchDeferred: wrappedFetchDeferred,
      cancelDeferred: wrappedCancelDeferred,
      getAllModels: wrappedGetAllModels,
      filterAllModels: wrappedFilterAllModels,
      generateImages: wrappedGenerateImages,
      classify: wrappedClassify,
    }),
  };
}

/**
 * Register routed snapshots for chat providers known at startup.
 * Registration failures warn per provider; registry read failures propagate.
 * @example installProviderOverrides(pi, registry, routes, warn) // installs provider wrappers
 */
function installProviderOverrides(
  pi: ProviderOverrideApi,
  registry: Pick<ModelRegistry, "getAll" | "getProvider">,
  routes: ProviderRoutes,
  reportWarning: (message: string) => void,
): void {
  const models: Model<Api>[] = registry.getAll();
  const providerIds = unique(models.map((model) => model.provider));

  for (const providerId of providerIds) {
    const providerValue = registry.getProvider(providerId);
    if (providerValue === undefined) {
      continue;
    }

    const wrappedProvider = wrapProvider(providerValue, routes);
    try {
      // Live host registration can fail while recomposing provider state.
      pi.registerProvider(wrappedProvider);
    } catch {
      reportWarning(PROVIDER_INSTALL_WARNING);
    }
  }
}

/**
 * Register startup routing for Pi providers when PROVIDER_BASE_URL is configured.
 * Invalid URLs warn without installing a handler; the host owns the subscription.
 * @example providerBaseUrlOverrides(pi) // routes configured providers on session_start
 */
export default function providerBaseUrlOverrides(
  pi: ProviderOverrideApi,
): void {
  const providerBaseUrl = readProviderBaseUrl();
  if (!providerBaseUrl) {
    return;
  }

  const routes = createProviderRoutes(providerBaseUrl);
  pi.on("session_start", (_event, ctx) => {
    const reportWarning = (message: string): void => {
      ctx.ui.notify(`${WARNING_PREFIX} ${message}`, "warning");
    };
    installProviderOverrides(pi, ctx.modelRegistry, routes, reportWarning);
  });
}
