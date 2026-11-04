import { describe, expect, it, spyOn } from "bun:test";
import process from "node:process";
import type { AnyModel, Provider } from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { resolveAzureBaseUrl } from "@earendil-works/pi-ai/api/azure-openai-config";
import { azureProvider } from "@earendil-works/pi-ai/providers/azure";
import {
  openrouterProvider,
  personalizeOpenRouterCatalog,
} from "@earendil-works/pi-ai/providers/openrouter";
import { isModelType } from "@earendil-works/pi-ai/utils/model-operations";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import providerBaseUrlOverrides from "./index.ts";

const PERSONALIZED_CONTEXT_WINDOW = 12_345;

type StartHandler = (
  event: SessionStartEvent,
  context: ExtensionContext,
) => void | Promise<void>;

/**
 * Installs the real extension around one provider, restoring the captured env.
 * @throws If startup fails or the provider is not registered.
 * @example await overrideProvider(azureProvider()) // proxy-routed Azure provider
 */
async function overrideProvider(provider: Provider): Promise<Provider> {
  let start: StartHandler | undefined;
  let wrapped: Provider | undefined;
  const key = "PROVIDER_BASE_URL";
  const previous = process.env[key];
  try {
    process.env[key] = "https://proxy.test/api";
    providerBaseUrlOverrides({
      on(_event: string, handler: StartHandler) {
        start = handler;
      },
      registerProvider(value: Provider) {
        wrapped = value;
      },
    } as ExtensionAPI);
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
  await start?.({ type: "session_start", reason: "startup" }, {
    modelRegistry: {
      getAll: () => provider.getModels(),
      getProvider: (_id: string): Provider | undefined => provider,
    },
    ui: { notify: (_message: string): void => undefined },
  } as ExtensionContext);
  if (!wrapped) {
    throw new Error("Provider override was not registered");
  }
  return wrapped;
}

describe("providerBaseUrlOverrides", () => {
  it("should keep Azure chat requests on the proxy when Azure endpoint options are configured", async () => {
    const provider = azureProvider();
    const model = provider
      .getModels()
      .find((entry) => entry.api === "openai-completions");
    if (!model) {
      throw new Error("Azure chat model is missing");
    }
    let endpoint: string | undefined;
    const wrapped = await overrideProvider({
      ...provider,
      stream(routedModel, _context, requestOptions) {
        endpoint = resolveAzureBaseUrl(routedModel, requestOptions);
        return createAssistantMessageEventStream();
      },
    });
    const options = {
      apiKey: "test-key",
      azureBaseUrl: "https://direct.openai.azure.com",
      azureResourceName: "direct",
      // biome-ignore lint/style/useNamingConvention: preserve Azure's environment variable key.
      env: { AZURE_OPENAI_BASE_URL: "https://env.openai.azure.com" },
    };
    wrapped.stream(model, normalizeContext({ messages: [] }), options);
    expect(endpoint).toBe("https://proxy.test/api/v1");
    expect(options.azureBaseUrl).toBe("https://direct.openai.azure.com");
  });

  it("should apply the key-specific OpenRouter catalog through the routed API base", async () => {
    const provider = openrouterProvider();
    const model = provider
      .getModels()
      .find((entry) => entry.api === "openai-completions");
    if (!model) {
      throw new Error("OpenRouter chat model is missing");
    }
    let catalog: readonly AnyModel[] = [model];
    const wrapped = await overrideProvider({
      ...provider,
      async refreshModels(context) {
        catalog = await personalizeOpenRouterCatalog([model], context);
      },
    });
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [
          // biome-ignore lint/style/useNamingConvention: preserve OpenRouter's response field.
          { id: model.id, context_length: PERSONALIZED_CONTEXT_WINDOW },
        ],
      }),
    );
    await wrapped.refreshModels?.({
      baseUrl: "https://proxy.test/api",
      credential: { type: "api_key", key: "test-key" },
      signal: new AbortController().signal,
      allowNetwork: true,
      publish: async () => true,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://proxy.test/api/v1/models/user",
    );
    expect(
      catalog
        .filter((entry) => isModelType(entry, "chat"))
        .map((entry) => [entry.id, entry.contextWindow]),
    ).toEqual([[model.id, PERSONALIZED_CONTEXT_WINDOW]]);
  });
});
