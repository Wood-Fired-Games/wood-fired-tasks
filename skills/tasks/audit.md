---
name: audit
description: Operational retroactive grader for a /tasks:loop run. Resolves a LOOP-RUN.md (via --loop-run <path> or --project <id>), enumerates the closed tasks, dispatches one read-only tasks-verifier subagent per task (reconstructing acceptance_criteria from the task description when the tasks database column is NULL), scores each task COVERED/PARTIAL/MISSING, rolls up an integration verdict, and emits a gitignored AUDIT.md. Read-only against both the source tree and the tasks database; bounded by a 5 USD hard cost cap.
argument-hint: --loop-run <path> | --project <id>
disable-model-invocation: false
---

# /tasks:audit

You are the **orchestrator** of a retroactive grade. Your job is *not* to
fix anything — you re-run the same `tasks-verifier` contract `/tasks:loop`
uses, against every task a completed loop closed, and emit an AUDIT.md
scoring the run. You **never** mutate code, never re-open / comment on /
transition tasks, and never write anywhere except the single AUDIT.md
under `.planning/loops/`.

The full design — contract, methodology, guardrails, artifact schema,
verification fixtures, and cost budget — is the source of truth at
[`docs/tasks-audit-design.md`](../../docs/tasks-audit-design.md). This
skill is the executable implementation of that design; where they could
drift, the design doc wins. Section references below (§N) point into it.

> **Mental model.** You are the auditor, not the builder. Each task: hand
> a fresh read-only `tasks-verifier` a self-contained envelope (acceptance
> criteria + commits + file changes), collect its verdict, and roll the
> verdicts up. Your context only holds per-task summaries (verdict + check
> count + first failing line) — never the verifier transcripts.

## Preflight: MCP tools

This skill calls tools on the `wood-fired-tasks` MCP server. Shorthand
`wood-fired-tasks:<tool>` ↔ harness name `mcp__wood-fired-tasks__<tool>`.
On `InputValidationError`, load via `ToolSearch`
(`select:mcp__wood-fired-tasks__get_task,mcp__wood-fired-tasks__get_comments,mcp__wood-fired-tasks__get_dependencies,mcp__wood-fired-tasks__list_tasks,mcp__wood-fired-tasks__list_projects,mcp__wood-fired-tasks__resolve_model,mcp__wood-fired-tasks__list_models`)
and retry. (`resolve_model` / `list_models` resolve the `planning`-role
verifier-dispatch model below — both are read-only.)

**Execution ledger:** before the first MCP call, mirror this skill's step list into the harness todo list per [loop-shared.md §S](loop-shared.md#s-execution-ledger-mandatory-step-tracking).

**Allowed MCP tool surface is the READ-ONLY set ONLY:**

- `get_task` — read a closed task's `acceptance_criteria`, `description`, title.
- `get_comments` — read the worker's closing comment (commit SHAs, files).
- `get_dependencies` — read-only dependency lookup.
- `list_tasks` — read-only list query (resolve a `--project` run).
- `list_projects` — read-only project list.
- `resolve_model` / `list_models` — resolve the `planning`-role dispatch model (read-only; see below).

### Planning-role model resolution (resolve ONCE, before dispatch)

The verifier subagents this skill dispatches in Step 3 are **planning-phase**
graders — audit is the retroactive half of the planning pipeline — so they run
the `planning` pipeline role. Resolve the dispatch `model:` ONCE, before the
Step-3 loop, per the canonical contract in
[loop-shared.md §R](loop-shared.md#r-model-resolution):

> Call `resolve_model { project_id, role: 'planning' }`. **`task_id` is
> OMITTED** so the `planning` slot's `constant` / `default` governs (audit
> grades many tasks with one resolved model rather than size-routing per
> task). Use the `project_id` resolved from the LOOP-RUN.md in Step 1 (always
> known here); on `null` pass **no** `model:` and inherit the orchestrator's
> session model (the backward-compatible default). If a run supplied
> `--planning-model <ref>`, skip `resolve_model` and pass that ref directly.

Read the resolver's returned value VERBATIM (per §R's anti-fabrication note /
§L) and reuse the SAME resolved `model:` for every verifier dispatch. The
dispatch-time fallback (retry once with no `model:` on an unrecognized-model
error) applies per §R.

**The mutating tools are NOT permitted (Guardrail 2):** `update_task`,
`add_comment`, `claim_task`, `create_task`, `create_project`,
`update_project`, `delete_project`, `delete_task`, `delete_comment`,
`add_dependency`, `remove_dependency`, and `completion_report` writes.
An audit that comments on or transitions the tasks it grades would
corrupt every future audit of the same run. If any step seems to need
one of these, you have misread the design — stop and re-read §5
Guardrail 2.

---

## Step 1 — Resolve LOOP-RUN.md

Parse `$ARGUMENTS`. **Exactly one** of the following is required (design
§3 Step 1):

- `--loop-run <path>` — literal path to a LOOP-RUN.md. Resolve relative
  to repo root if not absolute. Refuse if the file does not exist or its
  frontmatter does not parse against `LoopRunFrontmatterSchema`
  (`src/lib/loop-run/schema.ts`).
- `--project <id>` — glob `.planning/loops/<UTC>-<id>.md`, sort by the
  UTC timestamp prefix **descending**, pick the first. Refuse if no
  match.

**Refuse if BOTH or NEITHER are supplied.** Emit a one-line usage error
and stop — do not guess:

```
/tasks:audit requires exactly one of --loop-run <path> | --project <id> (got both / neither).
```

Read and parse the resolved LOOP-RUN.md frontmatter. Capture `run_id`
and `project_id` — these two are **reused** in the AUDIT.md frontmatter
so the two artifacts correlate. The audit's own timestamps are fresh,
NOT reused: record `audit_started_at = <now UTC, RFC 3339>` (and
`audit_ended_at` at emit time) and mint a fresh `audit_id` (UUIDv4).

## Step 2 — Enumerate closed tasks

Read the `## Tasks Closed` section body of the LOOP-RUN.md. Set
`total_tasks` = the count of task rows there. For **each** task, fetch
read-only from the tasks database:

- `acceptance_criteria` — the verbatim column value via `get_task`. **If
  NULL, reconstruct from the task `description`** (Guardrail 4): extract
  bullet lines (`- ` or `* `) that fall under a heading matching
  `/accept|verif|criteria/i`. This branch is what makes historical
  grading of Project 11 / Project 12 (which pre-date the Wave 1.3
  `acceptance_criteria` column) possible.
- `commit_shas` — the SHAs the worker recorded on close (from the
  LOOP-RUN.md `## Tasks Closed` `commit_shas` column, cross-checked
  against the closing comment via `get_comments`).
- `file_changes` — the path list the worker reported as modified.
- `worker_subagent_session_id` — from the LOOP-RUN.md `## Tasks Closed`
  row (opaque handle, passed through to the verifier).
- `loop_verdict` — the task's verdict from the LOOP-RUN.md `## Tasks Closed`
  row (PASS / FAIL / PARTIAL / NOT_VERIFIED), carried into the AuditTaskEntry.

**No-criteria escape hatch.** If a task has neither an
`acceptance_criteria` column value nor any reconstructable bullets in
its description, score it `PARTIAL` now (`no_acceptance_criteria: true`,
`verifier_verdict` omitted) and **skip Step 3 for that task** — there is
nothing for the verifier to grade against. A NULL column with a
reconstructable bullet MUST still be dispatched (Guardrail 4) — do not
short-circuit it to the escape hatch.

## 5 USD hard cost-cap guard (run BEFORE Step 3 — Guardrail 3)

Compute `estimated_usd = task_count × 0.30 USD`, where `task_count` is the
number of tasks that would be dispatched to a verifier (the §6
per-verifier budget).

**If `estimated_usd > 5 USD`, grade as many tasks as fit under the cap
instead of halting at zero.** Compute `budget_count = floor(5 / 0.30) = 16`.
Prioritize which tasks get a verifier — highest-signal first:

1. Tasks whose LOOP-RUN.md verdict was NOT `PASS` (FAIL / PARTIAL /
   NOT_VERIFIED) — drift here is most likely.
2. Then PASS tasks by descending `file_changes` count (bigger diffs, bigger
   risk).
3. Then the rest by ascending task id.

Dispatch verifiers for the first `budget_count` tasks only. Every remaining
task is scored `PARTIAL` with `cost_cap_deferred: true` and NO verifier
dispatched. Set frontmatter `cost_cap_hit: true`. The integration verdict
roll-up treats deferred tasks as `PARTIAL` (never `COVERED` — ungraded is
not certified).

Example: a 20-task run grades the 16 highest-signal tasks and defers 4 with
`cost_cap_deferred: true`. A 15-task run is `15 × 0.30 USD = 4.50 USD ≤ 5 USD`
→ grade all.

## Step 3 — Dispatch one `tasks-verifier` per task

For each task with grade-able acceptance criteria, dispatch one
`tasks-verifier` subagent using the **exact same envelope** as
[`docs/verifier-contract.md`](../../docs/verifier-contract.md) defines —
do NOT re-invent the verifier. The `VerifierInputs` envelope:

```ts
{
  task_id: number,
  acceptance_criteria: string,        // reconstructed if the column was NULL
  worker_subagent_session_id: string, // from the LOOP-RUN.md row
  commit_shas: string[],
  file_changes: string[],
}
```

`base_sha` and `additional_observations` are deliberately **omitted** from the
audit envelope: audit grades an already-integrated historical tree, so there
is no expected worktree base to assert, and the original run's orchestrator
observations are not reproducible inputs — the audit is a pure function of
(LOOP-RUN.md, tasks-database, current tree).

**Default to `subagent_type: "general-purpose"` with the verifier prompt
embedded in the brief** — the named `tasks-verifier` subagent type is
only registered for sessions started after the user ran `install.sh`, and
an `Agent` call with an unknown `subagent_type` FAILS the whole dispatch.
Embed the full body of
[`skills/agents/tasks-verifier.md`](../agents/tasks-verifier.md) as the
prompt prefix (read it at run time so prompt updates flow through),
followed by a fenced JSON block with the `VerifierInputs` envelope.
**Always pass `name: "audit-verifier-task-<id>"`** so the verifier is
addressable for schema-repair round-trips after its first message. **Set
`model:` to the planning-role model resolved once in Preflight**
([loop-shared.md §R](loop-shared.md#r-model-resolution)).

```
Agent(
  subagent_type: "general-purpose",          // or "tasks-verifier" if registered
  name: "audit-verifier-task-<id>",          // REQUIRED — addressable for repair
  model: <planning-role model resolved in Preflight, or omit to inherit>, // loop-shared.md §R
  description: "Audit-grade task #<id> against acceptance criteria",
  prompt: <<-EOF
${body of skills/agents/tasks-verifier.md}

Here is your VerifierInputs envelope. Follow docs/verifier-contract.md exactly.
Your FINAL message MUST be a single JSON object parseable as VerificationEvidence.

```json
${JSON.stringify(verifierInputs, null, 2)}
```
EOF
)
```

The verifier is read-only by its own Wave 2.1 / #314 contract (tool
allowlist, denylist, ≤ 30 tool calls / ≤ 5 minutes) — the audit
orchestrator inherits that property and must not relax it. The verifier
returns `VerificationEvidence` (verdict + checks + session metadata).
Summarise each return (verdict + check count + first FAIL/SKIP evidence
line) into the per-task entry **before** dispatching the next verifier,
so the orchestrator's working context stays bounded by the per-task
summary shape, not the cumulative transcripts.

## Step 4 — Score per task (COVERED / PARTIAL / MISSING)

Map each verifier's top-level `verdict` to an `AuditScore` (design §3
Step 4; `AuditScoreSchema` in `src/lib/audit/schema.ts`):

| Verifier verdict | Audit score |
|------------------|-------------|
| `PASS`           | `COVERED`   |
| `PARTIAL`        | `PARTIAL`   |
| `NOT_VERIFIED`   | `PARTIAL`   |
| `FAIL`           | `MISSING`   |

`NOT_VERIFIED` rolls up to `PARTIAL` (not `MISSING`): the verifier ran
and could not form a verdict, which is a softer signal than an explicit
`FAIL`. Build one `AuditTaskEntry` per task (`task_id`, `title`, `score`,
verbatim `verifier_verdict`, `check_count`, optional
`first_failing_evidence` truncated to 200 chars, optional
`no_acceptance_criteria`).

## Step 5 — Roll up the integration verdict

Compute `integration_verdict` deterministically from the per-task scores
(design §3 Step 5):

| Task score population              | Integration verdict |
|------------------------------------|---------------------|
| At least one `MISSING`             | `MISSING`           |
| No `MISSING`, ≥ one `PARTIAL`      | `PARTIAL`           |
| All `COVERED`                      | `COVERED`           |
| Zero tasks scored                  | `PARTIAL`           |

A run with zero gradable tasks rolls up to `PARTIAL`, not `COVERED` — it
would be misleading to certify a run nothing was graded against.

## Step 6 — Emit AUDIT.md

Write the artifact to
`.planning/loops/<UTC-timestamp>-<project_id>-AUDIT.md` (timestamp format
`YYYY-MM-DDTHH-MM-SSZ`, same convention as `docs/loop-run-schema.md` §2).
Create `.planning/loops/` if absent. The file is **gitignored** for the
same reason LOOP-RUN.md is — runtime artifacts stay per-machine. **Do NOT
`git add` it**, and do NOT modify `.gitignore` to make it an exception.
This `Write` is the ONLY filesystem mutation the skill is permitted.

**Frontmatter (YAML)** — mirror `AuditRunFrontmatterSchema` in
`src/lib/audit/schema.ts` field-for-field:

| Field                 | Source                                                              |
|-----------------------|---------------------------------------------------------------------|
| `run_id`              | **reused** from the LOOP-RUN.md frontmatter (UUIDv4).               |
| `audit_id`            | **fresh** UUIDv4 minted this invocation.                           |
| `project_id`          | int ≥ 1, from the LOOP-RUN.md.                                      |
| `audit_started_at`    | RFC 3339 UTC start time.                                            |
| `audit_ended_at`      | RFC 3339 UTC end time.                                              |
| `total_tasks`         | count of rows in LOOP-RUN.md `## Tasks Closed`.                     |
| `covered_count`       | tasks scored `COVERED`.                                            |
| `partial_count`       | tasks scored `PARTIAL`.                                            |
| `missing_count`       | tasks scored `MISSING`.                                            |
| `integration_verdict` | `COVERED` \| `PARTIAL` \| `MISSING` (§3 Step 5).                    |
| `total_usd`           | orchestrator + every verifier dispatch (cache-discounted); `0` if cost-cap-hit. |
| `cost_cap_hit`        | `true` iff the 5 USD cap halted the run before dispatch.           |

**You MUST construct the counts so the invariant holds:**
`covered_count + partial_count + missing_count == total_tasks`. The
schema does NOT enforce this (`.refine()` is intentionally absent — same
posture as `LoopRunFrontmatterSchema`); it is your responsibility by
construction.

**Body sections (in order — design §4):**

1. **`## Per-Task Audit`** — one row per task: `task_id`, `title`,
   `score`, `loop_verdict`, raw `verifier_verdict`, check count, the first
   FAIL/SKIP evidence line (truncated to 200 chars), and a stable link back
   to the task in the tasks database.
2. **`## Integration Verdict`** — the §3 Step 5 roll-up plus a
   one-paragraph rationale citing the contributing tasks (e.g. "MISSING
   because task #N had no commits referencing the file in AC #2").
3. **`## Verdict Drift`** — one bullet per task whose audit score DISAGREES
   with its loop verdict (e.g. loop said PASS, audit scored MISSING):
   `#<task_id> — loop:<verdict> → audit:<score> — <first failing evidence
   line>`. Sentinel `_No drift: audit agrees with every loop verdict._` when
   empty. **Exclude entries with `cost_cap_deferred: true`** — their PARTIAL
   is a budget artifact, not a grading disagreement, and a capped run would
   otherwise drown real drift in spurious `PASS → PARTIAL` rows. List them
   instead on one closing line: `_Deferred, ungraded (cost cap): #a, #b, …_`
   (omit the line when none). Drift rows are the audit's primary output —
   they are where grade inflation or environment skew shows up.
4. **`## Cost Breakdown`** — one row per dispatched verifier (`task_id`,
   tokens, cache-discounted USD, wall seconds), an orchestrator-overhead
   row, and a TOTAL. (Cost-cap-deferred tasks show no verifier row; spend
   stays ≤ 5 USD.)
5. **`## Replay Instructions`** — the exact
   `/tasks:audit --loop-run <path>` invocation that reproduces this
   artifact (`audit_id` is fresh per invocation; the LOOP-RUN.md path +
   tasks-database state fully determine the audit).

Set `audit_ended_at = <now UTC>` immediately before the final write.

## Guardrails (LIVE rules — do NOT remove)

Each guardrail is enforced by a falsifiable test gate in
[`src/api/routes/tasks/__tests__/skill-audit-design.test.ts`](../../src/api/routes/tasks/__tests__/skill-audit-design.test.ts).
Do not weaken those tests without simultaneously updating
`docs/tasks-audit-design.md` §5.

1. **MUST NOT mutate code.** No `Edit` / `Write` / `MultiEdit` /
   `NotebookEdit` against the source tree. The ONLY `Write` permitted is
   the AUDIT.md emit under `.planning/loops/`. Audit is a grader, not a
   fixer — remediation lives in a separate orchestrator.
2. **MUST NOT call wood-fired-tasks `update_task` or `add_comment`** (nor
   any other mutating MCP tool — see Preflight). Read-only against the
   tasks database, symmetric to the verifier contract. The audit must be a pure
   function of (LOOP-RUN.md, tasks-database snapshot at audit time).
3. **MUST hard-bound verifier spend at ≤ 5 USD.** Compute
   `estimated_usd = task_count × 0.30 USD` after Step 1 and before Step 3;
   on overage, grade only the `budget_count = 16` highest-signal tasks (the
   cost-cap section's prioritization), defer the rest with
   `cost_cap_deferred: true`, and set `cost_cap_hit: true`. The cap bounds
   spend — it no longer zeroes the run.
4. **MUST reconstruct `acceptance_criteria` from the task description
   when the tasks database column is NULL.** Historical loops pre-date Wave 1.3;
   a NULL column must NOT cause the audit to skip that task. Fall back to
   `score: PARTIAL`, `no_acceptance_criteria: true` ONLY when no bullets
   are recoverable.

## Links

- Design spec (source of truth): [`docs/tasks-audit-design.md`](../../docs/tasks-audit-design.md)
- Schema (zod): [`src/lib/audit/schema.ts`](../../src/lib/audit/schema.ts)
- Schema tests: [`src/lib/audit/__tests__/schema.test.ts`](../../src/lib/audit/__tests__/schema.test.ts)
- Design-doc / skill tests: [`src/api/routes/tasks/__tests__/skill-audit-design.test.ts`](../../src/api/routes/tasks/__tests__/skill-audit-design.test.ts)
- Verifier contract reused verbatim: [`docs/verifier-contract.md`](../../docs/verifier-contract.md)
- Companion skill (producer of LOOP-RUN.md): [`skills/tasks/loop.md`](./loop.md)
