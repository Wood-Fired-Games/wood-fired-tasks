---
name: decompose
description: DESIGN-ONLY STUB. Wave 5 design landed (see docs/tasks-decompose-design.md); runtime not implemented. When run, would auto-break a project-level goal into independent leaf tasks (or a dependency DAG) ready for /tasks:loop or /tasks:loop-dag. Pipeline: goal capture → codebase recon → candidate generation → independence check → topology decision → coverage check → sizing → materialize → DECOMPOSITION.md emit. Bounded ≤ $5 target / $15 hard cap. Skill is gated (`disable-model-invocation: true`) until the runtime ships — explicit user invocation surfaces the design pointer instead of pretending to execute.
argument-hint: --project <id> --goal "..." [--success "..."] [--domain frontend|backend|docs|infra|mixed]
disable-model-invocation: true
---

# /tasks:decompose

> **Status (2026-05-23):** Design spec landed via wood-fired-tasks task
> **#320**. Runtime orchestration is **not implemented yet** — see the
> follow-on tasks listed at the bottom of
> [`docs/tasks-decompose-design.md`](../../docs/tasks-decompose-design.md).
> This skill file is a **discovery stub**: invocation should read the
> design spec and report back rather than executing the pipeline.

See [`docs/tasks-decompose-design.md`](../../docs/tasks-decompose-design.md)
for the full design — contract, methodology, guardrails, artifact schema,
verification fixtures, and cost budget. That document is the source of
truth; this skill file intentionally restates only the navigation.

## Preflight: MCP tools

This skill calls tools on the `wood-fired-tasks` MCP server. The doc uses shorthand `wood-fired-tasks:<tool>`; harness tool names are `mcp__wood-fired-tasks__<tool>`. On `InputValidationError`, load via `ToolSearch` (`select:mcp__wood-fired-tasks__create_task,mcp__wood-fired-tasks__add_dependency,mcp__wood-fired-tasks__topology_check`) and retry. (Runtime is a design-only stub today — tool calls listed here are what the implemented pipeline would call; the stub does not actually call them.)

## On invocation

While the design is the only artifact that has landed, the skill MUST:

1. **Tell the user the skill is design-only** and point at
   `docs/tasks-decompose-design.md`. Do NOT pretend to start the pipeline.
2. **Refuse to dispatch any subagent**, refuse to call `create_task`,
   refuse to call `add_dependency`, and refuse to write under
   `.planning/decompositions/`. The runtime is deferred — these tool
   calls would silently violate the contract.
3. **Remind the user** that follow-on wood-fired-tasks tasks must be
   created to implement the pipeline (Explore-agent wiring, planner +
   critic subagent definitions, cost tracker, fixtures) before this
   skill becomes operational.

A representative response shape:

```
/tasks:decompose is design-only as of #320 (Wave 5).

The design (contract, methodology, guardrails, artifact schema, cost
budget, and verification-fixture sketches) lives at:

  docs/tasks-decompose-design.md

Runtime orchestration is deferred. The follow-on tasks needed to
implement it are listed at the bottom of that design doc — they must
be created in wood-fired-tasks project 15 before /tasks:decompose
can be invoked operationally.

No subagent dispatched. No tasks materialized. No artifacts written.
```

## The 9-step pipeline at a glance

(See [`docs/tasks-decompose-design.md`](../../docs/tasks-decompose-design.md) §4 for the
full detail; this section is a one-line-per-step reminder.)

1. **Goal capture** — `--goal` (≤ 200 words), `--success` (3–5), `--domain`, blast-radius keyword check.
2. **Codebase recon** — single Explore-agent subagent, ≤ 50 tool calls / ≤ 8 min, output cached.
3. **Candidate generation** — planner subagent emits 8–25 drafts (title + description + acceptance_criteria + suspected_edges + estimated_minutes).
4. **Independence check** — critic subagent does pairwise comparison; halt if ≥ 30% interdependent.
5. **Topology decision** — apply `topology_check` (Wave 4.1 / #318); FLAT → `/tasks:loop`, DAG → `/tasks:loop-dag` (Wave 4.3 / #341) + suggested wave grouping, DAG_CYCLIC → HALT.
6. **Coverage check** — second critic; gaps → add candidates, duplicates → merge (≤ 2 Step 4 re-runs).
7. **Sizing check** — each candidate ≤ 90 minutes; split oversize.
8. **Materialize** — `create_task` + `add_dependency`, idempotent on `decomposition_id`.
9. **Emit `DECOMPOSITION.md`** — `.planning/decompositions/<UTC>-<project_id>.md` (gitignored, same rationale as `LOOP-RUN.md`).

## Guardrails (do NOT remove)

1. The skill MUST NOT execute the decomposed tasks (plan/execute separation).
2. The skill MUST NOT modify itself.
3. The skill MUST halt + ask if Step 4 rejects ≥ 30% of candidate pairs.
4. The skill MUST refuse goals containing `deploy`, `migrate production`, or `delete data`.

Each guardrail is enforced by a falsifiable test gate in
`src/api/routes/tasks/__tests__/skill-decompose-design.test.ts`. Do not
weaken those tests without simultaneously updating
`docs/tasks-decompose-design.md` §5.

## Links

- Design spec: [`docs/tasks-decompose-design.md`](../../docs/tasks-decompose-design.md)
- Schema (zod): [`src/lib/decompose/schema.ts`](../../src/lib/decompose/schema.ts)
- Schema tests: [`src/lib/decompose/__tests__/schema.test.ts`](../../src/lib/decompose/__tests__/schema.test.ts)
- Design-doc tests: [`src/api/routes/tasks/__tests__/skill-decompose-design.test.ts`](../../src/api/routes/tasks/__tests__/skill-decompose-design.test.ts)
- Companion skill (consumer): [`skills/tasks/loop.md`](./loop.md) — drains `FLAT` advisories.
- Companion orchestrator (consumer): [`skills/tasks/loop-dag.md`](./loop-dag.md) — drains `DAG` advisories wave-by-wave (Wave 4.3 / #341).
