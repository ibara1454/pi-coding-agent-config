# Custom Biome rules

Custom `.grit` rules and colocated integration tests live in `src/`.
[`biome-manifest.json`](biome-manifest.json) exports the rules and presets through
Biome's [plugin package format](https://biomejs.dev/guides/publish-packages/).

## Usage

Requires Biome 2.6 or later. The root installs `biome-rules` as a workspace
dependency; workspace configs inherit its plugin settings through `"extends": "//"`.
The package remains private and is not published to npm. To use it in another
project, install it from a local checkout:

```bash
bun add --dev /path/to/this-repo/packages/biome-rules
```

Add the presets to that project's `biome.jsonc`:

```jsonc
{
  "plugins": [
    "biome-rules/presets/source",
    {
      "path": "biome-rules/presets/tests",
      "includes": ["**/*.test.ts", "**/*.integration.test.ts"]
    }
  ]
}
```

`source` enables `no-double-type-assertion`, `no-private-methods`, and
`use-undefined`. `tests` enables `no-async-describe-callback` and
`use-should-test-title`; its file scope belongs to the consuming configuration.
To enable one rule instead, use its exported name, such as
`"plugins": ["biome-rules/no-private-methods"]`. Package imports require qualified
suppression names: replace `lint/plugin/<rule-name>` with
`lint/plugin/biome-rules/<rule-name>`.

## [no-async-describe-callback](src/no-async-describe-callback.grit)

Keep `describe` callbacks synchronous. Put async work in tests or lifecycle
hooks.

## [no-double-type-assertion](src/no-double-type-assertion.grit)

Replace `value as unknown as T` with type narrowing or a correctly shaped
value.

## [no-private-methods](src/no-private-methods.grit)

Use module-level helpers instead of `private` or `#` methods. Private fields
remain allowed.

## [use-should-test-title](src/use-should-test-title.grit)

Start literal `test`/`it` titles with `should ` and name the expected behavior.

## [use-undefined](src/use-undefined.grit)

Use `undefined` for absent values and types.

Equality checks (`==`, `!=`, `===`, `!==`) allow null operands, including
parentheses.
This does not exempt nested values: `null === send(null)` still reports the
argument.

The rule has no autofix: JSON serialization and external APIs distinguish
`null` from `undefined`.

Keep required protocol/host nulls, null-rejection fixtures, and null-prototype
objects. Place a narrow suppression immediately above the line containing
`null`, not above the start of a multiline statement:

```ts
// biome-ignore lint/plugin/biome-rules/use-undefined: LSP requires null for an unversioned document.
const document = { uri, version: null };
```

Do not suppress internal absence; update its producers, consumers, and tests.

## Testing

Each rule has a colocated `*.integration.test.ts` file with inline valid and
invalid source strings. The shared `src/test-utils.ts` helper loads the package
metadata, manifest, and selected `.grit` rule into an in-memory filesystem.
It runs the real Biome WASM engine through the exported package rule name,
including package-qualified suppression behavior.
It releases each workspace after use and decodes diagnostic spans as UTF-8
byte offsets. Tests require neither CLI subprocesses nor fixture files.

Keep `@biomejs/wasm-nodejs` pinned to the same version as the root
`@biomejs/biome` CLI so tests and repository lint use the same engine.

Run only the custom-rule tests from the repository root:

```bash
bun test packages/biome-rules
```
