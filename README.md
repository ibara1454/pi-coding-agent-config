# Pi Coding Agent Configuration

This repository contains personal configuration and customized extensions for
[pi-coding-agent](https://github.com/earendil-works/pi).

Run `bun install --frozen-lockfile` after cloning to install workspace dependencies.

## Key extensions

This table highlights packaged extensions and is not an exhaustive list of standalone integrations.

| Extension | Purpose | Scoped guidance and test status |
| --- | --- | --- |
| [`provider-base-url-overrides`](packages/provider-base-url-overrides/README.md) | Routes effective Pi provider model base URLs `PROVIDER_BASE_URL`. | `bun test packages/provider-base-url-overrides` |
| [`omp-status-line`](packages/omp-status-line/README.md) | Renders Pi's status line editor chrome. | `bun test packages/omp-status-line` |
| [`omp-welcome`](packages/omp-welcome/README.md) | Renders Pi's startup welcome UI. | `bun test packages/omp-welcome` |
| [`sandbox`](packages/sandbox/README.md) | Replaces Pi's bash tool schema-backed sandbox policy. | Dependencies installed with `bun install --frozen-lockfile`; no test suite. |

## Validation

Run all lint and type-check tasks through Turborepo:

```bash
bun run check
```

Check formatting, recommended lint rules, and import organization for every
workspace:

```bash
bun run lint
```

Apply safe Biome fixes:

```bash
bun run lint:fix
```

Run strict type checking for every workspace:

```bash
bun run typecheck
```

Run all extension tests through Turborepo:

```bash
bun run test
```

Use the focused `bun test packages/...` commands above while iterating on one extension.
