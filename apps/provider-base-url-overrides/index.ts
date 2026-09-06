import type {
  Api,
  Model,
  Provider,
  ProviderRequestOptions,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";

// biome-ignore lint/suspicious/noControlCharactersInRegex: Provider URLs must reject ASCII control bytes.
const ASCII_CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/u;
const HTTP_URL_PREFIX = /^https?:\/\/[^/?#]+(?:\/|$)/iu;
const AZURE_API = "azure-openai-responses";
const WARNING_PREFIX = "[provider-base-url-overrides]";
const PROVIDER_INSTALL_WARNING =
  "Skipping a provider override because registration failed.";

type TransportOptions = ProviderRequestOptions & {
  azureBaseUrl?: string;
};

type ProviderRoutes = {
  root: string;
  openAi: string;
  googleGenerative: string;
};

type NonNullRecord<T extends Record<string, unknown>> = {
  [K in keyof T as K extends string ? K : never]?: NonNullable<T[K]>;
};

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function warn(message: string): void {
  console.warn(`${WARNING_PREFIX} ${message}`);
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
  if (!value) return undefined;

  if (!isValidProviderBaseUrl(value)) {
    warn(
      "Ignoring invalid PROVIDER_BASE_URL; expected an absolute HTTP(S) URL without control characters, query, or fragment.",
    );
    return undefined;
  }

  return value;
}

function isValidProviderBaseUrl(value: string): boolean {
  if (ASCII_CONTROL_CHARACTER.test(value)) return false;
  if (!HTTP_URL_PREFIX.test(value)) return false;
  if (value.includes("?") || value.includes("#")) return false;

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

function createProviderRoutes(root: string): ProviderRoutes {
  const suffixRoot = root.replace(/\/+$/u, "");
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

function routeModel<TApi extends Api>(
  model: Model<TApi>,
  routes: ProviderRoutes,
): Model<TApi> {
  const snapshot = { ...model };
  snapshot.baseUrl = routedBaseUrl(snapshot, routes);
  return snapshot;
}

function routeModels<TApi extends Api>(
  models: readonly Model<TApi>[],
  routes: ProviderRoutes,
): Model<TApi>[] {
  const routedModels: Model<TApi>[] = [];
  for (const model of models) {
    routedModels.push(routeModel(model, routes));
  }
  return routedModels;
}

function routeTransportOptions<TOptions extends ProviderRequestOptions>(
  api: Api,
  routedModelBaseUrl: string,
  options: TOptions | undefined,
): TOptions | undefined;

function routeTransportOptions(
  api: Api,
  routedModelBaseUrl: string,
  options: ProviderRequestOptions | undefined,
): TransportOptions | undefined {
  if (api !== AZURE_API) return options;

  const optionsSnapshot: ProviderRequestOptions = { ...options };
  return {
    ...optionsSnapshot,
    azureBaseUrl: routedModelBaseUrl,
    env: {
      ...optionsSnapshot.env,
      AZURE_OPENAI_BASE_URL: routedModelBaseUrl,
    },
  };
}

function routeRequest<
  TApi extends Api,
  TOptions extends ProviderRequestOptions,
>(
  model: Model<TApi>,
  routes: ProviderRoutes,
  options: TOptions | undefined,
): { model: Model<TApi>; options: TOptions | undefined } {
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

  const refreshModels = provider.refreshModels;
  const wrappedRefreshModels: Provider["refreshModels"] = refreshModels
    ? (context) => refreshModels.call(provider, context)
    : undefined;

  const filterModels = provider.filterModels;
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

  const fetchDeferred = provider.fetchDeferred;
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

  const cancelDeferred = provider.cancelDeferred;
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
    }),
  };
}

function installProviderOverrides(
  pi: ExtensionAPI,
  registry: ModelRegistry,
  routes: ProviderRoutes,
  reportWarning: (message: string) => void,
): void {
  const models: Model<Api>[] = registry.getAll();
  const providerIds = unique(models.map((model) => model.provider));

  for (const providerId of providerIds) {
    const providerValue = registry.getProvider(providerId);
    if (providerValue === undefined) continue;

    const wrappedProvider = wrapProvider(providerValue, routes);
    try {
      // Live host registration can fail while recomposing provider state.
      pi.registerProvider(wrappedProvider);
    } catch {
      reportWarning(PROVIDER_INSTALL_WARNING);
    }
  }
}

export default function providerBaseUrlOverrides(pi: ExtensionAPI): void {
  const providerBaseUrl = readProviderBaseUrl();
  if (!providerBaseUrl) return;

  const routes = createProviderRoutes(providerBaseUrl);
  pi.on("session_start", (_event, ctx) => {
    const reportWarning = (message: string): void => {
      ctx.ui.notify(`${WARNING_PREFIX} ${message}`, "warning");
    };
    installProviderOverrides(pi, ctx.modelRegistry, routes, reportWarning);
  });
}
