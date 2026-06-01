# WSJF Prioritization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution model for this repo:** this plan is the input to `/tasks:decompose`
> (one run per phase → a task DAG) and `/tasks:loop-dag` (wave-parallel workers,
> each doing red→green→commit TDD per task). The plan therefore locks the
> **cross-task contracts** (§Contracts) and gives each task its files, test specs,
> and acceptance criteria; loop-dag workers write the literal implementation under
> TDD. Worked numeric examples follow the canonical constants in §Contracts.

**Goal:** Add deterministic, autonomously-scored WSJF prioritization to
wood-fired-tasks so `/tasks:loop` and `/tasks:loop-dag` sequence work by economic
value, grounded in a per-project value charter, with full auditability and
LLM-reliability guardrails.

**Architecture:** The agent emits only **classifications over closed enums + verbatim
evidence spans**; pure server functions compute the Fibonacci component scores and
the WSJF ratio. Selection gates on the ready frontier and propagates downstream
Cost-of-Delay onto blockers. Every write passes a deterministic validation gate and
appends to append-only audit history. Backward-compatible: all columns nullable, the
existing `priority` enum is the fallback.

**Tech Stack:** TypeScript, SQLite (better-sqlite3 + Umzug migrations), Zod
validation, MCP tool layer, Vitest (Node ≥ 20.12), Markdown skills (mirrored to
`client-package`).

**Source spec:** `docs/superpowers/specs/2026-06-01-wsjf-prioritization-design.md`

---

## Contracts (shared backbone — all tasks depend on these)

These types/signatures/constants are the single source of truth. Every task below
references them by name; keep names identical across tasks.

### Enums & core types (`src/types/wsjf.ts` — new)

```ts
export type Fib = 1 | 2 | 3 | 5 | 8 | 13;
export const FIB: readonly Fib[] = [1, 2, 3, 5, 8, 13];

export type AlignmentClass = 'none' | 'weak' | 'direct' | 'core';
export type SeverityClass  = 'none' | 'tech_debt' | 'security' | 'data_loss' | 'compliance';
export type DecayClass     = 'flat' | 'slow' | 'fast';

// What the LLM emits — never a final number.
export interface WsjfClassification {
  themeName: string | null;            // must exist in charter.value_themes (or null = no charter)
  alignment: AlignmentClass;
  severity: SeverityClass;
  decay: DecayClass | null;            // null when a deadline date is present
  jobSizeTier: Fib;                    // must fall inside jobSizeBand(features)
  evidence: WsjfEvidence;              // verbatim spans, one per component
}

export interface WsjfEvidence {
  value: string; timeCriticality: string; riskOpportunity: string; jobSize: string;
}

// Deterministic inputs the server gathers (no LLM).
export interface WsjfFeatures {
  deadlineDate: string | null;         // ISO; parsed from task text or charter.time_context
  daysUntilDeadline: number | null;
  transitiveDependents: number;        // from the DAG
  filesTouched: number | null;         // when linkable; else null
  charterVersion: number | null;
}

// Stored, server-computed.
export interface WsjfComponents { value: Fib; timeCriticality: Fib; riskOpportunity: Fib; jobSize: Fib; }
export type WsjfComponentKey = keyof WsjfComponents;
export type WsjfSource = Record<WsjfComponentKey, 'auto' | 'manual'>;
export type WsjfLocks  = Record<WsjfComponentKey, boolean>;
```

### Charter (`src/types/project.ts` — extend)

```ts
export interface ValueTheme { name: string; weight: Fib; description: string; }
export interface ValueCharter {
  mission: string;
  value_themes: ValueTheme[];
  time_context: string;
  risk_posture: string;
  out_of_scope: string[];
  interview_version: number;
  updated_at: string;
}
```

### Deterministic functions (`src/services/wsjf.service.ts` — new). Canonical constants:

```ts
export function fibClamp(n: number): Fib;          // round up to nearest FIB tier, max 13

// Time Criticality from parsed deadline (days until). 13 reserved for overdue/expired.
export function tcFromDaysUntil(days: number): Fib;
//  days <= 0 -> 13 | 1..7 -> 8 | 8..90 -> 5 | 91..180 -> 3 | 181..365 -> 2 | >365 -> 1
export function tcFromDecayClass(d: DecayClass): Fib;   // flat->1, slow->3, fast->5 (no hard date => cap 5)

export function rrFromFanout(n: number): Fib;      // 0->1, 1->3, 2..3->5, 4..7->8, >=8->13
export function rrFromSeverity(s: SeverityClass): Fib; // none->1, tech_debt->3, security/data_loss/compliance->8
// RR = max(rrFromFanout, rrFromSeverity)

export function jobSizeBand(f: WsjfFeatures, text: string): [Fib, Fib];
//  filesTouched known: 1 -> [1,2], 2..3 -> [2,5], 4..8 -> [5,8], >8 -> [8,13]
//  else keyword priors: typo/config/copy -> [1,3]; refactor/migrate/rewrite/new subsystem -> [8,13]; default [1,13]

export function ubvFromThemeAlignment(weight: Fib, a: AlignmentClass): Fib;
//  core -> weight | direct -> oneStepDown(weight) | weak -> twoStepsDown(weight) | none -> 1
//  oneStepDown: 13->8,8->5,5->3,3->2,2->1,1->1 ; twoStepsDown applies it twice

export function computeWsjf(c: WsjfComponents): number;  // (value+timeCriticality+riskOpportunity)/max(jobSize,1)

export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export function priorityFallbackScore(p: Priority): number; // urgent 9, high 6, medium 3, low 1

export const PROPAGATION_GAMMA = 0.5;
export const PROPAGATION_CAP = 3;   // effective_CoD <= base_CoD * CAP
```

### Validation gate

```ts
export interface ScoreSubmission { classification: WsjfClassification; features: WsjfFeatures; }
export interface ValidateContext { charter: ValueCharter | null; batch?: WsjfComponents[]; }
export interface ValidateResult { ok: boolean; components?: WsjfComponents; errors: string[]; }

export function validateScoreSubmission(s: ScoreSubmission, ctx: ValidateContext): ValidateResult;
// Checks (deterministic): enum membership; themeName exists in charter (or null only when charter null);
// evidence spans non-empty AND each a verbatim substring of source text/charter; jobSizeTier within band;
// cross-component contradiction rules (e.g. jobSize===1 && value===13 -> error);
// batch invariants when ctx.batch present: every CoD column has a `1` anchor AND variance >= VARIANCE_FLOOR.
// On ok: returns server-computed `components`. On !ok: errors[] for bounded retry.
```

### Ranking result

```ts
export interface RankedTask {
  taskId: number;
  scored: boolean;                 // false => fallback (priority) used
  baseWsjf: number | null;
  effectiveWsjf: number;           // sort key (desc); fallback tasks use priorityFallbackScore
  components: WsjfComponents | null;
  propagation: { dependentId: number; contribution: number }[];
  evidence: WsjfEvidence | null;
}
export function rankFrontier(projectId: number, scope: 'frontier' | 'all'): Promise<RankedTask[]>;
```

### History row (append-only) — see migration 015

`wsjf_score_history`: `{ id, task_id, project_id, changed_at, trigger, actor_type, actor_id,
charter_version, rescore_run_id, value, time_criticality, risk_opportunity, job_size,
classifications(JSON), features(JSON), evidence(JSON), source(JSON), locked(JSON),
wsjf_score, prev_wsjf_score }`.
`trigger ∈ {create, decompose, single_create, rescore, manual, propagation}`.

---

## File structure

| File | Responsibility | Phase |
|---|---|---|
| `src/types/wsjf.ts` | enums, classification/feature/component types | 1 |
| `src/types/task.ts` | add WSJF fields + read-only derived score fields | 1 |
| `src/types/project.ts` | add `ValueCharter` | 3 |
| `src/schemas/wsjf.schema.ts` | Zod: components, classification, evidence, locks, submission | 1 |
| `src/schemas/task.schema.ts` | wire `wsjf` into create/update client + service schemas | 1 |
| `src/schemas/project.schema.ts` | `ValueCharterSchema`; wire into project schemas | 3 |
| `src/db/migrations/013-wsjf-fields.ts` | task WSJF columns | 1 |
| `src/db/migrations/014-value-charter.ts` | `projects.value_charter` | 3 |
| `src/db/migrations/015-wsjf-audit.ts` | 3 append-only audit tables | 1 |
| `src/services/wsjf.service.ts` | deterministic fns, computeWsjf, validate gate, rankFrontier, propagation | 1 |
| `src/services/wsjf-rescore.service.ts` | rescore orchestration + run records | 4 |
| `src/services/wsjf-health.service.ts` | degeneracy linter | 5 |
| `src/repositories/wsjf-history.repository.ts` | append-only writers + history reads | 1 |
| `src/repositories/task.repository.ts` | persist WSJF columns; expose graph data | 1 |
| `src/repositories/project.repository.ts` | persist charter + charter history | 3 |
| `src/mcp/tools/task-tools.ts` | wsjf on create/update; `wsjf_history` | 1 |
| `src/mcp/tools/wsjf-tools.ts` | `wsjf_ranking`, `rescore_project`, `wsjf_health` | 1/4/5 |
| `src/mcp/tools/project-tools.ts` | charter on create/update | 3 |
| `src/api/routes/tasks/*` | REST: components, locks, history | 4 |
| `src/api/routes/projects/*` | REST: charter, charter history, rescore runs | 4 |
| `skills/tasks/wsjf-rubric.md` | classification contract (+ mirror to client-package) | 2 |
| `skills/tasks/loop.md` | selection via `wsjf_ranking` + LOOP-RUN snapshot | 1 |
| `skills/tasks/loop-dag.md` | frontier ordering via `wsjf_ranking` | 1 |
| `skills/tasks/decompose.md` | batch classification scoring at materialize | 2 |
| `skills/tasks/create-task.md` | single-task classification scoring | 2 |
| `skills/tasks/new-project.md` | charter interview (+ rescore prompt) | 3/4 |
| `tests/src/services/wsjf.*.test.ts` etc. | unit + reliability + golden-set + replay | all |

---

## Phase 1 — Core engine (deterministic substrate, gate, selection, audit)

**Goal:** A project can carry WSJF-scored tasks; the server computes/ranks them
deterministically with propagation; every write is validated and audited; loop and
loop-dag order by WSJF when present and fall back to priority otherwise.
**PR boundary / decompose run #1.**

### Task 1.1 — `src/types/wsjf.ts`
- **Files:** Create `src/types/wsjf.ts`; Test `tests/src/types/wsjf.test.ts`.
- **Tests:** `FIB` contains exactly `[1,2,3,5,8,13]`; type-level exports compile (tsc).
- **Acceptance:** all Contracts enums/types exported with exact names.

### Task 1.2 — Deterministic component functions
- **Files:** Create `src/services/wsjf.service.ts` (functions only); Test `tests/src/services/wsjf.functions.test.ts`.
- **Tests (table-driven, exact values):**
  - `fibClamp`: 0→1, 4→5, 6→8, 13→13, 99→13.
  - `tcFromDaysUntil`: -3→13, 0→13, 5→8, 75→5, 120→3, 300→2, 800→1.
  - `tcFromDecayClass`: flat→1, slow→3, fast→5.
  - `rrFromFanout`: 0→1, 1→3, 3→5, 6→8, 9→13. `rrFromSeverity`: none→1, tech_debt→3, security→8, compliance→8.
  - `jobSizeBand`: filesTouched 1→[1,2], 6→[5,8], 20→[8,13]; null + "migrate the schema"→[8,13]; null + "fix typo"→[1,3].
  - `ubvFromThemeAlignment`: (13,'core')→13, (13,'direct')→8, (13,'weak')→5, (13,'none')→1, (5,'core')→5, (3,'direct')→2.
  - `computeWsjf`: {13,5,8,5}→5.2; jobSize 0 treated as 1.
  - `priorityFallbackScore`: urgent→9, low→1.
- **Acceptance:** all pure (no I/O), deterministic, exported per Contracts.

### Task 1.3 — Migration 013 (task WSJF columns)
- **Files:** Create `src/db/migrations/013-wsjf-fields.ts`; Test add to `tests/src/db/migrations-roundtrip.test.ts`.
- **Columns:** `wsjf_value, wsjf_time_criticality, wsjf_risk_opportunity, wsjf_job_size` (INTEGER, nullable, CHECK in Fibonacci set / job_size ≥1), `wsjf_evidence, wsjf_locked, wsjf_source, wsjf_classifications, wsjf_features` (TEXT JSON, nullable). Follow `012`'s up/down + transaction pattern.
- **Tests:** up adds columns; down drops them; roundtrip leaves schema unchanged; CHECK rejects `wsjf_value = 4`.
- **Acceptance:** `npm run migrate` clean on a fresh DB.

### Task 1.4 — Migration 015 (audit tables)
- **Files:** Create `src/db/migrations/015-wsjf-audit.ts`; Test in roundtrip suite.
- **Tables:** `wsjf_score_history`, `project_charter_history`, `wsjf_rescore_run` per spec §4.3 + Contracts. Indexes: `(task_id, changed_at)`, `(rescore_run_id)`, `(project_id, interview_version)`.
- **Tests:** up/down roundtrip; FK columns present; insert a row reads back identically.
- **Acceptance:** append-only intent documented; (014 lands in Phase 3 — 015 must not depend on `projects.value_charter`, only on `projects.id`).

### Task 1.5 — Zod schemas (`wsjf.schema.ts`)
- **Files:** Create `src/schemas/wsjf.schema.ts`; Test `tests/src/schemas/wsjf.schema.test.ts`.
- **Schemas:** `FibSchema` (enum 1/2/3/5/8/13), `WsjfClassificationSchema`, `WsjfEvidenceSchema`, `WsjfComponentsSchema`, `WsjfLocksSchema`, `WsjfSourceSchema`, `ScoreSubmissionSchema`.
- **Tests:** rejects `value: 4/6/7`; rejects empty evidence string; accepts a full valid submission; all-four-or-none enforced at the task layer (Task 1.7).
- **Acceptance:** parse/secure-parse exported.

### Task 1.6 — `validateScoreSubmission`
- **Files:** Modify `src/services/wsjf.service.ts`; Test `tests/src/services/wsjf.validate.test.ts`.
- **Tests:**
  - rejects evidence span not present in source text;
  - rejects `themeName` absent from charter; allows `themeName=null` only when `charter=null`;
  - rejects `jobSizeTier` outside `jobSizeBand`;
  - contradiction rule: `jobSize=1 && value=13` → error;
  - batch invariant: a batch with no `1` in the value column → error; a batch where all components identical → variance-floor error;
  - on success returns server-computed `components` (ignores any client number).
- **Acceptance:** gate is pure given (submission, ctx); returns structured `errors[]`.

### Task 1.7 — Task type/schema wiring + repository persistence
- **Files:** Modify `src/types/task.ts`, `src/schemas/task.schema.ts`, `src/repositories/task.repository.ts`; Test `tests/src/repositories/task.wsjf.test.ts`.
- **Details:** add WSJF fields to `Task`, derived read-only `wsjf_score?`/`effective_wsjf?` to read DTO; wire optional `wsjf` into `CreateTaskClientSchema`/`UpdateTaskClientSchema` + service schemas; enforce all-four-or-none; repository reads/writes the columns + JSON fields.
- **Tests:** create a task with components → persists + reads back; half-scored task rejected; unscored task unaffected.
- **Acceptance:** existing task tests still green.

### Task 1.8 — History repository + in-transaction audit write
- **Files:** Create `src/repositories/wsjf-history.repository.ts`; Modify `task.service.ts` to append a `wsjf_score_history` row in the **same transaction** as any component write; Test `tests/src/services/wsjf.audit.test.ts`.
- **Tests:** create-with-score writes 1 history row (trigger=`create`); update writes another with correct `prev_wsjf_score`; UPDATE/DELETE on history table rejected by repository; row carries classifications+features.
- **Acceptance:** no component write path bypasses history (assert via a write-path test matrix).

### Task 1.9 — `rankFrontier` + propagation
- **Files:** Modify `src/services/wsjf.service.ts` (uses `dependency.service`/`topology.service`); Test `tests/src/services/wsjf.rank.test.ts`.
- **Tests:**
  - linear chain A→B→C: blocker A's `effectiveWsjf` rises by γ-discounted dependents;
  - diamond A→{B,C}→D: D counted once for A (dedupe by closure set);
  - cap: effective ≤ base×3;
  - cycle input rejected (relies on topology `DAG_CYCLIC` guard);
  - mixed scored/unscored: unscored sorted via `priorityFallbackScore`; ties → created_at/id;
  - `scope:'frontier'` excludes blocked tasks.
- **Acceptance:** returns `RankedTask[]` sorted desc by `effectiveWsjf` with `propagation` breakdown.

### Task 1.10 — MCP: `wsjf_ranking` + `wsjf_history`; create/update accept submissions
- **Files:** Create `src/mcp/tools/wsjf-tools.ts` (`wsjf_ranking`); Modify `src/mcp/tools/task-tools.ts` (route `wsjf` through `validateScoreSubmission`; add `wsjf_history`); Test `tests/src/mcp/wsjf-tools.test.ts`.
- **Tests:** `wsjf_ranking(scope)` returns ordered list w/ breakdown; `create_task` with a bad evidence span is rejected with structured error; `wsjf_history(task_id)` returns timeline w/ deltas.
- **Acceptance:** tool schemas validate; manual numbers accepted only on the manual path (set in Phase 4 — for now agent path requires classification).

### Task 1.11 — loop & loop-dag selection + LOOP-RUN snapshot
- **Files:** Modify `skills/tasks/loop.md` (Step 1), `skills/tasks/loop-dag.md` (Step 3a / sort), `skills/tasks/loop-shared.md` (LOOP-RUN snapshot block); mirror any client-package copies.
- **Details:** if project has ≥1 WSJF-scored task → order via `wsjf_ranking` (scope from topology gate); else current priority+id. Persist the ranking snapshot (scores, effective, breakdown, γ/CAP) into `LOOP-RUN.md`.
- **Tests:** skill-level smoke (existing smoke harness): a WSJF-scored fixture project orders by WSJF; an unscored project orders by priority (unchanged).
- **Acceptance:** no skills↔client-package drift (parity check passes).

---

## Phase 2 — Autonomous scoring (rubric, decompose, single-create, reliability)

**Goal:** Agents score tasks at creation via the classification contract; batch
scoring is column-anchored; tiered/selective redundancy + golden-set/replay land.
**PR boundary / decompose run #2.**

### Task 2.1 — `skills/tasks/wsjf-rubric.md` (classification contract)
- **Files:** Create skill + mirror to `client-package`; Test parity check.
- **Content:** the closed enums + enum→tier mapping tables (Contracts), the "emit classifications + verbatim spans, never numbers" rule, and the relative-anchoring instruction. Single source referenced by 2.2/2.3.
- **Acceptance:** identical bytes in both locations (drift guard).

### Task 2.2 — decompose batch scoring
- **Files:** Modify `skills/tasks/decompose.md` (Step 8 materialize); mirror.
- **Details:** before `create_task`, score the **whole candidate batch column-anchored** against the charter; submit classifications+evidence per candidate; rely on the gate's batch invariant (every column has a `1`; variance ≥ floor) to reject degenerate batches and re-prompt.
- **Tests:** decompose fixture produces a `1` anchor in each CoD column; a degenerate batch triggers re-prompt.
- **Acceptance:** materialized tasks carry components+evidence; trigger=`decompose` in history.

### Task 2.3 — single-create scoring
- **Files:** Modify `skills/tasks/create-task.md`; mirror.
- **Details:** fetch parent project charter via `get_project`; classify against themes; objective components from text/graph; on empty charter, fall back to signal classification and record fallback in evidence.
- **Tests:** scored-with-charter vs fallback-without-charter fixtures; trigger=`single_create`.
- **Acceptance:** never blocks; bounded retry → priority fallback on gate exhaustion.

### Task 2.4 — Tiered/selective redundancy
- **Files:** Modify `wsjf.service.ts` (aggregation helpers: median bucket) + scoring skills (orchestration); Test `tests/src/services/wsjf.redundancy.test.ts`.
- **Details:** N-sample (default 3) median per component for **high-stakes** tasks (top-of-frontier or deterministic-undecided); escalate to an independent verifier sub-agent (worker+`tasks-verifier` pattern) only on disagreement/contradiction; persistent disagreement → mark component low-confidence + flag.
- **Tests:** median aggregation is deterministic; disagreement beyond tolerance triggers escalation path (mocked); low-confidence flag recorded.
- **Acceptance:** redundancy scoped (not applied to every task).

### Task 2.5 — Golden-set + replay regression
- **Files:** Create `tests/src/services/wsjf.golden.test.ts`, `tests/src/services/wsjf.replay.test.ts`, fixture corpus `tests/fixtures/wsjf-golden/`.
- **Tests:** golden tasks+charter → expected buckets within tolerance; replay: recompute every fixture's score from stored classifications+features and assert equality with stored number.
- **Acceptance:** CI gate; mapping change reflected by updating golden expectations only.

---

## Phase 3 — Charter + interview

**Goal:** Projects carry a value charter captured via a skippable gstack-style
interview; Business Value derives from it. **PR boundary / decompose run #3.**

### Task 3.1 — Migration 014 + project type/schema
- **Files:** Create `src/db/migrations/014-value-charter.ts`; Modify `src/types/project.ts`, `src/schemas/project.schema.ts`, `src/repositories/project.repository.ts`; Tests.
- **Details:** `projects.value_charter` TEXT JSON nullable; `ValueCharterSchema`; repository read/write.
- **Tests:** roundtrip; charter validation rejects non-Fibonacci theme weight; null charter allowed.

### Task 3.2 — MCP charter on create/update
- **Files:** Modify `src/mcp/tools/project-tools.ts`; Tests.
- **Tests:** `create_project`/`update_project` accept+persist charter; reject malformed.

### Task 3.3 — `skills/tasks/new-project.md` interview
- **Files:** Create skill + mirror; skill-level test/fixture.
- **Details:** one-question-at-a-time via `AskUserQuestion`, STOP-and-wait; auto-detect candidate themes from existing tasks/repo → confirm; ranking→Fibonacci weight mapping; skippable (empty charter); writes charter via `update_project`. Question set per spec §8.3 + the approved sample transcript.
- **Acceptance:** skipping yields no charter (fallback scoring still works).

### Task 3.4 — charter-driven Business Value wiring
- **Files:** Modify `wsjf-rubric.md` + scoring skills to source `themeName` enum from the live charter; Tests.
- **Tests:** UBV uses charter theme weight × alignment; absent charter → signal fallback path.

---

## Phase 4 — Living backlog (rescore, overrides, propagation, REST/CLI)

**Goal:** Re-interview → prompt → deterministic rescore; per-component manual locks
with provenance; inheritance to derived tasks; REST + CLI surface. **PR boundary /
decompose run #4.**

### Task 4.1 — `wsjf-rescore.service.ts` + `rescore_project` + run records
- **Files:** Create service; Create `wsjf_rescore_run` writer; Modify `wsjf-tools.ts`; Tests.
- **Details:** returns task set needing rescore + charter + graph signals; accepts written-back classifications; opens a `wsjf_rescore_run`; one `wsjf_score_history` row per change linked by `rescore_run_id`; **skips locked components**; returns summary.
- **Tests:** locked components untouched; run links all changes; deterministic given same charter+tasks.

### Task 4.2 — re-interview + prompt-before-rescore
- **Files:** Modify `skills/tasks/new-project.md` (smart-skip on existing charter; overwrite/partial/abort; bump `interview_version`; snapshot to `project_charter_history`; prompt "rescore N tasks now?"); mirror.
- **Tests:** re-run skips unchanged answers; charter snapshot appended; rescore only on confirm.

### Task 4.3 — manual override + per-component locks + provenance
- **Files:** Modify task type/schema/repo + `update_task`; Tests.
- **Details:** manual path sets values directly with `source=manual`, exempt from classification requirement but **not** from enum/contradiction checks; `wsjf_locked` per component; history trigger=`manual`.
- **Tests:** manual set + lock persists; subsequent rescore respects lock; contradiction still rejected.

### Task 4.4 — propagation to derived tasks
- **Files:** Modify subtask/decompose creation paths; Tests.
- **Details:** derived task inherits parent's value-theme mapping + Business-Value prior; objective components scored fresh; manual parent value propagated as human-anchored prior (flagged).
- **Tests:** child of a scored parent inherits theme + UBV prior; flag set when parent was manual.

### Task 4.5 — REST + CLI surface
- **Files:** Modify `src/api/routes/tasks/*`, `src/api/routes/projects/*`; add CLI command(s); Tests.
- **Details:** REST read/write components, evidence, locks; GET task score history; GET project charter history + rescore runs. CLI: `wft task wsjf-history <id>`, set/lock components, `wft project charter-history <id>`.
- **Tests:** route validation mirrors MCP gate; history endpoints return ordered rows.

---

## Phase 5 — Guidance (degeneracy linter)

**Goal:** Surface WSJF anti-patterns with plain-language fixes. **PR boundary /
decompose run #5.**

### Task 5.1 — `wsjf-health.service.ts` + `wsjf_health` tool
- **Files:** Create service; Modify `wsjf-tools.ts`; Tests `tests/src/services/wsjf.health.test.ts`.
- **Checks (spec §9 + score-churn):** near-identical scores; CoD column missing a `1`; Job Size collapsed to 1–2; past-deadline with high TC; high fallback ratio; score-churn across rescores (uses history). Each returns severity + message + fix.
- **Tests:** each check fires on a crafted fixture and stays silent on a healthy one.

### Task 5.2 — surfacing
- **Files:** Modify `skills/tasks/loop.md`, `loop-dag.md`, `project-status` skill + `wsjf-rescore` post-step to call `wsjf_health` and print findings; mirror.
- **Tests:** smoke: a degenerate fixture surfaces warnings at loop start + post-rescore; healthy fixture silent.

---

## Cross-phase dependencies (for the DAG)

- Phase 2 depends on Phase 1 (gate, history, types). Phase 3 charter unblocks
  Phase 2's charter-driven UBV (2.3/2.4 can ship signal-only first, enriched in 3.4).
- Phase 4 depends on 1 (history/locks columns), 3 (charter), 2 (scoring).
- Phase 5 depends on 1 (history) + 2 (scored data) + 4 (rescore-churn).
- Within a phase, tasks numbered to read top-to-bottom but most are independent
  (e.g. 1.2 functions, 1.3/1.4 migrations, 1.5 schemas run in parallel; 1.6/1.9
  depend on 1.2; 1.7 depends on 1.5; 1.8 depends on 1.7; 1.10 depends on 1.6/1.9;
  1.11 depends on 1.10). decompose's `topology_check` will formalize edges.

---

## Self-review — spec coverage

| Spec section | Covered by |
|---|---|
| §4.1 task columns | 1.3, 1.7 |
| §4.2 charter | 3.1 |
| §4.3 audit tables | 1.4, 1.8, 4.1, 4.2 |
| §5 types/schemas | 1.1, 1.5, 1.7, 3.1 |
| §6 deterministic fns + gate + rank | 1.2, 1.6, 1.9 |
| §7 MCP surface | 1.10, 3.2, 4.1, 5.1 |
| §8.1 scoring skills + rubric | 2.1, 2.2, 2.3, 3.4 |
| §8.2 selection | 1.11 |
| §8.3 interview | 3.3 |
| §8.4 rescore | 4.1, 4.2 |
| §8.5 overrides + propagation | 4.3, 4.4 |
| §9 linter | 5.1, 5.2 |
| §10 rubric/classification | 2.1 |
| §11 auditability | 1.8, 1.10, 4.1, 4.5 |
| §12 determinism/reliability | 1.2, 1.6, 2.4, 2.5 |
| §13 testing | every task's Test entry + 2.5 |
| §14 phasing | the five phases |

No gaps. Constants in §Contracts are referenced consistently (γ=0.5, CAP=3,
fallback 9/6/3/1, TC/RR/UBV maps) across tasks 1.2/1.6/1.9 and the worked examples.
