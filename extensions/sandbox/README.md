# Sandbox extension

A [pi](https://github.com/badlogic/pi-mono) extension that runs Bash commands in an OS-level sandbox using [`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime).

It replaces pi's `bash` tool and also applies to user Bash commands. Sandboxing is supported on macOS (`sandbox-exec`) and Linux (`bubblewrap`).

This extension was originally copied from the [pi sandbox extension example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/sandbox).

## Install

Install the extension dependencies:

```sh
cd ~/.pi/agent/extensions/sandbox
npm install
```

Start pi with the extension:

```sh
pi -e ~/.pi/agent/extensions/sandbox
```

On Linux, install `bubblewrap`, `socat`, and `ripgrep` through your system package manager.

## Configuration

Configuration is loaded and merged in this order; later values take precedence:

1. Built-in defaults
2. `~/.pi/agent/sandbox.json` (global)
3. `<project>/.pi/sandbox.json` (project)

For example:

```json
{
  "enabled": true,
  "network": {
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws"],
    "allowRead": [],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

The default configuration allows network access to npm, PyPI, and GitHub domains; denies reads from `~/.ssh`, `~/.aws`, and `~/.gnupg`; and permits writes only to the project directory and `/tmp`.

Set `"enabled": false` in either configuration file to disable the sandbox. Use `--no-sandbox` to disable it for one invocation:

```sh
pi -e ~/.pi/agent/extensions/sandbox --no-sandbox
```

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
