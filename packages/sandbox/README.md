# Sandbox extension

A [pi](https://github.com/badlogic/pi-mono) extension that runs Bash commands in an OS-level sandbox using [`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime).

It replaces pi's `bash` tool and also applies to user Bash commands. Sandboxing is supported on macOS (`sandbox-exec`) and Linux (`bubblewrap`).

This extension was originally copied from the [pi sandbox extension example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/sandbox).

## Install

Install all workspace dependencies from the repository root:

```sh
bun install --frozen-lockfile
```

Start Pi with the repository's agent configuration:

```sh
PI_CODING_AGENT_DIR="$PWD/apps/agent" pi
```

On Linux, install `bubblewrap`, `socat`, and `ripgrep` through your system package manager.

## Configuration

The extension reads configuration from these sources; later sources take precedence:

1. Built-in defaults
2. `~/.pi/agent/sandbox.json` (global)
3. `<project>/.pi/sandbox.json` (project)

`network` and `filesystem` are merged one property deep. Arrays and nested objects such as `tlsTerminate` replace the earlier value rather than being concatenated or recursively merged. A project-level `ignoreViolations` replaces the complete global map.

The JSON Schema for both configuration files is [`apps/agent/schemas/sandbox.schema.json`](../../apps/agent/schemas/sandbox.schema.json). Unknown properties are currently ignored at runtime, but the schema rejects them so misspelled or unsupported settings remain visible in editors and validators. A config may include a `$schema` string for editor integration; the extension itself ignores it.

### Built-in defaults

```json
{
  "enabled": true,
  "network": {
    "allowedDomains": [
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com"
    ],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

Set `--no-sandbox` to disable sandboxing for one run:

```sh
PI_CODING_AGENT_DIR="$PWD/apps/agent" pi --no-sandbox
```

### Top-level settings

| Setting | Type | Default | Behavior |
| --- | --- | --- | --- |
| `$schema` | string | unset | Optional editor annotation. Ignored by the extension. |
| `enabled` | boolean | `true` | Enables this extension's sandbox. |
| `network` | object | shown above | Network and proxy policy; see [Network settings](#network-settings). |
| `filesystem` | object | shown above | Read and write policy; see [Filesystem settings](#filesystem-settings). |
| `ignoreViolations` | object of string arrays | unset | Suppresses matching runtime violation reports. It does not grant access or change enforcement. The key `"*"` applies to every command; other keys are matched as command substrings. Each array value is matched as a substring of the violation text. |
| `enableWeakerNestedSandbox` | boolean | `false` | Linux: permits operation in nested environments such as unprivileged containers by using weaker isolation. Enable only when another isolation boundary compensates for the reduced protection. |

### Network settings

Unmatched outbound hosts are denied because this extension does not provide `sandbox-runtime` with an interactive network permission callback. `deniedDomains` takes precedence over `allowedDomains`.

Domain entries may be exact domains, leading-wildcard subdomains such as `*.example.com`, `localhost`, or bracketed IPv6 literals. An optional `:port` restricts a rule to one destination port. `allowedDomains` rejects a bare `*` and overly broad patterns such as `*.com`; `deniedDomains` additionally accepts `*` and `*:port`.

The host-only `mitmProxy.domains` and `tlsTerminate.excludeDomains` fields do not accept ports; in version 0.0.71, IPv6 literals in those two fields are unbracketed (for example, `::1`).

| Setting | Type | Default | Behavior |
| --- | --- | --- | --- |
| `allowedDomains` | string[] | npm, PyPI, and GitHub domains shown above | Hosts the sandbox may contact. |
| `deniedDomains` | string[] | `[]` | Hosts explicitly denied, even if an allow rule also matches. |
| `deniedDomainReasons` | object of strings | unset | Model-facing reason keyed by the exact `deniedDomains` entry it explains. Values must be non-empty. |
| `strictAllowlist` | boolean | `false` | Prevents unmatched hosts from falling through to a permission callback. This has no practical effect in this extension because no callback is installed and unmatched hosts are already denied. |
| `allowUnixSockets` | string[] | unset | macOS only: Unix socket paths to allow. Ignored on Linux because seccomp cannot filter Unix sockets by path. |
| `allowAllUnixSockets` | boolean | `false` | Allows all Unix sockets and disables Unix-socket blocking on both supported platforms. |
| `allowLocalBinding` | boolean | `false` | Allows sandboxed processes to bind local listening ports. |
| `allowMachLookup` | string[] | unset | macOS only: additional XPC/Mach services to allow. A wildcard is allowed only as one trailing `*`. |
| `httpProxyPort` | integer `1..65535` | unset | Uses an external HTTP proxy on this local port instead of starting the runtime's HTTP proxy. The external proxy must enforce domain policy. |
| `socksProxyPort` | integer `1..65535` | unset | Uses an external SOCKS proxy on this local port instead of starting the runtime's SOCKS proxy. The external proxy must enforce domain policy. |
| `mitmProxy` | object | unset | Routes selected domains through an upstream MITM proxy over a Unix socket; see [Nested network objects](#nested-network-objects). |
| `tlsTerminate` | object | unset | Experimental in-process HTTPS termination; see [Nested network objects](#nested-network-objects). |
| `parentProxy` | object | unset | Routes outbound HTTP and HTTPS through parent proxies; falls back to `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables when unset. |

`network.filterRequest` exists in the programmatic runtime API but requires a JavaScript function, so it cannot be configured in JSON and is not supported by this extension.

#### Nested network objects

| Object property | Type | Required | Behavior |
| --- | --- | --- | --- |
| `mitmProxy.socketPath` | non-empty string | yes | Unix socket path of the upstream MITM proxy. |
| `mitmProxy.domains` | non-empty string[] | yes | Host-only domain patterns to route through that proxy; port suffixes are not accepted. |
| `tlsTerminate.caCertPath` | non-empty string | with `caKeyPath` | PEM CA certificate used to sign per-host certificates. When both CA paths are omitted, the runtime generates an ephemeral CA on Linux and macOS. |
| `tlsTerminate.caKeyPath` | non-empty string | with `caCertPath` | PEM private key corresponding to `caCertPath`. The two paths must be supplied together or both omitted. |
| `tlsTerminate.excludeDomains` | string[] | no | Host-only patterns whose HTTPS connections remain opaque tunnels. Domain allow/deny rules still apply, but request filtering and credential injection cannot inspect their HTTPS traffic. |
| `tlsTerminate.extraCaCertPaths` | string[] | no | Additional non-empty PEM CA file paths appended to the child's trust bundle. The array itself may be empty. Missing or invalid files are skipped by the runtime. |
| `parentProxy.http` | URI string | no | Parent proxy for plain HTTP traffic. |
| `parentProxy.https` | URI string | no | Parent proxy for HTTPS/CONNECT traffic; falls back to `http` when unset. |
| `parentProxy.noProxy` | string | no | Comma-separated hostname-suffix and CIDR bypass list. |

### Filesystem settings

Read policy uses deny-then-allow precedence: `allowRead` carves readable paths back out of `denyRead`. Write policy uses allow-then-deny precedence: only `allowWrite` paths are writable, and `denyWrite` takes precedence within them.

| Setting | Type | Default | Behavior |
| --- | --- | --- | --- |
| `disabled` | boolean | `false` | Disables all filesystem enforcement, including mandatory protections. Network restrictions remain active. This grants the sandboxed process host filesystem access and should be used only for trusted commands. |
| `denyRead` | string[] | `["~/.ssh", "~/.aws", "~/.gnupg"]` | Paths hidden from sandboxed processes. |
| `allowRead` | string[] | unset | Paths made readable again inside a denied region. |
| `allowWrite` | string[] | `[".", "/tmp"]` | Paths that may be modified. All other paths are read-only. |
| `denyWrite` | string[] | `[".env", ".env.*", "*.pem", "*.key"]` | Paths made read-only inside an allowed write path. |
| `allowGitConfig` | boolean | `false` | Allows writes to repository `.git/config` files while keeping `.git/hooks` protected. It does not control read access and does not remove the working-directory `.gitconfig` mandatory protection. |

Each filesystem path string must be non-empty; the arrays themselves may be empty.

Relative paths are resolved against the process working directory; `~` expands to the host user's home directory. macOS supports Git-style glob patterns. Linux supports literal paths only: version 0.0.71 strips a trailing `/**` but skips other glob patterns. Consequently, the default `.env.*`, `*.pem`, and `*.key` rules are not enforced as globs on Linux; list each required literal path there.

Unless `filesystem.disabled` is true, the runtime also applies mandatory write protection to security-sensitive files and directories such as shell startup files, `.gitmodules`, `.git/hooks`, `.git/config`, `.mcp.json`, `.vscode`, `.idea`, and selected `.claude` paths. These rules are independent of `denyWrite`, except that `allowGitConfig` opts repository `.git/config` out. See [Linux working-tree mount placeholders](#linux-working-tree-mount-placeholders) for the artifact created when a mandatory path does not yet exist.

### Runtime settings not exposed here

`@anthropic-ai/sandbox-runtime` 0.0.71 has additional programmatic top-level options that this extension does not merge or pass to `SandboxManager.initialize`: `credentials`, `enableWeakerNetworkIsolation`, `allowAppleEvents`, `ripgrep`, `mandatoryDenySearchDepth`, `allowPty`, `seccomp`, `bwrapPath`, `socatPath`, `windows`, and `git`. Adding them to `sandbox.json` currently has no effect.

Similarly, `permissionPromptTimeoutSeconds`, `allowBrowserProcess`, and `network.allowUnauthenticatedSocksProxy` are not settings recognized by this extension or by the pinned runtime. The supplied JSON Schema rejects all of these unsupported properties.

## Commands

Run `/sandbox` in pi to display the effective sandbox configuration and status.

## Caveats

### Linux symlinks

On Linux, use canonical paths for filesystem rules where possible. Cross-boundary symlinks in `denyRead`, `allowRead`, or `allowWrite` can change bubblewrap mount behavior; the extension warns when it detects them. In particular, cross-boundary `allowWrite` symlinks are skipped to avoid accidentally granting write access to their targets.

### Linux working-tree mount placeholders

With the pinned `@anthropic-ai/sandbox-runtime` 0.0.71, sandboxed commands on Linux can see unexpected entries such as `.bashrc`, `.profile`, `.gitconfig`, `.mcp.json`, and `.claude/` in the project root. For example, `git status --short` run inside the sandbox reports the missing protected paths as untracked.

These entries are not copied from the user's home directory. The runtime has a hard-coded list of dangerous files and directories, resolves that list against `process.cwd()`, and asks bubblewrap to protect each missing path with a bind such as:

```text
--ro-bind /dev/null <cwd>/.bashrc
```

Bubblewrap creates the missing destination mount point in the host working tree. While the command runs, the host sees a zero-byte regular file and the sandbox sees the `/dev/null` character device mounted over it. The extension calls `SandboxManager.cleanupAfterCommand()` when the command exits, so normal completion removes the host placeholder; this does not prevent the placeholder from affecting the command itself, and abrupt termination of the extension process can leave it behind.

Changing `HOME` or providing a separate shell home does not fix the issue because the runtime anchors these mandatory paths to the process working directory. Removing `"."` from `filesystem.allowWrite` avoids root-level placeholders only by making the project root read-only, apart from any separately allowed paths. Setting `filesystem.disabled` also avoids them, but disables all filesystem restrictions. The current runtime has no configuration that relocates or selectively disables protection for missing mandatory paths.

Potential upstream fixes include:

- Stop mounting `/dev/null` over missing protected paths, while retaining read-only binds for paths that already exist. This removes the artifacts but permits creation of previously missing protected paths.
- Split home-only files such as `.bashrc`, `.profile`, and `.gitconfig` from project-local files such as `.gitmodules` and `.mcp.json`, and protect the former only under the real home directory. This substantially reduces, but does not eliminate, project placeholders.
- Present the project through a private overlay or tmpfs-backed view before adding protected-path mounts, or block path creation through a non-mount mechanism. These approaches preserve protection without modifying the host working tree, but require a larger runtime change.
- Hide the known paths from Git with repository-local excludes. This is only a mitigation: the entries still affect other tools and still exist on the host while a command runs.

Inside the sandbox, `git add` refuses these character devices rather than committing them. A concurrent host-side Git command can see zero-byte regular files while the sandbox is active, so host-side accidental staging remains possible.

This extension currently leaves the runtime behavior unchanged rather than weakening filesystem isolation. Track the upstream investigation in [`sandbox-runtime` issue #139](https://github.com/anthropic-experimental/sandbox-runtime/issues/139).
