# Domain docs

## Layout

Domain terminology follows package ownership:

- `apps/<package>/CONTEXT.md` and `packages/<package>/CONTEXT.md` define package-specific terms.
- A root `CONTEXT.md`, when present, contains only terminology shared across packages.
- `apps/<package>/adr/` and `packages/<package>/adr/` contain package-specific architecture decision records.
- `docs/adr/` contains only repository-wide architecture decision records.

## Consumer rules

Before exploring code for a task:

1. Read root `CONTEXT.md` when it exists for shared terminology.
2. Read `CONTEXT.md` in each package affected by the task when it exists.
3. Read relevant ADRs in each affected package's `adr/` directory and in root `docs/adr/` when they exist.
4. Use the owning glossary's vocabulary in issue titles, proposals, hypotheses, and test names.

If these files do not exist, proceed silently. Do not recommend creating them upfront. The `domain-modeling` skill creates context documents and ADRs when a real decision or terminology need arises.
