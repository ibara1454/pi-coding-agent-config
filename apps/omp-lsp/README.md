# omp-lsp

A [Pi](https://github.com/earendil-works/pi) extension providing the `lsp` tool for semantic code navigation, diagnostics, refactoring, and optional formatting. It includes all 55 Oh My Pi server presets and uses installed language servers; it never downloads servers or dependencies.

## Activate and install

From the repository root:

```sh
bun install --frozen-lockfile
PI_CODING_AGENT_DIR="$(realpath config/pi)" pi
```

The tracked `config/pi/settings.json` loads this package through `../../apps`. `PI_CODING_AGENT_DIR` must name the canonical configuration directory, not `settings.json` or an unresolved symlink.

For a one-off run after installing workspace dependencies:

```sh
pi -e "$(realpath apps/omp-lsp/index.ts)"
```

To use the extension independently, copy the complete `apps/omp-lsp/` directory into your Pi configuration's `extensions/` directory, omitting generated `node_modules/`. Run `bun install --production` inside the copied package, then restart Pi or run `/reload`. Keep its supporting source files, `defaults.json`, and `LICENSE`; copying only `index.ts` is insufficient.

### Supported languages and servers to install

Install the language servers your projects need separately. Project-local binaries, including `node_modules/.bin` and common virtual-environment directories, and `PATH` are searched. The tables below cover all 55 bundled presets in [defaults.json](./defaults.json); that file defines their exact file types and project-root markers.

Install only what you need. Multiple entries for one language are alternatives, not a requirement to install every server. The preset names in parentheses identify entries you can customize or disable in [server definitions](#server-definitions).

| Language or framework | Server to install (preset) | Required executable |
| --- | --- | --- |
| Astro | Astro language server (`astro`) | `astro-ls` |
| C, C++, Objective-C, Objective-C++ | clangd (`clangd`) | `clangd` |
| C# | OmniSharp (`omnisharp`) | `omnisharp` |
| CSS, SCSS, Sass, Less | VS Code CSS language server (`vscode-css-language-server`) | `vscode-css-language-server` |
| Dart, Flutter | Dart SDK language server (`dartls`) | `dart` |
| Dockerfile | Docker language server (`dockerls`) | `docker-langserver` |
| Elixir, HEEx, EEx | ElixirLS (`elixirls`) | `elixir-ls` |
| Elixir, HEEx, EEx | Expert (`expert`) | `expert` |
| Emmet abbreviations in HTML, CSS, SCSS, Less, JSX, TSX, Vue, Svelte | Emmet language server (`emmet-language-server`) | `emmet-language-server` |
| Erlang | Erlang LS (`erlangls`) | `erlang_ls` |
| Gleam | Gleam's built-in language server (`gleam`) | `gleam` |
| Go | gopls (`gopls`) | `gopls` |
| GraphQL | GraphQL language server (`graphql`) | `graphql-lsp` |
| Haskell | Haskell Language Server (`hls`) | `haskell-language-server-wrapper` |
| Helm YAML and templates | Helm LS (`helm-ls`) | `helm_ls` |
| HTML | VS Code HTML language server (`vscode-html-language-server`) | `vscode-html-language-server` |
| Java | Eclipse JDT Language Server (`jdtls`) | `jdtls` |
| JavaScript, TypeScript, JSX, TSX | Native TypeScript compiler with LSP support (`typescript-native`) | `tsc` with `--lsp` support |
| JavaScript, TypeScript, JSX, TSX | TypeScript Language Server plus TypeScript (`typescript-language-server`) | `typescript-language-server` |
| JavaScript, TypeScript, JSX, TSX in Deno projects | Deno's built-in language server (`denols`) | `deno` |
| JSON, JSONC | VS Code JSON language server (`vscode-json-language-server`) | `vscode-json-language-server` |
| Kotlin | Kotlin LSP (`kotlin-lsp`) | `kotlin-lsp` |
| LaTeX, BibTeX | TexLab (`texlab`) | `texlab` |
| Lua | Lua Language Server (`lua-language-server`) | `lua-language-server` |
| Markdown | Marksman (`marksman`) | `marksman` |
| Nix | nixd (`nixd`) | `nixd` |
| Nix | nil (`nil`) | `nil` |
| OCaml | OCaml-LSP (`ocamllsp`) | `ocamllsp` |
| Odin | OLS (`ols`) | `ols` |
| PHP | Intelephense (`intelephense`) | `intelephense` |
| PHP | Phpactor (`phpactor`) | `phpactor` |
| Prisma schema | Prisma language server (`prismals`) | `prisma-language-server` |
| Python | Basedpyright (`basedpyright`) | `basedpyright-langserver` |
| Python | Pyright (`pyright`) | `pyright-langserver` |
| Python | Python LSP Server (`pylsp`) | `pylsp` |
| Python | ty (`ty`) | `ty` |
| Ruby, ERB | Ruby LSP (`ruby-lsp`) | `ruby-lsp` |
| Ruby | Solargraph (`solargraph`) | `solargraph` |
| Rust | rust-analyzer (`rust-analyzer`) | `rust-analyzer` |
| Scala, sbt | Metals (`metals`) | `metals` |
| Shell scripts (`.sh`, `.bash`, `.zsh`) | Bash Language Server (`bashls`) | `bash-language-server` |
| Svelte | Svelte language server (`svelte`) | `svelteserver` |
| Swift | SourceKit-LSP (`sourcekit-lsp`) | `sourcekit-lsp` |
| Tailwind CSS in HTML, CSS, SCSS, JavaScript, TypeScript, JSX, TSX, Vue, Svelte | Tailwind CSS language server (`tailwindcss`) | `tailwindcss-language-server` |
| Terraform | Terraform LS (`terraformls`) | `terraform-ls` |
| TLA+ | TLAPM LSP (`tlaplus`) | `tlapm_lsp` |
| Vim script | Vim language server (`vimls`) | `vim-language-server` |
| Vue | Vue language server (`vue-language-server`) | `vue-language-server` |
| YAML | YAML Language Server (`yamlls`) | `yaml-language-server` |
| Zig | ZLS (`zls`) | `zls` |

The HTML, CSS, JSON, and ESLint executables are distributed together in [`vscode-langservers-extracted`](https://github.com/hrsh7th/vscode-langservers-extracted). [TypeScript Language Server](https://github.com/typescript-language-server/typescript-language-server#installing) requires both `typescript-language-server` and `typescript`.

An installed native `tsc` with LSP support is preferred for the default TypeScript/JavaScript preset; otherwise the extension uses `typescript-language-server`. A compiler without `--lsp` support is not a language server. The legacy preset uses its semantic server so initial cross-file requests do not return syntax-only results.

### Optional linting and formatting presets

These five presets supplement language servers; they do not replace semantic navigation or refactoring. Biome and SwiftLint use CLI adapters.

| Language or framework | Tool to install (preset) | Required executable |
| --- | --- | --- |
| JavaScript, TypeScript, JSX, TSX, JSON, JSONC, CSS | Biome (`biome`) | `biome` |
| JavaScript, TypeScript, JSX, TSX, Vue, Svelte | ESLint plus the VS Code ESLint language server (`eslint`) | `vscode-eslint-language-server` |
| Python | Ruff (`ruff`) | `ruff` |
| Ruby | RuboCop (`rubocop`) | `rubocop` |
| Swift | SwiftLint (`swiftlint`) | `swiftlint` |

## Use the `lsp` tool

The `omp-lsp` package registers one tool: `lsp`. The entries below are values of its `action` parameter, not separate tools.

| Operation | `action` values |
| --- | --- |
| Navigation and symbols | `definition`, `references`, `type_definition`, `implementation`, `hover`, `symbols` |
| Diagnostics | `diagnostics` |
| Refactoring | `rename`, `rename_file`, `code_actions` |
| Server inspection and lifecycle | `status`, `capabilities`, `reload` |
| Raw protocol requests | `request` |

Start by inspecting configured and missing servers:

```json
{"action":"status"}
```

Position-based actions use a one-based `line` and a `symbol` substring. Append `#2` to select the second occurrence on that line:

```json
{"action":"definition","file":"src/index.ts","line":12,"symbol":"createClient"}
```

**`rename` and `rename_file` apply changes by default.** Set `apply: false` to preview:

```json
{"action":"rename","file":"src/index.ts","line":12,"symbol":"createClient","new_name":"buildClient","apply":false}
```

Code actions only list by default. Applying one requires `apply: true` and a `query` containing its title or zero-based index.

Use `file: "*"` for workspace diagnostics, or with `symbols` and a `query` for workspace symbol search. The `request` action sends a server `method` with a JSON-encoded `payload` string. After changing LSP configuration, reload it with:

```json
{"action":"reload","file":"*"}
```

## Configuration

### Settings

Settings are layered from bundled defaults, the Pi agent directory's `settings.json`, and the trusted project's `.pi/settings.json`. Project values override global values. The agent directory is selected by `PI_CODING_AGENT_DIR` and defaults to `~/.pi/agent`.

These are the defaults:

```json
{
  "lsp": {
    "enabled": true,
    "lazy": true,
    "diagnosticsOnWrite": true,
    "diagnosticsOnEdit": false,
    "formatOnWrite": false,
    "diagnosticsDeduplicate": true
  }
}
```

Successful Pi `write` and `edit` operations synchronize changed documents. The diagnostic settings control appended feedback; `diagnosticsDeduplicate` suppresses unchanged diagnostic reports. `formatOnWrite` formats successful writes, not targeted edits.

### Server definitions

Server definitions are read only from the agent directory and the trusted project's `.pi/` directory. Within each directory, priority is highest to lowest: `lsp.json`, `.lsp.json`, `lsp.yaml`, `.lsp.yaml`, `lsp.yml`, then `.lsp.yml`. Files merge from lower to higher priority, and project definitions override global definitions.

Project-root files, `.omp/`, `.claude/`, and plugin directories are not searched.

You can override any bundled preset without editing `defaults.json`. Use the preset name from the tables above as the key under `servers`.

#### 1. Choose the configuration scope

| Scope | Extension switches | Server overrides |
| --- | --- | --- |
| All projects using this Pi agent directory | `<agent-dir>/settings.json` | `<agent-dir>/lsp.json` |
| This trusted project only | `.pi/settings.json` | `.pi/lsp.json` |

`<agent-dir>` is `PI_CODING_AGENT_DIR`, or `~/.pi/agent` when unset. With this repository's setup, it is the canonical `config/pi` directory. Precedence is **bundled defaults → agent-directory overrides → trusted project overrides**. Untrusted projects cannot supply project overrides or run language servers.

The examples below use project-local files. Merge these keys into existing files; do not replace unrelated settings such as your extension list.

#### 2. Override extension behavior in `.pi/settings.json`

```json
{
  "lsp": {
    "diagnosticsOnEdit": true,
    "formatOnWrite": true
  }
}
```

This enables diagnostic feedback after edits and formatting after writes. Other switches, such as `diagnosticsOnWrite`, retain their lower-priority values. These switches belong in `settings.json`, not `lsp.json`.

#### 3. Override server presets in `.pi/lsp.json`

```json
{
  "idleTimeoutMs": 600000,
  "servers": {
    "clangd": {
      "args": ["--background-index", "--clang-tidy"]
    },
    "pyright": {
      "settings": {
        "python": {
          "analysis": {
            "autoSearchPaths": true,
            "diagnosticMode": "workspace",
            "useLibraryCodeForTypes": true
          }
        }
      }
    },
    "ruff": {
      "disabled": true
    }
  }
}
```

This example:

- Sets the idle timeout to 600,000 milliseconds (10 minutes).
- Replaces clangd's complete argument list. The bundled `--header-insertion=iwyu` argument is omitted; add it explicitly if you want to retain it.
- Configures Pyright to analyze the workspace rather than only open files, retaining the two other bundled analysis settings.
- Disables the Ruff preset for this project.

**Server overrides merge by field, not recursively.** Omitted fields such as `command`, `fileTypes`, and `rootMarkers` retain their lower-priority values. Supplied arrays such as `args` replace the entire array; supplied objects such as `settings`, `initOptions`, and `env` replace the entire object.

For example, if your agent-directory `lsp.json` adds another Pyright setting, the project-level `settings` object above replaces it too. Copy every nested value you want to retain into the higher-priority object. The same replacement rule applies between configuration files within one directory.

#### 4. Reload and inspect the configuration

After saving, call the `lsp` tool with:

```json
{"action":"reload","file":"*"}
```

Then inspect configured and missing servers:

```json
{"action":"status"}
```

Overrides do not install executables. Install the required servers separately, or override their `command` field to point to an installed executable.

New named definitions specify `command`, `args`, `fileTypes`, and `rootMarkers`. Optional `env`, `settings`, `initOptions`, `languageId`, and `extensionToLanguage` configure the server further. See [defaults.json](./defaults.json) for complete examples.

## Runtime boundaries

- LSP is available only in trusted Pi projects. Servers and workspace checkers run with normal host permissions, outside the Bash sandbox; this extension does not alter sandbox policy.
- Servers are session-owned, start lazily by default, and are stopped on session shutdown. Set `lazy: false` to warm configured servers during initialization.
- Missing servers and failed diagnostics are not evidence that a project is clean. Unversioned server diagnostics are explicitly marked freshness-unverified rather than presented as verified clean results.

## Focused checks

From the repository root:

```sh
bun test apps/omp-lsp
```

From `apps/omp-lsp/`:

```sh
bun run lint
bun run typecheck
bun run test
```

## Origin and license

The extension retains server presets from [Oh My Pi](https://github.com/can1357/oh-my-pi). Upstream attribution and MIT license terms are preserved in [LICENSE](./LICENSE).
