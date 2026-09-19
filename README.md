# Pi Coding Agent Configuration

This repository contains personal configuration and customized extensions for
[pi-coding-agent](https://github.com/earendil-works/pi).

## Repository layout

- `apps/` contains **Pi extension packages only**. Each extension is a complete
  package with its own `package.json`, entrypoint, and supporting files.
- `packages/` contains shared libraries and development tooling.
- `config/pi/` contains Pi configuration and local runtime state. It is not an
  application or a Bun workspace package.

`config/pi/settings.json` loads every extension package in `apps/` through
`"extensions": ["../../apps"]`. Keep non-extension applications out of `apps/`.
Before introducing one, replace that directory-wide setting with explicit paths
to the Pi extension packages.

## Installation

Install [Pi](https://github.com/earendil-works/pi) and [Bun](https://bun.com/)
separately, then choose one of the following setups.

### Use the entire repository

1. Copy or clone the entire repository to local storage and open its root
   directory. Keep `apps/` and `config/pi/` in their existing relative locations.
2. Install the workspace dependencies:

   ```sh
   bun install --frozen-lockfile
   ```

3. Point Pi at the canonical configuration directory:

   ```sh
   export PI_CODING_AGENT_DIR="$(realpath config/pi)"
   ```

4. Start Pi:

   ```sh
   pi
   ```

**`PI_CODING_AGENT_DIR` must name the directory containing `settings.json`, not
the JSON file itself.** The export above selects `config/pi/settings.json` and
makes its `../../apps` extension path resolve to this repository's `apps/`.

The export lasts for the current shell and its child processes. To make it
persistent, add an equivalent export with the canonical absolute directory to
your own shell startup configuration. No shell files are modified by this
repository.

An existing `~/.pi/agent` symlink may point to `config/pi/`, but pass its resolved
target to Pi rather than the symlink's spelling:

```sh
export PI_CODING_AGENT_DIR="$(realpath "$HOME/.pi/agent")"
```

Using an unresolved symlink as the configuration directory can break relative
extension paths and dependency lookup. This setup needs neither an `extensions`
symlink nor a `node_modules` symlink inside `config/pi/`.

### Copy extensions into your own Pi configuration

Use this option to keep an existing Pi configuration independent of this
repository.

1. Copy each desired **complete package directory** from `apps/` into your Pi
   configuration's `extensions/` directory. For example, copy `apps/sandbox/` to
   `~/.pi/agent/extensions/sandbox/`. If `PI_CODING_AGENT_DIR` is already set, use
   its `extensions/` directory instead. Include `package.json`, the entrypoint,
   supporting source files, and assets; omit generated `node_modules/` directories.
2. Open each copied package directory and install its runtime dependencies there:

   ```sh
   bun install --production
   ```

3. Restart Pi or run `/reload`. Pi automatically discovers these package
   directories; do not copy this repository's settings or its `../../apps` entry
   into your independent configuration.

Copying only `index.ts` is insufficient for extensions with supporting modules.
Sandbox users must also meet its [platform requirements](apps/sandbox/README.md#install).

For a one-off run from the repository root after installing workspace dependencies:

```sh
pi -e "$(realpath apps/extension-manager/index.ts)"
```

See Pi's [extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
for other loading options.

## Key extensions

This table highlights packaged extensions and is not an exhaustive list of standalone integrations.

| Extension | Purpose | Scoped guidance and test status |
| --- | --- | --- |
| [`provider-base-url-overrides`](apps/provider-base-url-overrides/README.md) | Routes effective Pi provider model base URLs with `PROVIDER_BASE_URL`. | `bun test apps/provider-base-url-overrides` |
| [`omp-status-line`](apps/omp-status-line/README.md) | Renders Pi's status line and editor chrome. | `bun test apps/omp-status-line` |
| [`omp-welcome`](apps/omp-welcome/README.md) | Renders Pi's startup welcome UI. | `bun test apps/omp-welcome` |
| [`extension-manager`](apps/extension-manager/README.md) | Discovers Pi extension resources and toggles them from the `/extensions` panel. | `bun test apps/extension-manager` |
| [`sandbox`](apps/sandbox/README.md) | Replaces Pi's bash tool with schema-backed sandbox policy. | `bun test apps/sandbox` |
| [`omp-lsp`](apps/omp-lsp/README.md) | Adds semantic navigation, refactoring, diagnostics, and optional formatting through installed language servers. | `bun test apps/omp-lsp` |

## Validation

Run all lint and type-check tasks through Turborepo:

```bash
bun run check
```

Check formatting, import organization, and the lint policy in `biome.json`
(`all` preset with project-specific exceptions):

```bash
bun run lint
```

See [the custom Biome rules guide](packages/biome-rules/README.md) for rule
behavior, implementation, and testing guidance.

Apply safe Biome fixes:

```bash
bun run lint:fix
```

Run strict type checking for every workspace:

```bash
bun run typecheck
```

Run all workspace tests through Turborepo:

```bash
bun run test
```

Use the focused `bun test apps/...` commands above while iterating on one extension.

## Testing

A normal run (`bun run test`, or a focused `bun test apps/...`) executes the
declared suite: the direct unit suites, the panel and rendering suites, and the
command-level integration suites.

Every tested workspace preloads the shared `test/setup.ts` seam, which restores spies
and clears mock call state after each test. That cleanup does not revert
`mock.module()` overrides, so the few files that must override host modules install
them at the top level and stay isolated to their own file.

Narrow a run to one file while working on the extension manager panel:

```bash
bun test apps/extension-manager
bun test apps/extension-manager/panel.test.ts
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
