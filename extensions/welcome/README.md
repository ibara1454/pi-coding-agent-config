# oh-my-pi Welcome UI for Pi

A Pi extension that recreates the startup welcome UI from [oh-my-pi](https://github.com/can1357/oh-my-pi).

## Origin and attribution

This extension was implemented from the original oh-my-pi source code—not reconstructed only from screenshots. The port follows the implementations in:

- `packages/coding-agent/src/modes/components/welcome.ts`
- `packages/coding-agent/src/modes/components/tips.txt`
- `packages/coding-agent/src/modes/interactive-mode.ts`
- `packages/coding-agent/src/session/session-listing.ts`

The original code was adapted to the extension APIs exposed by `@earendil-works/pi-coding-agent`. Pi exposes custom headers through `ctx.ui.setHeader()`, so the welcome box remains normal TUI header content: the transcript owns scrolling while the editor and status UI stay docked.

## Features

- Rounded welcome box matching oh-my-pi:

  ```text
  ╭─── pi v0.84.1 ───────────────────────────────────────────────────────────────╮
  │                         │                                                    │
  │     Welcome back!       │ Tips                                               │
  │                         │ / for commands                                     │
  │      ▀██████████▀       │ ! to run bash                                      │
  │       ╘██    ██         │ !! to run bash (no context)                        │
  │        ██    ██         │ drop files to attach                               │
  │        ██    ██         │ ────────────────────────────────────────────────── │
  │       ▄██▄  ▄██▄        │ Extensions                                         │
  │                         │ • welcome user                                     │
  │                         │ ────────────────────────────────────────────────── │
  │                         │ Recent sessions                                    │
  │                         │ • Add welcome UI (2h ago)                          │
  │                         │                                                    │
  ╰─────────────────────────┴────────────────────────────────────────────────────╯
   Tip: Use /reload after changing extensions.
  ```

- Exact five-row Pi logo and pink-to-mint oh-my-pi gradient.
- Three-second one-shot logo intro, with a stable resting frame afterward.
- Truecolor rendering with the original 256-color fallback ramp.
- Startup tips, including command, shell, session, model, and keyboard hints.
- Enabled user and trusted-project extensions, labeled by scope.
- Four most recently modified sessions, using explicit session names or the first prompt as fallback.
- Responsive rendering:
  - Two columns in wide terminals.
  - A stacked layout in narrow terminals.
  - ANSI-safe and terminal-cell-safe truncation.
  - Extension overflow constrained by the available terminal height.
- One selected tip and one intro animation per process, so `/reload` does not restart the splash animation or reshuffle the tip.

## Extension discovery

The Extensions section mirrors Pi 0.84.1 startup discovery without loading or installing resources a second time. It includes:

- Enabled extensions from `PI_CODING_AGENT_DIR`.
- Enabled extensions from a trusted project's `.pi` directory.
- Explicit `extensions` entries from user and trusted-project settings.
- Package-provided extensions, including package-object filters and `autoload: false` selections.
- Auto-discovered `.ts` and `.js` extension files.

The snapshot applies Pi's trust gate, project-before-user precedence, local overrides, disabled patterns, symlink canonicalization, and deduplication. Project resources are omitted when the project is not trusted.

Rows are sorted by scope and name, with project extensions before user extensions. When the welcome extension is not visible through normal discovery, it adds itself to the displayed user list.

## Recent sessions

The extension reads session metadata through Pi's public `SessionManager.list()` API. It uses the active working directory and session directory, sorts by modification time, and displays up to four sessions.

Session labels follow this precedence:

1. Explicit session name.
2. First prompt.
3. `Untitled · HH:MM`.

Relative ages use `just now`, minutes, hours, or days for recent sessions and the locale date for sessions at least one week old.

## Native startup resource inventory

The custom welcome is the single routine startup surface. While the extension is active, it suppresses Pi's native routine sections on startup and after `/reload`:

- `[Context]`
- `[Skills]`
- `[Prompts]`
- `[Extensions]`
- `[Themes]`

Pi's native diagnostics remain visible, including skill conflicts, prompt conflicts, extension load and command issues, shortcut conflicts, and theme conflicts. Pi's reload-completion notice also remains visible.

Pi does not expose control of its loaded-resource container through the public extension API. This extension therefore wraps the private `InteractiveMode.showLoadedResources()` method and temporarily invokes Pi's original renderer in diagnostics-only mode. The override is reference-counted across reloads and restores the original method when the extension shuts down.

### Compatibility behavior

The private override is enabled only when both conditions hold:

1. The installed `@earendil-works/pi-coding-agent` version is `0.84.x`.
2. `showLoadedResources()` still contains the reviewed control-flow seams.

If either guard fails, the extension fails open: Pi's native inventory remains visible, the welcome still renders, and one TUI warning explains that inventory suppression is unavailable. It never attempts an unverified patch.

An explicit `pi --verbose` launch restores Pi's full native resource inventory. Host calls that request `force: true` also bypass suppression. This preserves Pi's debugging and forced-rendering contracts.

## Quiet startup

The extension honors Pi's effective `quietStartup` setting:

```json
{
  "quietStartup": true
}
```

With quiet startup enabled, the custom welcome and Pi's routine inventory are both hidden; native diagnostics remain available. Passing `--verbose` overrides `quietStartup`, matching Pi's normal behavior.

The extension has no extension-specific configuration.

## Installation in this repository

The extension has no additional npm dependencies. Pi discovers `extensions/welcome/index.ts` automatically when this repository is used as `PI_CODING_AGENT_DIR`.
