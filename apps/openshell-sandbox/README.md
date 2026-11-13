# OpenShell model-Bash sandbox

This Pi extension replaces **model-requested Bash**, not user Bash (`!` and `!!`). Pi, file tools, model traffic, and other extensions' host processes remain outside this boundary. Model Bash is registered fail-closed before SDK or configuration loading: setup, execution, or uncertain cleanup failures never reroute it to the host. User Bash remains host-side even when OpenShell is preparing or failed. This is not whole-agent isolation.

## Installation and prerequisites

1. Install **Docker Desktop or Docker Engine 28.0+** using the official guide for your platform:
   - **Linux:** [Docker Engine installation](https://docs.docker.com/engine/install/).
   - **WSL2:** [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) and [WSL2 backend/integration setup](https://docs.docker.com/desktop/features/wsl/).
   - **Apple Silicon macOS:** [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/).

     Start Docker and ensure its local Unix socket is accessible to the Pi user. Arrange access/file sharing for the selected project yourself; the extension does not install or restart services. For WSL2, enable the WSL2 backend and distribution integration so the socket is available inside the distribution.

     **Required: Docker host networking for the trusted supervisor.** OpenShell 0.1.0 runs its supervisor with `network_mode=host` so it can reach the gateway's primary loopback listener. The model-Bash workload stays on `network_mode=none`. Docker Engine on Linux supports host networking directly; see [NVIDIA's versioned Docker-driver requirement](https://github.com/NVIDIA/OpenShell/blob/v0.1.0/crates/openshell-driver-docker/README.md#gateway-session-and-tls).

     **Docker Desktop 4.34+:** open **Settings → Resources → Network → Enable host networking**, then follow your installed version's apply/restart prompt. Selecting host mode for a container does not enable this Desktop setting. Enhanced Container Isolation is incompatible with this setup. If a restart is required, it can interrupt other containers. See [Docker's setup instructions](https://docs.docker.com/engine/network/drivers/host/#docker-desktop).
2. Install the **native OpenShell 0.1.0 CLI and gateway** using the commands below, based on the [versioned upstream instructions](https://docs.nvidia.com/openshell/v0.1.0/about/installation). Existing 0.0.x installations require sandbox cleanup, backups, and uninstall before installation; follow the [0.1.0 upgrade guide](https://github.com/NVIDIA/OpenShell/blob/v0.1.0/docs/upgrade/0-1-0.mdx). Do not reuse old sandbox state or mix native/SDK versions.
   - **Linux/WSL2:** Debian/Ubuntu or an RPM-based distribution, x86\_64 or ARM64, glibc 2.28+, package-install privileges (`sudo`), and a working systemd user session. Enable systemd in WSL2 before using this installer.
   - **Apple Silicon macOS:** install [Homebrew](https://brew.sh/) first. Intel macOS is not supported by this release.
   - Both platforms need `curl` and a SHA-256 utility (`sha256sum` or `shasum`).

     Run as your normal user; the installer requests package-manager privileges when needed. Both the installer script and the selected release are pinned:

     ```sh
     installer="$(curl -fsSL https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.0/install.sh)" &&
       OPENSHELL_VERSION=v0.1.0 sh -c "$installer"
     ```

     The installer installs `openshell` and `openshell-gateway` through the native package manager, verifies downloaded Linux packages against release checksums, and starts/registers a default local gateway through systemd or Homebrew. That default gateway is separate from the private gateway this extension owns.

     Verify in the same shell environment that will launch Pi:

     ```sh
     command -v openshell openshell-gateway
     openshell --version
     openshell-gateway --version
     openshell status
     ```

     Both version commands must report `0.1.0`, both binaries must be on `PATH`, and `openshell status` should reach the installer's default gateway. This does not prove the extension's sandbox permissions or project access. Installing `openshell` from PyPI installs only the Python SDK, not these native binaries.
3. Create a **GitHub personal access token (classic)** for [GitHub Packages authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages). Fine-grained tokens are not supported:
   - Open GitHub **Settings &gt; Developer settings &gt; Personal access tokens &gt; Tokens (classic)**, then choose **Generate new token &gt; Generate new token (classic)**. See [GitHub's token creation guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic).
   - Enter a descriptive name and expiration, select only **`read:packages`**, and click **Generate token**.
   - Copy the generated PAT privately. Your account must have access to `@nvidia/openshell-sdk`; authorize the token for SSO if the package's organization requires it.
4. Configure `NVIDIA_NPM_TOKEN` in your `~/.bashrc` (Bash) or `~/.zshrc` (Zsh), replacing the placeholder with your PAT:
   ```sh
     # For Bash
     echo 'export NVIDIA_NPM_TOKEN="YOUR_GITHUB_PAT"' >> ~/.bashrc && source ~/.bashrc
     # For Zsh
     echo 'export NVIDIA_NPM_TOKEN="YOUR_GITHUB_PAT"' >> ~/.zshrc && source ~/.zshrc
   ```

## About OpenShell

[OpenShell](https://github.com/NVIDIA/OpenShell) is NVIDIA's runtime for running AI-agent commands in isolated environments called sandboxes. This extension uses it with Docker and a policy file to control which files and network destinations model-requested Bash can access.

OpenShell prepares separate trusted supervisor and restricted workload containers, including the version-matched sandbox runtime. The workload has no direct Docker network; the supervisor mediates its network requests. The extension does not create a separate Docker network or override native runtime images.

The default workload image is `nvcr.io/nvidia/base/ubuntu:24.04`, not the former Community tool image. It includes Bash but not Git, Node, Python, or curl. Select a fully qualified custom `image` with the tools you need; the extension does not install them. The baseline uses non-root UID/GID `1000`; custom policies and images must agree on workload identity and mounted-file ownership.

## Configuration

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

OpenShell 0.1.0 has **no built-in provider profiles**. For authenticated HTTPS Git, review the [versioned GitHub example](https://github.com/NVIDIA/OpenShell/blob/v0.1.0/providers/github.yaml), adapt its binary paths and grants to your image, and save it as `github-profile.yaml` beside the declaring settings file. Add `./github-profile.yaml` to `openShellSandbox.profilePaths` and the following provider to `providers`, preserving any other needed entries:

```json
{
  "name": "work-github",
  "profile": "github",
  "credentialMode": "explicit",
  "credentialsFromEnv": { "GITHUB_TOKEN": "WORK_GITHUB_TOKEN" }
}
```

Supply `WORK_GITHUB_TOKEN` through your own credential tooling in the **Pi process environment**. JSON contains variable names, not values; a missing selected value fails rather than silently using anonymous access. Explicit mode is the default; `native-refresh` is recognized but rejected as unsupported, never silently downgraded. Credential environment keys must be unique across attached providers.

**Network permissions are additive:** OpenShell combines the selected policy's grants with grants from attached provider profiles. A request may be permitted by either source; this is not an intersection. Keep existing policy rules in the policy—there is no need to move them into profiles or duplicate them there. Importing a profile alone does not attach it or grant its permissions.

Configured provider `name` values are policy-facing identities: explicit `credentialBinding.provider` references must name a configured provider whose profile has no endpoints. Each generation translates those references to unique native provider identities in a separate policy snapshot, without changing the selected policy or its grants. Profiles with endpoints supply their own credential bindings.

Credential binding controls where a credential may be used; it does **not** itself grant network access. Both effective network permission and endpoint-scoped credential binding must pass. Review permissions in **both** the selected policy and attached profiles, without disabling TLS verification. See [credential profiles and authenticated clients](adr/0001-openshell-configuration-and-trust-boundaries.md#custom-credential-profiles-and-authenticated-clients) for npm/PyPI guidance and [credential validation](adr/0001-openshell-configuration-and-trust-boundaries.md#credential-authority-and-isolation) for import/alias checks.

**Migration:** remove every `providers[].client` entry; it is rejected. Native providers supply credential environment placeholders, but workloads must configure Git/npm/pip clients manually while preserving TLS/proxy settings. The extension writes no client configuration, credential helper, or Git `safe.directory` entry. Mismatched mounted ownership may require deliberate, path-specific `safe.directory` configuration. Baseline executable/network grants remain unchanged; Node policy entries do not make Node a startup requirement.

The trusted host gateway and separate supervisor/proxy container handle real provider values; ordinary workload children receive opaque handles. This is not universal credential non-disclosure: an allowed endpoint can return the credential, and a granted project directory exposes raw `.env`/`.npmrc` files within it. Project client files are neither overwritten nor secret-masked. The selected image, native components, policy, attached profiles, and credential-bearing endpoints are trusted inputs.

## Use and recover

- `/sandbox` displays the **current activation's** cached phase, selected policy/image, required explicit native paths, ordinary failure details, and available recovery coordinates. It does not prepare, repair, discover, or delete resources.
- Edit settings, policy, or profiles manually, review permissions, then run `/reload`. Edits do not mutate the active snapshot.
- Every `session_start` (startup, reload, new, resume, fork) gets fresh private resources. Model calls share preparation only within that activation. **SDK readiness is not permission, tool-availability, tool-version, privilege, or project-write proof.** Missing tools and denied operations remain ordinary command failures; permissions are not widened automatically.
- Cancellation/timeout or indeterminate execution invalidates the whole sandbox generation, including concurrent/background work. Confirmed cleanup permits a fresh generation; no command is replayed. A Bash timeout preserves streamed stdout/stderr and uses Pi's timeout result, but uncertain creation/cleanup blocks model Bash and takes precedence over that result.

### After failed shutdown

1. **Save the failed activation's transcript coordinates.** Shutdown publishes available recovery facts before retiring it: gateway endpoint, TLS directory, and sandbox identity/create outcome where known. Prepared-gateway coordinates remain useful even before sandbox creation; `creation: not started` neither proves creation nor transfers ownership.
2. Use the saved transcript for that failed activation, not a later `/sandbox` display. `/reload` starts an **independent activation**; it does not adopt, repair, or clean up old resources.
3. Before separate operator cleanup, inspect exact native identities/ownership and obtain independent backend-settlement proof for an unknown create. `NotFound` alone is not proof. Never delete by name prefix alone; there is no orphan/crash-recovery sweep.

[ADR-0002](adr/0002-openshell-runtime-and-lifecycle.md#lifetimes-and-cancellation) explains actual-settlement ownership, bounded cleanup, name-based RPC ownership checks, and direct-child termination limits. Caller timeouts and SDK stream aborts do not prove backend termination.

Normal cleanup retains Docker's image cache and completed project writes; container-only files/installations are disposable. Two Pi instances have separate runtime resources but may mount the same live project and conflict over edits, package outputs, or Git locks. Separate worktrees help with edits but still share common Git metadata.

## Package structure

```text
openshell-sandbox/
|-- adr/                       # Architecture decisions
|-- assets/
|   `-- policy.yaml            # Native policy
`-- src/                       # Implementation and colocated tests
    |-- index.ts               # Pi extension factory
    |-- configuration/         # Trusted settings and policy/profile mapping
    |   |-- native/
    |   `-- validation/
    |-- diagnostics/           # Sanitized failures
    |-- gateway/               # Private gateway, configuration, and TLS
    |-- host/                  # Host capabilities and owned resource handles
    |-- image/                 # Default image reference, not an image builder
    |-- pi/
    |   |-- bash.ts            # Model-Bash adapter
    |   |-- commands/          # Cached /sandbox status
    |   `-- session/           # Activation lifecycle, trust, and UI
    |-- providers/             # Credential profiles and native providers
    |-- runtime/               # Whole-runtime disposal
    |   |-- execution/         # Command streams
    |   |-- generation/        # Provisioning and cleanup
    |   `-- work/              # Raw-work settlement and bounded waits
    `-- workspace/             # Guarded project and Git mounts
```

Use explicit named `index.ts` exports across modules, including imports prefixed with `openshell-sandbox/`; import siblings directly within an owner. Nested modules are visible through their enclosing interface. Keep test helpers in the owning module's `test/*.helper.ts`; cross-module fixture imports use its fixture-only `test/index.helper.ts`. Production cannot import helpers or suites.

## Caveats

**macOS behavior remains unverified.**

**Empty HTTP response bodies (OpenShell 0.0.116).** Historical native verification found that the [HTTP relay](https://github.com/NVIDIA/OpenShell/blob/v0.0.116/crates/openshell-supervisor-network/src/l7/rest.rs#L3135-L3259) can drop non-SSE HTTP/1.0 or HTTP/1.1 bodies when the server uses implicit EOF framing without `Content-Length`, `Transfer-Encoding`, or an explicit `Connection: close` response header. Have the server send a correct length or explicit response-close header. No extension proxy workaround or native patch is supplied.