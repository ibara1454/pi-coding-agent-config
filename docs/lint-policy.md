# Lint rule policy

[The root `biome.jsonc`](../biome.jsonc) is the authoritative configuration. It uses
Biome's `all` preset with explicit project decisions and comments explaining disabled
rules. This reference covers the 29 rules reviewed during the lint cleanup, not
every rule enabled by the preset or the custom Grit plugins.

- **Error:** enabled and enforced by `bun run check` and `bun run lint`.
- **Off:** deliberately disabled or deferred; no diagnostic is emitted.

Promoting a rule to an error does not fix existing violations. Keep this table and
the configuration aligned when changing policy. Preserve external protocol/schema
spellings when resolving naming violations; do not rename public contracts solely
to satisfy a naming convention.

Gradual adoption keeps rules at **Error** while starting metric limits above the
existing baseline: cognitive complexity is capped at **120** (Biome default: 15)
and function length at **750** counted lines (Biome default: 50). These initial
ceilings include production code and test-suite callbacks; lower them as the
owning operations are simplified rather than splitting cohesive code solely to
meet a metric. `noMagicNumbers` is enforced in both production and test code,
using named constants for flagged numeric literals without changing their values.

## Conditional expressions and loops

All rules in this section use the `lint/style/` prefix.

| Rule | Meaning | Severity |
|---|---|---|
| `noTernary` | Prohibits every `condition ? a : b` expression. | Off |
| `noNestedTernary` | Prohibits ternaries nested inside other ternaries. | Error |
| `noContinue` | Prohibits `continue` statements in loops. | Off |
| `noIncrementDecrement` | Prohibits `++` and `--`, including loop counters. | Off |
| `noNegationElse` | Flags `if (!condition) … else …`, preferring a positive condition and reversed branches. | Off |

## Numbers and data access

All rules in this section use the `lint/style/` prefix.

| Rule | Meaning | Severity |
|---|---|---|
| `noMagicNumbers` | Requests named constants instead of numeric literals used directly. | Error |
| `useNumericSeparators` | Requests separators in long numeric literals, such as `10_000`. | Error |
| `useDestructuring` | Prefers destructuring over supported property/index access patterns. | Error |
| `useExplicitLengthCheck` | Requires explicit comparisons of length/size properties, such as `items.length > 0`. | Error |
| `useAtIndex` | Prefers `.at()` for supported indexing patterns, such as `.at(-1)` for the last item. | Error |

## Naming and TypeScript declarations

All rules in this section use the `lint/style/` prefix.

| Rule | Meaning | Severity |
|---|---|---|
| `useNamingConvention` | Enforces naming and casing conventions across identifiers and properties. | Error |
| `useConsistentMethodSignatures` | Currently prefers function properties, `f: () => void`, over method signatures, `f(): void`. | Error |
| `useConsistentTypeDefinitions` | Currently prefers `interface` over equivalent object-shaped `type` declarations. | Error |
| `useConsistentArrayType` | Currently prefers `T[]` over `Array<T>`. | Error |
| `noInferrableTypes` | Flags redundant annotations such as `let count: number = 0`. | Error |

## File organization and runtime boundaries

All rules in this section use the `lint/style/` prefix.

| Rule | Meaning | Severity |
|---|---|---|
| `noExcessiveLinesPerFile` | Flags files exceeding the rule's line-count limit, currently 300 by default. | Off |
| `noExcessiveClassesPerFile` | Limits classes per file, currently one by default. | Off |
| `useExportsLast` | Requires exports after all non-export statements. | Off |
| `noProcessEnv` | Prohibits direct access to `process.env`. | Off |
| `useErrorCause` | Requests preservation of the original error when wrapping it in a new error. | Error |

## Complexity and expression clarity

| Rule | Meaning | Severity |
|---|---|---|
| `lint/complexity/noExcessiveLinesPerFunction` | Flags functions exceeding the configured limit of 750 counted lines. | Error |
| `lint/complexity/noExcessiveCognitiveComplexity` | Flags branching/nesting complexity above the configured limit of 120. | Error |
| `lint/complexity/useSimplifiedLogicExpression` | Flags redundant terms in logical expressions. | Error |
| `lint/complexity/noImplicitCoercions` | Prefers explicit conversions, such as `Boolean(value)` instead of `!!value`. | Error |
| `lint/style/useNumberNamespace` | Prefers equivalent `Number` properties, such as `Number.NaN` instead of global `NaN`. | Error |

## Other checks

| Rule | Meaning | Severity |
|---|---|---|
| `lint/correctness/noProcessGlobal` | Requires an explicit `node:process` import instead of relying on global `process`. | Error |
| `lint/performance/noAwaitInLoops` | Flags awaits inside loops to highlight potentially unnecessary sequential work. | Off |
| `lint/security/noSecrets` | Heuristically flags strings resembling credentials or secrets. | Off |
| `lint/suspicious/noBitwiseOperators` | Prohibits bitwise operators such as `^`, `>>`, and `>>>`. | Off |

Disabling `noSecrets` removes that heuristic for future code too. The reviewed
findings were false positives; that is not a guarantee against future credential
exposure. Reconsider the rule when its detection can be tuned for this repository.

## Further reference

See [Biome's rule reference](https://biomejs.dev/linter/rules/) for detailed examples
and rule options. The installed Biome version and `biome.jsonc` determine the active
behavior; documentation for newer releases may differ.
