Owner: Repository maintainers

# /tasks:audit Design Spec

> **Companion artifacts (to be added when the runtime lands):**
> a zod schema mirror at `src/lib/audit/schema.ts` (in this commit) and
> future reference examples at `docs/audit-reference-example.md`
> (deferred to the implementation follow-on tasks). This document is the
> design-of-record landed by wood-fired-tasks task **#323**.

## Status

Wave 7.1 DESIGN landed by wood-fired-tasks task **#323** (2026-05-23).
Runtime orchestration is **deferred** — the skill file at
[`skills/tasks/audit.md`](../skills/tasks/audit.md) is a discovery stub
that points users at this design and refuses to dispatch any subagent or
mutate the bugs database. The follow-on tasks listed in §8 will:

1. Implement the runtime orchestration pipeline (§3).
2. Author the three verification fixtures sketched in §7.
3. Integrate `/tasks:audit` into onboarding docs (AGENTS.md,
   docs/NAVIGATION.md, README quickstart) next to `/tasks:loop`.

Until those tasks land, invoking `/tasks:audit` MUST emit a
"design-only — implementation deferred" message rather than executing
any step of the pipeline.

## §1 Goal + scope

The skill is a **retroactive grader** for the bugs-db side of the
house. It consumes the artifact `/tasks:loop` already emits
(LOOP-RUN.md), re-runs the same `tasks-verifier` subagent contract
(Wave 2.1 / #314) against every task that loop ran, and produces an
AUDIT.md scoring each task COVERED / PARTIAL / MISSING with an
integration-level roll-up.

**What it IS:**

- A retroactive grader — runs *after* a loop completes (or against any
  historical LOOP-RUN.md the user points at).
- An independent re-verification — uses a fresh `tasks-verifier`
  context per task, with no access to the original worker's transcript.
- A historical-grade tool — must work on Project 11 / Project 12 runs
  whose tasks pre-date the Wave 1.3 `acceptance_criteria` column
  (reconstruct from task description when NULL).

**What it ISN'T:**

- Not a real-time monitor — does not subscribe to live `/tasks:loop`
  events; the loop completes, then audit runs.
- Not an executor / fixer — never modifies code, never re-opens tasks,
  never adds comments. Read-only on the bugs DB and the source tree.
- Not a replacement for the per-task verifier dispatched mid-loop
  (Wave 2.2 / #315) — that gate stops a *single* bad worker from
  closing; audit grades the *aggregate* run after the fact.

## §2 Inputs / outputs contract

```yaml
name: audit
namespace: tasks
triggers:
  - "audit the last loop run"
  - "grade project 12 retroactively"
  - "/tasks:audit"
required-args (exactly one of):
  --loop-run <path>      # explicit path to a LOOP-RUN.md on disk
  --project <id>         # wood-fired-tasks project id; auto-finds the
                         # most recent .planning/loops/<UTC>-<id>.md
outputs:
  - .planning/loops/<UTC>-<project_id>-AUDIT.md
    (NOT committed — .planning/ is gitignored, same rationale as
    LOOP-RUN.md per docs/loop-run-schema.md §2)
cost-budget:
  target:   $1–3      # typical 5–15-task run, $0.30 per verifier
  hard-cap: $5        # orchestrator HALTS before dispatching if
                      # estimated cost exceeds this; see §5 guardrail 3
side-effects:
  - filesystem writes: .planning/loops/<file>-AUDIT.md only
read-only:
  - source tree (verifier evidence queries)
  - bugs DB (get_task, get_comments, get_dependencies, list_tasks)
```

The AUDIT.md frontmatter shape is locked in by
`AuditRunFrontmatterSchema` at `src/lib/audit/schema.ts`. The per-task
roll-up shape is locked in by `AuditTaskEntrySchema`. A complete
roll-up envelope (frontmatter + entries) is `AuditRunSchema` — that is
the JSON-schema-friendly artifact shape callers can serialise and
re-parse.

## §3 Pipeline

The pipeline runs strictly in order. Each step hands a *summary* (not
raw output) to the next so the orchestrator's context stays small
across the run.

### Step 1 — Resolve LOOP-RUN.md

Accept the input via CLI flags. Exactly one of `--loop-run` or
`--project` is required (the runtime MUST refuse if both / neither is
supplied):

- `--loop-run <path>`: literal path; resolve relative to repo root if
  not absolute. Refuse if the file does not exist or is not a
  LOOP-RUN.md (frontmatter must parse against `LoopRunFrontmatterSchema`
  from `src/lib/loop-run/schema.ts`).
- `--project <id>`: glob `.planning/loops/<UTC>-<id>.md`, sort by
  UTC timestamp prefix descending, pick the first. Refuse if no match.

Parse the LOOP-RUN.md frontmatter (the `run_id`, `project_id`,
`started_at`, `ended_at` are reused in the AUDIT.md frontmatter so the
two artifacts can be correlated).

### Step 2 — Enumerate closed tasks

Read the `## Tasks Closed` section body of the LOOP-RUN.md. For each
task listed, fetch via the bugs DB (read-only):

- `acceptance_criteria` — the verbatim column value. **If NULL,
  reconstruct from the task `description`** by extracting bullet lines
  that read like criteria (any `- ` or `* ` bullet under headings
  matching `/accept|verif|criteria/i`). This branch is what makes
  historical grading of Project 11 / Project 12 (which pre-date Wave
  1.3) possible. Guardrail 4 (§5) locks this in.
- `commit_shas` — the SHAs the worker recorded on close (from the
  closing comment or LOOP-RUN.md `## Tasks Closed` body).
- `file_changes` — the path list the worker reported as modified.

If a task has neither an `acceptance_criteria` column value nor any
reconstructable bullets in its description, mark it `PARTIAL`
(score=PARTIAL, reason=`no_acceptance_criteria`) and skip Step 3 for
that task — there is nothing for the verifier to grade against.

### Step 3 — Dispatch one `tasks-verifier` per task

For each task with grade-able acceptance criteria, dispatch one
`tasks-verifier` subagent using the **exact same envelope shape** as
`docs/verifier-contract.md` defines:

```ts
{
  task_id: number,
  acceptance_criteria: string,        // reconstructed if column was NULL
  worker_subagent_session_id: string, // pulled from LOOP-RUN.md
  commit_shas: string[],
  file_changes: string[],
}
```

The verifier returns `VerificationEvidence` (verdict + checks + session
metadata) per the contract. The audit orchestrator does NOT re-invent
the verifier — it reuses the Wave 2.1 / #314 contract verbatim. Tool
allowlist, denylist, and bounds (≤ 30 tool calls, ≤ 5 minutes) all
apply unchanged.

### Step 4 — Score per task (COVERED / PARTIAL / MISSING)

Map the verifier's top-level `verdict` to an audit `score`:

| Verifier verdict | Audit score |
|------------------|-------------|
| `PASS`           | `COVERED`   |
| `PARTIAL`        | `PARTIAL`   |
| `NOT_VERIFIED`   | `PARTIAL`   |
| `FAIL`           | `MISSING`   |

`NOT_VERIFIED` rolls up to `PARTIAL` (not `MISSING`) because the absence
of evidence is not evidence of absence — the verifier ran and could not
form a verdict, which is a softer signal than the verifier emitting an
explicit `FAIL`.

### Step 5 — Roll up the integration verdict

Compute the integration-level verdict deterministically from the
per-task scores:

| Task score population              | Integration verdict |
|------------------------------------|---------------------|
| At least one `MISSING`             | `MISSING`           |
| No `MISSING`, ≥ one `PARTIAL`      | `PARTIAL`           |
| All `COVERED`                      | `COVERED`           |
| Zero tasks scored                  | `PARTIAL`           |

A run with zero gradable tasks (every task hit the
`no_acceptance_criteria` branch in Step 2) rolls up to `PARTIAL`, not
`COVERED` — it would be silently misleading to certify a run nothing
was actually graded against.

### Step 6 — Emit AUDIT.md

Write the artifact to
`.planning/loops/<UTC-timestamp>-<project_id>-AUDIT.md` (timestamp
format `YYYY-MM-DDTHH-MM-SSZ`, same convention as
`docs/loop-run-schema.md` §2). The file is **gitignored** for the same
reason `LOOP-RUN.md` is — runtime artifacts stay per-machine. The
artifact MUST contain frontmatter (§4) plus the four body sections
listed in §4.

### Subagents dispatched

| Step | Agent type        | Bounds                       | Output shape                                 |
|------|-------------------|------------------------------|----------------------------------------------|
| 3    | `tasks-verifier`  | ≤ 30 tool calls / ≤ 5 min    | `VerificationEvidence` per docs/verifier-contract.md |

The orchestrator itself stays under a context budget; per-task verifier
output is summarised (verdict + checks count + per-check status) into
the AUDIT.md body before the next verifier dispatches, so the
orchestrator's working context is bounded by the per-task summary
shape, not by the cumulative verifier transcripts.

## §4 AUDIT.md artifact contract

Lives at `.planning/loops/<UTC-timestamp>-<project_id>-AUDIT.md`. The
path is **not committed** — `.planning/` is in the repo's `.gitignore`
(same rationale that keeps `.planning/loops/*.md` out of git per
`docs/loop-run-schema.md` §2). Frontmatter is YAML, mirrored by
`AuditRunFrontmatterSchema` in `src/lib/audit/schema.ts`:

| Field             | Type        | Notes                                                                       |
|-------------------|-------------|-----------------------------------------------------------------------------|
| `run_id`          | UUIDv4      | **Reused** from the LOOP-RUN.md frontmatter — correlates the two artifacts. |
| `audit_id`        | UUIDv4      | **Fresh** per audit invocation; idempotency key for re-runs.                |
| `project_id`      | int ≥ 1     | wood-fired-tasks project id (mirrors LOOP-RUN.md).                           |
| `audit_started_at`| RFC 3339    | UTC start time.                                                             |
| `audit_ended_at`  | RFC 3339    | UTC end time.                                                               |
| `total_tasks`     | int ≥ 0     | Count of tasks listed in LOOP-RUN.md `## Tasks Closed`.                     |
| `covered_count`   | int ≥ 0     | Tasks scored `COVERED`.                                                     |
| `partial_count`   | int ≥ 0     | Tasks scored `PARTIAL`.                                                     |
| `missing_count`   | int ≥ 0     | Tasks scored `MISSING`.                                                     |
| `integration_verdict` | enum    | `COVERED` \| `PARTIAL` \| `MISSING` (per §3 Step 5 roll-up).                |
| `total_usd`       | number ≥ 0  | Cost across orchestrator + every verifier dispatch (cache-discounted).      |
| `cost_cap_hit`    | bool        | `true` iff the $5 hard cap halted the run before dispatch.                  |

The invariant `covered_count + partial_count + missing_count == total_tasks`
is **not** enforced by the schema (same posture as `LoopRunFrontmatterSchema`'s
`tasks_attempted` sum — see `docs/loop-run-schema.md` §3). The
orchestrator MUST construct the counts so that the invariant holds; the
schema test suite asserts this is true by construction in the audit
pipeline (not by `.refine()` on the schema itself).

Body sections (in order):

1. **`## Per-Task Audit`** — one row per task: `task_id`, `title`,
   `score`, `verifier_verdict` (raw), check count, the first FAIL/SKIP
   evidence line (truncated to 200 chars), and a stable link back to
   the task in the bugs DB.
2. **`## Integration Verdict`** — the roll-up from §3 Step 5 plus a
   one-paragraph rationale citing the contributing tasks (e.g. "MISSING
   because task #N had no commits referencing the file in AC #2").
3. **`## Cost Breakdown`** — one row per dispatched verifier
   (`task_id`, tokens, cache-discounted USD, wall seconds) plus an
   orchestrator-overhead row and a total.
4. **`## Replay Instructions`** — the exact `/tasks:audit --loop-run
   <path>` invocation that reproduces this artifact (`audit_id` is
   fresh per invocation; the LOOP-RUN.md path + bugs-DB state are the
   inputs that fully determine the audit).

## §5 Guardrails

Each guardrail is enforced by a falsifiable test gate in
`src/api/routes/tasks/__tests__/skill-audit-design.test.ts`. Do not
weaken the tests without simultaneously updating the corresponding
guardrail here.

### Guardrail 1 — read-only against the source tree

The skill **MUST NOT mutate code**.

- **Why.** Audit is a grader, not a fixer. Mixing audit + auto-fix in
  one orchestrator concentrates blast radius and makes the audit
  unauditable (a "passing" audit could mean the grader patched the
  code mid-run). Audit and remediation MUST stay in separate
  orchestrators.
- **Enforcement mechanism.** The skill's documented tool surface
  includes `Read`, `Glob`, the read-only bugs-DB MCP tools, and `Write`
  **only** against `.planning/loops/<UTC>-<project_id>-AUDIT.md`. The
  per-task `tasks-verifier` subagent is read-only by its own contract
  (Wave 2.1 / #314) — the audit orchestrator inherits that property.
  Static test gate: §7 fixture "skill never mutates code" asserts a
  test-mode invocation that attempts `Edit` / `Write` against the
  source tree returns a refusal.

### Guardrail 2 — read-only against the bugs DB

The skill **MUST NOT call wood-fired-tasks `update_task` or
`add_comment`**.

- **Why.** Symmetric to the verifier contract. An audit that comments
  on or transitions the tasks it grades would corrupt future audits of
  the same run (the comment / status change becomes evidence the
  *next* audit would re-grade against). The audit must be a pure
  function of (LOOP-RUN.md, bugs-DB snapshot at audit time).
- **Enforcement mechanism.** The skill's documented MCP tool surface
  is the read-only set: `get_task`, `get_comments`, `get_dependencies`,
  `list_tasks`, `list_projects`. Mutating tools (`update_task`,
  `add_comment`, `claim_task`, `create_task`, `delete_*`,
  `add_dependency`, `remove_dependency`, `completion_report` writes)
  are **not** in the skill's allowed-tools list. Static test gate: §7
  fixture "skill never writes to bugs DB" asserts a test-mode
  invocation that attempts those tool calls returns a refusal.

### Guardrail 3 — $5 hard cost cap

The skill **MUST refuse to start if the estimated cost exceeds $5**.

- **Why.** Cost runaway on retroactive audits is a real risk — a
  historical 50-task loop would push past $15 at the per-verifier
  budget in §6. The acceptance criterion explicitly names "≤ $5 per
  audited loop run" as a bounded budget; the hard cap exists to make
  that bound load-bearing rather than aspirational.
- **Enforcement mechanism.** After Step 1 (resolve LOOP-RUN.md) but
  before Step 3 (dispatch verifiers), the orchestrator computes
  `estimated_usd = task_count × $0.30` (the per-verifier budget from §6).
  If `estimated_usd > $5`, the orchestrator halts and records
  `cost_cap_hit: true` in a partial AUDIT.md, dispatching zero
  verifiers. Static test gate: §7 fixture "$5 cost cap" supplies a
  20-task synthetic LOOP-RUN.md (`20 × $0.30 = $6.00 > $5`) and
  asserts the run halts with `cost_cap_hit: true` and `total_usd: 0`
  (no verifier dispatched).

### Guardrail 4 — acceptance-criteria reconstruction for historical loops

The skill **MUST reconstruct `acceptance_criteria` from the task
description when the bugs DB column is NULL**.

- **Why.** Project 11 and Project 12 pre-date the Wave 1.3
  `acceptance_criteria` column. The acceptance criterion for this task
  explicitly demands retroactive grading of those projects; treating a
  NULL column as "ungradable" would defeat that goal. The reconstruction
  rule (extract bullets under headings matching
  `/accept|verif|criteria/i`) is a deterministic, falsifiable fallback.
- **Enforcement mechanism.** Step 2 of the pipeline checks the column
  before dispatching the verifier; on NULL, it parses the task
  description for the documented bullet shape and falls back to a
  per-task `score: PARTIAL`, `reason: no_acceptance_criteria` ONLY
  when no bullets are recoverable. Static test gate: §7 fixture
  "historical-grade Project 12" asserts a synthetic task whose
  acceptance_criteria column is NULL but whose description contains a
  reconstructable bullet still gets dispatched to the verifier (and
  therefore receives a real COVERED / PARTIAL / MISSING score, not
  `no_acceptance_criteria`).

## §6 Cost model

- **Soft target: $1–$3 per audited loop run.** A typical 5–15-task
  loop with the per-verifier budget below lands in this range.
- **Hard cap: $5 per audited loop run.** Enforced by Guardrail 3 above
  — the orchestrator halts *before* dispatching any verifier if
  `task_count × per-verifier budget > $5`.
- **Per-verifier budget: ~$0.30 / ~50K tokens.** The `tasks-verifier`
  subagent already operates within `≤ 30 tool calls / ≤ 5 minutes`
  (Wave 2.1 / #314). At cache-discounted Sonnet rates that is ~50K
  tokens (~10K input, ~5K output, balance is cached reads) which is
  ~$0.30 per dispatch.
- **15-task run sanity check.** Project 12's session 84ae52df ran 15
  tasks ⇒ `15 × $0.30 = $4.50 ≤ $5 cap`. This is the explicit
  acceptance-verification scenario from the task and the design must
  not regress it. The fixture in §7 locks the number in.
- **How the orchestrator tracks cost.** After every verifier dispatch
  returns, the orchestrator reads the returned `usage` block from
  Claude Code, applies the cache-discounted USD calculation from the
  `agent_transactions_v` view (same formula as `LOOP-RUN.md` §4.4 and
  `tasks-decompose-design.md` §10), and increments an in-memory
  counter. The counter is the source of truth for the $5 hard cap.

## §7 Verification fixtures (deferred)

These three fixtures are *design sketches*. They will be authored when
the runtime lands (see §8). Listing them here so the implementation
follow-on cannot ship without them.

1. **Real PASS run** — feed `/tasks:audit` a LOOP-RUN.md whose every
   task closed with a real, complete worker commit (the loop's own
   regression set is the natural source). Assert AUDIT.md scores every
   task `COVERED`, the integration verdict is `COVERED`, and the
   total cost is ≤ $1 (small fixture, ~3 tasks).
2. **Falsified completion** — start from the same loop run, then delete
   one of the files an acceptance criterion explicitly references
   (e.g. remove `docs/verifier-contract.md` between loop close and
   audit dispatch). Assert (a) the affected task's score is `MISSING`,
   (b) the integration verdict is `MISSING`, (c) the verifier's
   `FAIL` evidence line in `## Per-Task Audit` cites the deleted
   path. This is the load-bearing red-team scenario from the
   acceptance criteria.
3. **Historical-grade Project 12** — feed `/tasks:audit` the
   Project 12 LOOP-RUN.md (session 84ae52df, 15 tasks). At least one
   task in Project 12 has `acceptance_criteria = NULL` (pre-Wave 1.3).
   Assert (a) the audit dispatches 15 verifiers (not fewer — every
   task with a reconstructable bullet must still be graded), (b)
   `total_usd ≤ $5`, (c) `cost_cap_hit: false`, (d) the AUDIT.md is
   emitted with a non-trivial breakdown of COVERED / PARTIAL / MISSING
   counts. This fixture pairs with the Verification block of the
   originating task (`/tasks:audit on Project 12 84ae52df ... scores
   15 tasks ... audit cost stays under budget`).

A **blast-radius fixture** is intentionally omitted: unlike
`/tasks:decompose`, the audit skill mutates nothing — every path is
already read-only, so a "deploy" / "delete data" keyword has no
extra blast radius to refuse against.

## §8 Follow-on tasks

To be created in wood-fired-tasks project 15 *after* this design lands:

- **Implement /tasks:audit runtime** — replace the discovery stub in
  `skills/tasks/audit.md` with the full pipeline. Wire Step 1
  (LOOP-RUN.md resolver), Step 2 (closed-task enumerator + AC
  reconstruction), Step 3 (per-task `tasks-verifier` dispatcher),
  Step 4–5 (score + roll-up), Step 6 (AUDIT.md emitter), and the
  $5 cost-cap guard.
- **Author verification fixtures** — write the three fixtures sketched
  in §7 (real PASS, falsified completion, historical-grade Project 12)
  plus a smoke fixture that asserts the orchestrator refuses both
  `--loop-run` and `--project` being supplied simultaneously.
- **Integrate into onboarding** — add a `/tasks:audit` entry to
  `AGENTS.md`, a section in `docs/NAVIGATION.md` under "if you want to
  retroactively grade a loop run", and a one-paragraph quickstart in
  `README.md` next to the `/tasks:loop` example.
- **AC-reconstruction RFC** — the bullet-extraction heuristic in
  Guardrail 4 (regex against headings matching `/accept|verif|criteria/i`)
  is deliberately conservative. A separate task should benchmark it
  against the full Project 11 + Project 12 task corpus and surface
  any tasks where the heuristic under-recovers; tune the regex
  against that ground truth.
- **AUDIT.md reference example** — write `docs/audit-reference-example.md`
  alongside `docs/loop-run-reference-example.md`. The example becomes
  a regression gate the schema tests pin to.

---

This design intentionally leaves the runtime to the follow-on tasks.
The artifacts that DO land in this commit (this doc, the schema, the
skill stub, the schema + design-doc tests) are the falsifiable contract
the runtime will be implemented against.
