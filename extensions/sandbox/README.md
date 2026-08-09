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
