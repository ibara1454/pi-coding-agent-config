# Pi Coding Agent Configuration

This repository contains personal configuration and customized extensions for
[pi-coding-agent](https://github.com/earendil-works/pi).

Run `./bootstrap.sh` after cloning to install dependencies for all extensions.

## Key extensions

This table highlights packaged extensions and is not an exhaustive list of standalone integrations.

| Extension | Purpose | Scoped guidance and test status |
| --- | --- | --- |
| [`provider-base-url-overrides`](extensions/provider-base-url-overrides/README.md) | Routes effective Pi provider model base URLs from `PROVIDER_BASE_URL`. | `cd extensions/provider-base-url-overrides && npm test` |
| [`omp-status-line`](extensions/omp-status-line/README.md) | Renders Pi's status line and editor chrome. | `cd extensions/omp-status-line && npm test` |
| [`omp-welcome`](extensions/omp-welcome/README.md) | Renders Pi's startup welcome UI. | `cd extensions/omp-welcome && npm test` |
| [`sandbox`](extensions/sandbox/README.md) | Replaces Pi's bash tool with schema-backed sandbox policy. | No test suite; `cd extensions/sandbox && npm ci` |

## Testing

There is no root test command. Run each package command from its extension directory:

```bash
cd extensions/provider-base-url-overrides && npm test
cd extensions/omp-status-line && npm test
cd extensions/omp-welcome && npm test
```
