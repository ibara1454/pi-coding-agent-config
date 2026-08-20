import { expect, test } from "bun:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import providerBaseUrlOverrides from "./index.ts";

const ENVIRONMENT_VARIABLES = [
  "PROVIDER_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "GEMINI_BASE_URL",
] as const;

type EnvironmentVariable = (typeof ENVIRONMENT_VARIABLES)[number];
type TestContext = Record<string, unknown>;
type TestOptions = Record<string, unknown>;
type TestCredential = Record<string, unknown>;
type TestHandle = Record<string, unknown>;

interface TestModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ["text"];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  [key: string]: unknown;
}

interface TransportCall {
  model: TestModel;
  context?: TestContext;
  options?: TestOptions;
  handle?: TestHandle;
}

interface ProviderCalls {
  getModels: number;
  stream: TransportCall[];
  streamSimple: TransportCall[];
  refreshModels: TestContext[];
  filterModels: Array<{
    models: readonly TestModel[];
    credential: TestCredential | undefined;
  }>;
  fetchDeferred: TransportCall[];
  cancelDeferred: TransportCall[];
}

interface TestProvider {
  id: string;
  name: string;
  baseUrl?: string;
  headers?: Record<string, string | null>;
  auth: TestCredential;
  getModels(): readonly TestModel[];
  stream(
    model: TestModel,
    context: TestContext,
    options?: TestOptions,
  ): unknown;
  streamSimple(
    model: TestModel,
    context: TestContext,
    options?: TestOptions,
  ): unknown;
  refreshModels?(context: TestContext): Promise<void>;
  filterModels?(
    models: readonly TestModel[],
    credential: TestCredential | undefined,
  ): readonly TestModel[];
  fetchDeferred?(
    model: TestModel,
    handle: TestHandle,
    options?: TestOptions,
  ): unknown;
  cancelDeferred?(
    model: TestModel,
    handle: TestHandle,
    options?: TestOptions,
  ): Promise<void>;
}

interface TestModelRegistry {
  getAll(): readonly TestModel[];
  getProvider(id: string): TestProvider | undefined;
}

interface SessionHandler {
  (event: { type: "session_start"; reason: "startup" }, context: {
    modelRegistry: TestModelRegistry;
  }): void | Promise<void>;
}

interface ExtensionHarness {
  handlers: Array<{ event: string; handler: SessionHandler }>;
  registrations: TestProvider[];
  warnings: string[];
}

function makeModel(
  provider: string,
  id: string,
  baseUrl: string,
  api = "test-api",
): TestModel {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    contextWindow: 1000,
    maxTokens: 100,
  };
}

function makeProvider(
  id: string,
  models: readonly TestModel[],
  includeOptionalMethods = false,
): { provider: TestProvider; calls: ProviderCalls } {
  const calls: ProviderCalls = {
    getModels: 0,
    stream: [],
    streamSimple: [],
    refreshModels: [],
    filterModels: [],
    fetchDeferred: [],
    cancelDeferred: [],
  };
  const headers = { "x-provider": id };
  const auth = { kind: "test-auth", provider: id };
  const provider = {
    id,
    name: `${id} provider`,
    baseUrl: `https://origin.test/${id}`,
    headers,
    auth,
    getModels(this: TestProvider) {
      expect(this).toBe(provider);
      calls.getModels += 1;
      return models;
    },
    stream(this: TestProvider, model: TestModel, context: TestContext, options?: TestOptions) {
      expect(this).toBe(provider);
      calls.stream.push({ model, context, options });
      return { kind: "stream", provider: id };
    },
    streamSimple(this: TestProvider, model: TestModel, context: TestContext, options?: TestOptions) {
      expect(this).toBe(provider);
      calls.streamSimple.push({ model, context, options });
      return { kind: "stream-simple", provider: id };
    },
  } as TestProvider;

  if (includeOptionalMethods) {
    provider.refreshModels = async function (this: TestProvider, context: TestContext) {
      expect(this).toBe(provider);
      calls.refreshModels.push(context);
    };
    provider.filterModels = function (
      this: TestProvider,
      filterableModels: readonly TestModel[],
      credential: TestCredential | undefined,
    ) {
      expect(this).toBe(provider);
      calls.filterModels.push({ models: filterableModels, credential });
      return [models[0]];
    };
    provider.fetchDeferred = function (
      this: TestProvider,
      model: TestModel,
      handle: TestHandle,
      options?: TestOptions,
    ) {
      expect(this).toBe(provider);
      calls.fetchDeferred.push({ model, handle, options });
      return { kind: "fetch-deferred", provider: id };
    };
    provider.cancelDeferred = async function (
      this: TestProvider,
      model: TestModel,
      handle: TestHandle,
      options?: TestOptions,
    ) {
      expect(this).toBe(provider);
      calls.cancelDeferred.push({ model, handle, options });
    };
  }

  return { provider, calls };
}

function makeHarness(): {
  pi: ExtensionAPI;
  state: ExtensionHarness;
} {
  const state: ExtensionHarness = {
    handlers: [],
    registrations: [],
    warnings: [],
  };
  const pi = {
    on(event: string, handler: SessionHandler) {
      state.handlers.push({ event, handler });
    },
    registerProvider(provider: TestProvider) {
      state.registrations.push(provider);
    },
  } as unknown as ExtensionAPI;
  return { pi, state };
}

function runExtension(environment: Partial<Record<EnvironmentVariable, string>>): ExtensionHarness {
  const previousEnvironment = Object.fromEntries(
    ENVIRONMENT_VARIABLES.map((name) => [name, process.env[name]]),
  ) as Record<EnvironmentVariable, string | undefined>;
  const previousWarn = console.warn;
  const { pi, state } = makeHarness();

  try {
    for (const name of ENVIRONMENT_VARIABLES) {
      delete process.env[name];
    }
    for (const [name, value] of Object.entries(environment)) {
      if (value !== undefined) process.env[name as EnvironmentVariable] = value;
    }

    console.warn = (...args: unknown[]) => {
      state.warnings.push(args.map(String).join(" "));
    };
    providerBaseUrlOverrides(pi);
  } finally {
    console.warn = previousWarn;
    for (const name of ENVIRONMENT_VARIABLES) {
      const value = previousEnvironment[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  return state;
}

function makeRegistry(
  models: readonly TestModel[],
  providers: Record<string, TestProvider>,
): { registry: TestModelRegistry; lookups: string[] } {
  const lookups: string[] = [];
  return {
    registry: {
      getAll() {
        return [...models];
      },
      getProvider(id: string) {
        lookups.push(id);
        return providers[id];
      },
    },
    lookups,
  };
}

async function triggerSessionStart(
  harness: ExtensionHarness,
  modelRegistry: TestModelRegistry,
): Promise<void> {
  const handler = harness.handlers.find(({ event }) => event === "session_start")?.handler;
  if (!handler) throw new Error("session_start handler was not registered");
  await handler(
    { type: "session_start", reason: "startup" },
    { modelRegistry },
  );
}

test("vendor-specific environment variables alone do nothing", () => {
  for (const name of ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "GEMINI_BASE_URL"] as const) {
    const harness = runExtension({
      [name]: `https://vendor-only.test/${name.toLowerCase()}`,
    });

    expect(harness.handlers).toEqual([]);
    expect(harness.registrations).toEqual([]);
    expect(harness.warnings).toEqual([]);
  }
});

test("missing and blank PROVIDER_BASE_URL disable silently", () => {
  for (const value of [undefined, "", "   \t\n"]) {
    const harness = runExtension(
      value === undefined ? {} : { PROVIDER_BASE_URL: value },
    );

    expect(harness.handlers).toEqual([]);
    expect(harness.registrations).toEqual([]);
    expect(harness.warnings).toEqual([]);
  }
});

test("warns once and stays inactive for invalid nonblank URLs", () => {
  const invalidValues = [
    "proxy.test/path",
    "ftp://proxy.test/path",
    "https:///path-without-host",
    "https://proxy.test/path?tenant=a",
    "https://proxy.test/path#fragment",
    "https://proxy.test/a\nb",
  ];

  for (const value of invalidValues) {
    const harness = runExtension({ PROVIDER_BASE_URL: value });

    expect(harness.handlers).toEqual([]);
    expect(harness.registrations).toEqual([]);
    expect(harness.warnings).toHaveLength(1);
    expect(harness.warnings[0]).not.toContain(value);
    expect(harness.warnings[0]).not.toContain("proxy.test");
  }
});

test("valid PROVIDER_BASE_URL installs only session_start and wraps every represented provider", async () => {
  const baseUrl = " HTTPS://user:pass@proxy.test:8443/shared/path ";
  const alphaModel = makeModel("alpha", "alpha-one", "https://origin.test/alpha-one");
  const alphaSecondModel = makeModel("alpha", "alpha-two", "https://origin.test/alpha-two");
  const betaModel = makeModel("beta", "beta-one", "https://origin.test/beta-one");
  const alpha = makeProvider("alpha", [alphaModel, alphaSecondModel]);
  const beta = makeProvider("beta", [betaModel]);
  const harness = runExtension({ PROVIDER_BASE_URL: baseUrl });
  const { registry, lookups } = makeRegistry(
    [alphaModel, alphaSecondModel, betaModel, alphaModel],
    { alpha: alpha.provider, beta: beta.provider },
  );

  expect(harness.handlers.map(({ event }) => event)).toEqual(["session_start"]);
  expect(harness.registrations).toEqual([]);
  expect(harness.warnings).toEqual([]);

  await triggerSessionStart(harness, registry);

  expect(lookups).toEqual(["alpha", "beta"]);
  expect(harness.registrations.map((provider) => provider.id)).toEqual([
    "alpha",
    "beta",
  ]);
  expect(harness.registrations.map((provider) => provider.baseUrl)).toEqual([
    baseUrl.trim(),
    baseUrl.trim(),
  ]);
  expect(harness.registrations[0].getModels()).toEqual([
    { ...alphaModel },
    { ...alphaSecondModel },
  ]);
  expect(harness.registrations[1].getModels()).toEqual([
    { ...betaModel },
  ]);
  expect(harness.registrations[0].getModels()[0]).not.toBe(alphaModel);
  expect(harness.registrations[1].getModels()[0]).not.toBe(betaModel);
  expect(alphaModel.baseUrl).toBe("https://origin.test/alpha-one");
  expect(alphaSecondModel.baseUrl).toBe("https://origin.test/alpha-two");
  expect(betaModel.baseUrl).toBe("https://origin.test/beta-one");
});

test("routes every supported model API and preserves unrelated model URLs", async () => {
  const providerBaseUrl = "https://proxy.test/root";
  const models = [
    makeModel("routing", "anthropic", "https://origin.test/anthropic", "anthropic-messages"),
    makeModel("routing", "completions", "https://origin.test/completions", "openai-completions"),
    makeModel("routing", "responses", "https://origin.test/responses", "openai-responses"),
    makeModel("routing", "azure", "https://origin.test/azure", "azure-openai-responses"),
    makeModel("routing", "codex", "https://origin.test/codex", "openai-codex-responses"),
    makeModel("routing", "google", "https://origin.test/google", "google-generative-ai"),
    makeModel("routing", "vertex", "https://origin.test/vertex", "google-vertex"),
    makeModel("routing", "mistral", "https://origin.test/mistral", "mistral-conversations"),
    makeModel("routing", "bedrock", "https://origin.test/bedrock", "bedrock-converse-stream"),
    makeModel("routing", "pi", "https://origin.test/pi", "pi-messages"),
    makeModel("routing", "custom", "https://origin.test/custom", "custom-api"),
  ];
  const { provider } = makeProvider("routing", models);
  const harness = runExtension({ PROVIDER_BASE_URL: providerBaseUrl });
  const { registry } = makeRegistry(models, { routing: provider });

  await triggerSessionStart(harness, registry);

  const routedModels = harness.registrations[0].getModels();
  expect(routedModels.map((model) => model.baseUrl)).toEqual([
    providerBaseUrl,
    `${providerBaseUrl}/v1`,
    `${providerBaseUrl}/v1`,
    `${providerBaseUrl}/v1`,
    `${providerBaseUrl}/v1`,
    `${providerBaseUrl}/v1beta`,
    providerBaseUrl,
    "https://origin.test/mistral",
    "https://origin.test/bedrock",
    "https://origin.test/pi",
    "https://origin.test/custom",
  ]);
  for (const [index, model] of models.entries()) {
    expect(routedModels[index]).not.toBe(model);
    expect(model.baseUrl).toBe(`https://origin.test/${model.id}`);
  }
});

test("trailing roots route Google APIs with one separator", async () => {
  const providerBaseUrl = " https://proxy.test/root/ ";
  const anthropicModel = makeModel(
    "routing",
    "anthropic",
    "https://origin.test/anthropic",
    "anthropic-messages",
  );
  const openAiModel = makeModel(
    "routing",
    "openai",
    "https://origin.test/openai",
    "openai-responses",
  );
  const googleModel = makeModel(
    "routing",
    "google",
    "https://origin.test/google",
    "google-generative-ai",
  );
  const vertexModel = makeModel(
    "routing",
    "vertex",
    "https://origin.test/vertex",
    "google-vertex",
  );
  const models = [anthropicModel, openAiModel, googleModel, vertexModel];
  const { provider } = makeProvider("routing", models);
  const harness = runExtension({ PROVIDER_BASE_URL: providerBaseUrl });
  const { registry } = makeRegistry(models, { routing: provider });

  await triggerSessionStart(harness, registry);

  const routedModels = harness.registrations[0].getModels();
  expect(routedModels[0].baseUrl).toBe(providerBaseUrl.trim());
  expect(routedModels[1].baseUrl).toBe("https://proxy.test/root/v1");
  expect(routedModels[2].baseUrl).toBe("https://proxy.test/root/v1beta");
  expect(routedModels[3].baseUrl).toBe(providerBaseUrl.trim());
});

test("preserves provider metadata and omits absent optional methods", async () => {
  const model = makeModel("metadata", "model", "https://origin.test/model");
  const { provider } = makeProvider("metadata", [model]);
  const harness = runExtension({ PROVIDER_BASE_URL: "https://proxy.test/v1" });
  const { registry } = makeRegistry([model], { metadata: provider });

  await triggerSessionStart(harness, registry);

  const wrapped = harness.registrations[0];
  expect(wrapped.id).toBe(provider.id);
  expect(wrapped.name).toBe(provider.name);
  expect(wrapped.headers).toBe(provider.headers);
  expect(wrapped.auth).toBe(provider.auth);
  expect(wrapped.baseUrl).toBe("https://proxy.test/v1");
  expect(wrapped.refreshModels).toBeUndefined();
  expect(wrapped.filterModels).toBeUndefined();
  expect(wrapped.fetchDeferred).toBeUndefined();
  expect(wrapped.cancelDeferred).toBeUndefined();
});

test("delegates stream and streamSimple with per-model routes and preserved non-Azure options", async () => {
  const originalModel = makeModel(
    "transport",
    "model",
    "https://origin.test/model",
    "openai-completions",
  );
  const { provider, calls } = makeProvider("transport", [originalModel], true);
  const harness = runExtension({ PROVIDER_BASE_URL: "https://proxy.test/override" });
  const { registry } = makeRegistry([originalModel], { transport: provider });
  await triggerSessionStart(harness, registry);
  const wrapped = harness.registrations[0];
  const context = { request: "context" };
  const streamOptions = { temperature: 0.2 };
  const simpleOptions = { reasoning: "high" };
  const streamInput = { ...originalModel, baseUrl: "https://caller.test/stream" };
  const simpleInput = {
    ...originalModel,
    api: "anthropic-messages",
    baseUrl: "https://caller.test/simple",
  };

  const streamResult = wrapped.stream(streamInput, context, streamOptions);
  const simpleResult = wrapped.streamSimple(simpleInput, context, simpleOptions);

  expect(streamResult).toEqual({ kind: "stream", provider: "transport" });
  expect(simpleResult).toEqual({ kind: "stream-simple", provider: "transport" });
  expect(calls.stream[0]).toEqual({
    model: { ...streamInput, baseUrl: "https://proxy.test/override/v1" },
    context,
    options: streamOptions,
  });
  expect(calls.streamSimple[0]).toEqual({
    model: { ...simpleInput, baseUrl: "https://proxy.test/override" },
    context,
    options: simpleOptions,
  });
  expect(calls.stream[0].options).toBe(streamOptions);
  expect(calls.streamSimple[0].options).toBe(simpleOptions);
  expect(calls.stream[0].model).not.toBe(streamInput);
  expect(calls.streamSimple[0].model).not.toBe(simpleInput);
  expect(streamInput.baseUrl).toBe("https://caller.test/stream");
  expect(simpleInput.baseUrl).toBe("https://caller.test/simple");
  expect(originalModel.baseUrl).toBe("https://origin.test/model");
});

test("delegates refreshModels and filterModels with per-model routes and the original receiver", async () => {
  const model = makeModel(
    "catalog",
    "model",
    "https://origin.test/model",
    "openai-responses",
  );
  const secondModel = makeModel(
    "catalog",
    "second",
    "https://origin.test/second",
    "anthropic-messages",
  );
  const thirdModel = makeModel(
    "catalog",
    "third",
    "https://origin.test/third",
    "custom-api",
  );
  const { provider, calls } = makeProvider(
    "catalog",
    [model, secondModel, thirdModel],
    true,
  );
  const harness = runExtension({ PROVIDER_BASE_URL: "https://proxy.test/catalog" });
  const { registry } = makeRegistry([model], { catalog: provider });
  await triggerSessionStart(harness, registry);
  const wrapped = harness.registrations[0];
  const refreshContext = { allowNetwork: true };
  const credential = { token: "secret" };
  const filterInput = [model, secondModel, thirdModel];

  await wrapped.refreshModels?.(refreshContext);
  const filtered = wrapped.filterModels?.(filterInput, credential);
  const delegatedModels = calls.filterModels[0].models;

  expect(calls.refreshModels).toEqual([refreshContext]);
  expect(calls.filterModels[0].credential).toBe(credential);
  expect(delegatedModels).toEqual([
    { ...model, baseUrl: "https://proxy.test/catalog/v1" },
    { ...secondModel, baseUrl: "https://proxy.test/catalog" },
    { ...thirdModel, baseUrl: "https://origin.test/third" },
  ]);
  expect(delegatedModels[0]).not.toBe(model);
  expect(delegatedModels[1]).not.toBe(secondModel);
  expect(delegatedModels[2]).not.toBe(thirdModel);
  expect(model.baseUrl).toBe("https://origin.test/model");
  expect(secondModel.baseUrl).toBe("https://origin.test/second");
  expect(thirdModel.baseUrl).toBe("https://origin.test/third");
  expect(filtered).toHaveLength(1);
  expect(filtered?.[0]).toEqual({
    ...model,
    baseUrl: "https://proxy.test/catalog/v1",
  });
  expect(filtered?.[0]).not.toBe(delegatedModels[0]);
  expect(filtered?.[0]).not.toBe(model);
});

test("delegates deferred fetch and cancel with per-model routes and preserved non-Azure options", async () => {
  const originalModel = makeModel(
    "deferred",
    "model",
    "https://origin.test/model",
    "openai-responses",
  );
  const { provider, calls } = makeProvider("deferred", [originalModel], true);
  const harness = runExtension({ PROVIDER_BASE_URL: "https://proxy.test/deferred" });
  const { registry } = makeRegistry([originalModel], { deferred: provider });
  await triggerSessionStart(harness, registry);
  const wrapped = harness.registrations[0];
  const handle = { id: "deferred-handle" };
  const options = { wait: 5000 };
  const fetchInput = { ...originalModel, baseUrl: "https://caller.test/fetch" };
  const cancelInput = {
    ...originalModel,
    api: "anthropic-messages",
    baseUrl: "https://caller.test/cancel",
  };

  const fetchResult = await wrapped.fetchDeferred?.(fetchInput, handle, options);
  await wrapped.cancelDeferred?.(cancelInput, handle, options);

  expect(fetchResult).toEqual({ kind: "fetch-deferred", provider: "deferred" });
  expect(calls.fetchDeferred[0]).toEqual({
    model: { ...fetchInput, baseUrl: "https://proxy.test/deferred/v1" },
    handle,
    options,
  });
  expect(calls.cancelDeferred[0]).toEqual({
    model: { ...cancelInput, baseUrl: "https://proxy.test/deferred" },
    handle,
    options,
  });
  expect(calls.fetchDeferred[0].options).toBe(options);
  expect(calls.cancelDeferred[0].options).toBe(options);
  expect(calls.fetchDeferred[0].model).not.toBe(fetchInput);
  expect(calls.cancelDeferred[0].model).not.toBe(cancelInput);
  expect(fetchInput.baseUrl).toBe("https://caller.test/fetch");
  expect(cancelInput.baseUrl).toBe("https://caller.test/cancel");
  expect(originalModel.baseUrl).toBe("https://origin.test/model");
});

test("forces Azure routing options for every transport without mutating caller options", async () => {
  const originalModel = makeModel(
    "azure",
    "model",
    "https://origin.test/model",
    "azure-openai-responses",
  );
  const { provider, calls } = makeProvider("azure", [originalModel], true);
  const harness = runExtension({ PROVIDER_BASE_URL: "https://proxy.test/azure/" });
  const { registry } = makeRegistry([originalModel], { azure: provider });
  await triggerSessionStart(harness, registry);
  const wrapped = harness.registrations[0];
  const context = { request: "context" };
  const handle = { id: "azure-handle" };
  const callerEnv = {
    AZURE_OPENAI_BASE_URL: "https://configured.azure",
    AZURE_OPENAI_API_VERSION: "2024-10-21",
    KEEP_ENV: "keep",
  };
  const callerOptions: TestOptions = {
    apiKey: "key",
    azureBaseUrl: "https://configured-option",
    azureResourceName: "configured-resource",
    env: callerEnv,
    unrelated: { preserve: true },
  };
  const expectedBaseUrl = "https://proxy.test/azure/v1";
  const expectedOptions = {
    ...callerOptions,
    azureBaseUrl: expectedBaseUrl,
    env: { ...callerEnv, AZURE_OPENAI_BASE_URL: expectedBaseUrl },
  };
  const streamInput = { ...originalModel, baseUrl: "https://caller.test/stream" };
  const simpleInput = { ...originalModel, baseUrl: "https://caller.test/simple" };
  const fetchInput = { ...originalModel, baseUrl: "https://caller.test/fetch" };
  const cancelInput = { ...originalModel, baseUrl: "https://caller.test/cancel" };

  wrapped.stream(streamInput, context, callerOptions);
  wrapped.streamSimple(simpleInput, context, callerOptions);
  await wrapped.fetchDeferred?.(fetchInput, handle, callerOptions);
  await wrapped.cancelDeferred?.(cancelInput, handle, callerOptions);

  for (const call of [
    calls.stream[0],
    calls.streamSimple[0],
    calls.fetchDeferred[0],
    calls.cancelDeferred[0],
  ]) {
    expect(call.model.baseUrl).toBe(expectedBaseUrl);
    expect(call.options).toEqual(expectedOptions);
    expect(call.options).not.toBe(callerOptions);
    expect(call.options?.env).not.toBe(callerEnv);
  }
  expect(callerOptions).toEqual({
    apiKey: "key",
    azureBaseUrl: "https://configured-option",
    azureResourceName: "configured-resource",
    env: callerEnv,
    unrelated: { preserve: true },
  });
  expect(callerEnv).toEqual({
    AZURE_OPENAI_BASE_URL: "https://configured.azure",
    AZURE_OPENAI_API_VERSION: "2024-10-21",
    KEEP_ENV: "keep",
  });
});
