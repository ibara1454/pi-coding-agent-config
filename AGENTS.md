# Repository Guidelines

## Project Overview

This repository is a personal [Pi Coding Agent](https://github.com/earendil-works/pi) configuration organized as a Bun workspace monorepo. `packages/` contains self-contained TypeScript extensions. `apps/agent/` contains the Pi configuration; its tracked `settings.json` loads `../../packages/*`. The root `package.json` and `bun.lock` manage workspace dependencies. Pi controls extension discovery and lifecycle.

## Architecture & Data Flow

- Extension entry points are default-export factories. Pi loads a factory, then it registers `pi.on(...)` lifecycle handlers and composes host UI/tool APIs.
- Keep mutable state closure-local to the extension. Update it from session/model/agent/tool events, then request a render or update host UI state.
- Status line: `packages/omp-status-line/index.ts` reads global and project settings, aggregates session/context/git state, renders declarative segments, then wraps the editor and footer. `segments.ts` is the segment-rendering boundary; `types.ts`, `presets.ts`, and `theme.ts` define its contracts and presentation data.
- Welcome UI: `packages/omp-welcome/index.ts` collects extension/session data and installs a responsive header. `data.ts` handles discovery/settings snapshots; `welcome.ts` renders; `resource-inventory.ts` contains a deliberately guarded private-host compatibility seam that must fail open when the host changes.
- Provider base URL overrides: `packages/provider-base-url-overrides/index.ts` validates `PROVIDER_BASE_URL`, wraps effective Pi Providers at `session_start`, routes model base URLs by API type, and delegates original provider behavior; see its scoped README for the mapping.
- Sandbox: `packages/sandbox/index.ts` layers defaults, global, and project policy before replacing Pi's bash tool with `SandboxManager` operations.
- Agent configuration: `apps/agent/settings.json` loads package directories through `../../packages/*`; credentials and runtime state remain ignored beside it.

## Key Directories

- `packages/omp-status-line/` — self-contained ESM status-line/editor-chrome extension and Bun test package.
- `packages/omp-welcome/` — self-contained ESM welcome-header extension and Bun test package.
- `packages/provider-base-url-overrides/` — private ESM Pi extension package with scoped README and Bun tests.
- `packages/sandbox/` — sandbox bash replacement, npm dependency lockfile, and no test suite.
- `apps/agent/` — Pi Coding Agent configuration, runtime ignore rules, managed binary metadata, npm package state, and sandbox policy.
- `apps/agent/schemas/` — JSON Schema assets, currently `sandbox.schema.json` for `apps/agent/sandbox.json`.
- `package.json` and `bun.lock` — authoritative Bun workspace definition and dependency lock.

## Development Commands

Run commands from the repository root unless stated otherwise. There is no root build, lint, or typecheck command.

```bash
# Install every workspace dependency from the root lockfile.
bun install --frozen-lockfile

# Run every extension test.
bun test

# Run one extension's tests.
bun test packages/provider-base-url-overrides
bun test packages/omp-status-line
bun test packages/omp-welcome
```

`packages/sandbox` has no test suite. Do not treat its `bun run build` or `bun run check` commands as validation; both are explicit no-ops.

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
- `package.json` and `bun.lock` — root workspace manifest and dependency lockfile.
- `apps/agent/settings.json` — tracked, non-secret Pi defaults and extension references.
- `apps/agent/sandbox.json` and `apps/agent/schemas/sandbox.schema.json` — sandbox policy and its strict schema.
- `packages/omp-status-line/index.ts` — status-line integration entry point.
- `packages/omp-welcome/index.ts` — welcome integration entry point.
- `packages/sandbox/index.ts` — sandbox tool/policy entry point.
- `packages/provider-base-url-overrides/index.ts` — provider base URL override integration entry point.
- `.gitignore` and `apps/agent/.gitignore` — exclude dependencies, credentials, local Pi state, sessions, and generated binaries.

## Runtime/Tooling Preferences

- Use **Bun** for root workspace dependency installation and tests.
- Extension packages are private ESM packages with Pi entry points declared in their local `package.json` files.
- The sandbox dependency declares Node `>=20.11.0`; this is a sandbox dependency constraint, not evidence of a repository-wide engine declaration.
- Pi-host modules are available in Pi at runtime. Unit tests that import host-facing extensions should mock host modules before dynamically importing the extension, as `packages/omp-status-line/index.test.ts` does.
- `apps/agent/settings.json` is intentionally tracked because it contains the monorepo extension references. Credentials and runtime artifacts (`auth.json`, `models-store.json`, `trust.json`, `sessions/`, and generated binaries) remain ignored.
- Treat extension-specific READMEs as scoped guidance. In particular, sandbox prerequisites apply to sandbox deployment, not every extension.

## Testing & QA

- Tests use `bun:test`; there is no Jest, Vitest, coverage configuration, root build, root lint, or root typecheck command.
- Run all declared tests with `bun test`.
- Current coverage is localized: `packages/omp-status-line/index.test.ts` covers responsive status-line behavior; `packages/omp-welcome/*.test.ts` covers rendering, discovery, terminal-cell safety, lifecycle, gradients, and inventory overrides; `packages/provider-base-url-overrides/index.test.ts` covers URL validation, API mapping, provider delegation, Azure precedence, and lifecycle/immutability. `packages/sandbox/` has no test script or test files.
- Add tests beside their implementation and exercise observable behavior: rendered output, terminal-cell budgets, configuration precedence, fail-open compatibility guards, and lifecycle cleanup.
- Prefer lightweight fake Pi/UI/context objects over broad integration setup. For filesystem/configuration tests, create deterministic temp roots, restore environment variables, invoke shutdown/dispose paths, and remove temp data in `finally`/`afterEach`.
- Run the affected extension's test command before delivering a permanent behavior change.
