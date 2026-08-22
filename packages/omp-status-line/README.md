# oh-my-pi Status Line for Pi

A Pi extension that recreates the status line and rounded editor UI from [oh-my-pi](https://github.com/can1357/oh-my-pi).

## Origin and attribution

This extension was implemented from the original oh-my-pi source code—not reconstructed only from screenshots. The port follows the implementations in:

- `packages/coding-agent/src/modes/components/status-line/`
- `packages/coding-agent/src/modes/theme/symbols.ts`
- `packages/tui/src/components/editor.ts`

The original code was adapted to the extension APIs exposed by `@earendil-works/pi-coding-agent`. Pi does not expose oh-my-pi's native `setTopBorderProvider()` integration, so this extension wraps Pi's editor renderer and reproduces the same top status border, multiline chrome, and bottom input border.

## Features

- Rounded editor layout matching oh-my-pi:

  ```text
  ╭── π  > ⬢ GPT-5.6-Sol · ◕ xhigh > 📁 ~/project > ⑂ main > ◫ 12.4%/272K ⟲ > (sub) ▶────────────╮
  ╰─ Type a message…                                                                                 ─╯
  ```

- Pure Unicode symbols by default; no Nerd Font dependency.
- The original `default`, `minimal`, `compact`, `full`, `nerd`, `ascii`, and `custom` layouts.
- The original Powerline, thin Powerline, slash, pipe, block, none, and ASCII separators.
- Model and thinking level, path, git status, pull request, token usage, cache usage, cost, context usage, session, hostname, and timing segments.
- Responsive overflow behavior copied from oh-my-pi:
  1. Remove right-side segments first.
  2. Shrink the path segment.
  3. Remove lower-priority left-side segments while preserving the path as long as possible.
- Stable session-name accent colors.
- Extension statuses rendered below the editor.
- Asynchronous git status and GitHub pull-request refreshes.

The `nerd` preset name refers to the high-density oh-my-pi layout. It still uses the Unicode symbol set; it does not enable Nerd Font glyphs.

## Context usage

Pi's native extension context initially reports message usage only. Before the first assistant response, that can appear as an empty context even though the system prompt and tool schemas already occupy space.

To match oh-my-pi, this extension:

1. Uses provider-reported context tokens after a valid assistant response.
2. Before a provider anchor exists, estimates the system prompt, active tool schemas, and context entries.
3. Uses oh-my-pi's fallback token formula: UTF-8 byte length divided by four.
4. Re-estimates the active context after compaction until a new provider-reported value is available.

## Configuration

Configure the extension under `statusLine` in Pi's `settings.json`:

```json
{
  "statusLine": {
    "preset": "default",
    "sessionAccent": true
  }
}
```

Supported options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `preset` | `default \| minimal \| compact \| full \| nerd \| ascii \| custom` | `default` | Selects the segment layout. |
| `separator` | `powerline \| powerline-thin \| slash \| pipe \| block \| none \| ascii` | Preset value | Overrides the preset separator. |
| `leftSegments` | Segment ID array | Preset value | Left-side segments for the `custom` preset. |
| `rightSegments` | Segment ID array | Preset value | Right-side segments for the `custom` preset. |
| `showHookStatus` | boolean | `true` | Shows extension status lines below the editor. |
| `sessionAccent` | boolean | `true` | Colors the border gap from the session name. |
| `transparent` | boolean | `false` | Uses the terminal background and removes Powerline end caps. |
| `compactThinkingLevel` | boolean | `false` | Uses the thinking glyph as the model icon and removes the thinking suffix. |
| `segmentOptions` | object | Preset value | Overrides model, path, git, or time rendering options. |

### Custom layout

```json
{
  "statusLine": {
    "preset": "custom",
    "leftSegments": ["pi", "model", "path", "git", "pr"],
    "rightSegments": ["session_name", "cost", "context_pct"],
    "separator": "powerline-thin",
    "segmentOptions": {
      "model": { "showThinkingLevel": true },
      "path": { "abbreviate": true, "maxLength": 40 },
      "git": {
        "showBranch": true,
        "showStaged": true,
        "showUnstaged": true,
        "showUntracked": true
      }
    }
  }
}
```

Available segment IDs:

```text
pi model mode path git pr subagents token_in token_out token_total
 token_rate cost context_pct context_total time_spent time session
 hostname cache_read cache_write cache_hit session_name usage collab
```

## Extension status integration

Pi does not expose all of oh-my-pi's internal mode, collaboration, and subagent state. Other extensions can populate the corresponding segments through status keys:

```ts
ctx.ui.setStatus("mode", "Plan");
ctx.ui.setStatus("collab", "⇄ collab:2");
ctx.ui.setStatus("subagents", "2");
ctx.ui.setStatus("usage", "5h 24%");
```

Statuses not consumed by configured segments remain visible below the editor. For example, the sandbox extension's status is shown there.

## GitHub pull requests

The `pr` segment runs `gh pr view --json number,url` in the active working directory. It remains hidden when GitHub CLI is unavailable, unauthenticated, or the current branch has no pull request.

## Installation in this repository

The extension has no runtime package dependencies. When `apps/agent` is used as `PI_CODING_AGENT_DIR`, tracked `settings.json` loads `packages/omp-status-line` through the `../../packages/*` extension glob.

Run the unit tests from the extension directory:

```bash
bun test
```
