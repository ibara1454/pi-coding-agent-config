# Repository Guidelines

## Project Overview

This repository is a personal [Pi Coding Agent](https://github.com/earendil-works/pi) configuration organized as a Bun workspace monorepo. `apps/` contains self-contained TypeScript extensions; `packages/` contains shared libraries and development tooling. `config/pi/` contains the non-workspace Pi configuration; its tracked `settings.json` loads `../../apps`. The root `package.json` and `bun.lock` manage workspace dependencies. Pi controls extension discovery and lifecycle. Follow the placement constraints and installation options in `README.md`.

## Rules and Guidance

```text
.
|-- CODING_STANDARDS.md        # File-scoped standards for code review agents
|-- .editorconfig              # Formatting settings
|-- biome.jsonc                # Authoritative lint configuration
|-- .agents/skills/
|   |-- repo-design/SKILL.md   # Implementation and interface review rules
|   `-- repo-testing/SKILL.md  # Test design and review rules
`-- docs/
    |-- lint-policy.md         # Lint decisions and rationale
    `-- agents/
        |-- issue-tracker.md   # Issue workflow
        |-- triage-labels.md   # Triage labels
        `-- domain.md          # Domain documentation conventions
```

## Architecture & Data Flow

- Extension manager: `apps/extension-manager/src/index.ts` delegates `/extensions` registration to `src/pi/extension-command.ts`; `src/pi/extension-runtime.ts` binds discovery, persistence, panel creation, and disposal. Implementation and tests are grouped under `src/{pi,catalog,discovery,settings,panel}`.
- Status line: `apps/omp-status-line/src/index.ts` delegates to `src/pi/registration.ts`, which reads settings, aggregates session/context/git state, and wraps the editor and footer. Context, Git, and declarative rendering modules live under `src/{context,git,rendering}`.
- Welcome UI: `apps/omp-welcome/src/index.ts` delegates to `src/pi/registration.ts`. `src/discovery/data.ts` handles discovery/settings snapshots; `src/rendering/welcome.ts` renders; `src/pi/resource-inventory.ts` is a deliberately guarded, fail-open private-host compatibility layer.
- Provider base URL overrides: `apps/provider-base-url-overrides/src/index.ts` delegates to `src/pi/registration.ts`, which validates `PROVIDER_BASE_URL`, wraps effective Pi Providers at `session_start`, routes model base URLs by API type, and delegates original provider behavior; see its scoped README for the mapping.
- OpenShell sandbox: `apps/openshell-sandbox/src/index.ts` registers fail-closed model Bash; scoped modules own session lifecycle, native configuration, SDK resources, and direct-child gateway cleanup. User Bash remains host-side.
- Language servers: `apps/omp-lsp/src/index.ts` delegates to `src/pi/registration.ts`; configuration, host processes, runtime, and workspace operations live under `src/{configuration,host,runtime,workspace}`, with bundled server definitions in `assets/defaults.json`.
- Agent configuration: `config/pi/settings.json` loads extension packages through `../../apps`; credentials and runtime state remain ignored beside it. `PI_CODING_AGENT_DIR` must name the canonical configuration directory, not `settings.json` or an unresolved symlink.

## Key Directories

- `apps/extension-manager/` — private ESM `/extensions` discovery, persistence, and terminal UI package with Bun tests.
- `apps/omp-status-line/` — self-contained ESM status-line/editor-chrome extension and Bun test package.
- `apps/omp-welcome/` — self-contained ESM welcome-header extension and Bun test package.
- `apps/provider-base-url-overrides/` — private ESM Pi extension package with scoped README and Bun tests.
- `apps/openshell-sandbox/` — OpenShell-backed model Bash with colocated unit and integration tests.
- `packages/biome-rules/` — custom GritQL rules with colocated Bun integration tests.
- `config/pi/` — Pi configuration, runtime ignore rules, managed binary metadata, and npm package state.
- `package.json` and `bun.lock` — authoritative Bun workspace definition and dependency lock.

## Development Commands

Run commands from the repository root unless stated otherwise. There is no root build command.

```bash
# Install every workspace dependency from the root lockfile.
bun install --frozen-lockfile

# Run lint and type checking across every workspace.
bun run check

# Run every workspace's tests.
bun run test

# Run one workspace's tests.
bun test apps/extension-manager
bun test apps/provider-base-url-overrides
bun test apps/omp-status-line
bun test apps/omp-welcome
bun test apps/openshell-sandbox
bun test packages/biome-rules
```

## Important Files

- `README.md` — repository purpose and root setup entry point.
- `package.json` and `bun.lock` — root workspace manifest and dependency lockfile.
- `config/pi/settings.json` — tracked, non-secret Pi defaults and extension references.
- `apps/extension-manager/src/index.ts` — extension-manager host entry point.
- `apps/omp-status-line/src/index.ts` — status-line integration entry point.
- `apps/omp-welcome/src/index.ts` — welcome integration entry point.
- `apps/openshell-sandbox/src/index.ts` — OpenShell sandbox Pi factory.
- `apps/provider-base-url-overrides/src/index.ts` — provider base URL override integration entry point.
- `apps/omp-lsp/src/index.ts` — language-server integration entry point.
- `.gitignore` and `config/pi/.gitignore` — exclude dependencies, credentials, local Pi state, sessions, and generated binaries.

## Agent skills

### Issue tracker

Issues and specs live in this repository’s GitHub Issues through `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five canonical triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

For package-specific terminology, context discovery, and ADR locations, see `docs/agents/domain.md`.
