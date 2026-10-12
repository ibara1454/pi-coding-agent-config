# Custom Biome rules

Custom `.grit` rules and colocated integration tests live in `src/`. The root
Biome configuration loads these checked-in rules by filesystem path.

The private-method rule rejects class methods written as `private method()` or
`#method()`, including overload signatures. Private fields remain allowed. Move
internal helpers to module scope rather than making them public.

## Undefined instead of null

`use-undefined` rejects `null` values and types in source and tests. Equality
checks (`==`, `!=`, `===`, `!==`) allow null operands, including parentheses.
This does not exempt nested values: `null === send(null)` still reports the
argument.

Use `undefined` for internal absence. The rule has no autofix: JSON
serialization and external APIs distinguish these values.

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
