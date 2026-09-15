# Custom Biome rules

Custom `.grit` rules and colocated integration tests live in `src/`. The root
Biome configuration loads the rules by filesystem path; Biome 2.5.10 does not
resolve package specifiers for plugins.

The private-method rule rejects class methods written as `private method()` or
`#method()`, including overload signatures. Private fields remain allowed. Move
internal helpers to module scope rather than making them public.

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
