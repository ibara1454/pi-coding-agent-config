---
name: pi-extension-libraries
description: >-
  Choose existing Pi libraries when creating, modifying, or reviewing custom
  extensions in apps/. Use for extension APIs, tool parameter schemas, agent and
  model types, provider integrations, terminal UI, or dependency selection;
  prefer host-provided packages over duplicate implementations or new dependencies.
---

# Pi extension libraries

Before implementing a helper or adding a dependency, check the existing extension
code and the libraries below. Reuse the host's public APIs rather than rebuilding
its schemas, message types, terminal widgets, keyboard parsing, or model plumbing.

## Choose by responsibility

| When you need… | Use | Selection guidance |
| --- | --- | --- |
| Extension registration, lifecycle events, commands, tools, session state, or host UI | `@earendil-works/pi-coding-agent` | Import `ExtensionAPI`, `ExtensionContext`, and event types here. Use `isToolCallEventType` to narrow tool events. Use the supplied `pi` and `ctx` rather than constructing another coding-agent session. |
| Existing coding-agent helpers or themed UI | `@earendil-works/pi-coding-agent` | Reuse exported helpers such as `createReadTool`, `createBashTool`, `truncateHead`, and `truncateTail`; preserve their contracts. Use `getMarkdownTheme`, `getSelectListTheme`, or host components such as `BorderedLoader` when appropriate. |
| Agent-loop message, tool, result, or event contracts | `@earendil-works/pi-agent-core` | Use types such as `AgentMessage`, `AgentTool`, and `AgentToolResult` instead of local copies. This is the lower-level agent layer, not the extension registration API; a normal extension does not need its own agent loop. |
| JSON schemas for `pi.registerTool().parameters` and their inferred TypeScript types | `typebox` | Import `Type`, `Static`, and `TSchema` here. Compose `Type.Object`, `Type.String`, `Type.Optional`, etc.; do not add another schema library for ordinary tool parameters. |
| One-off runtime checks or explicit value operations on data outside Pi's tool-argument validation | `typebox/value` | Use `Value.Check` or `Value.Errors` for checking/reporting. Conversion, defaults, and cleaning are separate choices: do not silently alter input merely to validate it. |
| Repeated validation of the same schema in extension-owned code | `typebox/compile` | Use `Compile` and reuse the compiled validator. Do not compile per call or add a second validator solely for tool arguments Pi already validates. |
| Provider-neutral model, message, content, usage, or provider types; AI helpers | `@earendil-works/pi-ai` | Use types such as `Model`, `Message`, and `Provider`. Use `StringEnum` for string-valued tool choices instead of `Type.Enum` or unions of literals, for provider compatibility. |
| A separate model/provider collection that the task actually requires | `@earendil-works/pi-ai/models` | Use `createModels` for the lightweight model runtime. For the current Pi session, prefer `ctx.modelRegistry`; register extension providers through `pi.registerProvider` instead of rebuilding host model/auth state. |
| Every built-in provider and its catalog | `@earendil-works/pi-ai/providers/all` | Use `builtinModels` or `builtinProviders` only when all providers are required. For a single provider, prefer its public factory subpath, such as `@earendil-works/pi-ai/providers/openai`, after checking the pinned exports. |
| Maintenance of code using the older global model API | `@earendil-works/pi-ai/compat` | This is the compatibility entrypoint for APIs such as `getModel` and `complete`. Prefer the model/provider collection API for new code; do not assume these globals are published root exports. |
| OAuth compatibility types for an extension provider | `@earendil-works/pi-ai/oauth` | In Pi 1.4.0 this entrypoint retains compatibility type declarations, not standalone login/refresh implementations. Use provider-owned `OAuthAuth` and the host's provider registration/auth integration; do not implement a parallel token store or refresh loop. |
| Custom terminal components, layout, keyboard handling, fuzzy selection, or display-width calculations | `@earendil-works/pi-tui` | Reuse `Text`, `Markdown`, `Container`, `SelectList`, `Input`, `matchesKey`, `Key`, and `fuzzyFilter`. Use `visibleWidth` and `truncateToWidth` for ANSI/Unicode-aware sizing, not string length/slicing or homemade escape-code parsing. |
| Filesystem access, paths, URLs, or HTTP without a Pi-specific abstraction | Node.js built-ins and platform APIs | Prefer `node:fs/promises`, `node:path`, `URL`, and `fetch` over adding utility packages. Reuse an existing repository abstraction when it already owns the behavior. |

## Apply the boundaries

- For a notification, confirmation, selection, or text prompt, start with
  `ctx.ui.notify`, `confirm`, `select`, or `input`. Use `ctx.ui.custom` and `pi-tui`
  only when the built-in interaction cannot express the requested UI. Respect
  `ctx.hasUI` for interactive behavior; do not start a second terminal renderer.
- Keep tool parameter schemas JSON-compatible. Pi validates tool arguments, but
  execution must still enforce authorization and domain constraints. Do not rely
  on TypeBox-only refinements or codecs being applied by Pi's argument validator.
- Keep imports at documented public entrypoints. Do not reach into another
  package's `src/`, `dist/`, or `node_modules/` to obtain an internal helper.

## Import only what the extension needs

For example, an extension defining a string-choice tool and rendering a custom
text result uses these imports, not a new schema or terminal library:

```ts
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
```

Use `import type` for type-only dependencies. In new code, import TypeBox symbols
from `typebox`, not `pi-ai`; Pi's runtime compatibility aliases can expose symbols
that the published package's types do not export. Prefer `@earendil-works/*` and
`typebox` over the legacy `@mariozechner/*` and `@sinclair/typebox` aliases.

## Respect dependency and version ownership

- Pi maps its host-provided imports to its own copies so extensions share classes
  and registries. Do not bundle those packages or add them to runtime
  `dependencies`. Declare needed host packages as peers; follow this repository's
  Pi compatibility range (`^1.4.0`) rather than widening it blindly. Development
  copies belong in `devDependencies`; the workspace root already supplies the
  main Pi packages for local development.
- Unrelated runtime packages belong in the owning extension's `dependencies`,
  not only `devDependencies`: distributed Pi installs omit development packages.
  Do not rely on an undeclared transitive package just because it resolves locally.
- Check `package.json`, `bun.lock`, and the installed package's public declarations
  before choosing an API. This repository pins Pi 1.4.0; local installs can be
  stale, and the latest online documentation can describe a different version.
  Do not upgrade dependencies as a side effect of selecting a library.

## References

- [Pi available imports](https://pi.dev/docs/latest/extensions#available-imports)
- [Pi 1.4.0 dependency rules](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/packages.md#declare-dependencies)
- [Pi 1.4.0 AI library and provider APIs](https://github.com/earendil-works/pi/blob/v1.4.0/packages/ai/README.md)
- [Pi 1.4.0 terminal UI library](https://github.com/earendil-works/pi/blob/v1.4.0/packages/tui/README.md)
