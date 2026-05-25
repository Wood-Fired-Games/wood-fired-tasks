---
name: audit
description: DESIGN-ONLY STUB. Wave 7.1 design landed (see docs/tasks-audit-design.md); runtime not implemented. When run, would retroactively grade a /tasks:loop run by dispatching one read-only tasks-verifier subagent per closed task and emit AUDIT.md scoring tasks COVERED/PARTIAL/MISSING against their acceptance_criteria. Bounded ≤ $5 per audited run. Skill is gated (`disable-model-invocation: true`) until the runtime ships — explicit user invocation surfaces the design pointer instead of pretending to execute.
argument-hint: --loop-run <path> | --project <id>
disable-model-invocation: true
---

# /tasks:audit

> **Status (2026-05-23):** Design spec landed via wood-fired-tasks task
> **#323**. Runtime orchestration is **not implemented yet** — see the
> follow-on tasks listed at the bottom of
> [`docs/tasks-audit-design.md`](../../docs/tasks-audit-design.md).
> This skill file is a **discovery stub**: invocation should read the
> design spec and report back rather than executing the pipeline.

See [`docs/tasks-audit-design.md`](../../docs/tasks-audit-design.md) for
the full design — contract, methodology, guardrails, artifact schema,
verification fixtures, and cost budget. That document is the source of
truth; this skill file intentionally restates only the navigation.

## Preflight: MCP tools

This skill calls tools on the `wood-fired-tasks` MCP server. The doc uses shorthand `wood-fired-tasks:<tool>`; harness tool names are `mcp__wood-fired-tasks__<tool>`. On `InputValidationError`, load via `ToolSearch` (`select:mcp__wood-fired-tasks__get_task,mcp__wood-fired-tasks__get_comments,mcp__wood-fired-tasks__get_dependencies`) and retry. (Runtime is a design-only stub today — tool calls listed here are what the implemented pipeline would call read-only; the stub does not actually call them.)

## On invocation

While the design is the only artifact that has landed, the skill MUST:

1. **Tell the user the skill is design-only** and point at
   `docs/tasks-audit-design.md`. Do NOT pretend to start the pipeline.
2. **Refuse to dispatch any subagent** (no `tasks-verifier`, no
   Explore-agent), refuse to call `update_task`, refuse to call
   `add_comment`, and refuse to write under `.planning/loops/`. If the
   runtime were implemented it would call:
   - `Read` / `Glob` (resolve LOOP-RUN.md from disk or `--project`)
   - `mcp__wood-fired-tasks__get_task` / `get_comments` /
     `get_dependencies` (reconstruct acceptance_criteria + closing
     evidence; read-only)
   - Task dispatch for one `tasks-verifier` subagent per task
   - `Write` to emit `.planning/loops/<UTC>-<project_id>-AUDIT.md`

   **Design-only — none of the above will fire on invocation.** The
   runtime is deferred; firing any of them would silently violate the
   contract.
3. **Remind the user** that follow-on wood-fired-tasks tasks must be
   created to implement the pipeline (LOOP-RUN.md resolver, per-task
   verifier dispatcher, score roll-up, cost tracker with $5 hard cap,
   AUDIT.md emitter, fixtures) before this skill becomes operational.

A representative response shape:

```
/tasks:audit is design-only as of #323 (Wave 7.1).

The design (contract, pipeline, guardrails, artifact schema, cost
budget, and verification-fixture sketches) lives at:

  docs/tasks-audit-design.md

Runtime orchestration is deferred. The follow-on tasks needed to
implement it are listed at the bottom of that design doc — they must
be created in wood-fired-tasks project 15 before /tasks:audit can be
invoked operationally.

No subagent dispatched. No bugs-DB writes. No artifacts written.
```

## The 6-step pipeline at a glance

(See [`docs/tasks-audit-design.md`](../../docs/tasks-audit-design.md) §3
for the full detail; this section is a one-line-per-step reminder.)

1. **Resolve LOOP-RUN.md** — from `--loop-run <path>` (literal) OR
   `--project <id>` (most recent `.planning/loops/<UTC>-<id>.md`).
2. **Enumerate closed tasks** — read `## Tasks Closed` from the
   LOOP-RUN.md; for each task fetch `acceptance_criteria`,
   `commit_shas`, `file_changes` from the bugs DB (or reconstruct
   `acceptance_criteria` from the task description when the bugs DB
   column is NULL — Wave 1.3 backfill is not required).
3. **Dispatch `tasks-verifier`** — one read-only subagent per task,
   same envelope as `docs/verifier-contract.md`. The verifier emits
   `VerificationEvidence`.
4. **Score per task** — map verifier verdict to audit score:
   `PASS → COVERED`, `PARTIAL → PARTIAL`, `NOT_VERIFIED → PARTIAL`,
   `FAIL → MISSING`.
5. **Roll up integration verdict** — any `MISSING` ⇒ integration
   `MISSING`. Else any `PARTIAL` ⇒ integration `PARTIAL`. Else
   `COVERED`.
6. **Emit AUDIT.md** —
   `.planning/loops/<UTC>-<project_id>-AUDIT.md` with frontmatter +
   `## Per-Task Audit` + `## Integration Verdict` + `## Cost Breakdown`
   + `## Replay Instructions`.

## Guardrails (do NOT remove)

1. The skill MUST NOT mutate code (no `Edit` / `Write` / `MultiEdit` /
   `NotebookEdit` against the source tree; the only `Write` allowed is
   the AUDIT.md emit under `.planning/loops/`).
2. The skill MUST NOT call wood-fired-tasks `update_task` or
   `add_comment` (read-only against the bugs DB; symmetric to the
   verifier contract).
3. The skill MUST refuse to start if the estimated cost > $5 (hard
   cap; estimated_usd = task_count × $0.30 per-verifier budget).
4. The skill MUST reconstruct `acceptance_criteria` from the task
   description when the bugs DB column is NULL (historical loops
   pre-date Wave 1.3 — a NULL must NOT cause the audit to skip that
   task).

Each guardrail is enforced by a falsifiable test gate in
`src/api/routes/tasks/__tests__/skill-audit-design.test.ts`. Do not
weaken those tests without simultaneously updating
`docs/tasks-audit-design.md` §5.

## Links

- Design spec: [`docs/tasks-audit-design.md`](../../docs/tasks-audit-design.md)
- Schema (zod): [`src/lib/audit/schema.ts`](../../src/lib/audit/schema.ts)
- Schema tests: [`src/lib/audit/__tests__/schema.test.ts`](../../src/lib/audit/__tests__/schema.test.ts)
- Design-doc tests: [`src/api/routes/tasks/__tests__/skill-audit-design.test.ts`](../../src/api/routes/tasks/__tests__/skill-audit-design.test.ts)
- Verifier contract reused verbatim: [`docs/verifier-contract.md`](../../docs/verifier-contract.md)
- Companion skill (producer of LOOP-RUN.md): [`skills/tasks/loop.md`](./loop.md)
