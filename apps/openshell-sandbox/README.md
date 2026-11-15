# OpenShell model-Bash sandbox

Start with [installation](#installation-and-prerequisites), then [configure a project and check Bash](#configuration). If OpenShell 0.1.8 is already installed and Docker host networking is enabled, skip those installation steps.

This extension sandboxes **model-requested Bash only**. User Bash (`!` and `!!`), Pi, file tools, model traffic, and other extensions' host processes remain host-side. This is **not whole-agent isolation**. If setup, execution, or cleanup cannot be completed safely, model Bash stays blocked; it never falls back to the host.

## About OpenShell

[OpenShell](https://github.com/NVIDIA/OpenShell) runs commands in isolated environments called sandboxes. The [official architecture guide](https://docs.nvidia.com/openshell/latest/about/architecture) describes the agent running inside the sandbox.

**This extension intentionally keeps Pi on the host**, so its session history remains there when sandbox containers are recreated. If you want to run the agent itself inside a container, use OpenShell directly instead of this extension.

Both diagrams below show a local Docker setup.

### Typical OpenShell usage: agent inside the sandbox

![Typical OpenShell usage: a host CLI or SDK manages the gateway; the agent and its tools run in the workload container, with network requests mediated by the supervisor.](assets/agent-in-sandbox.svg)

### This extension: Pi on the host, model Bash in the sandbox

![Bash delegation: Pi's model Bash call reaches the host-side extension, which sends the command through the OpenShell SDK to Bash in the workload container. Output and the exit code return to Pi as a tool result; other tools, session history, and model traffic stay on the host.](assets/architecture.svg)

The extension starts its own gateway, separate from the installer's default gateway.

The default workload image is `nvcr.io/nvidia/base/ubuntu:24.04`. It has Bash, **not Git, Node, Python, or curl**. To use those tools, select a fully qualified custom `image` in `openShellSandbox` settings. The extension does not install tools or override OpenShell's version-matched supervisor/runtime images.

The bundled policy runs the workload as non-root UID/GID `1000`. Your image, policy, and mounted-file ownership must agree. Policy entries for an executable do not install it or make it a startup requirement.

## Installation and prerequisites

### 1. Prepare Docker

Use **Docker Engine 28.0+** or **Docker Desktop 4.34+**:

- **Linux:** [Docker Engine installation](https://docs.docker.com/engine/install/).
- **WSL2:** [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/), with the [WSL2 backend and distribution integration](https://docs.docker.com/desktop/features/wsl/) enabled.
- **Apple Silicon macOS:** [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/).

Start Docker. Its local Unix socket must be accessible to the user launching Pi, and Docker must be able to share the selected project directory. The extension does not install or restart services or arrange file sharing.

**Why host networking is required:** this integration uses OpenShell 0.1.8's default `host` network mode for the trusted supervisor so it can reach the private gateway at `127.0.0.1`. The workload still uses `none`. Native OpenShell also supports an optional supervisor bridge mode, but **this extension does not select it**. See the [pinned Docker-driver contract](https://github.com/NVIDIA/OpenShell/blob/v0.1.8/crates/openshell-driver-docker/README.md#gateway-session-and-tls).

**Docker Desktop only:** if not already enabled, open **Settings → Resources → Network → Enable host networking** and follow the apply/restart prompt. Selecting host mode for a container does **not** enable this separate Desktop setting. Enhanced Container Isolation is incompatible with this setup; a Docker restart can interrupt other containers. See [Docker's instructions](https://docs.docker.com/engine/network/drivers/host/#docker-desktop).

### 2. Install and check native OpenShell 0.1.8

Use the **native CLI and gateway**, matching the package's pinned SDK:

- **Linux/WSL2:** Debian/Ubuntu or an RPM-based distribution; x86_64 or ARM64; glibc 2.28+; `sudo`; a working systemd user session. Enable systemd in WSL2 before installing.
- **Apple Silicon macOS:** Intel macOS is unsupported by this release. **Extension behavior on macOS remains unverified.**
- **Both:** `curl` and a SHA-256 utility (`sha256sum` or `shasum`).

**Upgrading from 0.0.x?** Stop here and follow the [backup, cleanup, and uninstall guide](https://github.com/NVIDIA/OpenShell/blob/v0.1.8/docs/upgrade/0-1-0.mdx) first. Do not reuse old sandbox state or mix native/SDK versions.

Run as your normal user; the installer requests package-manager privileges when needed. Both the script and release are pinned:

```sh
installer="$(curl -fsSL https://raw.githubusercontent.com/NVIDIA/OpenShell/v0.1.8/install.sh)" &&
  OPENSHELL_VERSION=v0.1.8 sh -c "$installer"
```

The [native installer](https://docs.nvidia.com/openshell/v0.1.8/about/installation) installs `openshell` and `openshell-gateway`, verifies downloaded Linux packages against release checksums, and starts/registers a default gateway through systemd or Homebrew. The extension creates its own private gateway instead of using that default.

In the same shell environment that will launch Pi, run:

```sh
command -v openshell openshell-gateway
openshell --version
openshell-gateway --version
openshell status
```

Both binaries must be on `PATH`, both versions must be `0.1.8`, and `openshell status` should reach the installer's default gateway. This checks the native installation, **not** the extension's project permissions. The PyPI package provides only the Python SDK, not these native binaries.

### 3. Authenticate the SDK download

Bun downloads `@nvidia/openshell-sdk` from GitHub Packages using `NVIDIA_NPM_TOKEN`, as configured in [`bunfig.toml`](bunfig.toml). This is **package-install authentication**, not a credential for model Bash or Pi's model provider.

1. In GitHub, open **Settings → Developer settings → Personal access tokens → Tokens (classic)** and generate a token with **`read:packages`**. Fine-grained tokens are not supported. See [GitHub's token guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic).
2. Ensure your account can access `@nvidia/openshell-sdk`; authorize the token for SSO if required by its organization. See [GitHub Packages authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages).
3. Supply the token privately in the shell where you will install dependencies. For an interactive **Bash** shell, this prompt hides the value and keeps it out of the command itself:

   ```bash
   read -r -s -p 'GitHub Packages token: ' NVIDIA_NPM_TOKEN
   printf '\n'
   export NVIDIA_NPM_TOKEN
   ```

The export lasts for this shell and its children. Use your own secret tooling for persistence; do not put token values in settings, policy files, or committed shell configuration.

### 4. Load the extension in Pi

Follow the root README's [repository setup](../../README.md#use-the-entire-repository) or [copy-package setup](../../README.md#copy-extensions-into-your-own-pi-configuration), installing dependencies in the shell from step 3. Those instructions also select the Pi configuration directory.

**Before normal model use, configure project access below.** Loading the extension does not grant access to your project.

## Configuration

### 1. Create a project policy

Open the project directory where you will launch Pi. Run this in your host shell to obtain its absolute canonical path:

```sh
pwd -P
```

Copy the complete [bundled policy](assets/policy.yaml) to **`.pi/openshell-sandbox.yaml` inside that project**; create `.pi/` if needed. Inside `filesystem_policy`, add the path printed above to the existing `read_write` list. For a project at `/work/my-project`, that list becomes:

```yaml
read_write:
  - /sandbox
  - /home/sandbox
  - /tmp
  - /dev/null
  - "/work/my-project"
```

Replace `/work/my-project` with your actual path. Keep this list nested under `filesystem_policy` and leave the rest of the copied policy intact; the snippet is **not a complete policy file**.

The baseline permits tool paths and selected GitHub/npm/PyPI operations, not your project's paths. Bind mounts, `include_workdir`, and the command's working directory do not replace explicit grants. Access also depends on workload identity, host permissions, and Docker file sharing. Never grant a parent directory, host home, SSH credentials, Docker socket, or unrelated worktrees just to bypass a denial.

### 2. Select the policy in settings

Add this field to the project's **`.pi/settings.json`**, preserving any other settings:

```json
{
  "openShellSandbox": {
    "policyPath": "./openshell-sandbox.yaml",
    "profilePaths": [],
    "providers": []
  }
}
```

Here `./openshell-sandbox.yaml` means **`.pi/openshell-sandbox.yaml`**, not a file at the project root. This example starts without credential providers and clears inherited profile/provider arrays.

Project settings are read only after you trust the project in Pi. Trust includes authority to select host credential-variable names, profile destinations, and the workload image.

#### Settings rules

- **Locations and precedence:** built-in defaults → `$PI_CODING_AGENT_DIR/settings.json` → trusted project's `.pi/settings.json`. You can use global settings instead of project settings.
- **Paths:** relative `policyPath` and `profilePaths` resolve beside the settings file that declares them. For global settings, that means inside `PI_CODING_AGENT_DIR`.
- **Replacement:** `providers` and `profilePaths` replace entire arrays, including `[]`. The selected YAML policy replaces the bundled document; it is not merged with it.
- **Validation:** absent settings are optional; malformed/unreadable present settings or selected documents block model Bash. Unknown native fields are not silently dropped.

See [configuration and trust boundaries](adr/0001-openshell-configuration-and-trust-boundaries.md) for native validation and permission details.

### 3. Activate and check model Bash

1. Launch Pi from that project directory. Trust it only after reviewing its settings and policy; run `/reload` if Pi is already open.
2. Run `/sandbox` and check the selected policy/image and `Required explicit native read_write grants`. If you use [`git worktree`](#using-git-worktrees), add the external metadata grants before continuing.
3. After any settings or policy edit, run `/reload`. Files are snapshotted; edits do not change the active sandbox.
4. Ask the model: **“Use the Bash tool to run `pwd && ls -A`.”** Do not use `!` or `!!`; those test host Bash instead.
5. Confirm that `pwd` matches your canonical project path, the listing succeeds, and `/sandbox` reports `ready`.

That completes the basic Bash/directory-access check. **`ready` alone proves neither project access nor write permission, tool availability/version, or usable network access.** Check the actual tools and operations your task needs. Missing tools and denied operations remain command failures; the extension never widens permissions automatically.

### Using Git worktrees

If this directory was created with [`git worktree add`](https://git-scm.com/docs/git-worktree), Git keeps some metadata outside it. Grant the container access to those metadata directories before running model Bash:

1. Launch Pi for inspection and run `/sandbox`; do not start normal model work yet.
2. Copy the complete quoted external paths under `Required explicit native read_write grants` into the selected policy's `filesystem_policy.read_write` list. Add `- ` before each quoted path; preserve quotes and escapes, which are valid YAML.
3. Review those exact grants and run `/reload`. Do not grant an ancestor or other worktrees to make Git work.

Two Pi instances have separate runtime resources but may edit the same live files. Separate worktrees reduce edit conflicts but still share common Git metadata and can contend on Git locks.

## Optional: access private repositories and package registries

Configure credentials here for Git and package-manager commands **inside the container**. Skip this section for operations that need no credentials. The installation token `NVIDIA_NPM_TOKEN` is not forwarded automatically.

A **provider profile** declares credential keys, destination bindings, and optional network grants. A **provider instance** stores concrete credentials and configuration for that profile. This extension creates provider instances from selected host credentials and attaches them to the sandbox. OpenShell 0.1.8 has **no built-in profiles**; importing a profile alone does not attach it or grant permissions.

Policy and attached-profile network grants add together; a restrictive profile does not revoke policy grants.

### Example: access a private GitHub repository from the container

Use this setup to let `git fetch` and other Git commands that contact a remote GitHub repository—such as `git clone`, `git pull`, or `git push`—authenticate **from inside the OpenShell workload container**. It is not needed for local-only commands such as `git status` or `git diff`. Each remote operation must still be allowed by OpenShell's policy/profile grants and the GitHub account/token permissions.

1. Select an image containing Git, `base64`, and `tr` (used by the check below). Review the [pinned GitHub profile](https://github.com/NVIDIA/OpenShell/blob/v0.1.8/providers/github.yaml), adapt its binary paths and grants to that image, and save it as **`.pi/github-profile.yaml`** beside the project settings.
2. Extend `.pi/settings.json` as below. Keep any custom `image` and any other needed provider/profile entries; arrays replace rather than merge.

   ```json
   {
     "openShellSandbox": {
       "policyPath": "./openshell-sandbox.yaml",
       "profilePaths": ["./github-profile.yaml"],
       "providers": [
         {
           "name": "work-github",
           "profile": "github",
           "credentialMode": "explicit",
           "credentialsFromEnv": { "GITHUB_TOKEN": "WORK_GITHUB_TOKEN" }
         }
       ]
     }
   }
   ```

3. Supply `WORK_GITHUB_TOKEN` through your credential tooling **before launching Pi**. `GITHUB_TOKEN` is the profile's credential key; `WORK_GITHUB_TOKEN` is the host environment variable holding its value. JSON contains names, never secrets. Restart Pi from that environment if needed; `/reload` cannot import variables exported in another shell.
4. After profile/settings edits, run `/reload`. Then ask the model to run the following through its **Bash tool inside the container**, not through `!`/`!!` or a host shell. Replace `OWNER/REPO` with a private repository the supplied token can read:

   ```sh
   remote='https://github.com/OWNER/REPO.git'
   : "${GITHUB_TOKEN:?Run inside the OpenShell workload with the GitHub provider attached}"
   auth="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"
   GIT_TERMINAL_PROMPT=0 git -c credential.helper= \
     -c "http.${remote}.extraHeader=Authorization: Basic ${auth}" \
     ls-remote "$remote"
   ```

   `ls-remote` checks remote read access without fetching files or changing the repository. Success is exit code `0`, normally with commit IDs and reference names; an empty repository may list nothing. It does not prove push permission.

The command uses OpenShell's workload `GITHUB_TOKEN` **placeholder**, not the host's real token. It encodes that placeholder into an HTTP Basic authentication header scoped to the selected repository URL. OpenShell resolves it only for an authorized request; TLS/proxy settings remain unchanged.

Git's `-c` options apply only to this invocation: no credential helper is saved, and neither `~/.gitconfig` nor project Git configuration is written. Repeat the same command-scoped options for later authenticated operations—for example, replace `ls-remote "$remote"` with `fetch "$remote"` to fetch into the current repository.

For an npm provider-profile example, see [custom credential profiles](adr/0001-openshell-configuration-and-trust-boundaries.md#custom-credential-profiles-and-authenticated-clients).

## Usage

- **Inspect:** `/sandbox` shows the cached phase, policy/image, required paths, failures, and available recovery coordinates for the current extension activation. It does not prepare, repair, discover, or delete resources.
- **Apply changes:** edit settings, policy, or profiles, review permissions, then `/reload`.
- **Expect fresh resources:** startup, reload, new, resume, and fork each create an independent *extension activation*. Commands share resources only within that activation. Container-only files/installations are disposable; normal cleanup keeps completed project writes and Docker's image cache.
- **After cancellation, timeout, or uncertain execution:** the extension's entire sandbox generation, including concurrent/background work, is invalidated. Confirmed cleanup permits a fresh generation; commands are never replayed. Bash timeouts preserve streamed output and Pi's timeout result unless uncertain creation/cleanup requires blocking model Bash.

## Troubleshooting

### Git reports dubious ownership

If Git rejects mounted ownership, review the ownership mismatch and configure `safe.directory` only for the intended path.

### After failed shutdown

1. **Save the failed activation's transcript coordinates:** gateway endpoint, TLS directory, and sandbox identity/create outcome where available. A prepared gateway can exist before sandbox creation; `creation: not started` does not mean a sandbox exists or transfer ownership.
2. Use that saved transcript, not a later `/sandbox` display. `/reload` starts an independent activation; it **does not repair or clean up old resources**.
3. Before separate operator cleanup, verify exact native identities and ownership. If creation is unknown, independently prove the backend create operation has finished; `NotFound` alone is insufficient. Never delete by name prefix. There is no automatic orphan/crash-recovery sweep.

See [lifecycle and cleanup guarantees](adr/0002-openshell-runtime-and-lifecycle.md#lifetimes-and-cancellation) before operator recovery. Caller timeouts and SDK stream aborts do not prove backend termination; cleanup tracks only the owned gateway's direct child, not all descendants.

### Empty HTTP response bodies (OpenShell 0.1.8)

Source review of the [ordinary HTTP relay](https://github.com/NVIDIA/OpenShell/blob/v0.1.8/crates/openshell-supervisor-network/src/l7/rest/http_response.rs#L197-L236) shows that it still treats non-SSE HTTP/1.1 responses as empty when `Content-Length`, `Transfer-Encoding`, and an explicit `Connection: close` response header are all absent. HTTP/1.0 now relays until EOF by default unless `Connection: keep-alive` is present. If you control the server, send a correct content length or an explicit response-close header. Native 0.1.8 behavior for this case has not been verified.

## Contributing

See the [contributor guide](CONTRIBUTING.md) for the package structure and module/test-helper conventions.

