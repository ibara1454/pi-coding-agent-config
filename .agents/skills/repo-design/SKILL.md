---
name: repo-design
description: >-
  Repository function and interface contracts. Use when implementing, refactoring,
  or reviewing functions or methods; naming or extracting helpers; changing module
  boundaries, parameters, return values, exports, or caller dispatch; documenting
  TypeScript contracts; or handling validation, failures, effects, and resource lifetimes.
---

# Repository design

Apply the requirements below to every affected function and interface. Requirement words and deviations are defined in [AGENTS.md](../../../AGENTS.md#repository-engineering).

Examples isolate the illustrated rule; surrounding imports, types, and fixture setup are omitted.

## Identify the contract

A module is a function, class, package, or larger slice with an interface and implementation. Its interface is every fact callers must know: types, ordering, errors, configuration, resource ownership, and relevant performance constraints.

Keep a module when deleting it would spread policy, effects, or lifecycle steps into callers. Delete a pass-through whose callers already know the wrapped operation. File size, lint scores, uncovered lines, and test access alone do not justify a new module.

**GOOD — hide the loading and validation sequence behind one operation.**

```ts
const settings = await loadSettings(path);

async function loadSettings(path: string): Promise<Settings> {
  const text = await readFile(path, "utf8");
  return parseAndValidateSettings(text);
}
```

**NG — callers reproduce the sequence; a pass-through hides nothing.**

```ts
const text = await readSettingsText(path);
const parsed = parseSettingsJson(text);
const settings = validateSettings(parsed);

const readSettingsText = (path: string) => readFile(path, "utf8");
```

A function or constant MUST NOT be exported only so tests can import it. Exercise private behavior through the owning module's production interface.

**GOOD — test private parsing through the production loading operation.**

```ts
function parseSettings(text: string): Settings {
  return validateSettings(JSON.parse(text));
}

export async function loadSettings(path: string): Promise<Settings> {
  return parseSettings(await readFile(path, "utf8"));
}

// settings.integration.test.ts: fixtureFile belongs to this test.
expect(await loadSettings(fixtureFile)).toEqual({ enabled: true });
```

**NG — widen the production interface only for a test.**

```ts
export { parseSettings }; // Exported only for parseSettings.test.ts.
```

## Name and extract coherent operations

Split code when responsibilities have different change reasons, side effects, resource lifetimes, or test setup. Keep steps together when they form one operation with the same ownership.

**GOOD — separate policy from I/O when they need different test setup.**

```ts
function canLoad(settings: Settings): boolean {
  return settings.trusted && settings.enabled;
}

export async function load(io: SettingsIo): Promise<boolean> {
  return canLoad(await io.read());
}
```

**NG — add a layer without separating any behavior or lifetime.**

```ts
export const read = (io: SettingsIo) => io.read();
```

For every added or modified function, agents MUST check its name against the implementation and call sites:

1. Name the domain operation and its important observable effects. Summarize responsibility; leave algorithm details to the implementation and TSDoc.
2. Treat a vague, unwieldy, or difficult-to-choose name as a signal to revisit the extraction. Rename when the operation is already coherent; otherwise reshape its interface and parameters or simplify/refactor its logic until a concise name describes it accurately.
3. Make work-selection inputs, results, and effect ownership explicit. A processing range belongs in an input or the operation's owned state; an unrelated output report must not secretly select work.
4. Treat supplied inputs and captured caller state as read-only. Return computed values and diagnostics for the owner to apply instead of mutating parameters, filling output containers, or updating captured caller state. Callers own their virtual state and result aggregation. Keep a helper local when it relies on the enclosing operation's private state, without using that locality to hide caller-state mutation.
5. Necessary I/O belongs in operations that explicitly own those effects. Returning data does not require making effect-owning operations pure; make their I/O and failures part of the contract.

Before accepting an extraction, agents MUST trace every call site against the contract and account for selected work, state updates, returned results, and failure handling.

```ts
// restoreTextEdits owns filesystem restoration; its caller selects work and builds the report.
const committedChanges = plan.slice(0, committedCount);
const failures = await restoreTextEdits(committedChanges);
const nextReport = {
  ...report,
  failures: [...report.failures, ...failures],
};
```

Here the range is explicit, the helper returns diagnostics, and the owner builds the updated result. Likewise, a planning helper returns a plan and diagnostics rather than modifying a supplied virtual-files map or captured error list.

## Document important or repeatedly called functions

When adding or modifying a TypeScript function or method, agents MUST add or update a TSDoc comment directly above its declaration if either condition applies:

- **Important:** its contract is needed to understand the module's public behavior, core policy, validation, state transitions, or resource ownership.
- **Repeated calls:** it serves multiple callers or is expected to be invoked more than once, including repeated invocations through a single call site.

The TSDoc MUST explain purpose, input and output semantics, relevant errors, side effects, and resource ownership. Use `@param`, `@returns`, and `@throws` where applicable, and include an `@example` showing concrete inputs and expected output or observable effects. Explain non-obvious terminology and units; keep comments concise and focused on behavior rather than restating TypeScript types.

Before completing the change, check every added or modified function against these conditions and ensure its required TSDoc matches the implementation.

## Validate before use and keep failures visible

Validate host, process, configuration, filesystem, network, and terminal data before policy consumes it. Check trust or permission before touching guarded resources. Catch an effect failure in the module that owns the effect.

A required-operation failure MUST remain observable through the declared result, error, or notification. An optional integration MAY fail open without blocking unrelated host behavior.

**GOOD — check trust before access and report required failures.**

```ts
async function loadProject(context: Context): Promise<LoadResult> {
  if (!context.projectTrusted) return { kind: "skipped" };

  try {
    const text = await context.readSettings();
    return { kind: "loaded", settings: parseAndValidateSettings(text) };
  } catch (error) {
    return { kind: "failed", error };
  }
}
```

**NG — access precedes the guard, or a required failure looks successful.**

```ts
const text = await context.readSettings();
if (!context.projectTrusted) return;

try {
  await saveRequiredSettings();
} catch {
  return { kind: "saved" };
}
```

## Give every resource one owner

Every acquired timer, subscription, lock, socket, temporary directory, and other handle MUST have one owner. The owner releases it on every applicable normal, error, and cancellation path. Cleanup MUST be idempotent when more than one path can request it.

**GOOD — release the resource when work succeeds, throws, or is cancelled.**

```ts
async function withSubscription<T>(
  subscribe: () => () => void,
  work: () => Promise<T>,
): Promise<T> {
  const unsubscribe = subscribe();
  try {
    return await work();
  } finally {
    unsubscribe();
  }
}
```

**NG — a rejected operation skips cleanup.**

```ts
const unsubscribe = subscribe();
const result = await work();
unsubscribe();
return result;
```

## Carry interface changes through every consumer

Trace every added value, type, or discriminated variant from its producer through every dispatch and final observable result. Update affected callers, tests, and documentation in the same change. Remove obsolete aliases, re-exports, and duplicate conventions unless compatibility is explicitly required.

**GOOD — handle every result and make missing variants visible.**

```ts
function handlePanelResult(result: PanelResult): void {
  switch (result.kind) {
    case "close":
      return;
    case "reload":
      return reload();
    case "commit":
      return commit(result.targets);
    default:
      return assertNever(result);
  }
}
```

**NG — silently discard a newly added result.**

```ts
if (result.kind !== "commit") return;
```
