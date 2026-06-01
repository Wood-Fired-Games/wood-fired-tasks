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

### 4.3 Audit tables (migration `015-wsjf-audit.ts`)

All three are **append-only** (no UPDATE/DELETE in normal flow; enforced at the
repository layer; dropped by the down-migration). They make every value and every
mid-project change traceable — see §11.

**`wsjf_score_history`** — one immutable row per score write to a task:

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PK | |
| `task_id` / `project_id` | INTEGER FK | |
| `changed_at` | TEXT | timestamp |
| `trigger` | TEXT | `create \| decompose \| single_create \| rescore \| manual \| propagation` |
| `actor_type` / `actor_id` | TEXT | `agent \| user`, session/user id |
| `charter_version` | INTEGER | nullable; which charter informed this score |
| `rescore_run_id` | INTEGER FK | nullable; batch this change belonged to |
| `value` / `time_criticality` / `risk_opportunity` / `job_size` | INTEGER | component snapshot (server-computed) |
| `classifications` | TEXT (JSON) | the LLM's enum classifications that produced the numbers (theme, alignment, severity, decay, job-size tier) |
| `features` | TEXT (JSON) | deterministic inputs used (parsed deadline, fan-out count, files/LOC, charter version) |
| `evidence` / `source` / `locked` | TEXT (JSON) | snapshots at write time |
| `wsjf_score` | REAL | derived snapshot |
| `prev_wsjf_score` | REAL | nullable; for fast delta queries |

Storing `classifications` + `features` (not just the numbers) is what makes the
score `f(stored inputs)` and enables **replay verification** without the LLM
(§12.5).

**`project_charter_history`** — full charter snapshot per version:

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PK | |
| `project_id` | INTEGER FK | |
| `interview_version` | INTEGER | |
| `charter` | TEXT (JSON) | full snapshot |
| `change_kind` | TEXT | `overwrite \| partial_update` |
| `actor_type` / `actor_id` | TEXT | |
| `changed_at` | TEXT | |

**`wsjf_rescore_run`** — one row per rescore event:

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PK | |
| `project_id` | INTEGER FK | |
| `triggered_at` | TEXT | |
| `charter_version` | INTEGER | the new charter driving the rescore |
| `actor_type` / `actor_id` | TEXT | |
| `tasks_evaluated` / `tasks_changed` / `tasks_skipped_locked` | INTEGER | |
| `summary` | TEXT (JSON) | aggregate movement stats |

`wsjf_score_history.rescore_run_id` links every score change to the run that
produced it.

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

All of the following are **pure, deterministic functions** — no LLM. The LLM's
only contribution is bounded enum classifications fed into them (§12).

- **Deterministic component functions** (turn classifications + features into
  Fibonacci tiers):
  - `tcFromDaysUntil(days)` — deadline parsed from text/charter → Time Criticality.
  - `tcFromDecayClass(class)` — fallback when no date: `{flat,slow,fast}` → tier.
  - `rrFromFanout(transitiveDependents)` — from the DAG.
  - `rrFromSeverity(class)` — `{none,tech_debt,security,data_loss,compliance}` → tier;
    `RR = max(rrFromFanout, rrFromSeverity)`.
  - `jobSizeBand(features)` → allowed tier band; the LLM picks within it.
  - `ubvFromThemeAlignment(themeWeight, alignmentClass)` — `weight × alignment`
    lookup → tier.
- `computeWsjf(c) = (UBV + TC + RR) / max(JobSize, 1)` — Job-Size floor prevents
  divide-by-zero and caps small-job bias.
- `validateScoreSubmission(submission, context)` — the deterministic gate (§12.3);
  every write path runs it before persistence.
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

- `create_task` / `update_task`: gain the optional `wsjf` object. Agents submit
  **classifications + evidence spans** (not numbers); the tool runs
  `validateScoreSubmission` and the server computes the stored components. A
  numbers-only submission is accepted **only** on the human/CLI manual-override
  path (which sets `source=manual` and is exempt from the classification
  requirement but not from the enum/contradiction checks).
- `create_project` / `update_project`: gain the optional `value_charter`.
- **New `wsjf_ranking(project_id, scope: 'frontier' | 'all')`** — the single
  server-owned ordering authority. Loop skills call it instead of doing math,
  avoiding the skills-vs-client-package drift trap.
- **New `rescore_project(project_id)`** — returns the task set needing rescore, the
  charter, and current graph signals (fan-out counts, deadline deltas); accepts
  written-back component scores. Opens a `wsjf_rescore_run`, writes a
  `wsjf_score_history` row per change, and returns the run id + summary. Drives the
  living-backlog rescore (§8.2).
- **New `wsjf_history(task_id)`** — the score timeline for a task: every change
  with from→to delta, trigger, actor, charter version, and evidence (§11).
- **New `wsjf_health(project_id)`** — the degeneracy linter (§9).

Every component write (via `create_task` / `update_task` / `rescore_project` /
propagation) **appends a `wsjf_score_history` row** in the same transaction; every
charter write appends a `project_charter_history` row. History writes are not
optional — they are part of the write path, not a side channel.

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

The rubric is a **classification contract**, not a "pick a number" guide (§12): it
defines the closed enums the LLM chooses from and the deterministic map to
{1,2,3,5,8,13}. The agent classifies **relatively across the candidate set**
(batch); the server applies the map. Each classification emits a one-line verbatim
evidence span. The descriptions below double as the human-readable anchors and the
enum-to-tier mapping table.

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

## 11. Auditability

Every score, and every mid-project change to it, must be traceable to *who/what
set it, when, under which charter, and on what evidence*. Two layers:

### 11.1 Point-in-time justification (per current value)

The live task carries `wsjf_evidence` (one string per component), `wsjf_source`
(`auto | manual` per component), and `wsjf_locked`. This answers "why is this
value what it is *right now*."

### 11.2 Temporal trail (per change over time)

The append-only audit tables (§4.3) answer the questions point-in-time data
cannot:

- **"Why did task X's value drop from 8 to 3?"** → `wsjf_score_history` rows for
  X, each with from→to (`prev_wsjf_score` → `wsjf_score`), `trigger`, `actor`,
  `charter_version`, and the evidence captured at that moment.
- **"What did re-interview v2 do to the backlog?"** → the `wsjf_rescore_run` row
  (tasks evaluated / changed / skipped-locked + summary) plus every
  `wsjf_score_history` row sharing its `rescore_run_id`.
- **"What changed in the charter between rescases?"** → diff `project_charter_history`
  snapshots for `interview_version` N-1 vs N.
- **"Which values did a human set, and when?"** → history rows where
  `trigger = manual` / `source = manual`.

History writes happen **in the same transaction** as the score/charter write
(§7), so the trail can never silently diverge from reality.

### 11.3 Auditing the tuning constants and the ranking math

The constants (`γ = 0.5`, `CAP = 3`, the priority→WSJF fallback map) are
config-as-code: documented module constants, versioned in git. Their *application*
is auditable two ways:

- `wsjf_ranking` returns the **propagation breakdown** per task (base CoD, the
  per-dependent contributions, the capped effective CoD), so a ranking is
  explainable, not a black box.
- `/tasks:loop` and `/tasks:loop-dag` **snapshot the `wsjf_ranking` result they
  acted on** (scores, effective scores, breakdown, constant values) into the
  existing `LOOP-RUN.md` artifact — so "what order did this run pick, and why" is
  reproducible after the fact even as scores later change.

### 11.4 Surfacing

`wsjf_history(task_id)` (MCP) + REST endpoints (task score history; project
charter history; rescore runs) + CLI (`wft task wsjf-history <id>`,
`wft project charter-history <id>`). The §9 linter gains a **score-churn check**
(a task whose value flaps across consecutive rescases = the unstable-estimate
pitfall) — detectable only because history exists.

## 12. Determinism & LLM reliability

Design goal: **maximize deterministic computation; minimize and fence the LLM's
degrees of freedom.** The unifying principle — **the LLM never emits a WSJF
number.** It emits *classifications over closed enumerations with cited evidence
spans*; a pure function turns those into the Fibonacci score. The stored number is
therefore always `f(stored classifications + features)` — recomputable and
verifiable without the model.

### 12.1 Deterministic-first decomposition

Each component splits into a deterministic substrate (server) + a bounded residual
classification (LLM). The substrate dominates:

| Component | Deterministic substrate (pure functions in `wsjf.service`) | Residual LLM (enum classification only) |
|---|---|---|
| Time Criticality | parse deadline (date parser) → `tcFromDaysUntil(d)`; server owns deadline-vs-now | only if no date: `decay ∈ {flat, slow, fast}` → bucket |
| Risk/Opportunity | `rrFromFanout(transitiveDependents)` from the DAG | `severity ∈ {none, tech_debt, security, data_loss, compliance}`; final `= max(fanout, severity)` |
| Job Size | linked files/LOC (when available) + keyword scope priors → a *band* | pick a tier *within the band* only |
| User-Business Value | `weight × alignment` lookup table | map task → charter theme (closed set) + `alignment ∈ {none, weak, direct, core}` |

TC and RR are frequently **fully deterministic** (a date or a fan-out count
decides them); the LLM collapses to bounded classification, and UBV becomes
"choose a theme + alignment level," never "invent a number."

### 12.2 Output constraint & deterministic validation

- **Schema-constrained generation**: scoring returns strict zod with **enum-only**
  fields (theme names sourced live from the charter; fixed alignment/severity/decay
  levels). Temperature 0. Out-of-enum → hard reject.
- **Verbatim evidence spans**: each classification cites a substring of the task
  text / charter; the server checks the span **literally occurs in the source**.
  Fabricated span → reject.
- **Recompute, don't trust**: the agent submits *classifications + features*; the
  server computes the number. A hallucinated number cannot enter — the agent never
  submits one.

### 12.3 `validateScoreSubmission` — the deterministic chokepoint

One gate **below** every write path (MCP + REST), unbypassable. A submission must
pass all of:

1. Fibonacci enum + all-four-or-none invariant.
2. Evidence-span existence; theme references exist in the charter.
3. **Cross-component contradiction rules** (e.g. JobSize=1 ∧ UBV=13 → reject/flag).
4. **Batch invariants that machine-enforce relative anchoring**: every CoD column
   has a `1` anchor and variance ≥ floor. A degenerate batch is **rejected and
   re-prompted**, not stored — turning the make-or-break anchoring rule from a hope
   into a gate.

Failure → structured error → **bounded** agent retry (cap N; on exhaustion, mark
the task `scoring_failed` and fall back to the priority enum — never block).

### 12.4 Tiered, selective redundancy

For the residual classifications only, and **only where it changes outcomes**
(tasks near the top of the ready frontier, or where the deterministic layer could
not decide):

1. **Tier 1 — N-sample self-consistency**: classify N times (default 3), take the
   **median/mode bucket** per component (deterministic aggregation).
2. **Tier 2 — independent verifier sub-agent** (reusing the worker+`tasks-verifier`
   pattern): triggered only when Tier-1 samples disagree beyond tolerance or a
   contradiction rule fires. A fresh-context agent re-classifies blind; must agree
   within tolerance, else the component is marked **low-confidence** and flagged for
   human review.

Everything else gets a single deterministic-first pass. This bounds token cost to
where ranking precision actually matters.

### 12.5 Replay & calibration (deterministic regression)

- **Replay**: because history stores classifications + features (§4.3), a job
  recomputes every stored score from its inputs and asserts equality — detects
  drift, and lets the mapping change be applied by **deterministic rescore, no
  LLM**.
- **Golden-set CI gate**: a fixed corpus of tasks (with charter) and expected
  buckets; CI asserts the scorer stays within tolerance — catches model drift
  before release.
- **Telemetry**: retry rate, Tier-1 inter-sample agreement, contradiction-flag
  rate, low-confidence rate → analytics dashboard (consistent with existing tooling).

## 13. Testing

- **Unit**: `computeWsjf`; the deterministic component functions (`tcFromDaysUntil`,
  `rrFromFanout`, Job-Size band, UBV `weight×alignment`); `priorityFallbackScore`;
  propagation on a known DAG (diamond dedupe, γ decay, CAP, cycle-guard);
  Job-Size floor.
- **Reliability**: `validateScoreSubmission` rejects out-of-enum numbers,
  fabricated evidence spans, unknown themes, contradiction rules, and degenerate
  batches (no `1` anchor / sub-floor variance); bounded-retry exhaustion falls back
  to priority; recompute-from-classifications equals the stored score (replay);
  golden-set within tolerance; Tier-2 verifier triggers only on disagreement.
- **Migrations**: `013`, `014`, `015` up/down roundtrip.
- **Schema**: Fibonacci enum rejects 4/6/7; all-four-or-none invariant; charter
  schema validation.
- **MCP**: `wsjf_ranking` ordering including a buried blocker surfacing via
  propagation; `rescore_project` respects locks; `wsjf_health` fires each check.
- **Audit**: every write path (create / update / rescore / propagation) appends a
  `wsjf_score_history` row in-transaction; history tables reject UPDATE/DELETE;
  `wsjf_history` returns correct from→to deltas; a rescore links all its changes by
  `rescore_run_id`; charter edits append a snapshot; score-churn check fires.
- **Backward-compat**: an unscored project still sorts by priority; mixed
  scored/unscored projects sort coherently via the fallback mapping.
- **Skill-level**: decompose batch scoring produces a `1` anchor per column;
  re-interview → prompt → rescore leaves locked components untouched.

## 14. Phasing (incremental PRs; fits merge-commit + CI-gate flow)

1. **Core engine** — task WSJF columns (+ classification/feature columns),
   **`wsjf_score_history` + in-transaction audit writes**, `wsjf.service`
   (deterministic component functions, compute, fallback, propagation),
   **`validateScoreSubmission` gate**, `wsjf_ranking` (with breakdown),
   loop/loop-dag selection + LOOP-RUN snapshot, create/update fields,
   `wsjf_history` tool. Deterministic core + gate land first so all later LLM
   scoring writes through a validated chokepoint.
2. **Autonomous scoring** — `wsjf-rubric.md` as a **classification** contract,
   decompose batch scoring (classifications → server-computed numbers),
   single-create scoring, evidence spans, tiered/selective redundancy (§12.4),
   golden-set CI gate + replay test.
3. **Charter + interview** — `projects.value_charter` + `project_charter_history`,
   `new-project.md`, charter-driven Business Value.
4. **Living backlog** — `rescore_project` + `wsjf_rescore_run`, re-interview
   (prompt-before-rescore), manual override + per-component locks + propagation,
   REST/CLI affordances (incl. history endpoints).
5. **Guidance** — `wsjf_health` linter (incl. score-churn) + surfacing.

Audit is built into Phase 1's write path, not retrofitted; later phases add their
own trigger types and the charter/rescore-run records as they introduce those
write paths.

Each phase delivers standalone value and can ship as its own PR.

## 15. Out of scope (v1; future)

- Automatic Time-Criticality decay recomputed on a schedule (server can do the
  deadline delta on read; a background cron is deferred).
- Web UI controls (REST + CLI contract defined now; UI consumes it later).
- Critical-path / whole-chain WSJF planning view (recommendation "C" from
  research).
- Large-item carve-out for small-job bias beyond the Job-Size floor + linter
  warning.
- Project-level `value_themes` weighting beyond simple ranked weights.

## 16. Decisions log

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
| Auditability | Append-only history (scores + charter + rescore runs), in-transaction; ranking breakdown + LOOP-RUN snapshot for the math |
| LLM output form | LLM emits **classifications over closed enums + evidence spans**, never a number; server computes the Fibonacci score deterministically |
| Validation | `validateScoreSubmission` deterministic gate below all write paths; bounded retry → priority fallback |
| Redundancy | Tiered (N-sample median → escalate to independent verifier sub-agent), **selective** (high-stakes / undecided only) |
| Reliability regression | Replay (recompute from stored classifications) + golden-set CI gate |
