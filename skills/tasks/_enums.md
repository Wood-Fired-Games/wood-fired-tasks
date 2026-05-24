---
name: _enums
description: "Reference-only enum source-of-truth pointer for /tasks:* skills. NOT invocable. Documentation only — do not list as a slash command."
disable-model-invocation: true
---

# Canonical Task Enum Reference

> **This file is documentation-only.** It is gated with `disable-model-invocation: true` so Claude Code's slash-command surface does NOT list it. Every other `/tasks:*` skill that mentions a status or priority value MUST cite this file (and the underlying source) instead of duplicating the value list.

## Authoritative source

The single authoritative source for both enums is the TypeScript constant module:

- **Source of truth:** [`src/types/task.ts`](../../src/types/task.ts) lines 2–3
- **Zod re-export:** [`src/schemas/task.schema.ts`](../../src/schemas/task.schema.ts) line 2 (imports `TASK_STATUSES` and `TASK_PRIORITIES` from `src/types/task.ts` and re-exposes them via `z.enum()`)

If the values below ever drift from `src/types/task.ts`, **the source wins**. Update this file (and any skill that cites it) to match.

## Canonical TASK_STATUSES

Exact value list, ordered as in source:

1. `open`
2. `in_progress`
3. `done`
4. `closed`
5. `blocked`
6. `backlogged`

Notes:

- There is **no `cancelled`** status. Skills that historically named `cancelled` should use `closed` (terminal) or `backlogged` (deprioritized, not abandoned) depending on intent.
- Both `done` and `closed` are terminal in the lifecycle sense — neither can be marked `done` again.
- `backlogged` is a deprioritization signal, not a terminal state — it can be returned to `open` later.

## Canonical TASK_PRIORITIES

Exact value list, ordered low → high:

1. `low`
2. `medium`
3. `high`
4. `urgent`

Notes:

- There is **no `critical`** priority (use `urgent`).
- There is **no `normal`** priority (use `medium`).
- Default priority for new tasks is `medium`; default for `/tasks:log-bug` is `high`.

## How skills should cite this file

A skill that lists or branches on enum values MUST include a one-line reference near the value list, e.g.:

```markdown
See [_enums.md](_enums.md) for canonical status values (source: `src/types/task.ts`).
```

The static test at [`src/api/routes/tasks/__tests__/skill-enums.test.ts`](../../src/api/routes/tasks/__tests__/skill-enums.test.ts) asserts that every enum-shaped token used in `skills/tasks/*.md` is a member of the canonical arrays above.
