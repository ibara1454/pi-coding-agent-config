# Coding Standards

Patterns are relative to the repository root; `**` matches zero or more directories. Apply every matching section, including repository-wide rules. Conditions beside a pattern narrow its scope.

## All files

**Files:** `**/*` (including dotfiles).

Repository **MUST** and **SHOULD** rules, including their negative forms, are requirements. Voluntary deviations need another reviewer's `ACCEPT`; unaccepted waivers leave work incomplete. Higher-priority instructions take precedence: record conflicts as authorized overrides, without requesting a waiver.

- Follow `.editorconfig`: keep LF, UTF-8, trimmed trailing whitespace, and a final newline; use the indentation configured for the file type.
- Use code to express **how** it works, tests to specify **what** it should do, commit messages to explain **why** it changed, and code comments to explain **why not**—why an otherwise reasonable alternative was rejected.
- Use **Bun** for root workspace dependency installation and tests. Run the affected workspace's test command before delivering a permanent behavior change.
- **Implementation and interface review:** Before implementing, refactoring, or reviewing functions, methods, module boundaries, parameters/results, exports, validation/failures, effects, or resource lifetimes, MUST use the `repo-design` skill.
- **Test design and review:** Before designing, adding, modifying, or reviewing tests, selecting test levels or mocks, naming suites/cases, building tables, or changing snapshots, MUST use the `repo-testing` skill.

## TypeScript

**Files:** `**/*.ts`.

- Use 2-space indentation, as configured in `.editorconfig`.
- Use ESM imports and Node built-ins with `node:` specifiers. Use `import type` for type-only host contracts.
- Do not inject stable built-ins such as `Date.now` solely for testing when a scoped spy is sufficient. Pass domain inputs and caller-owned operations instead.

```ts
function hasExpired(expiresAt: number): boolean {
  return Date.now() >= expiresAt;
}
```

### Pi extension entry points

**Files:** `apps/*/index.ts` (Pi-host-loaded entry points declared in each extension's `package.json`).

- Pi-host-loaded package entries default-export only the declared extension factory and do not re-export implementation helpers.

### Pi extension runtime

**Files:** `apps/**/*.ts` (runtime implementation, excluding test suites and test helpers).

- Keep mutable session state closure-local, and release timers, subscriptions, panels, terminal modes, and retained host references on shutdown and every earlier exit path.
- Wrap `pi.exec`, filesystem parsing, sockets, and other external operations in `try`/`catch`; degrade gracefully, retain usable cached state where appropriate, and never block the host tool flow on optional integration failure.
- For Pi refresh work triggered by events or renders, reuse matching in-flight work and invalidate cached results when relevant inputs change.

### Terminal UI

**Files:** `apps/**/*.ts` (components implementing or rendering terminal UI).

- UI components with resources expose and call `dispose()`.
- Pi terminal UI must use cell-width and ANSI helpers, sanitize external inline text, and close OSC 8 hyperlinks within the rendered surface.
- Keep declarative UI data separate from rendering where existing modules already do so: e.g. status-line presets/theme/types versus `renderSegment`, and welcome discovery data versus `WelcomeHeader` rendering.

### Implementation and test pairing

**Files:** `**/*.ts`, except `packages/biome-rules/**/*.ts`.

- Every implementation `name.ts` MUST have a same-directory `name.test.ts` unit-test file; every `name.test.ts` MUST have its corresponding `name.ts` implementation.
- An integration suite `name.integration.test.ts` MUST have a same-directory `name.ts` implementation. It supplements, but does not replace, `name.test.ts`.
- Scenario suffixes are literal: `name.errors.test.ts` requires `name.errors.ts`. Put scenarios for `name.ts` in `name.test.ts` instead.
- Pure re-export barrels, type-only modules, and test helpers/shared setup are exempt from requiring their own unit-test files. Runtime entry points are not exempt merely because they are named `index.ts`. Tests MUST exercise meaningful behavior; do not create empty implementations or artificial suites to satisfy pairing.

### Tests and shared setup

**Files:** `**/*.test.ts`, `test/**/*.ts`.

- Test suites use `bun:test`; there is no Jest or Vitest.
- Add tests beside their implementation and exercise observable behavior: rendered output, terminal-cell budgets, configuration precedence, fail-open compatibility guards, and lifecycle cleanup.
- Host-facing integration tests use real Pi exports and lightweight fake contexts or scoped, restored spies, as `apps/omp-status-line/index.integration.test.ts` does. Avoid global `mock.module(...)` overrides: they persist across suites.
- Root `bunfig.toml` preloads `test/setup.ts` for direct Bun test runs; the preload restores spies and clears mock calls after each test but does not undo `mock.module(...)` overrides.

## Workspace manifests and tooling

**Files:** `package.json`, `bun.lock`, `bunfig.toml`, `turbo.jsonc`, `apps/*/package.json`, `packages/*/package.json`.

- `bun run test` dispatches the workspace `test` tasks through Turborepo. There is no root build command.

### Pi extension manifests

**Files:** `apps/*/package.json`.

- Extension packages are private ESM packages with Pi entry points declared in their local `package.json` files.

## Package-specific guidance

**Files:** `apps/**/*`, `packages/biome-rules/**/*`.

- For `apps/**/*`, treat extension-specific READMEs as scoped guidance. In particular, sandbox prerequisites apply to sandbox deployment, not every extension.
- For changes to `packages/biome-rules/**/*`, read the custom-rule testing notes in `packages/biome-rules/README.md`.
