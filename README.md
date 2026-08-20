# Pi Coding Agent Configuration

This repository contains personal configuration and customized extensions for
[pi-coding-agent](https://github.com/earendil-works/pi).

Run `npm ci` after cloning to install dependencies for every extension workspace.

## Key extensions

This table highlights packaged extensions and is not an exhaustive list of standalone integrations.

| Extension | Purpose | Scoped guidance and test status |
| --- | --- | --- |
| [`provider-base-url-overrides`](packages/provider-base-url-overrides/README.md) | Routes effective Pi provider model base URLs from `PROVIDER_BASE_URL`. | `npm test --workspace packages/provider-base-url-overrides` |
| [`omp-status-line`](packages/omp-status-line/README.md) | Renders Pi's status line and editor chrome. | `npm test --workspace packages/omp-status-line` |
| [`omp-welcome`](packages/omp-welcome/README.md) | Renders Pi's startup welcome UI. | `npm test --workspace packages/omp-welcome` |
| [`sandbox`](packages/sandbox/README.md) | Replaces Pi's bash tool with schema-backed sandbox policy. | Dependencies are installed by root `npm ci`; no test suite. |

## Testing

Run every declared package test from the repository root:

```bash
npm test --workspaces --if-present
```
