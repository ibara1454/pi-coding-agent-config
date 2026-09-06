# Repository Guidelines

## Project Overview

This repository is a personal [Pi Coding Agent](https://github.com/earendil-works/pi) configuration organized as a Bun workspace monorepo. `apps/` contains self-contained TypeScript extensions; `packages/` is reserved for shared libraries. `config/pi/` contains the non-workspace Pi configuration; its tracked `settings.json` loads `../../apps`. The root `package.json` and `bun.lock` manage workspace dependencies. Pi controls extension discovery and lifecycle. Follow the placement constraints and installation options in `README.md`.

## Architecture & Data Flow

- Extension manager: `apps/extension-manager/index.ts` delegates `/extensions` registration to `extension-command.ts`, which discovers settings resources into a catalog, opens the panel, and reports commits; `extension-runtime.ts` binds discovery, persistence, panel creation, and disposal.
- Status line: `apps/omp-status-line/index.ts` reads global and project settings, aggregates session/context/git state, renders declarative segments, then wraps the editor and footer. `segments.ts` is the segment-rendering interface; `types.ts`, `presets.ts`, and `theme.ts` define its contracts and presentation data.
- Welcome UI: `apps/omp-welcome/index.ts` collects extension/session data and installs a responsive header. `data.ts` handles discovery/settings snapshots; `welcome.ts` renders; `resource-inventory.ts` is a deliberately guarded, fail-open private-host compatibility layer.
- Provider base URL overrides: `apps/provider-base-url-overrides/index.ts` validates `PROVIDER_BASE_URL`, wraps effective Pi Providers at `session_start`, routes model base URLs by API type, and delegates original provider behavior; see its scoped README for the mapping.
- Sandbox: `apps/sandbox/index.ts` layers defaults, global, and project policy before replacing Pi's bash tool with `SandboxManager` operations.
- Agent configuration: `config/pi/settings.json` loads extension packages through `../../apps`; credentials and runtime state remain ignored beside it. `PI_CODING_AGENT_DIR` must name the canonical configuration directory, not `settings.json` or an unresolved symlink.

## Key Directories

- `apps/extension-manager/` — private ESM `/extensions` discovery, persistence, and terminal UI package with Bun tests.
- `apps/omp-status-line/` — self-contained ESM status-line/editor-chrome extension and Bun test package.
- `apps/omp-welcome/` — self-contained ESM welcome-header extension and Bun test package.
- `apps/provider-base-url-overrides/` — private ESM Pi extension package with scoped README and Bun tests.
- `apps/sandbox/` — OS-level sandboxing for Pi's Bash tool.
- `packages/` — shared library packages, as they are added.
- `config/pi/` — Pi configuration, runtime ignore rules, managed binary metadata, npm package state, and sandbox policy.
- `config/pi/schemas/` — JSON Schema assets, currently `sandbox.schema.json` for `config/pi/sandbox.json`.
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
bun test apps/extension-manager
bun test apps/provider-base-url-overrides
bun test apps/omp-status-line
bun test apps/omp-welcome
bun test apps/sandbox
```

## Code Conventions & Common Patterns

- Follow `.editorconfig`: TypeScript uses 2 spaces; keep LF, UTF-8, trimmed trailing whitespace, and a final newline.
- Use ESM imports and Node built-ins with `node:` specifiers. Use `import type` for type-only host contracts.
- Pi-host-loaded package entries default-export only the declared extension factory and do not re-export implementation helpers. Keep mutable session state closure-local, and release timers, subscriptions, panels, terminal modes, and retained host references on shutdown and every earlier exit path.
- UI components with resources expose and call `dispose()`.
- Wrap `pi.exec`, filesystem parsing, sockets, and other external operations in `try`/`catch`; degrade gracefully, retain usable cached state where appropriate, and never block the host tool flow on optional integration failure.
- For Pi refresh work triggered by events or renders, reuse matching in-flight work and invalidate cached results when relevant inputs change.
- Pi terminal UI must use cell-width and ANSI helpers, sanitize external inline text, and close OSC 8 hyperlinks within the rendered surface.
- Keep declarative UI data separate from rendering where existing modules already do so: e.g. status-line presets/theme/types versus `renderSegment`, and welcome discovery data versus `WelcomeHeader` rendering.
- Name direct suites `*.test.ts`; use `*.integration.test.ts` when the result is owned by another production module, an external runtime, or real filesystem/process semantics. Use lowercase behavior-focused descriptions.

## Important Files

- `README.md` — repository purpose and root setup entry point.
- `package.json` and `bun.lock` — root workspace manifest and dependency lockfile.
- `config/pi/settings.json` — tracked, non-secret Pi defaults and extension references.
- `config/pi/sandbox.json` and `config/pi/schemas/sandbox.schema.json` — sandbox policy and its strict schema.
- `apps/extension-manager/index.ts` — extension-manager host entry point.
- `apps/omp-status-line/index.ts` — status-line integration entry point.
- `apps/omp-welcome/index.ts` — welcome integration entry point.
- `apps/sandbox/index.ts` — sandbox tool/policy entry point.
- `apps/provider-base-url-overrides/index.ts` — provider base URL override integration entry point.
- `.gitignore` and `config/pi/.gitignore` — exclude dependencies, credentials, local Pi state, sessions, and generated binaries.

## Runtime/Tooling Preferences

- Use **Bun** for root workspace dependency installation and tests.
- Extension packages are private ESM packages with Pi entry points declared in their local `package.json` files.
- The sandbox dependency declares Node `>=20.11.0`; this is a sandbox dependency constraint, not evidence of a repository-wide engine declaration.
- Pi-host modules are available in Pi at runtime. Host-facing integration tests should mock Pi runtime modules before dynamically importing the extension, as `apps/omp-status-line/index.integration.test.ts` does.
- `config/pi/settings.json` is intentionally tracked because it contains the monorepo extension references. Credentials and runtime artifacts (`auth.json`, `models-store.json`, `trust.json`, `sessions/`, and generated binaries) remain ignored.
- Treat extension-specific READMEs as scoped guidance. In particular, sandbox prerequisites apply to sandbox deployment, not every extension.

## Testing & QA

- Tests use `bun:test`; there is no Jest, Vitest, or root build command.
- `bun run test` dispatches the workspace `test` tasks through Turborepo. Root `bunfig.toml` preloads `test/setup.ts` for direct Bun test runs; the preload restores spies and clears mock calls after each test but does not undo `mock.module(...)` overrides.
- Add tests beside their implementation and exercise observable behavior: rendered output, terminal-cell budgets, configuration precedence, fail-open compatibility guards, and lifecycle cleanup.
- Prefer lightweight fake Pi/UI/context objects over broad integration setup. For filesystem/configuration tests, create deterministic temp roots, restore environment variables, invoke shutdown/dispose paths, and remove temp data in `finally`/`afterEach`.
- Run the affected extension's test command before delivering a permanent behavior change.

## Agent skills

### Repository engineering

Before implementing or reviewing any repository change, read and apply `docs/agents/engineering.md`; it governs module/interface design, exports, resource ownership, cross-interface dispatch, tests and snapshots, and deviations.

### Issue tracker

Issues and specs live in this repository’s GitHub Issues through `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
