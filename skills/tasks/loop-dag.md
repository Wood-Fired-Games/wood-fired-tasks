---
name: loop-dag
description: Wave-by-wave parallel executor for DAG-topology wood-fired-bugs projects. Computes the dependency frontier (open tasks whose blocked_by edges are all satisfied), dispatches a worker subagent per frontier task in parallel under a concurrency cap, runs the mandatory tasks-verifier per worker, recomputes the frontier wave-by-wave until the backlog drains, runs INTEGRATION-AUDIT per wave on file overlaps, and emits LOOP-RUN.md with an extended wave_summary section. Refuses FLAT (use /tasks:loop) and DAG_CYCLIC (cycles must be broken first). Sibling executor to /tasks:loop; differs by exploiting parallelism across independent frontier tasks instead of running a single topological order sequentially.
argument-hint: [project-name] [--max-waves N] [--concurrency K]
disable-model-invocation: false
---

# Task Loop-DAG Workflow (Wave 4.3 / task #341)

You are the **orchestrator** of an autonomous backlog-drain for a **DAG-topology** project. The wood-fired-bugs project you target has dependency edges; tasks must run in an order that respects them, but tasks on the same frontier (no unsatisfied dependencies) MAY run in parallel.

This skill is the **DAG-shaped sibling** of [`skills/tasks/loop.md`](./loop.md). The two skills share most of the contract — pre-loop discovery, worker briefs, the mandatory `tasks-verifier` dispatch, the LOOP-RUN.md artifact, and the integration-auditor — and this file deliberately points at `loop.md` for the shared sections rather than duplicating them. What this skill adds is **wave-by-wave parallel dispatch** instead of single-task sequential ordering.

> **Mental model.** Think of yourself as a foreman scheduling a build crew across independent foundations on the same site. Each foundation (wave) is a set of tasks that have no remaining dependencies. While the wave's workers are pouring concrete in parallel, you (the orchestrator) plan the next wave. You never let a worker start before its supporting foundation has cured — that's what `blocked_by` enforces.

---

## 1. Argument Parsing

Parse `$ARGUMENTS` — or, when invoked via natural language ("drain DAG project X", "run the dependency graph for project Y"), extract the equivalent fields from the request:

- `[project-name-or-id]` — if the value starts with `#` or is a bare integer, treat it as the project ID and skip the name match. Otherwise, do a case-insensitive partial match against project names. Resolution rules are identical to `loop.md` §1 → Resolve Project ID; reuse them.
- `--max-waves N` — optional. Stop the loop after N completed waves and check in with the user before continuing. Default is **3**. Pass `--max-waves 0` to drain the entire DAG unattended (only if the user explicitly asks). A wave is "completed" when every worker dispatched in that wave returned AND the wave's verifier rollup landed.
- `--concurrency K` — optional. Maximum number of worker subagents to run in parallel within a single wave. Default is **4**. Tune down to **1** for diagnostic single-step runs (useful when reproducing a wave-specific failure); tune up only when the project's tasks are known to be cheap and well-isolated. Hard ceiling **8** to keep orchestrator-side accounting tractable.

**If no project name/ID is provided:** ask the user. Do not pick one silently.

### Resolve Project ID

Reuse `loop.md` §1 Resolve Project ID verbatim. Same `wood-fired-bugs:list_projects` call, same match precedence (ID first, then case-insensitive partial name match), same "list available projects and stop" fallback when nothing matches.

---

## 2. Pre-Loop Discovery (run ONCE, before any wave is dispatched)

Reuse `loop.md` §2a–§2e verbatim — these sub-steps are about understanding the repo, validation commands, baseline tests, cross-repo scope detection, and epic-vs-bug sizing. None of them are flat-vs-DAG specific. The only sub-step this skill replaces is `loop.md` §2f (topology pre-flight gate), redefined below for the DAG-only contract.

### 2f. Topology pre-flight gate (DAG-only contract)

Before computing the first frontier and BEFORE dispatching any worker, the orchestrator MUST call the `topology_check` MCP tool with `{project_id}` and branch on the returned `topology` field. Unlike `/tasks:loop` (which auto-orders DAGs via Kahn's algorithm and runs them sequentially), `/tasks:loop-dag` REFUSES non-DAG topologies — they have a different correct executor.

Record the branch outcome in orchestrator state as `gate_decision` for inclusion in the LOOP-RUN.md frontmatter (§5). Log the gate decision in the orchestrator's first prompt so a transcript reader sees what was decided and why.

**Branches:**

- **`topology: "FLAT"`** → set `gate_decision = "blocked"` and HALT immediately. Do NOT compute a frontier, do NOT dispatch any worker. Emit this message verbatim, substituting the real project id:

    ```
    Project <id> has zero dependency edges (topology=FLAT). /tasks:loop-dag is the wrong executor for this project — use /tasks:loop instead. /tasks:loop-dag exists specifically to exploit parallelism across independent frontier tasks in a DAG; with no edges there is no frontier structure to exploit, and dispatching a flat backlog in waves of one would be strictly worse than /tasks:loop's plain priority + ID ordering.
    ```

- **`topology: "DAG"`** → set `gate_decision = "allowed"`. Proceed to §3 The Wave Loop. The frontier algorithm in §3a consumes `topology_check.edges` directly. No `--i-know-what-im-doing` override exists for this skill — there is no degenerate fallback that makes sense (running the DAG flat would silently violate the dependency contract, which is the entire reason this skill exists).

- **`topology: "DAG_CYCLIC"`** → set `gate_decision = "blocked"` unconditionally. HALT the loop immediately. Do NOT compute a frontier, do NOT dispatch any worker. Cycles in the dependency graph mean there is no frontier any runner could ever drain — every cycle member is permanently blocked by another cycle member. Emit this message verbatim, substituting the real project id and citing the cycle members from `topology_check`:

    ```
    Project <id> has a dependency cycle (DAG_CYCLIC). Cannot loop — cycles must be broken before any runner can proceed. Cycle members (from topology_check): <list of task ids>. No override flag applies; the cycle must be resolved (split a task, drop an edge, or close the offending tasks) before /tasks:loop-dag will accept this project.
    ```

**Blocked-branch behaviour:** when `gate_decision = "blocked"` (FLAT or DAG_CYCLIC), the orchestrator does NOT enter §3 The Wave Loop, does NOT claim any task, and does NOT dispatch a worker. §5 (LOOP-RUN.md emit) is still permitted — emit a single LOOP-RUN.md with `gate_decision: blocked`, `tasks_attempted: 0`, and an empty `wave_summary` section (sentinel paragraph below) so the refused run is auditable. §4 (per-wave integration audit) is skipped (no worker sessions means no overlaps to audit).

---

## 3. The Wave Loop

The orchestrator drains the DAG by alternating two phases: **compute the frontier**, then **dispatch the wave**. Continue until the open-task set is empty or `--max-waves N` is hit.

Each wave goes through **six sub-steps**: 3a (compute frontier), 3b (claim + dispatch in parallel), 3c (await wave completion), 3d (verify each worker via `tasks-verifier`), 3e (record wave summary), 3f (per-wave integration audit per §4). Do not skip ahead. The wave is a unit: every worker in the wave runs to completion (or its bounded error path) before §4 grades the wave and §3a recomputes the next frontier.

### Step 3a — Compute the frontier

```
wood-fired-bugs:list_tasks with project_id=<id>, status=open
```

The **frontier** is the set of open tasks whose `blocked_by` edges are ALL closed (`status` in {`done`, `closed`}) OR satisfied (the blocking task is missing from the project — defensive treatment of orphaned edges, mirroring `TopologyService`'s same-project edge filter).

Algorithm:

1. Fetch all open tasks for the project via `wood-fired-bugs:list_tasks` with `status=open` and `limit=200`.
2. For each open task, call `wood-fired-bugs:get_dependencies` to read its `blocked_by` set. Cache the result per task ID for the duration of this loop run (the dependency graph is stable; re-fetching per wave wastes round-trips).
3. A task is **on the frontier** iff every `blocked_by` task id either (a) has `status` in {`done`, `closed`}, (b) is missing from the project (cross-project or dangling edge — drop defensively, matching `src/services/topology.service.ts`'s same-project filter), or (c) has been already-closed by a prior wave in THIS loop run (track this in orchestrator state — a task closed in wave N is satisfied for wave N+1's frontier calculation even if the bugs-DB write hasn't been re-read).
4. **Skip tasks already claimed by someone else.** If a task is on the frontier but its `claimed_at` is non-null and the assignee is not this orchestrator's agent name, drop it from this wave's dispatch set and re-evaluate it on the next frontier recomputation (it may still be claimed; that's fine — eventually it closes or is released).
5. **Skip tasks the orchestrator already dispatched in a prior wave of THIS run.** A worker that returned FAIL → blocked stays blocked; do NOT silently re-attempt within the same loop run. Track these in orchestrator state by task id.
6. Sort the resulting frontier by **priority DESC** (`urgent` > `high` > `medium` > `low`), then **`created_at` ASC** (older first), then **`id` ASC**. The first `--concurrency K` tasks of the sorted frontier are the wave's dispatch set.
7. If the resulting frontier is empty, do one final check: are there any open tasks left at all? If YES, those tasks are all transitively blocked by something that either failed (verdict=FAIL → blocked) or was never closed — emit a `## Stalled Tasks` block in the final LOOP-RUN.md naming them and exit. If NO, the backlog is drained — announce completion, run §4 (integration audit) ONCE, then exit.

**Frontier correctness invariant (fixture-graded):** for the canonical fixture `edges = {334→337, 335→337, 337→338, 337→339}` on an open-task set `{334, 335, 337, 338, 339}`, the frontier algorithm MUST produce the waves `{334, 335}` (wave 1) / `{337}` (wave 2) / `{338, 339}` (wave 3). This is the load-bearing correctness contract for §3a — any change to the algorithm MUST preserve this fixture's wave shape. Tested by `src/api/routes/tasks/__tests__/loop-dag-skill-design.test.ts`.

### Step 3b — Claim and dispatch in parallel

For each task in the wave's dispatch set (up to `--concurrency K`):

1. Claim the task: `wood-fired-bugs:claim_task with task_id=<id>, assignee=<your agent name>`. If the claim fails (another runner won the race), drop the task from this wave's dispatch set and re-evaluate on the next frontier recomputation.
2. Read context: `wood-fired-bugs:get_task with id=<id>`, `wood-fired-bugs:get_comments with task_id=<id>`. Extract acceptance criteria, linked docs, constraints — exactly as `loop.md` §Step 2 (Claim and read) describes.
3. Plan validation depth and pre-scan scope — exactly as `loop.md` §Step 3 (Plan the validation depth and pre-scan scope) describes. The pre-scan happens in the orchestrator, BEFORE dispatching the worker.
4. Dispatch the worker subagent. **The dispatch contract is identical to `loop.md` §Step 4 — Dispatch a subagent**: same brief template, same `Agent` tool, same `subagent_type` selection table, same "Do NOT commit" trailer. Re-read `loop.md` §Step 4 for the full brief shape rather than duplicating it here.

**Parallel dispatch shape.** When `--concurrency K >= 2` and the wave has ≥ 2 tasks, the orchestrator MUST issue the `Agent` tool calls for the wave in a **single message** so they execute concurrently — per the platform's parallel-tool-call semantics. Each `Agent` call gets its own `name: "worker-task-<id>"` so it is independently addressable via `SendMessage` later (mirrors `loop.md` §7b's `name:` requirement for verifiers — the same reasoning applies to workers, since the orchestrator may need to send a tight diagnostic back to a single worker without disturbing the others mid-wave).

Sequential dispatch (one Agent call, await, next Agent call) is permitted only when `--concurrency 1` is explicitly set — it is the strictly slower path and exists for diagnostic single-step runs.

### Step 3c — Await wave completion

The orchestrator waits for ALL worker subagents dispatched in this wave to return their final messages before proceeding to §3d. **No verifier dispatch happens until every worker in the wave has returned** — the verifier round-trip is per-task but the wave's grading phase is unified so the integration audit in §3f sees a coherent post-wave state.

If a worker times out, crashes, or returns an unparseable summary, treat that worker's task as a failed dispatch:

1. Synthesize a `verdict: "NOT_VERIFIED"` evidence object for the verifier slot in §3d (no verifier dispatch for this task — there's nothing to grade against).
2. Add a `wood-fired-bugs:add_comment` citing the worker failure mode (timeout, crash, parse failure) verbatim.
3. Call `wood-fired-bugs:update_task with updates={ "status": "blocked", "verification_evidence": <the NOT_VERIFIED object> }`. The task stays blocked for this loop run; downstream tasks remain open and will surface in §3a's stalled-tasks check at the end.

### Step 3d — Verify each worker via `tasks-verifier`

For EACH worker that returned a real summary (i.e. NOT the crash/timeout/parse-fail path from §3c), the orchestrator MUST dispatch a separate `tasks-verifier` subagent. **This is non-negotiable** — it is the same `tasks-verifier` contract `loop.md` Step 7 uses, and it is mandatory here for exactly the same reason: the verifier's read-only context window is the entire point of generator/critic separation.

Re-read `loop.md` §Step 7 in full — the verifier dispatch shape (§7a build envelope, §7b dispatch, §7c parse + repair, §7d branch on verdict) applies VERBATIM to each worker in this wave's dispatch set. The same `VerifierInputs` envelope, the same `name: "verifier-task-<id>"` requirement, the same `SendMessage` auto-repair patterns, the same generator/critic-separation rule.

**Parallel verifier dispatch.** As with §3b, when the wave has ≥ 2 workers that returned cleanly, the orchestrator SHOULD issue the verifier `Agent` calls for the wave in a single message so they execute concurrently. The verifiers are independent — each grades its own worker's commits against its own acceptance criteria — so parallel dispatch is strictly safe.

**Branch outcomes per task (same rollup table as `loop.md` §7d):**

- `verdict: "PASS"` → commit the worker's changes if not already committed (mirrors `loop.md` §Step 6 — Commit + push), call `wood-fired-bugs:update_task with updates={ "status": "done", "verification_evidence": <full evidence> }`. Add the bugs-DB close-out comment per `loop.md` §Step 8 template.
- `verdict: "FAIL"` → call `wood-fired-bugs:add_comment` with the failed-checks bullet list, then `wood-fired-bugs:update_task with updates={ "status": "blocked", "verification_evidence": <full evidence> }`. **Downstream tasks (those whose `blocked_by` includes this task) MUST stay `open` and untouched — they will simply never appear on a future frontier** because their `blocked_by` is no longer satisfied. The orchestrator MUST NOT silently re-attempt the failed task within the same loop run. The §3a stalled-tasks check at the end will surface the downstream stall.
- `verdict: "PARTIAL"` → call `wood-fired-bugs:add_comment` listing the UNCHECKABLE criteria, then `wood-fired-bugs:update_task with updates={ "verification_evidence": <full evidence> }` only — status stays `in_progress`. Same load-bearing rule as FAIL: downstream tasks stay open and will not appear on the next frontier (PARTIAL is not the same as `done`/`closed`; `blocked_by` is not satisfied).
- `verdict: "NOT_VERIFIED"` → same handling as `loop.md` §7d NOT_VERIFIED branch. Same downstream-stays-open rule applies.

**Verifier=FAIL is a hard stop for the dependency chain.** The whole reason `/tasks:loop-dag` enforces wave-by-wave frontier recomputation is so a failure surfaces immediately and downstream work is NEVER attempted on top of a broken foundation. This is the dependency-respecting contract the task topology gate (#318) exists to guarantee.

### Step 3e — Record the wave summary

After every worker in this wave has either closed (PASS) or been blocked / left in_progress (FAIL / PARTIAL / NOT_VERIFIED), append a `wave_summary` row to orchestrator state for inclusion in the LOOP-RUN.md frontmatter (§5). Each row has:

- `wave_index`: 1-based integer, incremented per wave.
- `task_ids`: the dispatched set, sorted ascending.
- `started_at`: RFC 3339 UTC, captured immediately before §3b's parallel dispatch.
- `ended_at`: RFC 3339 UTC, captured immediately after the last verifier in §3d returned.
- `verdicts`: object with the per-task verdict, keyed by task id (`{ "334": "PASS", "335": "FAIL", ... }`).

The wave summary is the LOAD-BEARING audit artifact this skill adds over `/tasks:loop` — it is what makes a DAG run replayable wave-by-wave instead of as a flat task list. Without it, the LOOP-RUN.md output cannot answer the question "which tasks ran in parallel?".

### Step 3f — Per-wave integration audit

After §3e records the wave summary, run a per-wave integration audit BEFORE recomputing the next frontier. This is a tighter cadence than `loop.md` §Step 10 (which runs ONCE at loop termination) — because parallel dispatch in §3b means multiple workers may have touched the same file at the same time, an audit per wave catches integration drift while the diff is still small and the orchestrator can still revert before downstream work piles on.

Reuse the §10b–§10e contract from `loop.md` verbatim, with the scope narrowed to **this wave's worker session commit ranges only**:

- §10b detect overlaps (same generated-file exclusion list).
- §10c emit `.planning/loops/<UTC-timestamp>-<project_id>-wave<wave_index>-integration.md` (note the `-wave<wave_index>-` suffix — distinguishes per-wave artifacts from `/tasks:loop`'s one-per-run artifact).
- §10d dispatch one `integration-auditor` subagent per overlap.
- §10e branch on the rolled-up verdict. **The BROKEN-revert protocol is identical** — flip the affected tasks back to `in_progress`, preserve PASS evidence, append `integration_concern` notes, and re-emit LOOP-RUN.md.

**Empty-overlap suppression**: if the wave's dispatch set has only one worker, OR if no file overlap exists across the wave's workers, no per-wave integration-audit artifact is emitted (mirrors `loop.md` §10b's empty-overlap suppression rule — keep `.planning/loops/` scannable).

After §3f completes (or is suppressed), return to §3a and recompute the next frontier.

---

## 4. Run-termination integration audit

When the loop terminates (backlog drained, `--max-waves N` hit, or stalled-tasks check fires), run ONE final integration audit across **all worker sessions from all waves in this run**. This is the cross-wave overlap detector — §3f catches within-wave drift; §4 catches the case where wave 2's worker touched a file that wave 1's worker also touched.

Reuse `loop.md` §Step 10 verbatim for the cross-wave audit. The artifact path is `.planning/loops/<UTC-timestamp>-<project_id>-integration.md` (no `-wave<idx>-` suffix — same naming convention `/tasks:loop` uses).

The per-wave artifacts from §3f and the run-termination artifact from §4 coexist — they describe disjoint scopes (within-wave vs cross-wave) and are independently audit-trail-able. Both live under `.planning/loops/` (gitignored, same rationale as `/tasks:loop`).

---

## 5. Emit LOOP-RUN.md (with wave_summary section)

The final orchestrator step writes a per-run audit artifact summarizing every wave touched during this loop invocation. Contract is the same as `loop.md` §Step 9 with **one extension**: a mandatory `wave_summary` body section that `/tasks:loop` does not emit.

### 5a. Artifact path

```
.planning/loops/<UTC-timestamp>-<project_id>.md
```

Same path convention as `loop.md` §9a. The `<UTC-timestamp>` is the orchestrator's `started_at` (the time the loop began), not the per-wave time — one LOOP-RUN.md file per run, regardless of wave count.

### 5b. Incremental rewrite (kill-safe)

The orchestrator re-emits LOOP-RUN.md **after EACH wave's §3f completes** (not after each task). Use the `Write` tool to replace the file in place — same path, full new contents. This guarantees that if the loop is killed mid-run, the file on disk still reflects the state at the last completed wave. Mirrors `loop.md` §9b's per-task incremental rewrite, scaled to per-wave granularity.

### 5c. Frontmatter construction

The YAML frontmatter is the 14 required fields from `docs/loop-run-schema.md` §3 plus the optional `gate_decision` (Wave 4.2 / #319, extended by Wave 11). `/tasks:loop-dag` writes `gate_decision = "allowed"` for the happy DAG path and `gate_decision = "blocked"` for FLAT / DAG_CYCLIC refusals. No new top-level frontmatter fields are added — backward compatibility with `LoopRunFrontmatterSchema` (`src/lib/loop-run/schema.ts`) is preserved.

Source for each field is identical to `loop.md` §9c — re-read that table. The only differences:

- `subagents_dispatched` counts workers + verifiers + integration-auditors across ALL waves in this run.
- `tasks_attempted` / `tasks_passed` / `tasks_failed` / `tasks_partial` / `tasks_not_verified` are summed across all waves.

### 5d. Body sections

All sections from `loop.md` §9d apply: `## Tasks Closed`, `## Verifier Findings`, `## Integration Concerns`, `## Cost Breakdown`, `## Replay Instructions`. In addition, `/tasks:loop-dag` emits:

- **`## Wave Summary`** — a table with one row per wave, in `wave_index` ascending order. Columns: `wave_index | task_ids | started_at | ended_at | wall_seconds | verdicts`. The `task_ids` column lists the dispatched set comma-separated. The `verdicts` column lists `task_id:verdict` pairs comma-separated. Sentinel paragraph `_No waves dispatched — gate refused at §2f._` when the run was refused before any wave ran (FLAT / DAG_CYCLIC branches of §2f).

  Example:

  ```markdown
  ## Wave Summary

  | wave_index | task_ids | started_at | ended_at | wall_seconds | verdicts |
  |---|---|---|---|---|---|
  | 1 | 334, 335 | 2026-05-24T18:05:00Z | 2026-05-24T18:18:42Z | 822 | 334:PASS, 335:PASS |
  | 2 | 337 | 2026-05-24T18:18:50Z | 2026-05-24T18:26:11Z | 441 | 337:PASS |
  | 3 | 338, 339 | 2026-05-24T18:26:20Z | 2026-05-24T18:40:55Z | 875 | 338:PASS, 339:PASS |
  ```

- **`## Stalled Tasks`** — populated when §3a's final stall check fires (open tasks remain but the frontier is empty — every remaining task is transitively blocked by a FAIL/PARTIAL/NOT_VERIFIED in this run). One bullet per stalled task: `#<id> — <title> — blocked transitively by #<blocker_id> (verdict=<verdict>)`. Sentinel `_No stalled tasks._` when empty.

### 5e. NOT committed (intentional)

Same rationale as `loop.md` §9e — `.planning/` is gitignored per project policy. LOOP-RUN.md and the per-wave / run-termination integration-audit artifacts are local-machine per-run audit trails, not versioned artifacts. The orchestrator MUST NOT `git add` any `.planning/loops/` artifact. It MUST NOT modify `.gitignore`.

---

## Drain Budget / Checkpoints

The default `--max-waves N=3` exists because long unattended DAG drains accumulate small misunderstandings, the same as `/tasks:loop`'s `--max-tasks N=3`. After N successful waves, stop and summarise for the user:

- Waves completed this run (`wave_index` + `task_ids` + per-task verdicts).
- Tasks deferred (IDs + which wave they were originally scheduled in + why they were skipped).
- Stalled-task list (if §3a's stall check would fire at this point — e.g. FAIL in wave 2 stranded a wave-3 candidate).
- Suggested next batch of waves + the next frontier the orchestrator would compute.
- Whether the user should review the wave commits before continuing.

The user can then run the skill again with the same project name to resume — §3a's frontier recomputation is idempotent so resumption is a clean re-entry.

If the user explicitly asked to "drain the whole DAG" or "run until empty", set `--max-waves 0` and skip the checkpoint.

---

## Error Handling

### Worker subagent fails mid-wave

Per §3c, treat the failing task as `NOT_VERIFIED` → bugs-DB status `blocked` for THIS run. The remainder of the wave's workers continue uninterrupted — one worker failure does NOT cancel the wave. Downstream tasks (those whose `blocked_by` includes the failed task) stay open and will surface in the run's final `## Stalled Tasks` section.

### Verifier subagent unreachable for repair

Per §3d, follow `loop.md` §7c's hard-fallback exactly: synthesize `NOT_VERIFIED`, add a bugs-DB comment citing the §7b violation, preserve the original verifier's parse-failed output verbatim. Do NOT re-dispatch a fresh verifier — fresh dispatches lack the original verifier's tool-call context and will fabricate checks.

### Per-wave integration audit surfaces BROKEN

Per §3f → §10e BROKEN-revert protocol from `loop.md`: flip the affected tasks back to `in_progress`, preserve PASS evidence, append `integration_concern` notes, re-emit LOOP-RUN.md with a `## Integration Failure` body section. Subsequent waves WILL re-encounter the reverted tasks on the next frontier (because they're back to `in_progress`/`open` and their `blocked_by` is still satisfied), so the loop will re-attempt them in a later wave. This is the load-bearing recovery property — BROKEN overlaps are NOT permanent failures, just retryable ones.

### Stalled tasks (frontier empty but open tasks remain)

Per §3a, surface the stall in the final LOOP-RUN.md `## Stalled Tasks` section. Do NOT try to force-unblock by closing tasks the verifier failed; the FAIL was the verifier's honest judgment and the orchestrator MUST NOT override it (this is the same generator/critic-separation rule `loop.md` Important Rules pins).

### `topology_check` returns something other than FLAT / DAG / DAG_CYCLIC

Defensive halt. Emit a comment in the bugs-DB project's top-level discussion (`add_comment` on the highest-ID open task as a proxy — there is no project-level comment API) citing the unexpected topology value verbatim, then exit. This should be impossible per `TopologyService`'s contract; if it happens it is a data-shape bug worth a separate task.

---

## Important Rules

- **Generator/critic separation.** Same load-bearing rule as `loop.md`. The orchestrator MUST dispatch a SEPARATE `tasks-verifier` subagent per worker (per §3d) and a SEPARATE `integration-auditor` per overlap (per §3f / §4). The orchestrator MUST NOT grade its own dispatches. UPGRADES (FAIL→PASS, etc.) MUST come from a freshly re-dispatched verifier, never from orchestrator observation.
- **Wave-by-wave parallel dispatch.** The orchestrator MUST issue Agent calls for a wave in a single message when `--concurrency K >= 2`. Sequential dispatch within a wave (one Agent → await → next Agent) is permitted ONLY under `--concurrency 1`.
- **Frontier recomputation is wave-by-wave, NOT per-task.** The orchestrator computes the frontier ONCE at the start of each wave and dispatches every task on it in parallel. It does NOT recompute mid-wave after each worker returns — that would defeat the parallelism the skill exists to exploit.
- **Verifier=FAIL stops the dependency chain.** A failed task stays blocked; downstream tasks stay open and never appear on a future frontier in THIS run. No silent retry. This is the entire point of having a DAG-respecting executor.
- **One commit per task, not per wave.** Each worker's PASS triggers its own commit (mirrors `loop.md` §Step 6). Wave granularity is the dispatch + audit unit; commit granularity is per task. This keeps `git log` readable and per-task revertible.
- **Don't create new tasks during the loop.** Same rule as `loop.md` Important Rules. Note discoveries in comments on related tasks; the user promotes them later. (The §7d "declared scope narrowing" carve-out from `loop.md` applies here too if a worker's task was annotated `scope: design-only` in §2a — re-read the carve-out for the closure shape.)
- **Skill MUST NOT execute when topology is FLAT.** Refuse with the canonical §2f message and point the user at `/tasks:loop`. There is no override flag for this refusal — it would always be the wrong call.
- **Skill MUST NOT execute when topology is DAG_CYCLIC.** Refuse with the canonical §2f message and surface the cycle members. There is no override flag for this refusal — a cycle has no valid execution order.
- **Be honest about manual steps.** If smoke/UAT/deploy was skipped, say so in the comment (same as `loop.md`).
- **Stop when `--max-waves N` is hit** (default 3) and check in with the user — don't silently keep going.
- **Stop when the backlog drains.** Announce completion, run §4 integration audit, emit final LOOP-RUN.md, exit. No polling.
