# Plan: <feature name>

> Canonical plan/spec template for `docs/superpowers/{plans,specs}/`.
> Copy this file, fill every section, and delete the inline guidance.

## Goal

<one-sentence goal; the same string you would pass to `/tasks:decompose --goal`>

## Success criteria

- <criterion 1>
- <criterion 2>
- <criterion 3>

## Surface-coverage matrix

One row per capability the feature introduces; one column per deployment
**surface** it could need to reach. Each cell is either a `task-id` (the task
that covers that surface for that capability) or `N/A (reason)` with an
explicit reason. **Every non-N/A cell MUST map to a task.** A cell that is
neither a task id nor a reason-annotated `N/A` is a planning hole.

The 8 canonical surfaces are exactly:
`{ stdio MCP, remote MCP, REST, CLI, skills, client-package mirror, docs/tool-count, migration/backfill }`.

| Capability | stdio MCP | remote MCP | REST | CLI | skills | client-package mirror | docs/tool-count | migration/backfill |
|------------|-----------|------------|------|-----|--------|------------------------|-----------------|--------------------|
| <cap 1>    | #task     | #task      | #task | N/A (no CLI) | N/A (...) | N/A (...) | #task | N/A (no schema change) |

> **Why this matrix exists.** `/tasks:decompose` runs an **invariant-rider**
> step (design doc §Surface-coverage matrix → Step 8c, and
> `skills/tasks/decompose.md` Step 8c) that re-derives the touched surfaces
> from the candidate set itself and auto-emits coverage tasks / AC riders for
> any uncovered surface — most importantly the **stdio MCP tool → remote MCP
> parity** pairing. This matrix is the human-authored counterpart: it forces
> the "remote MCP" cell (and every other surface) to be covered at plan time.
> It exists because of the WSJF remote-parity gap, where 4 stdio MCP tools
> shipped PASS yet were unreachable in production — see
> [`docs/retrospectives/2026-06-01-wsjf-remote-parity-planning-gap.md`](../retrospectives/2026-06-01-wsjf-remote-parity-planning-gap.md).

## Tasks

<numbered task list / DAG; each task referenced in the matrix above must appear here>

## Out of scope

- <explicitly excluded item>
