# Extension Manager for Pi

A [Pi Coding Agent](https://github.com/earendil-works/pi) extension that adds
`/extensions`: a terminal panel for inspecting and persistently enabling or
disabling extensions and skills.

Originally copied from
[oh-my-pi's extension manager](https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent/src/modes/components/extensions),
this port keeps its searchable list, inspector, and keyboard and mouse
navigation while adapting persistence to Pi's public extension APIs.

The manager edits Pi settings only. Discovery does not execute extension
modules, install packages, or reload the running session.

## Panel behavior

The panel provides `All`, `Extensions`, and `Skills` tabs, fuzzy search, a
detail inspector, and staged changes. It shows both the configured state of an
individual origin and the state Pi will resolve after `/reload`.

### Text snapshots

Browse resources and inspect the selected row:

```text
Extension Manager
Persistent Extensions and Skills
 All   Extensions   Skills
Search: type to filter
────────────────────────────────────────────────────────────────────────────
Extensions                       │ alpha
> [x] G alpha                    │ alpha description
Skills                           │ Kind: Extension
  [x] P project-review           │ Scope: Global
                                 │ Source: Settings
                                 │ Resolution: Enabled after reload
                                 │ Shadowing: None
────────────────────────────────────────────────────────────────────────────
Tab kind  ↑↓ select  Space toggle  Enter inspect  Ctrl-S apply  Esc back
```

Stage a toggle, then apply or discard it when closing:

```text
Extensions
> [ ] G alpha
Skills
  [x] P project-review

Apply staged changes before closing?

 Apply   Discard   Cancel
```

Row markers:

| Marker | Meaning |
| --- | --- |
| `[x]` / `[ ]` | This catalog row is configured as enabled or disabled. |
| `G` / `P` | Global or project scope. |
| `[!]` | Discovery produced a diagnostic for the row. |
| `(N origins)` | Multiple declarations refer to the same resource. |

`[x]` does not necessarily mean the resource wins resolution. Open the
inspector and check `Resolution` and `Shadowing` when duplicate global,
project, package, or symlinked declarations exist.

### Controls

| Input | Action |
| --- | --- |
| `Tab` / `Right` | Move to the next resource-kind tab. |
| `Shift-Tab` / `Left` | Move to the previous tab. |
| `Up` / `Down` or `k` / `j` | Move the selected row. |
| Printable text / `Backspace` | Edit the fuzzy-search query. |
| `Space` | Stage an enable or disable toggle. |
| `Enter` | Focus the selected row's inspector. |
| `Ctrl-S` | Commit every staged change. |
| `Esc` | Close the inspector, clear search, or close the panel. |

In a regular terminal, clicking selects rows or tabs and the wheel scrolls.
Fullscreen mode supports wheel navigation without changing Pi's mouse mode.

### Applying changes

1. Stage one or more rows with `Space`.
2. Press `Ctrl-S` to write the affected settings files.
3. Run `/reload` after the panel closes.

Pressing `Esc` with staged changes opens an `Apply`, `Discard`, or `Cancel`
prompt. Disabling the Extension Manager itself requires a separate
confirmation; the command remains available until `/reload`.

## Discovery and scope

The catalog lists extensions and skills from:

- `<agent-dir>/settings.json`
- trusted `<cwd>/.pi/settings.json`
- the `extensions/` and `skills/` directories beside those settings files
- packages named in those settings files

It reads file paths, `package.json` declarations, and skill text. It does not
import or run extension code while building the list.

| Scope | Settings file | Availability |
| --- | --- | --- |
| Global | `<agent-dir>/settings.json` | Always inspected. |
| Project | `<cwd>/.pi/settings.json` | Inspected only when the project is trusted. |

When a project is untrusted, project settings and resources are neither read
nor shown. The global catalog remains available. The inspector exposes each
row's raw path, canonical path, source, filters, exact toggle serialization,
configuration reason, effective resolution, shadowing, and origins.

Canonical paths identify aliases and resolution winners. Persistence retains
the discovered raw path so a toggle does not silently rewrite a symlink or
relative-path declaration to another spelling.

## Settings writes and safety

Saving follows one guarded path:

```text
Space: stage a toggle
          |
          v
Lock every affected settings.json
          |
          v
Re-read files and validate resource identity
          |
          +-- conflict / invalid JSON / changed target --> stop; write nothing
          |
          v
Apply the exact resource filter in memory
          |
          v
Atomically replace each changed scope
          |
          +-- later write fails --> report committed and failed scopes
          |
          v
Run /reload
```

### How extension and skill choices are saved

An extension adds a feature to Pi. A skill gives Pi instructions for a task.
Each row in the panel shows one extension or skill.

Press `Ctrl-S` to save which rows are on or off. The manager records these
choices in `settings.json`, a text file that Pi reads when it starts or reloads.
Pi uses the global `settings.json` for every project. A project can also have
its own `settings.json`, which applies only to that project.

The file stores each extension or skill as a path: text that tells Pi where to
find it. A `-` at the start of a path turns that item off. A `+` turns one item
back on when a broader rule has turned it off. The manager changes only the
paths for rows you switched and leaves other settings alone.

#### Example: Extension Manager enabled

```json
{
  "extensions": [
    "/path/to/extension-manager"
  ]
}
```

The plain path tells Pi where to find Extension Manager.

#### Example: Extension Manager disabled

```json
{
  "extensions": [
    "/path/to/extension-manager",
    "-/path/to/extension-manager/index.ts"
  ]
}
```

The `-` path tells Pi not to load Extension Manager's entry file. Remove that
line to turn Extension Manager back on.

Any failed pre-write check stops every scope before mutation. A filesystem
failure during a later atomic replacement can still leave an earlier scope
committed; the notification names each result.

The panel remembers the extension and skill settings it read when it opened.
Before saving, it reads those settings again. If they changed while the panel
was open, the manager writes nothing and shows a conflict message in the panel.
Close and reopen `/extensions` to load the newest settings, then try again.

After a successful save, the panel closes and Pi shows a notification naming
the Global and Project settings that were saved. If one was saved and the other
failed, the same notification reports both results.

## Limitations and recovery

- The manager can toggle only resources exposed by current settings,
  auto-discovery, or an already configured package. It does not add, update, or
  remove package sources.
- `/extensions` is available only in TUI mode.
- Changes are persistent but not hot-applied; `/reload` is always required.
- A malformed settings file is shown as a diagnostic and is not overwritten.

If the manager was disabled, recover with `pi config` or edit the applicable
global or project `settings.json`. Remove any exact
`-.../extension-manager/index.ts` filter, then add the extension directory:

```json
{
  "extensions": [
    "/path/to/extension-manager"
  ]
}
```

Keep any unrelated entries already in the array, then run `/reload`.

## Design

The package keeps discovery and persistence behind two deep interfaces:
`discoverCatalog(...)` computes the complete panel seed without executing
extensions, and `commitSettings(...)` owns locked validation and writes.

| Area | Files |
| --- | --- |
| Host registration and lifecycle | `index.ts`, `extension-command.ts`, `extension-runtime.ts` |
| Discovery and Pi resolution | `discovery.ts`, `package-identity.ts`, `package-resource-paths.ts` |
| Staging and terminal UI | `catalog.ts`, `panel-state.ts`, `panel.ts` |
| Filter and settings policy | `resource-filters.ts`, `settings.ts` |
| Safe persistence | `persistence.ts`, `target-identity.ts`, `settings-serialization.ts` |

## Development

Run the focused suite from the repository root:

```sh
bun test packages/extension-manager
```

Run repository lint and type checking:

```sh
bun run check
```

For panel work, run the focused test file:

```sh
bun test packages/extension-manager/panel.test.ts
```
