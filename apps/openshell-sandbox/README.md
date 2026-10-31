# OpenShell model-Bash sandbox

This Pi extension replaces **model-requested Bash**, not user Bash (`!` and `!!`). Pi, file tools, model traffic, and other extensions' host processes remain outside this boundary. Model Bash is registered fail-closed before SDK or configuration loading: setup, execution, or uncertain cleanup failures never reroute it to the host. User Bash remains host-side even when OpenShell is preparing or failed. This is not whole-agent isolation.

**Native Docker/default-image and macOS behavior remain unverified.** [Automatic tests](#automatic-tests) use controlled effects and do not establish native acceptance.

## Installation and prerequisites

1. Install [Pi](https://github.com/earendil-works/pi), [Bun](https://bun.com/) for the Pi host and workspace tooling, [Docker](https://docs.docker.com/engine/install/) with a working local Unix socket, and the [native OpenShell 0.0.116 release](https://docs.nvidia.com/openshell/about/installation) with `openshell-gateway` on `PATH`. Start Docker and arrange access/file sharing for the selected project yourself; the extension does not install or restart services. Platform branches target Linux/WSL2 and Apple Silicon macOS, but macOS compatibility is unverified. Host Python is not required.
2. Configure [GitHub Packages install authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages) privately before installing dependencies. The root and package-local `bunfig.toml` map `@nvidia` to GitHub Packages and read authentication from `NVIDIA_NPM_TOKEN`; the manifest pins `@nvidia/openshell-sdk@0.0.116`. The mapping selects the registry; it does **not** authenticate. Supply a personal access token (classic) with only `read:packages` and access to the package through your credential tooling for the install command's environment, then remove it before starting Pi. Do not put token values in commands, tracked files, logs, or persistent project environment files. Package-install credentials are separate from sandbox workload providers.
3. From the repository root:

   ```sh
   bun install --frozen-lockfile
   export PI_CODING_AGENT_DIR="$(realpath config/pi)"
   ```

   `PI_CODING_AGENT_DIR` must name the canonical directory containing `settings.json`, not the file or an unresolved symlink. The repository settings discover `../../apps`. For an independent Pi configuration, copy this **entire package**, including `bunfig.toml` and assets, supply the same install-only credential, run `bun install --production` from the copied directory, and load only one model-Bash override. The package-local mapping works without this repository's root configuration.
4. Follow [Configure trusted inputs](#configure-trusted-inputs), including the first-inspection/edit/reload sequence for linked worktrees, **before normal model use**. To start Pi from the repository root:

   ```sh
   bun node_modules/@earendil-works/pi-coding-agent/dist/bun/cli.js
   ```

The SDK 0.0.116 default image is `ghcr.io/nvidia/openshell-community/sandboxes/base:latest`; its mutable tag is accepted, not an immutable toolchain. Guest Node/Bun/Python are not startup requirements, and tool versions, host UID/GID matching, and project writes are not guaranteed. Docker selects the platform normally. A trusted `image` override's compatibility is the operator's responsibility; the extension does not build images or manage their cache.

OpenShell resolves and prepares its supervisor automatically; the extension sets neither `supervisor_bin` nor `supervisor_image`. Its native extractor uses best-effort temporary-container cleanup: a removal failure can warn without blocking startup. This does not change the extension's private gateway/sandbox ownership or normal session cleanup.

## Configure trusted inputs

Add `openShellSandbox` to global `settings.json` under `PI_CODING_AGENT_DIR` or a **trusted** project's `.pi/settings.json`. For example, a complete project settings file selecting a manually maintained local policy and no inherited providers is:

```json
{
  "openShellSandbox": {
    "policyPath": "./openshell-sandbox.yaml",
    "providers": []
  }
}
```

- Precedence is built-in defaults, global settings, then trusted-project fields. Project settings are not read before trust. Trust includes authority to select host credential-variable names, custom profile destinations, and the image.
- Relative `policyPath` and `profilePaths` resolve from the settings file declaring them. `providers` and `profilePaths` replace entire arrays, including `[]`. The selected YAML policy is one complete document, never merged into a broader default.
- Missing settings are optional; malformed/unreadable present settings or selected documents fail closed. Native YAML is mapped to the pinned SDK schema without dropping unknown fields; native validation and enforcement remain authoritative. In policy/profile documents, the map key `__proto__` is rejected, including in nested maps and middleware JSON, because the pinned SDK cannot preserve it safely; other normal keys remain supported.

Before normal model use:

1. Copy the bundled [native baseline](assets/policy.yaml) to the selected `policyPath` and maintain it as a complete policy. Add **absolute canonical project paths** to `filesystem_policy.read_write`. The baseline grants tool paths and selected public GitHub/npm/PyPI operations, not your project's paths; mounts, `include_workdir`, and SDK exec working directories do not grant access.
2. For a linked worktree, first launch Pi for inspection and run `/sandbox`. Copy the complete quoted external Git metadata paths under `Required explicit native read_write grants` into that policy, keeping their quotes and escapes (valid YAML scalars); do not attempt normal model work yet.
3. Review the grants, edit the policy, then run `/reload` to activate it. Do not grant an ancestor directory, host home, SSH credentials, Docker socket, or other worktrees merely to make Git work. Grants remain subject to actual guest identity, host permissions, and Docker file sharing.

For authenticated HTTPS Git, add a provider entry to the effective `providers` array, preserving any other needed entries:

```json
{
  "name": "work-github",
  "profile": "github",
  "credentialMode": "explicit",
  "credentialsFromEnv": { "GITHUB_TOKEN": "WORK_GITHUB_TOKEN" }
}
```

Supply `WORK_GITHUB_TOKEN` through your own credential tooling in the **Pi process environment**. JSON contains variable names, not values; a missing selected value fails rather than silently using anonymous access. Explicit mode is the default; `native-refresh` is recognized but rejected as unsupported, never silently downgraded. Credential environment keys must be unique across attached providers.

Configured provider `name` values are policy-facing identities: explicit `credentialBinding.provider` references must name a configured provider. Each generation translates those references to its unique native provider identities in a separate policy snapshot, without changing the selected policy or its grants.

Select custom profiles with `profilePaths`; see [credential profiles and authenticated clients](adr/0001-openshell-configuration-and-trust-boundaries.md#custom-credential-profiles-and-authenticated-clients) for npm/PyPI guidance and [credential validation](adr/0001-openshell-configuration-and-trust-boundaries.md#credential-authority-and-isolation) for import/alias checks. Credential binding does **not** grant network access: explicitly permit the destination, operation, and executable in the selected policy without disabling TLS verification.

**Migration:** remove every `providers[].client` entry; it is rejected. Native providers supply credential environment placeholders, but workloads must configure Git/npm/pip clients manually while preserving TLS/proxy settings. The extension writes no client configuration, credential helper, or Git `safe.directory` entry. Mismatched mounted ownership may require deliberate, path-specific `safe.directory` configuration. Baseline executable/network grants remain unchanged; Node policy entries do not make Node a startup requirement.

The trusted host gateway and in-container supervisor/proxy handle real provider values; ordinary workload children receive opaque handles. This is not universal credential non-disclosure: an allowed endpoint can return the credential, and a granted project directory exposes raw `.env`/`.npmrc` files within it. Project client files are neither overwritten nor secret-masked. The selected image, native components, policy, and credential-bearing endpoints are trusted inputs.

## Use and recover

- `/sandbox` displays the **current activation's** cached phase, selected policy/image, required explicit native paths, ordinary failure details, and available recovery coordinates. It does not prepare, repair, discover, or delete resources.
- Edit settings, policy, or profiles manually, review permissions, then run `/reload`. Edits do not mutate the active snapshot.
- Every `session_start` (startup, reload, new, resume, fork) gets fresh private resources. Model calls share preparation only within that activation. **SDK readiness is not permission, tool-availability, tool-version, privilege, or project-write proof.** Missing tools and denied operations remain ordinary command failures; permissions are not widened automatically.
- Cancellation/timeout or indeterminate execution invalidates the whole sandbox generation, including concurrent/background work. Confirmed cleanup permits a fresh generation; no command is replayed. A Bash timeout preserves streamed stdout/stderr and uses Pi's timeout result, but uncertain creation/cleanup blocks model Bash and takes precedence over that result.

### After failed shutdown

1. **Save the failed activation's transcript coordinates.** Shutdown publishes available recovery facts before retiring it: gateway endpoint, TLS directory, network ID, and sandbox identity/create outcome where known. Prepared-gateway coordinates remain useful even before sandbox creation; `creation: not started` neither proves creation nor transfers ownership.
2. Use the saved transcript for that failed activation, not a later `/sandbox` display. `/reload` starts an **independent activation**; it does not adopt, repair, or clean up old resources.
3. Before separate operator cleanup, inspect exact native identities/ownership and obtain independent backend-settlement proof for an unknown create. `NotFound` alone is not proof. Never delete by name prefix alone; there is no orphan/crash-recovery sweep.

[ADR-0002](adr/0002-openshell-runtime-and-lifecycle.md#lifetimes-and-cancellation) explains actual-settlement ownership, bounded cleanup, immutable-ID execution, and direct-child termination limits. Caller timeouts and SDK stream aborts do not prove backend termination.

Normal cleanup retains Docker's image cache and completed project writes; container-only files/installations are disposable. Two Pi instances have separate runtime resources but may mount the same live project and conflict over edits, package outputs, or Git locks. Separate worktrees help with edits but still share common Git metadata.

## Package structure

`src/index.ts` is Pi's factory. Implementation and colocated tests live under `src/`; `assets/` contains only the native policy.

| Owner | Responsibility |
| --- | --- |
| `pi/session`, `pi/commands`, `pi/bash` | Activation/current-pointer ownership, trust, UI, cached `/sandbox`, and model-Bash adaptation. |
| `runtime/generation`, `runtime/execution`, `runtime/work` | Provisioning/cleanup, command streams, raw-work settlement and bounded waits; `runtime` owns whole-runtime disposal. |
| `configuration/native`, `configuration/validation` | Trusted settings selection, native policy/profile schema mapping, and input validation. |
| `gateway`, `providers`, `workspace` | Private native gateway/network, profile import and native provider provisioning, and guarded project/Git mounts. |
| `image` | Default sandbox image reference, not an image builder. |
| `host`, `diagnostics` | Host capabilities, retained direct-child/resource handles, and sanitized failures. |

Use explicit named `index.ts` exports across modules, including imports prefixed with `openshell-sandbox/`; import siblings directly within an owner. Nested modules are visible through their enclosing interface. Keep test helpers in the owning module's `test/*.helper.ts`; cross-module fixture imports use its fixture-only `test/index.helper.ts`. Production cannot import helpers or suites.

## Automatic tests

From the repository root:

```sh
bun run --filter openshell-sandbox test:unit
bun run --filter openshell-sandbox test
```

The unit command excludes `*.integration.test.ts`. The full package command writes `coverage/lcov.info` and enforces the 95% per-file coverage floor. Codecov separately requires 95% changed-line coverage in CI. Behavior-bearing TypeScript has colocated tests; barrels, type declarations, fixtures and thin wiring do not get artificial suites. Docker/native effects are controlled in automatic tests; filesystem/process integrations use owned fixtures. These checks do not establish native default-image or macOS acceptance.

Name tests after their implementation owner: `foo.test.ts` for direct behavior and `foo.integration.test.ts` for cross-module or real-I/O behavior. Keep suites beside implementation, not inside helper-only `test/` directories, and keep themed cases in those owner suites. Helpers are excluded from coverage; production files are not.

Registration/session unit tests mock activation preparation and disposal. Test host reads and native preparation at the activation/runtime boundaries rather than passing effect overrides through session ownership.

Deadlines and readiness use the monotonic `performance.now()` clock directly. Deterministic tests scope clock spies and restore them after disposing asynchronous work; timer effects remain controlled by their owning module.

## Caveats

**Empty HTTP response bodies (OpenShell 0.0.116).** Historical native verification found that the [HTTP relay](https://github.com/NVIDIA/OpenShell/blob/v0.0.116/crates/openshell-supervisor-network/src/l7/rest.rs#L3135-L3259) can drop non-SSE HTTP/1.0 or HTTP/1.1 bodies when the server uses implicit EOF framing without `Content-Length`, `Transfer-Encoding`, or an explicit `Connection: close` response header. Have the server send a correct length or explicit response-close header. No extension proxy workaround or native patch is supplied.
