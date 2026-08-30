# Provider Base URL Overrides

This extension rewrites model base URLs for effective Pi Providers at `session_start` when `PROVIDER_BASE_URL` is valid. It routes model endpoints by API type and does not implement or validate a proxy protocol.

## Activate and configure

From the repository root, load the extension for a one-off Pi run:

```sh
PROVIDER_BASE_URL=http://127.0.0.1:8787 pi -e ./packages/provider-base-url-overrides/index.ts
```

When `apps/agent` is used as `PI_CODING_AGENT_DIR`, its tracked `settings.json` loads the extension through `../../packages/*`; in that case, omit `-e`. Setting `PROVIDER_BASE_URL` only enables routing after the extension is loaded.

### Model API mapping

| Model API | Routed `model.baseUrl` |
| --- | --- |
| `anthropic-messages` | `${PROVIDER_BASE_URL}` |
| `openai-completions` | `${PROVIDER_BASE_URL}/v1` |
| `openai-responses` | `${PROVIDER_BASE_URL}/v1` |
| `azure-openai-responses` | `${PROVIDER_BASE_URL}/v1` |
| `openai-codex-responses` | `${PROVIDER_BASE_URL}/v1` |
| `google-generative-ai` | `${PROVIDER_BASE_URL}/v1beta` |
| `google-vertex` | `${PROVIDER_BASE_URL}` |
| `mistral-conversations`, `bedrock-converse-stream`, `pi-messages`, custom/unknown APIs | Original model URL unchanged |

The root is trimmed once. Anthropic and Vertex use the exact trimmed root, including a trailing `/`. For `/v1` and `/v1beta` routes, all trailing `/` characters are removed, then exactly one separator and the suffix are appended. Existing suffixes are not deduplicated: a root ending in `/v1` becomes `/v1/v1`, and a root ending in `/v1beta` becomes `/v1beta/v1beta`.

## Validation

- `PROVIDER_BASE_URL` is the only variable read; `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, and `GEMINI_BASE_URL` are ignored.
- After trimming, a missing or blank value disables the extension silently.
- A nonblank value must be an absolute `http://` or `https://` URL with a hostname; credentials, port, and path are allowed.
- ASCII control characters, query strings, and fragments are rejected.
- An invalid nonblank value emits one warning during initialization without echoing the configured URL.
- At `session_start`, the model registry must expose callable `getAll` and `getProvider` methods and return an array. Entries without a nonempty string provider ID are ignored.
- Before wrapping, a Provider must match the requested ID, expose string `name`, object `auth`, and the required Provider methods, and have only callable or nullish optional methods.
- Routed models must expose string `api` and `baseUrl` fields. Azure transport options must be objects, and a supplied `options.env` must contain only string values.

## Runtime and limitations

`PROVIDER_BASE_URL` is captured when the extension initializes. The only lifecycle hook is `session_start`; at that event, the extension snapshots unique provider IDs represented then and wraps those effective Providers. A same-ID wrapper copies `id`, `name`, `headers`, and `auth`, and sets its `baseUrl` to the trimmed proxy root. It delegates `getModels`, `stream`, and `streamSimple`, plus `refreshModels`, `filterModels`, `fetchDeferred`, and `cancelDeferred` when present, to the original Provider with the original receiver. Routed model objects are cloned. Azure transport options and env maps are cloned before endpoint fields are overwritten; non-Azure options retain their original identity. Original Providers, models, and caller option/env objects are not mutated.

Registry or hook inspection failures emit a generic warning and leave the extension inactive without blocking session startup. Invalid registry entries are ignored; invalid Providers and failed registrations skip only the affected override, warn without echoing external values, and allow remaining Providers to install. Once installed, a wrapper exposes malformed routed model data and Azure option/env data as `TypeError`; failures from original Provider methods propagate unchanged.

Providers added later are not wrapped until a later `session_start`, such as after Pi `/reload`. Changing the process environment requires reinitialization; the extension does not poll. Unsupported API types keep their original model URLs. Custom transports that ignore `model.baseUrl` cannot be forced through this extension.

### Azure OpenAI

For `azure-openai-responses`, the wrapper overwrites both `options.azureBaseUrl` and `options.env.AZURE_OPENAI_BASE_URL` with the routed `/v1` URL. Other option and environment fields are preserved, caller objects remain unchanged, and non-Azure option identity is preserved.

## Focused test

From the repository root:

```sh
bun test packages/provider-base-url-overrides
```

## Security

The routed endpoint can receive provider headers and credentials, prompts, tool content, and other request data. The extension does not redact or secure this traffic. Use only a trusted endpoint; prefer HTTPS except for trusted loopback or local use.
