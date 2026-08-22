# Domain docs

## Layout

This repository uses a single-context layout:

- `CONTEXT.md` at the repository root defines domain terms and system context.
- `docs/adr/` contains architecture decision records.

## Consumer rules

Before exploring code for a task:

1. Read root `CONTEXT.md` when it exists.
2. Read ADRs in `docs/adr/` relevant to the area being changed.
3. Use the glossary vocabulary from `CONTEXT.md` in issue titles, proposals, hypotheses, and test names.

If these files do not exist, proceed silently. Do not recommend creating them upfront. The `domain-modeling` skill creates context documents and ADRs when a real decision or terminology need arises.
