Owner: Repository maintainers

# /tasks:decompose Design Spec

> **Companion artifacts:**
> a zod schema mirror at `src/lib/decompose/schema.ts` (shipped — backs the
> live pipeline) and a reference example at
> `docs/decomposition-reference-example.md`. This document is the
> design-of-record landed by wood-fired-tasks task **#320**; the runtime that
> implements it shipped subsequently (see Status below).

## Status

Wave 5 DESIGN landed by wood-fired-tasks task **#320** (2026-05-23). The
runtime is now **OPERATIONAL**: the skill file at
[`skills/tasks/decompose.md`](../skills/tasks/decompose.md) is the executable
implementation of this design — it runs the full 9-step pipeline (§4): goal
capture → codebase recon (one Explore agent) → candidate generation
(planner) → independence check (critic) → topology decision (`topology_check`)
→ coverage check (critic) → sizing → materialize (`create_task` +
`add_dependency`) → emit `DECOMPOSITION.md`. It PLANS only and never executes
the tasks it materializes (Guardrail 1), and it is bounded by the $5 soft
target / $15 hard cap (Cost budget). Where the skill and this doc could
drift, the design doc wins.

The companion zod schema at
[`src/lib/decompose/schema.ts`](../src/lib/decompose/schema.ts) ships
alongside the skill and backs the live pipeline (`CandidateTaskSchema`,
`DecompositionFrontmatterSchema`); its constraints are locked by
`src/lib/decompose/__tests__/schema.test.ts`. `/tasks:decompose` is wired
into onboarding (AGENTS.md lists it as OPERATIONAL).

Still outstanding from the original follow-on list (§11): the four
verification fixtures sketched in §9 remain design sketches (see the
"Verification fixtures" section below).

## Why this exists

The Wave 4 readiness audit found a structural gap between the two
autonomous orchestrators shipped to date:

- **`/tasks:loop-dag`** (Wave 4.3 / #341) drains a wood-fired-tasks
  project whose topology is `DAG` by computing the dependency frontier
  wave-by-wave and dispatching workers in parallel within each wave. It
  assumes the project is *already* populated with dependency-edged tasks
  — it does not decompose a goal.
- **`/tasks:loop`** assumes the wood-fired-tasks project is *already*
  populated with bug-sized tasks. The Wave 4.2 topology pre-flight gate
  (#319) routes `DAG` projects to `/tasks:loop-dag`; `/tasks:loop` itself
  is the `FLAT`-topology executor.

There is no equivalent of `plan-phase` for the bugs-db side. A user with
a project-level goal ("ship OIDC SSO", "audit accessibility on the chat
surface") today has to hand-author 8–25 wood-fired-tasks tasks before any
orchestrator can drain them. That hand-authoring is the load-bearing
step `/tasks:decompose` will own.

The skill is intentionally a **planner, not an executor**. Separation of
plan-and-execute is the central guardrail (§5) — `/tasks:decompose`
designs the work, then hands off to `/tasks:loop` (FLAT) or
`/tasks:loop-dag` (DAG) for execution; it never runs the tasks it
materialised.

## Contract

```yaml
name: decompose
namespace: tasks
triggers:
  - "decompose project"
  - "break down this goal"
  - "/tasks:decompose"
required-args:
  --project <id>          # wood-fired-tasks project id (positive integer)
  --goal "..."            # one sentence, ≤ 200 words
optional-args:
  --success "..."         # repeatable bullet; 3–5 total required by §1
  --domain <enum>         # frontend | backend | docs | infra | mixed
  --dry-run               # run §1–§7, emit DECOMPOSITION.md, skip §8 materialize
outputs:
  - N candidate tasks created in wood-fired-tasks via create_task
  - K dependency edges added via add_dependency
  - DECOMPOSITION.md emitted to .planning/decompositions/<UTC>-<project_id>.md
    (NOT committed — .planning/ is gitignored, same rationale as LOOP-RUN.md)
cost-budget:
  target: $5            # soft target; emit a checkpoint at $5
  hard-cap: $15         # orchestrator halts and asks for confirmation
side-effects:
  - bugs-db writes: create_task, add_dependency (idempotent re-runs use
    DECOMPOSITION.md's decomposition_id as a dedup key)
  - filesystem writes: .planning/decompositions/<file>.md only
read-only:
  - source tree (recon)
  - bugs-db (list_projects, list_tasks, topology_check)
```

## Methodology (9 steps)

The pipeline runs strictly in order. Each step is bounded and each step
hands a *summary* (not raw output) to the next, so the orchestrator's
context stays small across the run.

### Step 1 — Goal capture

Accept the goal via CLI flags or interactive prompt. Validate:

- `--goal` is non-empty and ≤ 200 words (~ ≤ 1500 chars).
- `--success` provided 3–5 times (or interactive prompt collects 3–5).
- `--domain` matches the enum (defaults to `mixed` if omitted).
- Refuse the goal if it contains any blast-radius keyword (§5,
  guardrail 4): `deploy`, `migrate production`, `delete data`.

### Step 2 — Codebase recon

Dispatch a single **Explore-agent** subagent with bounds
`≤ 50 tool calls` and `≤ 8 minutes wall time`. The Explore agent reads
the repository's `AGENTS.md` / `CLAUDE.md` / `docs/REPO_MAP.md` first to
find the entry points, then walks only the subtree relevant to the goal
+ domain. Output: a structured recon summary (≤ 2 KB markdown) cached
under `.planning/decompositions/.cache/<decomposition_id>-recon.md` so
the next step does NOT re-read source files.

### Step 3 — Candidate task generation

Dispatch a **planner** subagent with the goal + success criteria + recon
summary. It emits **8–25 candidate drafts**, each with `title`,
`description` (2–3 sentences), `acceptance_criteria` (≥ 1 bullet), and
`suspected_edges` (any inter-draft dependency the planner notices while
authoring). Schema: `CandidateTaskSchema` in
`src/lib/decompose/schema.ts`. Under 8 candidates ⇒ goal is too small;
ask the user whether to file a single task instead. Over 25 ⇒ goal is
too broad; ask whether to split first.

### Step 4 — Independence check

Dispatch a **critic** subagent that does pairwise comparison of the
candidates: "can these be parallelized?". For each pair the critic
returns `INDEPENDENT` | `ORDERED(a→b)` | `MUTUALLY_EXCLUSIVE`. The
orchestrator aggregates the verdicts into a dependency edge set.
**Guardrail 3 (§5) fires here:** if ≥ 30% of candidate pairs come back
as `ORDERED` or `MUTUALLY_EXCLUSIVE`, the orchestrator halts and asks
the user whether the goal needs re-scoping before proceeding.

### Step 5 — Topology decision

Apply the Wave 4.1 classifier — the existing `topology_check` MCP tool
shipped by **task #318** — to the edge set from Step 4. Outcomes map
directly to advisories:

| Topology     | Advisory                                              |
|--------------|-------------------------------------------------------|
| `FLAT`       | `/tasks:loop` (no edges; drain in parallel)           |
| `DAG`        | `/tasks:loop-dag` + suggested wave grouping (Wave 4.3 / #341) |
| `DAG_CYCLIC` | **HALT** — emit a cycle report; do NOT materialize    |

For `DAG`, the orchestrator additionally groups candidates into 1–4
waves by computing connected components + a simple longest-path
heuristic. The grouping is *advisory only* — the user reviews
`DECOMPOSITION.md` before running `/tasks:loop-dag`.

### Step 6 — Coverage check

Dispatch a second **critic** subagent with (success_criteria, candidate
acceptance_criteria union). It returns one of:

- `COMPLETE` — every success criterion has at least one acceptance
  criterion that covers it.
- `GAPS([criterion, …])` — add candidate tasks to cover the missing
  criteria, then re-run Step 4 (independence) on the additions.
- `DUPLICATES([(id_a, id_b), …])` — merge the listed candidate pairs and
  re-run Step 4 on the survivors.

Bounded re-entry: at most **2** Step 4 re-runs. After 2, halt and ask
the user.

### Step 7 — Sizing check

Each candidate's `estimated_minutes` MUST be ≤ 90 (enforced by
`CandidateTaskSchema`; rejection halts the orchestrator). Candidates
over 90 minutes are split into ≤ 90-minute sub-candidates. Splits
create new dependency edges (split children → split parent stub);
re-run Step 4 once on the splits.

### Step 8 — Materialize

Create the surviving candidates in wood-fired-tasks via `create_task`,
then add the dependency edges via `add_dependency`. Materialization is
idempotent on `decomposition_id` — re-running the same decomposition
(same goal + same project + same `decomposition_id`) MUST NOT duplicate
tasks. The orchestrator records (`draft_id` → `task_id`) mapping in the
DECOMPOSITION.md body.

### Step 9 — Emit `DECOMPOSITION.md`

Write the artifact to
`.planning/decompositions/<UTC-timestamp>-<project_id>.md` (timestamp
format `YYYY-MM-DDTHH-MM-SSZ`, same convention as
`docs/loop-run-schema.md` §2). The file is **gitignored** for the same
reason `LOOP-RUN.md` is — runtime artifacts stay per-machine. The
artifact MUST contain: frontmatter (§6), goal, recon summary, coverage
matrix, topology verdict, advisory, candidate list with rationale +
materialized task ids, dependency edge list, and a cost breakdown.

### Subagents dispatched

| Step | Agent type    | Bounds                              | Output shape                              |
|------|---------------|-------------------------------------|-------------------------------------------|
| 2    | Explore-agent | ≤ 50 tool calls / ≤ 8 minutes       | recon summary markdown (≤ 2 KB)           |
| 3    | planner       | ≤ 30 tool calls / ≤ 6 minutes       | 8–25 `CandidateTaskSchema` JSON objects   |
| 4    | critic        | ≤ pairs(N) calls / ≤ 4 minutes      | edge set: `{from, to, verdict}`           |
| 6    | critic        | ≤ 20 tool calls / ≤ 3 minutes       | `COMPLETE` \| `GAPS` \| `DUPLICATES`      |

## Guardrails

### Guardrail 1 — separation of plan / execute

The skill **MUST NOT execute the decomposed tasks** — separation of
plan and execute is the central design property.

- **Why.** Mixing planning + execution in one orchestrator concentrates
  blast radius and makes failure attribution impossible (a bad plan
  looks indistinguishable from a bad execution). `/tasks:decompose` is
  the planner half; `/tasks:loop` and `/tasks:loop-dag` are the
  executor halves — keep them separate.
- **Enforcement mechanism.** The skill's documented tool surface is
  `list_projects`, `list_tasks`, `topology_check`, `create_task`, and
  `add_dependency`. It does **not** call `claim_task`, `update_task`
  (status transitions), or dispatch worker subagents that touch the
  source tree beyond the read-only recon in Step 2. The verification
  fixtures in §9 include a "skill never calls claim_task" gate.

### Guardrail 2 — no self-rewrite

The skill **MUST NOT modify itself** (cf. Claude Code session
`45bf9e75` self-rewrite incident — a previous skill rewrote its own
markdown mid-run and changed its own contract).

- **Why.** A self-modifying skill cannot be audited statically;
  guardrails 1, 3, and 4 become non-load-bearing the moment the skill
  file itself is mutable from inside the run.
- **Enforcement mechanism.** The skill's runtime checklist includes an
  explicit "Refuse Edit/Write against `skills/tasks/decompose.md`,
  `docs/tasks-decompose-design.md`, and `src/lib/decompose/**`" rule.
  Static test gate: §9 fixture **"design-doc edit refusal"** asserts a
  test-mode invocation that attempts such an edit returns a refusal
  and an exit code ≠ 0.

### Guardrail 3 — halt on high interdependence

The skill **MUST halt + ask the user if the independence check rejects
≥ 30 percent of candidate pairs as inter-dependent** (i.e. Step 4
returns `ORDERED` or `MUTUALLY_EXCLUSIVE` for ≥ 30% of pairs).

- **Why.** ≥ 30% interdependence is the empirical threshold above which
  the planner output is no longer a sensible decomposition — the goal
  is either a single epic, a roadmap, or a multi-phase migration that
  needs human-authored phase structure before the orchestrator can
  safely materialise it as a bugs-db backlog.
- **Enforcement mechanism.** Step 4 computes
  `interdependent_ratio = (ordered + mutually_exclusive) / total_pairs`.
  The orchestrator halts and asks the user when the ratio crosses 0.30.
  Static gate: §9 fixture **"OIDC SSO DAG"** drives this branch.

### Guardrail 4 — blast-radius keyword refusal

The skill **MUST refuse goals containing the words "deploy",
"migrate production", or "delete data"** (case-insensitive). Goals
that include those phrases need a human-authored plan with explicit
rollback steps, not an auto-decomposition.

- **Why.** Those three phrases (deploy / migrate production /
  delete data) name irreversible operations whose blast radius is
  measured in customer impact, not in test failures. An auto-generated
  decomposition that hides one of those operations inside a candidate
  task is exactly the wrong kind of automation.
- **Enforcement mechanism.** Step 1 input validation. The check is
  whole-word and case-insensitive: `\b(deploy|migrate production|delete data)\b`.
  Static gate: §9 fixture **"blast-radius refusal"** asserts each of
  the three phrases returns a refusal *before* any subagent dispatch.

## DECOMPOSITION.md artifact schema

Lives at `.planning/decompositions/<UTC-timestamp>-<project_id>.md`.
The path is **not committed** — `.planning/` is in the repo's
`.gitignore` (same rationale that keeps `.planning/loops/*.md` out of
git per `docs/loop-run-schema.md` §2). Frontmatter is YAML, mirrored
by `DecompositionFrontmatterSchema` in `src/lib/decompose/schema.ts`:

| Field                    | Type        | Notes                                                                   |
|--------------------------|-------------|-------------------------------------------------------------------------|
| `decomposition_id`       | UUIDv4      | Stable across re-runs; dedup key for §8 materialization.                |
| `project_id`             | int ≥ 1     | wood-fired-tasks project id.                                             |
| `generated_at`           | RFC 3339    | UTC start time.                                                         |
| `goal`                   | string      | Non-empty, ≤ ~1500 chars (200-word cap).                                |
| `success_criteria`       | string[]    | 3–5 entries.                                                            |
| `domain`                 | enum        | `frontend` \| `backend` \| `docs` \| `infra` \| `mixed`.                |
| `topology`               | enum        | `FLAT` \| `DAG` \| `DAG_CYCLIC` (from §5 / `topology_check`).           |
| `advisory`               | enum        | `/tasks:loop` \| `/tasks:loop-dag` \| `BLOCKED`.                        |
| `candidate_count`        | int ≥ 0     | Count of materialized candidates.                                       |
| `dependency_edge_count`  | int ≥ 0     | Count of edges added via `add_dependency`.                              |
| `total_usd`              | number ≥ 0  | Cost across orchestrator + every subagent (cache-discounted).           |
| `cost_cap_hit`           | bool        | `true` iff the $15 hard cap halted the run.                             |
| `aborted_reason`         | enum?       | `cycle` \| `high_interdependence` \| `blast_radius_keyword` \| absent.  |

Body sections (in order):

1. `## Goal` — verbatim user input.
2. `## Recon Summary` — output of Step 2.
3. `## Coverage Matrix` — rows = success criteria, columns = candidate
   task titles; cell ✓ when covered.
4. `## Topology Verdict` — classifier output + advisory rationale.
5. `## Candidates` — one block per candidate: `draft_id`, `task_id`,
   `title`, `description`, `acceptance_criteria`, rationale linking
   back to the success criteria it covers.
6. `## Dependency Edges` — table of (from_task_id, to_task_id, reason).
7. `## Cost Breakdown` — orchestrator + per-subagent cost rows.

## Acceptance criteria for each candidate task

A candidate is well-formed iff:

- `title` is a single line, ≤ 255 chars, imperative voice.
- `description` is 2–3 sentences, ≤ ~1000 chars, describing scope +
  intended approach (NOT a step-by-step execution plan — that's the
  worker's job).
- `acceptance_criteria` has ≥ 1 bullet; each bullet is independently
  verifiable (a test name, a build flag, a file-existence assertion, a
  log line, etc.).
- `suspected_edges` lists any `(from_draft_id, to_draft_id)` pair the
  planner noticed while authoring — these are *hints* for Step 4, not
  authoritative.
- `estimated_minutes` is an integer in `[1, 90]` (Step 7 sizing cap).

The schema for the above lives at `src/lib/decompose/schema.ts` as
`CandidateTaskSchema` — the same module that exports
`DecompositionFrontmatterSchema`. Tests in
`src/lib/decompose/__tests__/schema.test.ts` lock in the constraints.

## Topology-driven advisory

Reuses the existing `topology_check` MCP tool (Wave 4.1, **task #318**)
— no new tool added by this skill.

- `FLAT` (no dependency edges) ⇒ advisory `/tasks:loop`. The materialized
  tasks have no ordering, so the loop's `--max-tasks N` budget can drain
  them in any order. DECOMPOSITION.md records `advisory: /tasks:loop`.
- `DAG` (acyclic with edges) ⇒ advisory `/tasks:loop-dag` (Wave 4.3 /
  #341) + a wave grouping suggestion (1–4 waves derived from connected
  components + longest-path heuristic). Grouping is rendered as a table
  in §4 of the artifact body. DECOMPOSITION.md records
  `advisory: /tasks:loop-dag`.
- `DAG_CYCLIC` ⇒ **HALT**. No materialization. The skill emits a
  partial DECOMPOSITION.md with `advisory: BLOCKED`,
  `aborted_reason: cycle`, and a cycle report listing the offending
  `draft_id` chain. The user must break the cycle (re-scope a candidate)
  before re-running.

## Verification fixtures (deferred)

These four fixtures are *design sketches*. They will be authored when
the runtime lands (see §11). Listing them here so the implementation
follow-on cannot ship without them.

1. **Project 12 replay** — feed `/tasks:decompose` the same goal that
   produced project 12's current backlog and assert the candidate
   count + dependency edge count land within ±20% of the human-authored
   baseline. Validates the planner is not pathologically over- or
   under-decomposing.
2. **OIDC SSO DAG** — supply a synthetic OIDC SSO goal that the
   planner is known to decompose into a DAG (auth flow → token storage →
   session middleware → logout). Assert `topology=DAG`,
   `advisory=/tasks:loop-dag`, and that the suggested wave grouping
   has ≥ 2 waves. Exercises Guardrail 3 at sub-30% interdependence.
3. **Cyclic halt** — supply a goal whose planner output deliberately
   creates a cycle (e.g. "refactor user model to depend on auth which
   depends on user model"). Assert the run halts with
   `advisory: BLOCKED`, `aborted_reason: cycle`, and **no** tasks were
   created in bugs-db (idempotency: re-running yields the same partial
   artifact, never duplicates).
4. **Cost guardrail** — supply a goal large enough to push past $5
   target. Assert (a) a checkpoint is emitted at $5; (b) the
   orchestrator halts at $15 with `cost_cap_hit: true`; (c) any
   already-materialized tasks remain in bugs-db (no rollback) and the
   partial DECOMPOSITION.md is still written.

A **blast-radius refusal** fixture (one per keyword: `deploy`,
`migrate production`, `delete data`) belongs to the same suite — three
small parametric tests asserting the refusal path returns before any
subagent dispatch.

## Cost budget

- **Soft target: $5 per decomposition.** When the running cost (sum of
  orchestrator + every subagent's cache-discounted USD) crosses $5, the
  orchestrator emits a checkpoint to stdout *and* records
  `checkpoint_5usd_at_step: <step>` in DECOMPOSITION.md frontmatter
  (optional field). The run continues.
- **Hard cap: $15 per decomposition.** When the running cost crosses
  $15, the orchestrator halts immediately. Any work completed up to
  that step IS preserved (materialized tasks stay, partial
  DECOMPOSITION.md is written with `cost_cap_hit: true`). The user
  re-runs with `--resume <decomposition_id>` to continue from the last
  completed step (idempotent on `decomposition_id`).
- **How the orchestrator tracks cost.** After every subagent dispatch
  returns, the orchestrator reads the returned `usage` block from
  Claude Code, applies the cache-discounted USD calculation from the
  `agent_transactions_v` view (same formula as `LOOP-RUN.md` §4.4),
  and increments an in-memory counter. The counter is the source of
  truth for the $5 and $15 thresholds.

## Follow-on tasks

To be created in wood-fired-tasks project 15 *after* this design lands:

- **Implement /tasks:decompose runtime** — ✅ DONE. The full pipeline now
  lives in `skills/tasks/decompose.md`: Step 2 (Explore-agent), Step 3
  (planner), Step 4 + Step 6 (critic), and the cost tracker are all wired.
- **Author verification fixtures** — write the four fixtures sketched
  in §9 (Project 12 replay, OIDC SSO DAG, cyclic halt, cost guardrail)
  plus the three blast-radius refusal parametric tests.
- **Integrate into onboarding** — add a `/tasks:decompose` entry to
  `AGENTS.md`, a section in `docs/NAVIGATION.md` under "if you want to
  break down a project goal", and a one-paragraph quickstart in
  `README.md` next to the `/tasks:loop` example.
- **Phase-grouping algorithm RFC** — the longest-path heuristic for
  DAG grouping in Step 5 is a placeholder; a separate task should
  benchmark alternatives against the Project 12 replay fixture and
  pick a default.
- **Resume-from-checkpoint** — implement the `--resume <decomposition_id>`
  flag mentioned in §10 once the hard-cap behaviour has been
  observed in real runs.

---

This design intentionally leaves the runtime to the follow-on tasks.
The artifacts that DO land in this commit (this doc, the schema, the
skill stub, the schema + design-doc tests) are the falsifiable contract
the runtime will be implemented against.
