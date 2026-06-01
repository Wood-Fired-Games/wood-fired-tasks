# WSJF Prioritization for wood-fired-tasks — Design

**Date:** 2026-06-01
**Status:** Approved design, pending implementation plan
**Author:** Stuart (with Claude)

## 1. Summary

Add **WSJF (Weighted Shortest Job First)** prioritization to wood-fired-tasks so
that `/tasks:loop` and `/tasks:loop-dag` sequence work by economic value instead
of the flat `priority` enum. Scores are computed **autonomously** when agents
create tasks, grounded in a per-project **value charter** captured through a
skippable setup interview. The system is a *living backlog*: re-running the
interview rescases the project, humans can manually pin component scores, and a
linter warns when the data degenerates into the known WSJF anti-patterns.

WSJF is **additive and backward-compatible**: every column is nullable, the
existing `priority` enum is untouched, and unscored projects behave exactly as
they do today.

## 2. Background & key research findings

Canonical SAFe formula:

```
WSJF = Cost of Delay / Job Size
     = (User-Business Value + Time Criticality + Risk-Reduction/Opportunity-Enablement) / Job Size
```

Each component is scored on the **modified Fibonacci scale {1,2,3,5,8,13}**.
Three findings shape this design:

1. **Relative anchoring is make-or-break.** Components must be scored *across the
   candidate set* (one column at a time, smallest anchored at 1), not per-task in
   isolation. Scoring a task alone produces non-comparable numbers and defeats the
   method. This is why batch scoring (decompose, rescore) is the privileged path.
2. **The DAG breaks per-item WSJF.** A high-WSJF task may be blocked; a boring
   low-value prerequisite may be the real bottleneck. Resolution: **gate on the
   ready frontier + propagate downstream Cost of Delay onto blockers.**
3. **Autonomous scoring needs a reference frame and an audit trail.** Business
   Value cannot be honestly derived from a task's text alone — it is relative to
   what the project is trying to achieve. We supply that frame at the project
   level (the value charter) and require a per-component **evidence string** so
   agent scores are auditable, not vibes.

Full research notes underpin the rubric in §10 and the linter in §9.

## 3. Architecture: the judgment / math split

The load-bearing structural decision:

- **The agent derives the four component scores** (judgment): goal-alignment for
  Business Value, scope for Job Size, date/decay language for Time Criticality,
  severity language for Risk/Opportunity. Done at create time and rescore time,
  **batch column-anchored** wherever a set is available.
- **The server derives everything deterministic** (math): the WSJF score, the
  ready-frontier ranking, blocker propagation, the fan-out signal, deadline-vs-now
  recomputation, the priority fallback, persistence, locks, and the health linter.

This honors the "store components, server derives" decision and keeps the LLM out
of arithmetic and the server out of judgment.

## 4. Data model

### 4.1 `tasks` (migration `013-wsjf-fields.ts`)

All nullable; backward-compatible.

| Column | Type | Constraint / meaning |
|---|---|---|
| `wsjf_value` | INTEGER | User-Business Value ∈ {1,2,3,5,8,13} |
| `wsjf_time_criticality` | INTEGER | ∈ {1,2,3,5,8,13} |
| `wsjf_risk_opportunity` | INTEGER | ∈ {1,2,3,5,8,13} |
| `wsjf_job_size` | INTEGER | ≥ 1 (Fibonacci); denominator |
| `wsjf_evidence` | TEXT (JSON) | one evidence string per component |
| `wsjf_locked` | TEXT (JSON) | per-component lock map, default all-false |
| `wsjf_source` | TEXT (JSON) | per-component provenance: `auto \| manual` |

- A task is **WSJF-scored iff all four component columns are non-null.**
- The WSJF score is **never materialized** — derived on read, single code path.
- Invariant: if any component is set, **all four + evidence are required** (no
  half-scored tasks).

### 4.2 `projects` (migration `014-value-charter.ts`)

| Column | Type | Meaning |
|---|---|---|
| `value_charter` | TEXT (JSON) | nullable; the autonomous reference frame |

Charter shape:

```jsonc
{
  "mission": "prose goal / wedge",
  "value_themes": [
    { "name": "checkout reliability", "weight": 8, "description": "..." }
  ],
  "time_context": "deadlines, launch windows, decay notes",
  "risk_posture": "which risks matter (security/compliance/outage/tech-debt)",
  "interview_version": 1,
  "updated_at": "2026-06-01T00:00:00Z"
}
```

## 5. Types & validation schemas

- `src/types/task.ts`: add the optional WSJF fields; add `WsjfComponents`,
  `WsjfEvidence`, `WsjfLocks`, `WsjfSource` types; add read-only derived
  `wsjf_score?` and `effective_wsjf?` to the read DTO.
- `src/schemas/task.schema.ts`: `WsjfComponentsSchema` (Fibonacci enum — rejects
  4/6/7), `WsjfEvidenceSchema`, `WsjfLocksSchema`. Wire an optional `wsjf` object
  into `CreateTaskClientSchema`, `UpdateTaskClientSchema`, and the service-side
  `CreateTaskSchema` / `UpdateTaskSchema`. Enforce the all-four-or-none invariant.
- `src/types/project.ts` + project schema: `ValueCharterSchema`; wire into the
  project create/update client + service schemas.

## 6. Server: `src/services/wsjf.service.ts` (new)

- `computeWsjf(c) = (UBV + TC + RR) / max(JobSize, 1)` — Job-Size floor prevents
  divide-by-zero and caps small-job bias.
- `priorityFallbackScore(priority)` — deterministic mapping so unscored tasks sort
  coherently in the same numeric space as scored ones:

  | priority | synthetic WSJF |
  |---|---|
  | urgent | 9.0 |
  | high | 6.0 |
  | medium | 3.0 |
  | low | 1.0 |

  Tie-break falls through to `created_at` / `id` as today.

- `rankFrontier(projectId, scope)`:
  1. Load tasks + dependency edges (reuse `dependency.service` / `topology.service`).
  2. `base_CoD = UBV + TC + RR` per scored task.
  3. **Blocker propagation** over the transitive closure:
     `effective_CoD(n) = base_CoD(n) + Σ_{d ∈ distinctTransitiveDependents(n)} base_CoD(d)·γ^(dist−1)`,
     with **γ = 0.5** and capped at `base_CoD(n)·CAP` with **CAP = 3**.
     Diamond-safe (dedupe by transitive-closure set, not path enumeration),
     cycle-guarded (topology already rejects `DAG_CYCLIC`).
  4. `effective_wsjf = effective_CoD / jobSize`; unscored tasks use the fallback.
  5. Return ranked list: `base_wsjf`, `effective_wsjf`, `scored | fallback` flag,
     evidence, and the propagation breakdown.

γ and CAP are module constants, documented as the two tunable judgment calls.

## 7. MCP surface (`src/mcp/tools/`)

- `create_task` / `update_task`: gain the optional `wsjf` object (4 components +
  evidence + locks) — inherited from the client schemas.
- `create_project` / `update_project`: gain the optional `value_charter`.
- **New `wsjf_ranking(project_id, scope: 'frontier' | 'all')`** — the single
  server-owned ordering authority. Loop skills call it instead of doing math,
  avoiding the skills-vs-client-package drift trap.
- **New `rescore_project(project_id)`** — returns the task set needing rescore, the
  charter, and current graph signals (fan-out counts, deadline deltas); accepts
  written-back component scores. Drives the living-backlog rescore (§8.2).
- **New `wsjf_health(project_id)`** — the degeneracy linter (§9).

## 8. Skills (`skills/tasks/`)

### 8.1 Scoring at creation

- **`wsjf-rubric.md` (new)** — the single shared 1-2-3-5-8-13 anchor source (the
  §10 tables) referenced by every scoring skill. **Mirrored into
  `client-package`** per the known dual-source rule.
- **`decompose.md`** — add a scoring sub-step before materialize that scores the
  **whole candidate batch column-anchored** against the project charter, attaching
  components + evidence to each `create_task`. This is the ideal relative-anchoring
  path.
- **`create-task.md`** — single-task scoring: fetch the parent project's charter
  via `get_project`, score Business Value relative to its themes; objective
  components from text/graph. Falls back to the signal rubric (evidence records
  `no charter; scored from signals`) when the charter is empty.

### 8.2 Selection

- **`loop.md`** Step 1: if the project has any WSJF-scored task, order via
  `wsjf_ranking` (scope keyed off the topology gate); else current priority+id
  behavior.
- **`loop-dag.md`** Step 3a (current line 133): replace the frontier sort with
  `wsjf_ranking(scope: 'frontier')`.

### 8.3 Project interview (gstack-inspired)

- **`new-project.md` (new)** — skippable setup interview. Patterns adopted from
  gstack `/office-hours` + `/gstack init`:
  - One question at a time via `AskUserQuestion`, STOP-and-wait.
  - **Smart-skip**: load any existing charter, skip already-answered questions.
  - **Auto-detect-then-confirm**: infer candidate value themes from existing tasks
    / repo, present for confirmation rather than a blank prompt.
  - **Idempotent re-entry**: on an existing charter, offer overwrite /
    partial-update / abort.
  - Trimmed question set: mission/wedge → 2-4 ranked value themes → time pressure
    → risk posture → explicit low-value / out-of-scope.
  - Skipping entirely leaves an empty charter (scorer uses the signal fallback).
  - Writes `value_charter` via `create_project` / `update_project`.
  - Stylistically aligned with the existing GSD `/gsd:new-project` interview.

### 8.4 Living-backlog rescore

- Re-running `new-project.md` updates the charter and bumps `interview_version`,
  then **prompts** `rescore N tasks now?` before running (per decision).
- On confirm: call `rescore_project` to get the candidate set + charter + graph
  signals; **batch column-anchored** rescore Business Value / Job Size / severity;
  write components back via `update_task`. The server re-derives scores + ranking.
- **Locked components are never overwritten** (§8.5). Emits a rescore summary
  (tasks moved, by how much) and then runs `wsjf_health`.

### 8.5 Manual override + propagation

- **Per-component locks** (`wsjf_locked`): a human can pin Business Value while the
  agent keeps estimating Job Size. `wsjf_source` records `auto | manual` per
  component. Rescore skips locked components.
- **Human interface = REST + CLI only** (no web UI today; future UI consumes the
  same contract):
  - REST tasks route + `update_task` read/write components, evidence, and locks.
  - CLI command to set / lock components.
- **Propagation to derived tasks**: when a WSJF-scored task spawns subtasks or
  decompose-children, children inherit the parent's **value-theme mapping + a
  Business-Value prior** (value flows down the tree); per-child objective
  components (Job Size, fan-out) are scored fresh. A manually-set parent value is
  propagated as a **human-anchored** prior (flagged so it is visible).

## 9. Degeneracy / pitfall linter (`wsjf_health`)

Non-blocking, severity-tagged. Surfaced in `project-status`, at the start of loop
runs, and post-rescore. Each finding carries a plain-language explanation + fix
(audience: developers new to WSJF).

| Check | Pitfall | Message intent |
|---|---|---|
| All / near-identical component sets | no relative discrimination | "WSJF can't sequence these — scores don't differ" |
| A CoD column with no `1` anchor | not relatively anchored (SAFe rule) | "no baseline in <column>; re-anchor" |
| Job Size distribution collapsed to 1–2 | small-job bias | "backlog skewed to tiny jobs; large work will starve" |
| Past-deadline but TC still high | stale Time Criticality | "deadline passed; rescore" |
| High fallback ratio (> threshold) | no reference frame | "set a project goal/charter to enable value scoring" |

## 10. Scoring rubric (`wsjf-rubric.md` content)

Standard {1,2,3,5,8,13} anchors per component, applied **relatively across the
candidate set** (absolute anchors below seed and stabilize the ranking). Each
score must emit a one-line evidence string.

- **User-Business Value** — alignment to the charter's value themes; 1 =
  internal/cosmetic, 13 = mission-critical / top strategic bet. With no charter,
  fall back to signals (user-facing vs internal, revenue/retention language,
  surfaces touched) and record the fallback in evidence.
- **Time Criticality** — 1 = flat value over time, 13 = active incident /
  expiring window; driven by date/decay language and the server's deadline-vs-now
  delta.
- **Risk-Reduction / Opportunity-Enablement** — 1 = reduces nothing / 0
  dependents, 13 = severe security/data-loss risk or a blocker gating a large
  high-value subtree; **downstream dependent count comes from the DAG** (objective).
- **Job Size** — 1 = one-line/config change, 13 = new subsystem / migration /
  high-uncertainty spike; from scope language and files/modules touched.

`WSJF = (UBV + TC + RR) / max(JobSize, 1)`, ranked descending over the ready
frontier with the §6 propagation adjustment.

## 11. Testing

- **Unit**: `computeWsjf`; `priorityFallbackScore`; propagation on a known DAG
  (diamond dedupe, γ decay, CAP, cycle-guard); Job-Size floor.
- **Migrations**: `013` and `014` up/down roundtrip.
- **Schema**: Fibonacci enum rejects 4/6/7; all-four-or-none invariant; charter
  schema validation.
- **MCP**: `wsjf_ranking` ordering including a buried blocker surfacing via
  propagation; `rescore_project` respects locks; `wsjf_health` fires each check.
- **Backward-compat**: an unscored project still sorts by priority; mixed
  scored/unscored projects sort coherently via the fallback mapping.
- **Skill-level**: decompose batch scoring produces a `1` anchor per column;
  re-interview → prompt → rescore leaves locked components untouched.

## 12. Phasing (incremental PRs; fits merge-commit + CI-gate flow)

1. **Core engine** — task WSJF columns, `wsjf.service` (compute / fallback /
   propagation), `wsjf_ranking`, loop/loop-dag selection, create/update fields.
2. **Autonomous scoring** — `wsjf-rubric.md`, decompose batch scoring,
   single-create scoring, evidence.
3. **Charter + interview** — `projects.value_charter`, `new-project.md`,
   charter-driven Business Value.
4. **Living backlog** — `rescore_project`, re-interview (prompt-before-rescore),
   manual override + per-component locks + propagation, REST/CLI affordances.
5. **Guidance** — `wsjf_health` linter + surfacing.

Each phase delivers standalone value and can ship as its own PR.

## 13. Out of scope (v1; future)

- Automatic Time-Criticality decay recomputed on a schedule (server can do the
  deadline delta on read; a background cron is deferred).
- Web UI controls (REST + CLI contract defined now; UI consumes it later).
- Critical-path / whole-chain WSJF planning view (recommendation "C" from
  research).
- Large-item carve-out for small-job bias beyond the Job-Size floor + linter
  warning.
- Project-level `value_themes` weighting beyond simple ranked weights.

## 14. Decisions log

| Decision | Choice |
|---|---|
| Storage model | Store components; server derives the score |
| DAG handling | Frontier gate + blocker propagation (γ=0.5, CAP=3) |
| Scoring source | Auto-score on create + priority fallback when absent |
| Evidence | Store scores + per-component evidence strings |
| Business Value frame | Project value charter (goal-derived), signal fallback |
| Interview reference | gstack `/office-hours` + `/gstack init` patterns |
| Human interface | REST API + CLI only |
| Rescore trigger | Prompt before rescoring |
| Lock granularity | Per-component locks with `auto \| manual` provenance |
