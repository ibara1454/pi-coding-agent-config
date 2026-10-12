# Custom Biome rules

Custom `.grit` rules and colocated integration tests live in `src/`. The root
Biome configuration loads these checked-in rules by filesystem path.

## Rules

| Rule | Required usage |
| --- | --- |
| [`no-async-describe-callback`](src/no-async-describe-callback.grit) | Keep `describe` callbacks synchronous; put async work in tests or lifecycle hooks. |
| [`no-double-type-assertion`](src/no-double-type-assertion.grit) | Replace `value as unknown as T` with type narrowing or a correctly shaped value. |
| [`no-private-methods`](src/no-private-methods.grit) | Use module-level helpers instead of `private` or `#` methods. Private fields remain allowed. |
| [`use-should-test-title`](src/use-should-test-title.grit) | Start literal `test`/`it` titles with `should ` and name the expected behavior. |
| [`use-undefined`](src/use-undefined.grit) | Use `undefined` for absent values and types; see the [exceptions below](#undefined-instead-of-null). |

## Undefined instead of null

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
// biome-ignore lint/plugin/use-undefined: LSP requires null for an unversioned document.
const document = { uri, version: null };
```

Do not suppress internal absence; update its producers, consumers, and tests.

## Testing

Each rule has a colocated `*.integration.test.ts` file with inline valid and
invalid source strings. The shared `src/test-utils.ts` helper loads the checked-in
`.grit` rule into an in-memory filesystem and runs the real Biome WASM engine.
It releases each workspace after use and decodes diagnostic spans as UTF-8
byte offsets. Tests require neither CLI subprocesses nor fixture files.

Keep `@biomejs/wasm-nodejs` pinned to the same version as the root
`@biomejs/biome` CLI so tests and repository lint use the same engine.

Run only the custom-rule tests from the repository root:

```bash
bun test packages/biome-rules
```
