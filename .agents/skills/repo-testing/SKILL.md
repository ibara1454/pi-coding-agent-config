---
name: repo-testing
description: >-
  Repository test contracts. Use when designing, adding, modifying, or reviewing
  tests; choosing direct versus integration coverage or mocking side effects;
  naming suites and cases; building test.each tables; or creating and reviewing snapshots.
---

# Repository testing

Apply the requirements below to every affected test. Requirement words and deviations are defined in [AGENTS.md](../../../AGENTS.md#repository-engineering).

## Choose the level from ownership of the expected result

A direct test covers behavior owned by one module through that module's interface and uses `*.test.ts`. An integration test covers a result that depends on another production module, an external runtime, or real filesystem/process semantics and uses `*.integration.test.ts`.

Imports, file count, and mock usage do not decide the level. Both levels test through the owning production interface. Export constraints are defined in [repo-design](../repo-design/SKILL.md#identify-the-contract).

## Keep pure behavior real and mock external side effects

Tests MUST run the real pure behavior under test. For pure-logic tests, replace filesystem, network, process, clock, and host side effects with in-memory mocks that record inputs or return planned outcomes.

When the expected result depends on real filesystem or process semantics, use isolated integration fixtures. Keep real I/O confined to test-owned state; tests MUST NOT read, write, or delete pre-existing user or project state. Use deterministic temp roots, restore environment variables, invoke shutdown/dispose paths, and remove temp data in `finally`/`afterEach`.

Prefer lightweight fake Pi/UI/context objects over broad integration setup.

## Name the operation, observable result, and distinguishing condition

Use lowercase behavior-focused descriptions. Group tests for a named operation under the exact `describe("exportedFunction")` or `describe("Class.method")`; the `describe` callback is synchronous. Every rendered leaf title starts with `should <observable result>` and adds `when <condition>` or `if <condition>` when a condition distinguishes the case.

For `test.each`, every interpolated row title must remain grammatical and complete. Lifecycle titles name the triggering transition. Snapshot titles name the bounded presentation state.

```ts
describe("parseSettingsDocument", () => {
  test.each([
    ["empty", ""],
    ["whitespace-only", "   "],
  ])("should return an empty value when input is %s", (_label, input) => {
    expect(parseSettingsDocument(input)).toBeEmpty();
  });
});
```

The condition distinguishes the case: `when called` does not. A table label must complete the title rather than merely append an opaque case identifier.

## Use tables for equivalent cases

Use `test.each` when at least three cases share arrange, act, and assertions and differ only in input and expected output. Two cases MAY use a table when the rows state the contract more clearly.

Generate a Cartesian product only when interactions among the dimensions are part of the contract. Otherwise cover each dimension independently or with representative combinations. A table callback that needs row-specific branching is several tests hidden in one callback; split it.

## Fix snapshot inputs and assert invariants separately

A snapshot MUST use fixed width, input, environment, and every other value that affects output. Keep cell width, sanitization, cleanup, and emitted effects as explicit assertions. Review changed snapshot output manually; CI MUST NOT update snapshots.

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
