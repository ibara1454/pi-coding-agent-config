import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";

const ASCII_CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/u;
const HTTP_URL_PREFIX = /^https?:\/\/[^/?#]+(?:\/|$)/iu;
const AZURE_API = "azure-openai-responses";

type TransportOptions = {
  azureBaseUrl?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
};

function readProviderBaseUrl(): string | undefined {
  const value = process.env.PROVIDER_BASE_URL?.trim();
  if (!value) return undefined;

  if (!isValidProviderBaseUrl(value)) {
    console.warn(
      "[provider-base-url-overrides] Ignoring invalid PROVIDER_BASE_URL; expected an absolute HTTP(S) URL without control characters, query, or fragment.",
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

function routedBaseUrl(
  model: Pick<Model<Api>, "api" | "baseUrl">,
  providerBaseUrl: string,
): string {
  switch (model.api) {
    case "anthropic-messages":
      return providerBaseUrl;
    case "google-generative-ai":
      return `${providerBaseUrl.replace(/\/+$/u, "")}/v1beta`;
    case "google-vertex":
      return providerBaseUrl;
    case "openai-completions":
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return `${providerBaseUrl.replace(/\/+$/u, "")}/v1`;
    default:
      return model.baseUrl;
  }
}

function routeModel<TApi extends Api>(
  model: Model<TApi>,
  providerBaseUrl: string,
): Model<TApi> {
  return { ...model, baseUrl: routedBaseUrl(model, providerBaseUrl) };
}

function routeTransportOptions<TOptions>(
  api: Api,
  routedModelBaseUrl: string,
  options: TOptions | undefined,
): TOptions | undefined {
  if (api !== AZURE_API) return options;

  const originalOptions = (options ?? {}) as TOptions & TransportOptions;
  return {
    ...originalOptions,
    azureBaseUrl: routedModelBaseUrl,
    env: {
      ...originalOptions.env,
      AZURE_OPENAI_BASE_URL: routedModelBaseUrl,
    },
  } as TOptions;
}

function routeRequest<TApi extends Api, TOptions>(
  model: Model<TApi>,
  providerBaseUrl: string,
  options: TOptions | undefined,
): { model: Model<TApi>; options: TOptions | undefined } {
  const routedModel = routeModel(model, providerBaseUrl);
  return {
    model: routedModel,
    options: routeTransportOptions(model.api, routedModel.baseUrl, options),
  };
}

function wrapProvider(provider: Provider, providerBaseUrl: string): Provider {
  const stream: Provider["stream"] = (model, context, options) => {
    const request = routeRequest(model, providerBaseUrl, options);
    return provider.stream.call(provider, request.model, context, request.options);
  };
  const streamSimple: Provider["streamSimple"] = (model, context, options) => {
    const request = routeRequest(model, providerBaseUrl, options);
    return provider.streamSimple.call(provider, request.model, context, request.options);
  };

  const wrapper: Provider = {
    id: provider.id,
    name: provider.name,
    baseUrl: providerBaseUrl,
    headers: provider.headers,
    auth: provider.auth,
    getModels() {
      return provider
        .getModels.call(provider)
        .map((model) => routeModel(model, providerBaseUrl));
    },
    stream,
    streamSimple,
  };

  const refreshModels = provider.refreshModels;
  if (refreshModels) {
    wrapper.refreshModels = (context) => refreshModels.call(provider, context);
  }

  const filterModels = provider.filterModels;
  if (filterModels) {
    wrapper.filterModels = (models, credential) => {
      const routedModels = models.map((model) => routeModel(model, providerBaseUrl));
      const filteredModels = filterModels.call(provider, routedModels, credential);
      return filteredModels.map((model) => routeModel(model, providerBaseUrl));
    };
  }

  const fetchDeferred = provider.fetchDeferred;
  if (fetchDeferred) {
    wrapper.fetchDeferred = (model, handle, options) => {
      const request = routeRequest(model, providerBaseUrl, options);
      return fetchDeferred.call(provider, request.model, handle, request.options);
    };
  }

  const cancelDeferred = provider.cancelDeferred;
  if (cancelDeferred) {
    wrapper.cancelDeferred = (model, handle, options) => {
      const request = routeRequest(model, providerBaseUrl, options);
      return cancelDeferred.call(provider, request.model, handle, request.options);
    };
  }

  return wrapper;
}

export default function providerBaseUrlOverrides(pi: ExtensionAPI): void {
  const providerBaseUrl = readProviderBaseUrl();
  if (!providerBaseUrl) return;

  pi.on("session_start", (_event, ctx) => {
    const providerIds = new Set(
      ctx.modelRegistry.getAll().map((model) => model.provider),
    );

    for (const providerId of providerIds) {
      const provider = ctx.modelRegistry.getProvider(providerId);
      if (provider) {
        pi.registerProvider(wrapProvider(provider, providerBaseUrl));
      }
    }
  });
}
