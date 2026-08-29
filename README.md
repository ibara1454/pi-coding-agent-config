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
| [`extension-manager`](packages/extension-manager) | Discovers Pi extensions and resources and toggles them from the `/extensions` panel. | `bun test packages/extension-manager` |
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

## Testing

A normal run (`bun run test`, or a focused `bun test packages/...`) executes every
declared suite: the direct unit suites, the panel and rendering suites, and the
command-level integration suites.

Every tested workspace preloads the shared `test/setup.ts` seam, which restores spies
and clears mock call state after each test. That cleanup does not revert
`mock.module()` overrides, so the few files that must override host modules install
them at the top level and stay isolated to their own file.

Narrow a run to one file while working on the extension manager panel:

```bash
bun test packages/extension-manager
bun test packages/extension-manager/panel.test.ts
```

### Coverage

Coverage is diagnostic only. There are no thresholds, nothing fails on a coverage
number, and CI never collects it:

```bash
bun run test:coverage
```

### Stress mode

Stress mode re-runs every suite in isolated processes, in randomized order, five times
each, to surface order dependence and leaked shared state:

```bash
bun run test:stress
```

`test:coverage` and `test:stress` are uncached Turborepo tasks, so each invocation
re-runs the suites.

### Snapshots

Snapshot updates are always deliberate and manual. Update them locally and review the
resulting diff before committing:

```bash
bun test --update-snapshots
```

CI runs `bun run check` and `bun run test` only. It never updates snapshots, collects
coverage, or runs stress mode.
