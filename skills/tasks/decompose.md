---
name: decompose
description: Operational planner that breaks a project-level goal into 8–25 independent leaf tasks (FLAT) or a dependency DAG, ready for /tasks:loop or /tasks:loop-dag. Runs a 9-step pipeline — goal capture → codebase recon (one Explore agent) → candidate generation (planner) → independence check (critic) → topology decision (topology_check) → coverage check (critic) → sizing → materialize (create_task + add_dependency) → DECOMPOSITION.md emit. When a source spec is supplied via --spec, a terminal Step 8d spec-coverage audit cross-checks the materialized tasks against the spec's declared surfaces and auto-emits coverage tasks for gaps. PLANS only; never executes the tasks it materializes. Bounded ≤ 5 USD soft target / 15 USD hard cap. Refuses blast-radius goals (deploy / migrate production / delete data).
argument-hint: --project <id> --goal "..." [--success "..."] [--domain frontend|backend|docs|infra|mixed] [--spec <path>] [--dry-run]
disable-model-invocation: false
---

# /tasks:decompose

You are the **orchestrator** of a goal decomposition. Your job is to turn
one project-level goal into a backlog of well-formed wood-fired-tasks tasks
(plus the dependency edges between them), then hand off to a *separate*
executor — `/tasks:loop` (FLAT) or `/tasks:loop-dag` (DAG). You are the
**planner half**; you NEVER execute the tasks you materialize (Guardrail 1).

The full design — contract, methodology, guardrails, artifact schema,
verification fixtures, and cost budget — is the source of truth at
[`docs/tasks-decompose-design.md`](../../docs/tasks-decompose-design.md).
This skill is the executable implementation of that design; where they
could drift, the design doc wins. Section references below (§N) point
into it.

> **Mental model.** You are the architect drafting the work breakdown, not
> the crew that builds it. Each step hands the *next* step a small summary
> (recon summary, candidate drafts, edge set, coverage verdict) — never the
> raw subagent transcript — so your working context stays bounded across
> the whole run. The only writes you perform are tasks-database `create_task` /
> `add_dependency` calls (Step 8) and the single `DECOMPOSITION.md` emit
> (Step 9). You touch the source tree **read-only**, and only during Step 2
> recon.

## Preflight: MCP tools

This skill calls tools on the `wood-fired-tasks` MCP server. Shorthand
`wood-fired-tasks:<tool>` ↔ harness name `mcp__wood-fired-tasks__<tool>`.
On `InputValidationError`, load via `ToolSearch`
(`select:mcp__wood-fired-tasks__list_projects,mcp__wood-fired-tasks__list_tasks,mcp__wood-fired-tasks__topology_check,mcp__wood-fired-tasks__create_task,mcp__wood-fired-tasks__add_dependency`)
and retry.

**Allowed MCP tool surface (Guardrail 1 — planner, not executor):**

- `list_projects` — resolve / validate the `--project` id (read-only).
- `list_tasks` — read existing backlog for idempotency dedup (read-only).
- `topology_check` — classify the Step-4 edge set (read-only; Wave 4.1 / #318).
- `create_task` — materialize a surviving candidate (Step 8 only).
- `add_dependency` — materialize a dependency edge (Step 8 only).

**The execution-side mutating tools are NOT permitted (Guardrail 1):**
`claim_task`, `update_task` (status transitions), `add_comment`,
`completion_report`, `delete_task`, `remove_dependency`,
`update_project`, `delete_project`. An orchestrator that claimed or
status-transitioned a task it just planned would be executing its own
plan — exactly the plan/execute fusion this skill exists to prevent. If a
step seems to need one of these, you have misread the design — stop and
re-read §5 Guardrail 1. `create_task` and `add_dependency` are the ONLY
mutating tools, and ONLY in Step 8 (skipped under `--dry-run`).

---

## Step 1 — Goal capture

Parse `$ARGUMENTS`. Supported flags: `--project <id>`, `--goal "..."`,
`--success "..."` (repeatable), `--domain <enum>`, `--spec <path>`,
`--dry-run`. Validate (design §3 Step 1):

> **Input model — read before you start.** Decompose consumes a *distilled*
> brief: a `--goal` (≤ 200 words) plus 3–5 `--success` criteria. It does
> **not** ingest a plan document as a *generation* input — it re-derives the
> task breakdown from its own Step-2 recon. If you are handed a long external
> plan, compress its intent into the `--goal` and pin the acceptance bar with
> the success criteria; the file-by-file detail is the executor's job
> downstream, not an input here.
>
> **`--spec <path>` does NOT change that.** The optional `--spec` flag names a
> source spec / plan / design doc that is consulted by **exactly one** step:
> the terminal **Step 8d spec-coverage audit**, which runs after
> materialization and cross-checks the *already-created* task set against the
> surfaces the spec declares. The spec is never read by Steps 2–7 and never
> seeds candidate generation — it is a post-hoc coverage cross-check, not a
> breakdown source. When `--spec` is omitted, Step 8d is skipped entirely.

- `--project <id>` — required, positive integer. Confirm it resolves via
  `wood-fired-tasks:list_projects`; refuse with a usage error if it does
  not exist.
- `--goal "..."` — required, non-empty, **≤ 200 words** (~≤ 1500 chars).
  Over the cap ⇒ refuse and ask the user to tighten the goal.
- `--success "..."` — **3–5 entries required**. Fewer than 3 or more than
  5 ⇒ ask the user to add/trim (or collect interactively until 3–5).
- `--domain <enum>` — one of `frontend | backend | docs | infra | mixed`.
  Defaults to `mixed` if omitted. Any other value ⇒ refuse.
- `--spec <path>` — optional. Path to a source spec / plan / design doc
  (e.g. a `docs/superpowers/specs/*.md` file). When supplied, the terminal
  **Step 8d spec-coverage audit** cross-checks the materialized task set
  against the spec's declared surfaces. Confirm the path exists and is
  readable; a missing/unreadable `--spec` ⇒ refuse with a usage error. The
  spec is read **read-only** and ONLY in Step 8d (never in Steps 2–7). When
  omitted, Step 8d is skipped.
- `--dry-run` — optional. When set, run §1–§7 and §9 but **SKIP §8
  materialize** (no `create_task` / `add_dependency`); the artifact records
  `candidate_count` of the would-be tasks with `task_id: (dry-run)`. Because
  Step 8d is a §8 sub-step, it is **also skipped under `--dry-run`** (there
  are no materialized tasks to audit).

### Guardrail 4 — blast-radius keyword refusal (BEFORE any dispatch)

Before Step 2 dispatches anything, scan `--goal` (and every `--success`
entry) for blast-radius keywords. The match is **whole-word,
case-insensitive**, regex `\b(deploy|migrate production|delete data)\b`.
If ANY of `deploy`, `migrate production`, or `delete data` matches, **REFUSE
immediately** — emit the message below and STOP. Do **not** dispatch the
Explore agent, the planner, or any critic; do **not** call `create_task`.
The refusal MUST happen in Step 1, before any subagent dispatch (design §5
Guardrail 4). If you write a partial artifact at all, it carries
`advisory: BLOCKED` and `aborted_reason: blast_radius_keyword`.

```
/tasks:decompose refuses this goal: it contains a blast-radius keyword
(deploy / migrate production / delete data). Those phrases name
irreversible operations whose blast radius is customer impact, not test
failures. Auto-decomposition would hide one of those operations inside a
candidate task — exactly the wrong automation. Author a human plan with
explicit rollback steps instead.

No subagent dispatched. No tasks materialized.
```

Mint a fresh `decomposition_id` (UUIDv4) now — it is the idempotency /
dedup key reused by Step 8 and recorded in the Step 9 frontmatter. Record
`generated_at = <now UTC, RFC 3339>`.

## Step 2 — Codebase recon

Dispatch **exactly ONE** Explore-agent subagent, bounded
`≤ 50 tool calls` and `≤ 8 minutes wall time` (design §3 Step 2). Use the
`Agent` tool with `subagent_type: "Explore"` and
`name: "decompose-recon"`. The Explore agent reads `AGENTS.md` /
`CLAUDE.md` / `docs/REPO_MAP.md` first to find entry points, then walks
only the subtree relevant to the goal + `--domain` (e.g. `frontend` →
`src/web/**` first; `infra` → `deploy/**` first; `mixed` disables the
directory-first heuristic).

Brief the agent to return a **structured recon summary, ≤ 2 KB markdown**
(entry points, relevant modules, existing tests, integration seams). The
`Explore` subagent_type is **read-only and has no `Write` tool**, so it
returns the summary in its final message and **YOU (the orchestrator) write
it** to `.planning/decompositions/.cache/<decomposition_id>-recon.md` (create
the `.cache/` dir if absent) so Step 3 does **not** re-read source files.
Hold only the summary in your context, never the agent's transcript.

This is the ONLY step that reads the source tree, and it is strictly
read-only (Guardrail 1). Do NOT dispatch workers that mutate the tree.

## Step 3 — Candidate task generation

Dispatch a **planner** subagent with `(goal, success_criteria, recon
summary)`. **Default `subagent_type: "general-purpose"`** with the planner
instructions embedded inline in the dispatch brief (the named planner
subagent type is only registered for sessions started after `install.sh`;
an `Agent` call with an unknown `subagent_type` FAILS the whole dispatch).
Pass `name: "decompose-planner"` so it is addressable for repair
round-trips. Bounds: `≤ 30 tool calls / ≤ 6 minutes` (design Subagents
table).

**Inline planner brief (embed verbatim, then append the inputs):**

> You are a task-decomposition planner. Given a goal, 3–5 success criteria,
> and a codebase recon summary, emit **8–25 candidate task drafts** as a
> JSON array. Each element MUST validate against `CandidateTaskSchema`
> (`src/lib/decompose/schema.ts`):
> - `draft_id` — positive integer, unique within the array.
> - `title` — single line, ≤ 255 chars, imperative voice.
> - `description` — 2–3 sentences, ≤ ~1000 chars; scope + intended approach,
>   NOT a step-by-step execution plan (that is the worker's job downstream).
> - `acceptance_criteria` — ≥ 1 bullet, each independently verifiable (a
>   test name, a build flag, a file-existence assertion, a log line).
> - `suspected_edges` — array of `{from_draft_id, to_draft_id}` for any
>   inter-draft dependency you notice while authoring (hints for Step 4,
>   not authoritative).
> - `estimated_minutes` — integer in [1, 90].
> Prefer independent leaf tasks. Only assert an edge when one draft truly
> cannot start until another completes. Return ONLY the JSON array.

Validate the returned array against `CandidateTaskSchema`.
**< 8 candidates** ⇒ the goal is too small; ask the user whether to file a
single task instead of decomposing, and STOP.
**> 25 candidates** ⇒ the goal is too broad; ask whether to split the goal
first, and STOP.

## Step 4 — Independence check

Dispatch a **critic** subagent (default `subagent_type:
"general-purpose"`, `name: "decompose-critic-independence"`, bounds
`≤ pairs(N) tool calls / ≤ 4 minutes`) to do **pairwise** comparison of the
candidates: for each pair return `INDEPENDENT` | `ORDERED(a→b)` |
`MUTUALLY_EXCLUSIVE`. Aggregate the verdicts into a dependency **edge set**
(one directed edge per `ORDERED` verdict; `MUTUALLY_EXCLUSIVE` pairs are
flagged for user attention).

### Guardrail 3 — halt on high interdependence

Compute
`interdependent_ratio = (ordered + mutually_exclusive) / total_pairs`.
**If `interdependent_ratio ≥ 0.30`, HALT and ask the user** whether the
goal needs re-scoping before proceeding (design §5 Guardrail 3). ≥ 30%
interdependence means the planner output is no longer a sensible
decomposition — the goal is an epic / roadmap / multi-phase migration that
needs human-authored phase structure first. On halt, write a partial
artifact with `aborted_reason: high_interdependence` and STOP — do not
proceed to Step 5.

## Step 5 — Topology decision

Call the `topology_check` MCP tool on the Step-4 edge set (Wave 4.1 / #318
— **no new tool is added by this skill**). Branch on the returned
`topology`:

| Topology     | Advisory          | Action                                                       |
|--------------|-------------------|--------------------------------------------------------------|
| `FLAT`       | `/tasks:loop`     | No edges; tasks drain in any order. Proceed to §6.           |
| `DAG`        | `/tasks:loop-dag` | Group candidates into **1–4 waves** (connected components + longest-path heuristic), render the grouping in artifact body §4. Proceed to §6. |
| `DAG_CYCLIC` | `BLOCKED`         | **HALT** — do NOT materialize. Emit a partial artifact with `advisory: BLOCKED`, `aborted_reason: cycle`, and a cycle report listing the offending `draft_id` chain. STOP. |

The wave grouping is **advisory only** — the user reviews
`DECOMPOSITION.md` before running `/tasks:loop-dag`.

**`topology_check` fallback (mirror `loop-dag.md` §2f / §3a step 2).**
`topology_check` is conditionally registered. It is wired on both the stdio
and remote MCP servers **in the codebase**, but a *deployed* server can lag
the code — a freshly built tool stays absent until the server is redeployed —
so always guard for its absence (the preflight `ToolSearch` load may return
no match). If the call raises `InputValidationError`, first try the
`ToolSearch` load
(`select:mcp__wood-fired-tasks__topology_check`) and retry. If it is still
unavailable or returns a malformed response, **fall back** to classifying
the edge set locally from Step 4: zero edges ⇒ `FLAT`; edges with no cycle
(run a DFS / Kahn check on the `draft_id` graph) ⇒ `DAG`; a detected cycle
⇒ `DAG_CYCLIC`. Record `topology_check_fallback: true` in the artifact's
Topology Verdict section so a reader knows the classification was local.

## Step 6 — Coverage check

Dispatch a second **critic** subagent (default `subagent_type:
"general-purpose"`, `name: "decompose-critic-coverage"`, bounds
`≤ 20 tool calls / ≤ 3 minutes`) with `(success_criteria, union of
candidate acceptance_criteria)`. It returns exactly one of:

- `COMPLETE` — every success criterion is covered by ≥ 1 acceptance
  criterion. Proceed to §7.
- `GAPS([criterion, …])` — add candidate tasks to cover the missing
  criteria, then **re-run Step 4** (independence) on the additions.
- `DUPLICATES([(id_a, id_b), …])` — merge the listed candidate pairs and
  **re-run Step 4** on the survivors.

**Bounded re-entry: at most 2 Step-4 re-runs.** After the second re-run,
halt and ask the user rather than looping further.

## Step 7 — Sizing check

Each candidate's `estimated_minutes` MUST be **≤ 90** (enforced by
`CandidateTaskSchema`; a value > 90 fails validation and halts the run).
Split any candidate over 90 minutes into ≤ 90-minute sub-candidates. Splits
create new dependency edges (split children → split-parent stub); **re-run
Step 4 once on the splits** to fold the new edges into the edge set.

## Step 8 — Materialize

**Skipped entirely under `--dry-run`.** Otherwise, create the surviving
candidates in wood-fired-tasks via `wood-fired-tasks:create_task`, then add
the dependency edges via `wood-fired-tasks:add_dependency`.

### Step 8a — Column-anchored batch WSJF scoring (BEFORE create_task)

> **Opt-out — skip this entire step if WSJF scoring is unwanted.** Batch scoring
> is opt-in and adds an LLM classification pass over the whole candidate set
> (extra cost + latency + nondeterminism on every decompose run). To opt out —
> the user doesn't use WSJF, or the project has no value charter — **materialize
> in Step 8b WITHOUT a `wsjf_submission` (and without `wsjf_trigger`)**: the
> tasks are created unscored and ordered by their `priority` field, exactly as
> before WSJF existed. `/tasks:loop[-dag]` selection falls back to priority+ID
> unchanged when no task in the project is scored, so nothing downstream breaks.

Before you materialize anything, score the **whole surviving candidate batch
at once, column-anchored** against the parent project's value charter (fetch
it via `get_project(project_id)` — the `value_charter`, or `null` when the
project carries none). Follow the classification contract in
[`wsjf-rubric.md`](./wsjf-rubric.md): the agent emits **only classifications
over the fixed enums + verbatim evidence spans, never a final number** — the
server recomputes the four Fibonacci components deterministically.

**Why column-anchored, not per-task.** Score the batch **relative to itself**:
look across ALL candidates one Cost-of-Delay column at a time (Business Value,
Time Criticality, Risk/Opportunity) and anchor the column so the
lowest-deserving candidate in that column is classified down to the `1` tier,
with the rest spread relative to it. A batch where you score each task in
isolation collapses to near-identical mid-band numbers and destroys the
relative ordering the whole method depends on.

**Submit per candidate, in the same `create_task` call.** For each surviving
candidate, pass `wsjf_submission = { classification, features }` to
`create_task` together with `wsjf_trigger='decompose'` (so the append-only
`wsjf_score_history` row is stamped `trigger='decompose'`, distinguishing a
decompose-batch score from a single-create or a manual override). The
`classification` carries `themeName` — the exact `name` of a **live** charter
`value_themes` entry the candidate serves, sourced from the charter you fetched
above (or `null` only when the charter is `null`) — the four enum
classifications, `jobSizeTier`, and one **verbatim** evidence span per
Cost-of-Delay + Job-Size column drawn from that candidate's own title /
description / acceptance_criteria. Business Value is **charter theme weight ×
alignment**: the server resolves the named theme's `weight` from the live
charter and computes UBV via `ubvFromThemeAlignment(theme.weight, alignment)`;
you emit only `themeName` + `alignment`, never the weight or the number. When
the charter is `null`, `themeName` is `null` and UBV takes the **signal
fallback** (alignment-only, weight `1`) — record the in-text signal in the Value
evidence span so the score is auditable as signal-derived. `features` are the
deterministic, no-LLM signals (deadline, transitive-dependent count from the
Step-4 edge set, files-touched when linkable, charter version).

> **Use `wsjf_submission`, NOT the raw `wsjf` object.** The live `create_task`
> tool input (`CreateTaskClientSchema.extend({ wsjf_submission, wsjf_trigger })`
> in [`src/mcp/tools/task-tools.ts`](../../src/mcp/tools/task-tools.ts), shape in
> [`src/schemas/task.schema.ts`](../../src/schemas/task.schema.ts)) exposes **two
> mutually exclusive WSJF paths** and a decompose run must take exactly one of
> them:
> - **`wsjf_submission` ({ classification, features }) + `wsjf_trigger='decompose'`
>   — the path decompose uses.** Classifications over the fixed enums + verbatim
>   evidence; the server runs the deterministic gate and **recomputes** the four
>   Fibonacci components. This is the only path that enforces the column-anchored
>   batch invariant above.
> - **The raw `wsjf` object ({ value, timeCriticality, riskOpportunity, jobSize,
>   … } — `WsjfWriteSchema`) — DO NOT use from decompose.** It is the
>   manual/pre-computed write path: it trusts client-supplied component numbers
>   verbatim (no classification gate, no batch-variance check) and stamps history
>   `trigger='manual'`/`'single_create'`. Passing a raw `wsjf` here would bypass
>   the anchoring the whole method depends on. Reserve it for human overrides
>   outside this skill.
>
> Pass `wsjf_submission` and `wsjf_trigger` **only**; never populate the raw
> `wsjf` field in a decompose `create_task` call.

**Propagate a scored parent's VALUE prior to decompose-children (#644).** When
the goal being decomposed corresponds to an already-WSJF-scored **parent task**
(you are breaking *that* task into children, not seeding a fresh project),
each child **inherits the parent's value-theme mapping + Business-Value (UBV)
prior** — value flows down the tree (design spec §8.5). Carry the parent's
`themeName` onto each child's `classification.themeName` and anchor the child's
Business-Value classification to the parent's value tier as the **prior**,
rather than re-deriving value from scratch. The three **objective** components
— Time Criticality, Risk/Opportunity, and Job Size — are still scored **fresh**
per child from that child's own deadline, DAG fan-out (Step-4 edge set), and
scope; never copy them from the parent. If the parent's value was **human-set**
(a manual override, `wsjf_source.value === 'manual'`), the inherited prior is a
**human-anchored** anchor (flagged so it is visible) — keep the child's value at
the parent's tier unless the child's own evidence clearly diverges. When the
parent is unscored, there is no prior to inherit and the child is scored
entirely fresh as below.

**Rely on the gate's BATCH invariant to reject degenerate batches.** The
server's `validateScoreSubmission` BATCH path enforces, across the batch, that
**every Cost-of-Delay column has a `1` anchor AND each column's variance ≥ the
variance floor**. If your batch is degenerate (no `1` anchor in some column, or
all-similar scores with sub-floor variance), the gate **rejects** the
submission with a structured per-violation error. On rejection, **re-prompt
yourself**: re-anchor the offending column(s) — push the lowest-deserving
candidate down to the `1` tier and widen the spread — then resubmit. Bounded
re-prompt: at most 2 re-score passes; if still degenerate after the second,
fall the batch back to unscored `create_task` (priority-only) and note it in
the artifact body §5. A bad evidence span (not a verbatim substring) is
rejected the same way and is fixed by quoting the candidate text exactly.

### Step 8b — Create + edge

**Idempotent on `decomposition_id` (tag-carried).** `create_task` has no
`decomposition_id` field, so the id rides on a **tag**: stamp every created
task with `decomp-<decomposition_id>` (and echo the id in the description).
Before creating, call
`list_tasks(project_id, tags=["decomp-<decomposition_id>"])` and **skip any
draft whose title already exists** under that tag — re-running the same goal
+ project + `decomposition_id` MUST NOT duplicate tasks. Record the
`(draft_id → task_id)` mapping for the artifact body §5. Each materialized
task carries its server-computed WSJF components + evidence (from Step 8a) and
a `wsjf_score_history` row with `trigger='decompose'`. Materialization
NEVER transitions a task's status, claims it, or comments on it
(Guardrail 1) — it only creates and edges.

### Step 8c — Invariant-rider coverage pass

**Runs AFTER candidate generation, BEFORE Step 8b materialization completes.**
After the surviving candidate set exists but before (or interleaved with) the
`create_task` / `add_dependency` calls, run a **surface-detection pass** over
the candidates and **auto-emit a coverage task (or attach an AC rider) for
every touched surface that lacks a covering task**. This is the
architectural-invariant check the per-task ACs cannot see — each candidate's
ACs are locally complete, so a cross-cutting surface (e.g. remote-MCP
reachability) drops silently unless the rider re-derives it from the candidate
set itself, independent of what the plan listed.

Surfaces checked (the canonical 8 — see
[`docs/tasks-decompose-design.md`](../../docs/tasks-decompose-design.md)
§Surface-coverage matrix): `{ stdio MCP, remote MCP, REST, CLI, skills,
client-package mirror, docs/tool-count, migration/backfill }`.

Detection → emission mappings:

- **A candidate adds a stdio MCP tool** (registers a tool in the stdio server)
  ⇒ auto-emit a **remote-MCP-parity task**: register the tool in
  `src/mcp/remote/register-tools.ts` + a backing REST endpoint, AND attach a
  `stdio ⊆ remote` **parity-test AC rider** so the suite goes RED until the
  remote proxy exists. This stdio-MCP-tool → remote-MCP-parity-task mapping is
  the load-bearing one — it is exactly the WSJF gap
  (`docs/retrospectives/2026-06-01-wsjf-remote-parity-planning-gap.md`) where 4
  stdio tools shipped PASS yet unreachable in production.
- **A candidate edits a skill that has a client-package mirror** ⇒ auto-emit a
  mirror-sync coverage task (skill ⇒ client-package copy stays in parity).
- **A candidate adds/changes a tool** ⇒ auto-emit a **docs/tool-count** update
  task (the documented tool count must match the registry).
- **A candidate adds a column / schema change** ⇒ auto-emit a
  **migration/backfill** coverage task.

Auto-emitted coverage tasks are created via the same `create_task` /
`add_dependency` path in Step 8b (and edged to the candidate that triggered
them), so a surface missing from the plan cannot silently drop through
decomposition. Record every rider-emitted task in the artifact body §5 with a
`(rider)` marker so the reader sees which tasks the invariant rider added.

### Step 8d — Terminal spec-coverage audit (when `--spec` is supplied)

**The TERMINAL materialize sub-step.** It runs LAST in Step 8 — after the
Step 8b `create_task` / `add_dependency` materialization and the Step 8c
invariant-rider pass have completed — and immediately **BEFORE the Step 9
`DECOMPOSITION.md` emit**. Where Step 8c re-derives the **8 canonical CODEBASE
surfaces** from the candidate set, Step 8d generalizes that rider into a
**SPEC-grounded coverage check**: it cross-references the materialized task set
against the surfaces the *source spec actually declares*, so an item the spec
called for but no task covers cannot drop silently.

**Bounded — skipped when no spec is supplied.** This phase is active **only
when `--spec <path>` was passed** in Step 1 (and never under `--dry-run`, where
no tasks were materialized). With no `--spec`, Step 8d is a **no-op**: record
`spec_coverage_audit: skipped (no --spec)` in the artifact body §8 and proceed
straight to Step 9. The phase performs **at most one** cross-reference pass over
the spec; it does NOT re-run Steps 4–7.

Read the `--spec` file **read-only** and extract its **declared surfaces** —
the three classes a spec uses to pin scope:

1. **Components / surfaces table** — the spec's components table or
   `## Surface-coverage matrix` (the PLAN-TEMPLATE matrix). Every non-`N/A`
   row / cell is a declared surface that must map to a materialized task.
2. **Per-section acceptance criteria** — each acceptance criterion / "must"
   bullet the spec states per phase or section.
3. **Explicit file references** — every concrete path or symbol the spec
   names (e.g. `src/mcp/remote/register-tools.ts`, `buildRemoteMcpEntry`).

Cross-reference each declared surface against the tasks created in Step 8b
(match by title / description / acceptance_criteria within the
`decomp-<decomposition_id>` tag set). Then:

- **(a) Auto-emit coverage tasks for uncovered spec items.** For every spec
  component / acceptance criterion / file reference that **no** materialized
  task covers, auto-emit a coverage task via the same Step 8b `create_task` /
  `add_dependency` path, **edged to the trigger** (the materialized task or
  spec item that motivated it), and stamp it with the same `(rider)` marker
  convention as Step 8c so the reader sees which tasks the audit added.
  *Motivating example* — a manual post-decompose audit of project 29 v2.0
  caught three uncovered surfaces (an OpenAPI `X-API-Key` security scheme, a
  docs scrub, and a package version bump) that no candidate task covered;
  Step 8d auto-emits exactly those.
- **(b) Flag factual drift for correction.** When a materialized task cites a
  file path or symbol that does **not** match the spec or the codebase, flag
  it in the audit verdict as `DRIFT(task_id, cited, expected)` for human
  correction. *Motivating example* — a task citing `buildRemoteMcpEntry` when
  the spec/codebase names a different symbol. Step 8d **flags** drift; it does
  NOT silently rewrite the offending task.

**Guardrail 2 — the audit NEVER edits decompose's own files.** Step 8d is
read-only over the spec and creation-only over the backlog (`create_task` /
`add_dependency`). It MUST NOT `Edit` / `Write` `skills/tasks/decompose.md`,
`docs/tasks-decompose-design.md`, or `src/lib/decompose/**`, and it MUST NOT
auto-emit a coverage task whose scope is to edit those files — even when the
spec references them. A spec item that names decompose's own files is recorded
in the audit verdict as `out-of-scope (Guardrail 2)`, never materialized.

Record the audit verdict in the `DECOMPOSITION.md` body §8 (Step 9): one of
`COVERED` (every declared surface maps to a task), the list of auto-emitted gap
tasks (each with its `(rider)` marker + trigger edge), any `DRIFT(...)` flags,
or `skipped (no --spec)`.

## Step 9 — Emit `DECOMPOSITION.md`

Write the artifact to
`.planning/decompositions/<UTC-timestamp>-<project_id>.md` (timestamp
format `YYYY-MM-DDTHH-MM-SSZ`, same convention as `docs/loop-run-schema.md`
§2). Create `.planning/decompositions/` if absent. The file is
**gitignored** — `.planning/` is in the repo's `.gitignore`, same rationale
as `LOOP-RUN.md`. **Do NOT `git add` it**, and do NOT modify `.gitignore`
to make it an exception. This `Write` (plus the recon cache write in §2) is
the only filesystem mutation the skill performs.

**Frontmatter (YAML)** — mirror `DecompositionFrontmatterSchema` in
`src/lib/decompose/schema.ts` field-for-field: `decomposition_id`,
`project_id`, `generated_at`, `goal`, `success_criteria`, `domain`,
`topology`, `advisory`, `candidate_count`, `dependency_edge_count`,
`total_usd`, `cost_cap_hit`, and the optional `aborted_reason` (set only on
the `cycle` / `high_interdependence` / `blast_radius_keyword` halt paths).

**Body sections (in order — design §6):**

1. `## Goal` — verbatim user input.
2. `## Recon Summary` — the Step 2 output.
3. `## Coverage Matrix` — rows = success criteria, columns = candidate
   titles; cell ✓ when covered.
4. `## Topology Verdict` — `topology_check` output + advisory rationale
   (+ `topology_check_fallback: true` if the §5 fallback fired; + the wave
   grouping table for `DAG`).
5. `## Candidates` — one block per candidate: `draft_id`, `task_id` (or
   `(dry-run)`), `title`, `description`, `acceptance_criteria`, rationale
   linking back to the success criteria it covers.
6. `## Dependency Edges` — table of (from_task_id, to_task_id, reason).
7. `## Cost Breakdown` — orchestrator + per-subagent cost rows + TOTAL.
8. `## Spec-Coverage Audit` — the Step 8d verdict. Present only when
   `--spec` was supplied: the spec surfaces checked (components,
   acceptance-criteria, file references), the auto-emitted gap tasks (each
   with its `(rider)` marker + trigger edge), and any `DRIFT(...)` flags.
   Records `skipped (no --spec)` when the flag was absent.

Set `generated_at`-paired end time immediately before the final write.

## Cost budget (Guardrail-adjacent — LIVE rule)

Track running cost across the orchestrator + every subagent dispatch
(cache-discounted USD, same formula as `LOOP-RUN.md` §4.4). After each
subagent returns, read its `usage` block and increment an in-memory
counter — that counter is the source of truth for both thresholds. **If a
subagent returns no `usage` block** (some agent types omit it), estimate its
cost from its tool-call count and output size, add the estimate to the
counter, and mark the artifact's `total_usd` approximate (prefix `~`) so a
reader knows the cap was enforced against an estimate.

Amounts below are written without a leading `$`-then-digit on purpose: a
bare `$` immediately followed by a digit in a skill body is captured by
argument substitution at load time (read as a positional arg) and renders
corrupted — write the USD figure instead.

- **5 USD soft target** — when running cost crosses **5 USD**, emit a
  checkpoint to stdout and record `checkpoint_5usd_at_step: <step>` (optional
  frontmatter field). The run **continues**.
- **15 USD hard cap** — when running cost crosses **15 USD**, **HALT
  immediately**. Preserve all work completed up to that step (materialized
  tasks stay; do NOT roll back), write a partial `DECOMPOSITION.md` with
  `cost_cap_hit: true`, and report the halt to the user. The user re-runs
  with `--resume <decomposition_id>` (idempotent on `decomposition_id`) to
  continue from the last completed step.

## Guardrails (LIVE rules — do NOT remove)

Each guardrail is enforced by a falsifiable test gate in
[`src/api/routes/tasks/__tests__/skill-decompose-design.test.ts`](../../src/api/routes/tasks/__tests__/skill-decompose-design.test.ts)
and the sibling fixtures test. Do not weaken those tests without
simultaneously updating `docs/tasks-decompose-design.md` §5.

1. **MUST NOT execute the decomposed tasks** (plan/execute separation). The
   skill does NOT call `claim_task`, `update_task` status transitions, or
   dispatch worker subagents that mutate the source tree beyond the Step-2
   read-only recon. Materialization (`create_task` / `add_dependency`) is
   creation only — never execution. `/tasks:loop` and `/tasks:loop-dag` are
   the executor halves; keep them separate.
2. **MUST NOT modify itself** (no self-rewrite). Refuse any `Edit` /
   `Write` / `MultiEdit` against `skills/tasks/decompose.md`,
   `docs/tasks-decompose-design.md`, and `src/lib/decompose/**`. A
   self-modifying skill cannot be audited statically — the moment the skill
   file is mutable from inside the run, guardrails 1, 3, and 4 stop being
   load-bearing.
3. **MUST halt + ask the user if Step 4 rejects ≥ 30% of candidate pairs**
   as inter-dependent (`interdependent_ratio ≥ 0.30`). Write
   `aborted_reason: high_interdependence` and stop before Step 5.
4. **MUST refuse goals containing `deploy`, `migrate production`, or
   `delete data`** (whole-word, case-insensitive `\b(...)\b`). The refusal
   fires in Step 1 input validation, **before any subagent dispatch**.

## Links

- Design spec (source of truth): [`docs/tasks-decompose-design.md`](../../docs/tasks-decompose-design.md)
- Schema (zod): [`src/lib/decompose/schema.ts`](../../src/lib/decompose/schema.ts)
- WSJF classification contract (Step 8a scoring): [`skills/tasks/wsjf-rubric.md`](./wsjf-rubric.md)
- Schema tests: [`src/lib/decompose/__tests__/schema.test.ts`](../../src/lib/decompose/__tests__/schema.test.ts)
- Design-doc / skill tests: [`src/api/routes/tasks/__tests__/skill-decompose-design.test.ts`](../../src/api/routes/tasks/__tests__/skill-decompose-design.test.ts)
- Companion executor (FLAT advisory): [`skills/tasks/loop.md`](./loop.md)
- Companion executor (DAG advisory): [`skills/tasks/loop-dag.md`](./loop-dag.md)
