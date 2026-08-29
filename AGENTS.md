# Repository Guidelines

## Project Overview

This repository is a personal [Pi Coding Agent](https://github.com/earendil-works/pi) configuration organized as a Bun workspace monorepo. `packages/` contains self-contained TypeScript extensions. `apps/agent/` contains the Pi configuration; its tracked `settings.json` loads `../../packages/*`. The root `package.json` and `bun.lock` manage workspace dependencies. Pi controls extension discovery and lifecycle.

## Architecture & Data Flow

- Extension manager: `packages/extension-manager/index.ts` delegates `/extensions` registration to `extension-command.ts`, which discovers settings resources into a catalog, opens the panel, and reports commits; `extension-runtime.ts` binds discovery, persistence, panel creation, and disposal.
- Status line: `packages/omp-status-line/index.ts` reads global and project settings, aggregates session/context/git state, renders declarative segments, then wraps the editor and footer. `segments.ts` is the segment-rendering interface; `types.ts`, `presets.ts`, and `theme.ts` define its contracts and presentation data.
- Welcome UI: `packages/omp-welcome/index.ts` collects extension/session data and installs a responsive header. `data.ts` handles discovery/settings snapshots; `welcome.ts` renders; `resource-inventory.ts` is a deliberately guarded, fail-open private-host compatibility layer.
- Provider base URL overrides: `packages/provider-base-url-overrides/index.ts` validates `PROVIDER_BASE_URL`, wraps effective Pi Providers at `session_start`, routes model base URLs by API type, and delegates original provider behavior; see its scoped README for the mapping.
- Sandbox: `packages/sandbox/index.ts` layers defaults, global, and project policy before replacing Pi's bash tool with `SandboxManager` operations.
- Agent configuration: `apps/agent/settings.json` loads package directories through `../../packages/*`; credentials and runtime state remain ignored beside it.

## Key Directories

- `packages/extension-manager/` — private ESM `/extensions` discovery, persistence, and terminal UI package with Bun tests.
- `packages/omp-status-line/` — self-contained ESM status-line/editor-chrome extension and Bun test package.
- `packages/omp-welcome/` — self-contained ESM welcome-header extension and Bun test package.
- `packages/provider-base-url-overrides/` — private ESM Pi extension package with scoped README and Bun tests.
- `packages/sandbox/` — sandbox bash replacement, npm dependency lockfile, and no test suite.
- `apps/agent/` — Pi Coding Agent configuration, runtime ignore rules, managed binary metadata, npm package state, and sandbox policy.
- `apps/agent/schemas/` — JSON Schema assets, currently `sandbox.schema.json` for `apps/agent/sandbox.json`.
- `package.json` and `bun.lock` — authoritative Bun workspace definition and dependency lock.

## Development Commands

Run commands from the repository root unless stated otherwise. There is no root build command.

```bash
# Install every workspace dependency from the root lockfile.
bun install --frozen-lockfile

# Run lint and type checking across every workspace.
bun run check

# Run every extension test.
bun run test

# Run one extension's tests.
bun test packages/extension-manager
bun test packages/provider-base-url-overrides
bun test packages/omp-status-line
bun test packages/omp-welcome
```

`packages/sandbox` has no test suite. Do not treat its `bun run build` or `bun run check` commands as validation; both are explicit no-ops.

## Code Conventions & Common Patterns

- Follow `.editorconfig`: TypeScript uses 2 spaces; keep LF, UTF-8, trimmed trailing whitespace, and a final newline.
- Use ESM imports and Node built-ins with `node:` specifiers. Use `import type` for type-only host contracts.
- Pi-host-loaded package entries default-export only the declared extension factory and do not re-export implementation helpers. Keep mutable session state closure-local, and release timers, subscriptions, panels, terminal modes, and retained host references on shutdown and every earlier exit path.
- For Pi refresh work triggered by events or renders, reuse matching in-flight work and invalidate cached results when relevant inputs change.
- Pi terminal UI must use cell-width and ANSI helpers, sanitize external inline text, and close OSC 8 hyperlinks within the rendered surface.

## Important Files

- `README.md` — repository purpose and root setup entry point.
- `package.json` and `bun.lock` — root workspace manifest and dependency lockfile.
- `apps/agent/settings.json` — tracked, non-secret Pi defaults and extension references.
- `apps/agent/sandbox.json` and `apps/agent/schemas/sandbox.schema.json` — sandbox policy and its strict schema.
- `packages/extension-manager/index.ts` — extension-manager host entry point.
- `packages/omp-status-line/index.ts` — status-line integration entry point.
- `packages/omp-welcome/index.ts` — welcome integration entry point.
- `packages/sandbox/index.ts` — sandbox tool/policy entry point.
- `packages/provider-base-url-overrides/index.ts` — provider base URL override integration entry point.
- `.gitignore` and `apps/agent/.gitignore` — exclude dependencies, credentials, local Pi state, sessions, and generated binaries.

## Runtime/Tooling Preferences

- Use **Bun** for root workspace dependency installation and tests.
- Extension packages are private ESM packages with Pi entry points declared in their local `package.json` files.
- The sandbox dependency declares Node `>=20.11.0`; this is a sandbox dependency constraint, not evidence of a repository-wide engine declaration.
- `apps/agent/settings.json` is intentionally tracked because it contains the monorepo extension references. Credentials and runtime artifacts (`auth.json`, `models-store.json`, `trust.json`, `sessions/`, and generated binaries) remain ignored.
- Treat extension-specific READMEs as scoped guidance. In particular, sandbox prerequisites apply to sandbox deployment, not every extension.

## Testing & QA

- Tests use `bun:test`; there is no Jest, Vitest, or root build command.
- `bun run test` dispatches the workspace `test` tasks through Turborepo. Root `bunfig.toml` preloads `test/setup.ts` for direct Bun test runs; the preload restores spies and clears mock calls after each test but does not undo `mock.module(...)` overrides.
- `bun run test:coverage` runs the tested packages' coverage commands; no threshold is enforced, and CI does not run coverage.

## Agent skills

### Repository engineering

Before implementing or reviewing any repository change, read and apply `docs/agents/engineering.md`; it governs module/interface design, exports, resource ownership, cross-interface dispatch, tests and snapshots, and deviations.

### Issue tracker

Issues and specs live in this repository’s GitHub Issues through `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
