# Repository engineering

Read this guide before implementing or reviewing a repository change. Apply only the rules that can affect the changed surface. Current manifests, scripts, configuration, and source are authoritative for facts that can change.

Examples show the rule; they do not limit it to the named package or type.

## Requirement words and deviations

- **MUST** and **MUST NOT** are required.
- **SHOULD** and **SHOULD NOT** are required unless an accepted waiver records why the default is wrong for this change.
- **MAY** is optional.

Direct system, developer, and user instructions keep their normal precedence. A higher-priority requirement that conflicts with this guide is an **authorized override**; follow it and record the conflict. It does not need repository-policy approval.

A voluntary deviation at this guide's precedence level is a **waiver**. It needs `ACCEPT` from a reviewer other than the implementer. Unaccepted waivers leave the work incomplete.

## Interface meaning

A module is a function, class, package, or larger slice with an interface and an implementation. Its interface is every fact callers must know: types, ordering, errors, configuration, resource ownership, and relevant performance constraints.

## Module design contract

### Add a module only when it removes work from callers

Keep a module when deleting it would spread policy, effects, or lifecycle steps into callers. Delete a pass-through whose callers already know the wrapped operation.

**GOOD**

```ts
// Callers know one operation and one result.
const settings = await loadSettings(path);

async function loadSettings(path: string): Promise<Settings> {
  const text = await readFile(path, "utf8");
  return parseAndValidateSettings(text);
}
```

**NG**

```ts
// Every caller must reproduce the implementation sequence.
const text = await readSettingsText(path);
const parsed = parseSettingsJson(text);
const settings = validateSettings(parsed);

// This extra module hides nothing.
const readSettingsText = (path: string) => readFile(path, "utf8");
```

File size, uncovered lines, and test access alone do not justify a new module.

### Do not export implementation only for tests

A function or constant MUST NOT be exported only so tests can import it. Exercise private behavior through the owning module's production interface.

**GOOD**

```ts
function parseSettings(text: string): Settings {
  return validateSettings(JSON.parse(text));
}

export function loadSettings(text: string): Settings {
  return parseSettings(text);
}

test("should load valid settings when JSON is valid", () => {
  expect(loadSettings('{"enabled":true}')).toEqual({ enabled: true });
});
```

**NG**

```ts
export { parseSettings }; // Exported only so parseSettings.test.ts can import it.
```

### Split responsibilities only when they change or are tested independently

Split code when responsibilities have different change reasons, side effects, resource lifetimes, or test setup. Do not add a pass-through layer with the same behavior and lifetime.

**GOOD**

```ts
function canLoad(settings: Settings): boolean {
  return settings.trusted && settings.enabled;
}

export async function load(io: SettingsIo): Promise<boolean> {
  return canLoad(await io.read());
}
```

**NG**

```ts
export const read = (io: SettingsIo) => io.read(); // Adds a layer but no behavior.
```

### Validate before use, gate access, and keep required failures visible

Validate host, process, configuration, filesystem, network, and terminal data before policy consumes it. Check trust or permission before touching guarded resources. Catch an effect failure in the module that owns the effect.

A required-operation failure MUST remain observable through the declared result, error, or notification. An optional integration MAY fail open without blocking unrelated host behavior.

**GOOD**

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

**NG**

```ts
const text = await context.readSettings(); // Guarded access happened before the trust check.
if (!context.projectTrusted) return;

try {
  await saveRequiredSettings();
} catch {
  return { kind: "saved" }; // Required failure was hidden.
}
```

### Give every resource one owner

Every acquired timer, subscription, lock, socket, temporary directory, and other handle MUST have one owner. The owner releases it on every applicable normal, error, and cancellation path. Cleanup MUST be idempotent when more than one path can request it.

**GOOD**

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

**NG**

```ts
const unsubscribe = subscribe();
const result = await work();
unsubscribe(); // An exception from work() skips cleanup.
return result;
```

### Carry interface changes through every consumer

Trace every added value, type, or discriminated variant from its producer through every dispatch and final observable result. Update affected callers, tests, and documentation in the same change. Remove obsolete aliases, re-exports, and duplicate conventions unless compatibility is explicitly required.

**GOOD**

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

**NG**

```ts
if (result.kind !== "commit") return; // A new "reload" result disappears silently.
```

## Test contract

### Choose the test level from the behavior that owns the expected result

A direct test covers behavior owned by one module through that module's interface and uses `*.test.ts`. An integration test covers a result that depends on another production module, an external runtime, or real filesystem/process semantics and uses `*.integration.test.ts`.

Imports, file count, and mock usage do not decide the level. Both levels test through the owning production interface.

**GOOD**

```ts
// pricing.test.ts — calculateTotal owns the result.
test("should calculate the total when the cart has items", () => {
  expect(calculateTotal(cart)).toBe(42);
});

// checkout.integration.test.ts — checkout and the real database collaborate.
test("should persist the order when checkout succeeds", async () => {
  await checkout(realDatabase, cart);
  expect(await realDatabase.orders()).toHaveLength(1);
});
```

**NG**

```ts
// Named integration only because it imports three files.
test("should work", () => expect(privateHelper()).toBe(true));
```

### Keep pure behavior real and mock external side effects

Tests MUST run the real pure behavior under test. Replace filesystem, network, process, clock, and host side effects with in-memory mocks that record inputs or return planned outcomes. Tests MUST NOT read, write, or delete external state.

**GOOD**

```ts
const storage = {
  read: async () => currentSettings,
  write: async (path: string, text: string) => {
    writes.push({ path, text });
  },
};

const result = await saveSettings(request, storage);
expect(result.status).toBe("committed");
expect(writes).toEqual([{ path: request.path, text: expectedText }]);
```

**NG**

```ts
const result = fakeSaveSettings(request); // Reimplements the pure policy.
await realStorage.write(request); // Mutates external state.
```

### Name the operation, observable result, and distinguishing condition

Group tests for a named operation under the exact `describe("exportedFunction")` or `describe("Class.method")`; the `describe` callback is synchronous. Every rendered leaf title starts with `should <observable result>` and adds `when <condition>` or `if <condition>` when a condition distinguishes the case.

For `test.each`, every interpolated row title must remain grammatical and complete. Lifecycle titles name the triggering transition. Snapshot titles name the bounded presentation state.

**GOOD**

```ts
describe("parseSettingsDocument", () => {
  test.each([
    ["empty", ""],
    ["whitespace-only", "   "],
  ])("should return an empty value when input is %s", (_label, input) => {
    expect(parseSettingsDocument(input)).toBeEmpty();
  });
});

test("should expose only the extension factory", assertSingleExport);
```

**NG**

```ts
test("works", runCase);
test.each(cases)("should return the expected result for: %s", runCase);
test("should parse when called", runCase);
```

### Use data tables for equivalent cases, not different control flow

Use `test.each` when at least three cases share arrange, act, and assertions and differ only in input and expected output. Two cases MAY use a table when the rows state the contract more clearly.

Generate a Cartesian product only when interactions among the dimensions are part of the contract. Otherwise cover each dimension independently or with representative combinations.

**GOOD**

```ts
const outcomes = [
  ["enabled", "loaded"],
  ["disabled", "skipped"],
] as const;

// The contract requires both outcomes through every entrypoint.
const cases = entrypoints.flatMap((entrypoint) =>
  outcomes.map(([input, expected]) => [expected, input, entrypoint] as const),
);

test.each(cases)(
  "should return %s when input is %s from %s",
  (expected, input, entrypoint) => {
    expect(run(entrypoint, input)).toBe(expected);
  },
);
```

**NG**

```ts
const cases = outcomes.map((expected) => [expected, expected] as const);
test.each(cases)("should return %s when given %s", (expected, input) => {
  expect(run(input)).toBe(expected); // The example only echoes its expectation.
});

// Unrelated dimensions produce a large matrix with no interaction contract.
const cases = cartesian(allThemes, allLocales, allCommands, allErrors);
```

A table callback that needs row-specific branching is several tests hidden in one callback; split it.

### Fix snapshot inputs and assert observable invariants outside the snapshot

A snapshot MUST use fixed width, input, environment, and every other value that affects output. Keep cell width, sanitization, cleanup, and emitted effects as explicit assertions. Review changed snapshot output manually; CI MUST NOT update snapshots.

**GOOD**

```ts
test("should render bounded output when details are open", () => {
  const output = renderPanel({ detailsOpen: true, rows: fixedRows, width: 40 });
  expect(frame(output)).toMatchSnapshot();

  for (const line of output.split("\n")) {
    expect(visibleWidth(line)).toBe(40);
  }
  expect(output).not.toContain("\r");
});
```

**NG**

```ts
expect(renderPanel(runtimeState)).toMatchSnapshot(); // Time, width, and input can drift.
```

