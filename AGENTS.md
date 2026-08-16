# Repository Guidelines

## Project Overview

This repository is a personal [Pi Coding Agent](https://github.com/earendil-works/pi) configuration plus custom TypeScript extensions. It is **not** a root application or workspace: source, dependencies, and tests are scoped per extension. Pi controls extension discovery and lifecycle; root `settings.json` provides runtime defaults but does not itself enumerate enabled extensions.

## Architecture & Data Flow

- Extension entry points are default-export factories. Pi loads a factory, then it registers `pi.on(...)` lifecycle handlers and composes host UI/tool APIs.
- Keep mutable state closure-local to the extension. Update it from session/model/agent/tool events, then request a render or update host UI state.
- Status line: `extensions/omp-status-line/index.ts` reads global and project settings, aggregates session/context/git state, renders declarative segments, then wraps the editor and footer. `segments.ts` is the segment-rendering boundary; `types.ts`, `presets.ts`, and `theme.ts` define its contracts and presentation data.
- Welcome UI: `extensions/omp-welcome/index.ts` collects extension/session data and installs a responsive header. `data.ts` handles discovery/settings snapshots; `welcome.ts` renders; `resource-inventory.ts` contains a deliberately guarded private-host compatibility seam that must fail open when the host changes.
- Provider base URL overrides: `extensions/provider-base-url-overrides/index.ts` validates `PROVIDER_BASE_URL`, wraps effective Pi Providers at `session_start`, routes model base URLs by API type, and delegates original provider behavior; see its scoped README for the mapping.
- Sandbox: `extensions/sandbox/index.ts` layers defaults, global, and project policy before replacing Pi's bash tool with `SandboxManager` operations.
- `extensions/atuin.ts` is a non-invasive bash-event observer. `extensions/herdr-agent-state.ts` is Herdr-managed/generated integration; do not hand-maintain it because Herdr can overwrite it.

## Key Directories

- `extensions/omp-status-line/` — self-contained ESM status-line/editor-chrome extension and Bun test package.
- `extensions/omp-welcome/` — self-contained ESM welcome-header extension and Bun test package.
- `extensions/provider-base-url-overrides/` — private ESM Pi extension package with scoped README and Bun tests.
- `extensions/sandbox/` — sandbox bash replacement, schema-backed policy, npm dependency lockfile, and no test suite.
- `extensions/*.ts` — standalone host-loaded integrations without package manifests; `bootstrap.sh` does not install dependencies for these files.
- `schemas/` — JSON Schema assets, currently `schemas/sandbox.schema.json` for `sandbox.json`.
- `bin/` — Pi-managed platform binaries such as `fd` and `rg`; do not edit or commit generated binaries.
- `npm/` — empty private npm metadata, not a workspace or root command package.

## Development Commands

Run commands from the stated directory; there is no root `package.json`, root build, root lint, root typecheck, or root test command.

```bash
# Repository root: install dependencies for every extension package.
bash bootstrap.sh

# Provider base URL overrides extension tests.
cd extensions/provider-base-url-overrides && npm test

# Status-line extension tests.
cd extensions/omp-status-line && npm test
# Equivalent: bun test

# Welcome extension tests.
cd extensions/omp-welcome && npm test

# Sandbox dependency installation when working only on sandbox.
cd extensions/sandbox && npm ci
```

`bootstrap.sh` uses `npm ci` where an extension has a lockfile and `npm install` otherwise. Do not treat `extensions/sandbox`'s `npm run build` or `npm run check` as validation: both are explicit no-ops.

## Code Conventions & Common Patterns

- Follow `.editorconfig`: TypeScript uses 2 spaces; keep LF, UTF-8, trimmed trailing whitespace, and a final newline.
- Use ESM imports and Node built-ins with `node:` specifiers. Use `import type` for type-only host contracts.
- Default-export an extension factory, then register host events inside it. Keep lifecycle state, timers, unsubscribe handles, in-flight flags, and TTL caches local to that factory.
- Dispose timers/subscriptions and clear retained session/UI references on `session_shutdown`. UI components with resources expose and call `dispose()`.
- Treat host/process/configuration data as untrusted: parse defensively with runtime guards and allowlists. Preserve documented precedence such as global settings followed by project settings.
- Wrap `pi.exec`, filesystem parsing, sockets, and other external operations in `try`/`catch`; degrade gracefully, retain usable cached state where appropriate, and never block the host tool flow on optional integration failure.
- For async refresh work, use explicit in-flight guards, cache keys, TTLs, and invalidation from relevant events instead of spawning redundant work per render.
- Terminal UI must be ANSI- and terminal-cell-safe. Use host width/truncation helpers, sanitize status text, preserve OSC 8 hyperlink closure, and test exact visible-width behavior rather than JavaScript string length.
- Keep declarative UI data separate from rendering where existing modules already do so: e.g. status-line presets/theme/types versus `renderSegment`, and welcome discovery data versus `WelcomeHeader` rendering.
- Match colocated test naming: `index.ts` → `index.test.ts`; use lowercase behavior-focused test descriptions.

## Important Files

- `README.md` — repository purpose and root setup entry point.
- `bootstrap.sh` — authoritative per-extension dependency installer.
- `settings.json` — local Pi model/status defaults; runtime state files are ignored and must not be committed casually.
- `sandbox.json` and `schemas/sandbox.schema.json` — sandbox policy and its strict schema.
- `extensions/omp-status-line/index.ts` — status-line integration entry point.
- `extensions/omp-welcome/index.ts` — welcome integration entry point.
- `extensions/sandbox/index.ts` — sandbox tool/policy entry point.
- `extensions/provider-base-url-overrides/index.ts` — provider base URL override integration entry point.
- `.gitignore` — excludes credentials, local Pi state, sessions, and generated binaries.

## Runtime/Tooling Preferences

- Use **npm** for extension dependency installation and **Bun** for the declared test scripts. Do not invent a root workspace workflow.
- Extension packages are private ESM packages with Pi entry points declared in their local `package.json` files.
- The sandbox dependency declares Node `>=20.11.0`; this is a sandbox dependency constraint, not evidence of a repository-wide engine declaration.
- Pi-host modules are available in Pi at runtime. Unit tests that import host-facing extensions should mock host modules before dynamically importing the extension, as `extensions/omp-status-line/index.test.ts` does.
- Local credentials/configuration/session artifacts (`auth.json`, `models-store.json`, `settings.json`, `trust.json`, `sessions/`) are ignored. Never add or expose them in commits.
- Treat extension-specific READMEs as scoped guidance. In particular, sandbox installation paths and prerequisites apply to sandbox deployment, not every extension.

## Testing & QA

- Tests use `bun:test`; there is no Jest, Vitest, coverage configuration, or repository-wide test command.
- Current coverage localized: `extensions/omp-status-line/index.test.ts` covers responsive status-line behavior; `extensions/omp-welcome/*.test.ts` covers rendering, discovery, terminal-cell safety, lifecycle, gradients, inventory overrides; `extensions/provider-base-url-overrides/index.test.ts` covers URL validation, API mapping, provider delegation, Azure precedence, and lifecycle/immutability. `extensions/sandbox/` has no test script or test files.
- Add tests beside their implementation and exercise observable behavior: rendered output, terminal-cell budgets, configuration precedence, fail-open compatibility guards, and lifecycle cleanup.
- Prefer lightweight fake Pi/UI/context objects over broad integration setup. For filesystem/configuration tests, create deterministic temp roots, restore environment variables, invoke shutdown/dispose paths, and remove temp data in `finally`/`afterEach`.
- Run the affected extension's test command before delivering a permanent behavior change. Do not claim unrun build/lint/typecheck checks: none are defined at the repository level.
