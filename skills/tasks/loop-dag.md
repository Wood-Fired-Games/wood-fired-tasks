---
name: loop-dag
description: Wave-by-wave parallel executor for DAG-topology wood-fired-tasks projects. Computes the dependency frontier (open tasks whose blocked_by edges are all satisfied), dispatches a worker subagent per frontier task in parallel under a concurrency cap, runs the mandatory tasks-verifier per worker, recomputes the frontier wave-by-wave until the backlog drains, runs INTEGRATION-AUDIT per wave on file overlaps, and emits LOOP-RUN.md with an extended wave_summary section. Refuses FLAT (use /tasks:loop) and DAG_CYCLIC (cycles must be broken first). Sibling executor to /tasks:loop; differs by exploiting parallelism across independent frontier tasks instead of running a single topological order sequentially.
argument-hint: [project-name] [--max-waves N] [--concurrency K]
disable-model-invocation: false
---

# Task Loop-DAG Workflow (Wave 4.3 / task #341)

You are the **orchestrator** of an autonomous backlog-drain for a **DAG-topology** project. The wood-fired-tasks project you target has dependency edges; tasks must run in an order that respects them, but tasks on the same frontier (no unsatisfied dependencies) MAY run in parallel.

> See [loop-shared.md](loop-shared.md) for the worker brief template (§A), VerifierInputs envelope (§B), and LOOP-RUN.md frontmatter (§C) — same contracts as /tasks:loop. Also: INTEGRATION-AUDIT.md schema (§D), declared scope narrowing carve-out (§E), `.flaky-tests.json` handling (§F), verifier parse-failure patterns (§G), declared scope narrowing detection (§H), Step 8 close-out comment (§I), Step 5 post-correction carve-out (§J), worktree teardown (§N), model resolution (§R).

This skill is the **DAG-shaped sibling** of [`skills/tasks/loop.md`](./loop.md). The two skills share most of the contract — pre-loop discovery, worker briefs, the mandatory `tasks-verifier` dispatch, the LOOP-RUN.md artifact, and the integration-auditor — and this file deliberately points at `loop.md` (and `loop-shared.md` for the shared templates) for the shared sections rather than duplicating them. What this skill adds is **wave-by-wave parallel dispatch** instead of single-task sequential ordering.

> **Mental model.** Think of yourself as a foreman scheduling a build crew across independent foundations on the same site. Each foundation (wave) is a set of tasks that have no remaining dependencies. While the wave's workers are pouring concrete in parallel, you (the orchestrator) plan the next wave. You never let a worker start before its supporting foundation has cured — that's what `blocked_by` enforces.

## Preflight: identity + MCP tools

**Resolve a real identity** before any `assignee` (on `claim_task`) or `author` (on `add_comment`) field — do NOT pass the literal `"user"` (that destroys cross-machine audit attribution). In priority order: (1) `git config user.email`, (2) `$USER`, (3) `claude-<model>-<purpose>` (e.g. `claude-opus-4.7-loop-dag`). Pick once at top of invocation and capture as `$ASSIGNEE` (used for both `assignee` and `author` throughout this run). Detailed enforcement rules already embedded in the per-worker brief / claim / comment sections below (and reused from `loop.md` / `loop-shared.md`) — this block is the canonical pointer.

**Execution ledger:** before the first MCP call, mirror this skill's step list into the harness todo list per [loop-shared.md §S](loop-shared.md#s-execution-ledger-mandatory-step-tracking).

This skill calls tools on the `wood-fired-tasks` MCP server. Shorthand `wood-fired-tasks:<tool>` ↔ harness name `mcp__wood-fired-tasks__<tool>`. On `InputValidationError`, load via `ToolSearch` (`select:mcp__wood-fired-tasks__list_projects,mcp__wood-fired-tasks__list_tasks,mcp__wood-fired-tasks__get_task,mcp__wood-fired-tasks__get_comments,mcp__wood-fired-tasks__get_dependencies,mcp__wood-fired-tasks__claim_task,mcp__wood-fired-tasks__update_task,mcp__wood-fired-tasks__add_comment,mcp__wood-fired-tasks__topology_check,mcp__wood-fired-tasks__wsjf_ranking,mcp__wood-fired-tasks__wsjf_health,mcp__wood-fired-tasks__resolve_model,mcp__wood-fired-tasks__list_models`) and retry. (`wsjf_ranking` is consumed by §3a's WSJF-ordered frontier sort; `wsjf_health` by §2h's loop-start health surfacing; `resolve_model` / `list_models` by the §3b / §3d dispatch-model resolution per [loop-shared.md §R](loop-shared.md#r-model-resolution).)

---

## 1. Argument Parsing

Parse `$ARGUMENTS` — or, when invoked via natural language ("drain DAG project X", "run the dependency graph for project Y"), extract the equivalent fields from the request:

- `[project-name-or-id]` — if the value starts with `#` or is a bare integer, treat it as the project ID and skip the name match. Otherwise, do a case-insensitive partial match against project names. Resolution rules are identical to `loop.md` §1 → Resolve Project ID; reuse them.
- `--max-waves N` — optional. Stop the loop after N completed waves and check in with the user before continuing. Default is **3**. Pass `--max-waves 0` to drain the entire DAG unattended (only if the user explicitly asks). A wave is "completed" when every worker dispatched in that wave returned AND the wave's verifier rollup landed.
- `--concurrency K` — optional. Maximum number of worker subagents to run in parallel within a single wave. Default is **4**. Tune down to **1** for diagnostic single-step runs (useful when reproducing a wave-specific failure); tune up only when the project's tasks are known to be cheap and well-isolated. Hard ceiling **8** to keep orchestrator-side accounting tractable.
- `--execution-model <ref>` / `--validation-model <ref>` / `--planning-model <ref>` — optional. Force a single model ref for every worker / verifier / planning dispatch this run, bypassing per-project/per-category `resolve_model` for that role. `<ref>` accepts a concrete model id or `auto`. Resolution + dispatch-time fallback: [loop-shared.md §R](loop-shared.md#r-model-resolution).

**If no project name/ID is provided:** ask the user. Do not pick one silently.

### Resolve Project ID

Reuse `loop.md` §1 Resolve Project ID verbatim. Same `wood-fired-tasks:list_projects` call, same match precedence (ID first, then case-insensitive partial name match), same "list available projects and stop" fallback when nothing matches.

---

## 2. Pre-Loop Discovery (run ONCE, before any wave is dispatched)

Reuse `loop.md` §2a–§2e verbatim — these sub-steps are about understanding the repo, validation commands, baseline tests, cross-repo scope detection, and epic-vs-bug sizing. None of them are flat-vs-DAG specific. The only sub-step this skill replaces is `loop.md` §2f (topology pre-flight gate), redefined below for the DAG-only contract.

Additionally apply [loop-shared.md §T](loop-shared.md#t-decomposition-artifact-reuse-executor-side-handoff) when open tasks carry a `decomp-<uuid>` tag — the decompose artifact's edge reasons (`predicted file overlap: <path>`) feed §3b worker-brief hard constraints.

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

**Blocked-branch behaviour:** when `gate_decision = "blocked"` (FLAT or DAG_CYCLIC), the orchestrator does NOT enter §3 The Wave Loop, does NOT claim any task, and does NOT dispatch a worker. §5f (termination emit) still fires — write a single LOOP-RUN.md with `gate_decision: blocked`, `tasks_attempted: 0`, an empty `wave_summary` section (sentinel paragraph below), and a `## Aborted` body section naming the gate reason. §4 (per-wave integration audit) is skipped (no worker sessions means no overlaps to audit).

**`gate_decision` value domain for `/tasks:loop-dag`.** This skill writes `gate_decision ∈ {"allowed", "blocked"}` and nothing else. The `LoopRunFrontmatterSchema` (`src/lib/loop-run/schema.ts`) ALSO accepts `"auto_ordered"` and `"overridden"`, but those values are exclusively `/tasks:loop`'s — they describe DAG handling decisions that `/tasks:loop-dag` never makes (this skill does not auto-order DAGs because it dispatches them in parallel waves, and it does not accept a topology override because the FLAT / DAG_CYCLIC refusals are unconditional). The orchestrator MUST NOT write `auto_ordered` or `overridden` even though the schema would accept them — doing so silently mislabels which executor ran and corrupts cross-skill audit-trail queries.

### 2g. Worker-feasibility gate (refuses tasks no autonomous worker can drive)

After §2f passes and BEFORE the heavy §2a–§2e pre-loop discovery, scan every open task in the project for hand-replay / cross-context indicators. Tasks that match are NOT dispatch-eligible regardless of dependency satisfaction. This gate exists because the §2f topology gate filters by edge structure but NOT by "is this a sensible thing for an autonomous worker subagent to attempt." Tasks that explicitly need a human-in-the-loop OR a separate orchestrator context to verify (e.g. "observe a live /tasks:loop run apply the exclusion") cannot produce a PASS-able evidence shape from a worker; dispatching them wastes budget and noise-floors the verdict distribution with guaranteed NOT_VERIFIED outcomes.

Run this scan via a single `wood-fired-tasks:list_tasks` (already done in §3a step 1 — reuse the result rather than re-fetching) plus per-task `wood-fired-tasks:get_task` only for the tasks whose tag list contains a candidate match (cheap pre-filter). Build the orchestrator-state set `not_dispatchable_this_run` (task id → reason).

**Indicators (any one triggers the gate):**

1. **Tag-based** — `tags` field contains any of:
   - `hand-replay`
   - `manual-verification`
   - `requires-live-replay`
   - `observe-in-loop`
   - `cross-context-observation`
2. **AC / description phrase-based** — `acceptance_criteria` column OR `description` field contains any of (case-insensitive substring):
   - `"observe the orchestrator"`
   - `"manually inspect"`
   - `"hand-replay"` / `"hand replay"`
   - `"live cross-context"`
   - `"observed in a live /tasks:loop"`
   - `"by observing"`
   - `"hand-driven verification"`

**Action on match (per task):**

1. Add `not_dispatchable_this_run[<id>] = "feasibility: <which indicator matched>"`.
2. Add a comment to the task via `wood-fired-tasks:add_comment` (once per loop run — guard with a check that no prior `/tasks:loop-dag worker-feasibility gate` comment exists for this `verified_at`-equivalent run-id):

   > `"/tasks:loop-dag worker-feasibility gate (run_id=<run_id>): task tagged/described as requiring hand-replay or live cross-context observation (matched indicator: <X>). An autonomous worker subagent cannot produce evidence for criteria of this shape. Marking as not-dispatchable for THIS run only — the task remains open for human-driven closure, or for a future loop run after the acceptance criteria are reshaped to be worker-checkable."`

3. The task is reported in the final LOOP-RUN.md `## Not-Dispatchable Tasks` body section (§5d).

**Override:** none. If you want to attempt one of these tasks anyway, edit the task to remove the indicator tag/phrase, then re-run. The skill intentionally has no `--include-manual-tasks` flag — adding one would invite agents under pressure to flip it on rather than reshape the task, defeating the gate's purpose.

**Wipeout case:** if the §2g scan flags every open task in the project (i.e. the entire backlog is hand-replay-tagged), §3a's frontier will be empty after step 6. Skip §2a–§2e (no point doing baselines for a wipeout) and route directly to §5f termination emit with a `## Aborted` section naming "feasibility wipeout: N/N open tasks gated". This is the optimization that addresses friction F6 — the cheap §2g scan runs BEFORE the expensive §2a–§2e baselines, so a doomed pool is detected for ~one MCP round-trip instead of after a full baseline-tests run.

### 2h. WSJF health surfacing (loop start)
Run ONCE, after §2f's gate is decided and BEFORE §3a computes the first frontier. Probe `wood-fired-tasks:wsjf_health` with `{ project_id }` — the non-blocking spec §9 degeneracy / pitfall linter (pure read; writes nothing). It returns `{ healthy, scored_task_count, findings[] }`; each entry in `findings[]` carries `check`, `severity` (`info` | `warning` | `critical`), `message`, and `suggestion`. **`healthy: true`** → one-line `"WSJF health: OK (<scored_task_count> scored task(s), no degeneracies)."` and proceed. **`findings[]` non-empty** → print a `WSJF Health` block in the first prompt listing each as `- [<severity>] <message> Fix: <suggestion>`, ordered `critical` → `warning` → `info`, warning the operator that the per-wave WSJF-ordered frontier sort (§3a step 8) may consume a degenerate ranking (near-identical scores, or a past-deadline task with stale Time Criticality). The findings are **advisory only — they NEVER block the run**, never change the gate decision, and never auto-rescore. If `wsjf_health` is unavailable (CONDITIONALLY registered — `src/mcp/server.ts` omits it when no linter is wired), skip this surfacing silently and proceed to §3.

---

## 3. The Wave Loop

The orchestrator drains the DAG by alternating two phases: **compute the frontier**, then **dispatch the wave**. Continue until the open-task set is empty or `--max-waves N` is hit.

Each wave goes through **six sub-steps**: 3a (compute frontier), 3b (claim + dispatch in parallel), 3c (await wave completion), 3d (verify each worker via `tasks-verifier`), 3e (record wave summary), 3f (per-wave integration audit per §4). Do not skip ahead. The wave is a unit: every worker in the wave runs to completion (or its bounded error path) before §4 grades the wave and §3a recomputes the next frontier.

### Step 3a — Compute the frontier

```
wood-fired-tasks:list_tasks with project_id=<id>, status=open
```

The **frontier** is the set of open tasks whose `blocked_by` edges are ALL closed (`status` in {`done`, `closed`}) OR satisfied (the blocking task is missing from the project — defensive treatment of orphaned edges, mirroring `TopologyService`'s same-project edge filter).

Algorithm:

1. Fetch all open tasks for the project via `wood-fired-tasks:list_tasks` with `status=open` and `limit=200`.
2. **Build the `blocked_by` index from `topology_check.edges` (already fetched in §2f).** For each edge `from → to` in the response, append `from` to `blocked_by[to]`. **Do NOT call `wood-fired-tasks:get_dependencies` per task** — `topology_check` is the authoritative single-call source-of-truth and per-task fetches are N+1 round-trips that the §2f call has already eliminated. The only exception: if §2f's `topology_check` was unavailable or returned a malformed response (defensive halt path), fall back to per-task `wood-fired-tasks:get_dependencies` here and cache per task id.
3. A task is **on the frontier** iff every `blocked_by` task id either (a) has `status` in {`done`, `closed`}, (b) is missing from the project (cross-project or dangling edge — drop defensively, matching `src/services/topology.service.ts`'s same-project filter), or (c) has been already-closed by a prior wave in THIS loop run (track this in orchestrator state — a task closed in wave N is satisfied for wave N+1's frontier calculation even if the tasks-database write hasn't been re-read).
4. **Skip tasks already claimed by someone else.** If a task is on the frontier but its `claimed_at` is non-null and the assignee is not this orchestrator's agent name, drop it from this wave's dispatch set and re-evaluate it on the next frontier recomputation (it may still be claimed; that's fine — eventually it closes or is released).
5. **Skip tasks the orchestrator already dispatched in a prior wave of THIS run.** A worker that returned FAIL → blocked stays blocked; do NOT silently re-attempt within the same loop run. Track these in orchestrator state by task id.
6. **Skip tasks flagged by §2g feasibility gate.** If a task id is in `not_dispatchable_this_run` (set built in §2g and extended below), drop it. The task remains open in the tasks database; it just doesn't enter THIS run's frontier.
7. **Skip tasks with stale-PARTIAL evidence (previously-PARTIAL guard).** If a task has `verification_evidence.verdict = "PARTIAL"` from a prior loop run AND no new commits have touched any of the files in `verification_evidence.file_changes` since `verification_evidence.verified_at`, add the task id to `not_dispatchable_this_run` with reason `"previously-PARTIAL, no new evidence"` and skip it. Add a one-time comment to the task: `"/tasks:loop-dag previously-PARTIAL guard: task graded PARTIAL on <verified_at> by verifier <verifier_session_id>; no new commits have touched its tracked files since. Re-dispatch would re-grade the same evidence and produce the same PARTIAL. Skipping. Either commit progress toward the UNCHECKABLE criteria first, or close the task manually."` (Check `git log --since=<verified_at> -- <files>` to determine staleness; if `file_changes` is empty in the prior evidence, treat as stale — there's no signal that anything has moved.)
8. Sort the resulting frontier. **WSJF-ordered frontier sort:** probe the `wsjf_ranking` MCP tool with `{ project_id, scope: "frontier" }` (scope is always `"frontier"` here — DAG-only, §3a dispatches only the ready frontier). **If ≥ 1 returned `ranking[]` entry has `scored: true`** → order this wave's surviving (steps 1–7) frontier by that pre-sorted order (descending `effectiveWsjf`, unscored via `priorityFallbackScore`, ties by created_at/id) and record the snapshot per §M. **If NO entry is scored** (backward-compatible default) → fall back UNCHANGED to **priority DESC**, then **`created_at` ASC**, then **`id` ASC**. The first `--concurrency K` tasks are the wave's dispatch set. WSJF reorders WITHIN a frontier only — never ahead of a blocker. Full procedure: [loop-shared.md §M](loop-shared.md#m-loop-runmd-wsjf-ranking-snapshot).
9. If the resulting frontier is empty, do one final check: are there any open tasks left at all? If YES, those tasks are all transitively blocked by something that either failed (verdict=FAIL → blocked), was never closed, or was filtered by §2g / step 7 — emit `## Stalled Tasks` AND `## Not-Dispatchable Tasks` blocks in the final LOOP-RUN.md (per §5d) and exit. If NO, the backlog is drained — announce completion, run §4 (integration audit) ONCE, then exit.

**Frontier correctness invariant (test fixture — not a real task set).** The canonical *test fixture* lives in `src/api/routes/tasks/__tests__/loop-dag-skill-design.test.ts`; the IDs 334/335/337/338/339 are fictional and need not be looked up in the live tasks database. Given edges `{334→337, 335→337, 337→338, 337→339}` on an open-task set `{334, 335, 337, 338, 339}`, the frontier algorithm MUST produce waves `{334, 335}` (wave 1) / `{337}` (wave 2) / `{338, 339}` (wave 3). This is the load-bearing correctness contract for §3a — any change to the algorithm MUST preserve this fixture's wave shape.

### Step 3b — Claim and dispatch in parallel

For each task in the wave's dispatch set (up to `--concurrency K`):

1. Claim the task: `wood-fired-tasks:claim_task with task_id=<id>, assignee=<your agent name>`. If the claim fails (another runner won the race), drop the task from this wave's dispatch set and re-evaluate on the next frontier recomputation.

   **Claim renewal cadence (task #1003).** Claims auto-release after a **30-minute** idle TTL (`claim_ttl_minutes` / `claim_remaining_seconds` on `get_task` show the live window), and the sweep emits `task.claim_released` when one lapses. Renewal is just a same-assignee re-claim: `claim_task` with the SAME `assignee` on a task you already hold refreshes `claimed_at` and restarts the TTL. Orchestrators of long waves MUST re-claim every still-held task **between waves** (and before any verifier round that may exceed the TTL — e.g. after a long worker or an operator pause) so a half-done task is never silently released back to `open` for another runner to legally claim. If a re-claim returns the already-claimed conflict for a task you held, the claim lapsed and was taken — drop it from your dispatch accounting and re-evaluate on the next frontier recomputation.
2. Read context: `wood-fired-tasks:get_task with id=<id>`, `wood-fired-tasks:get_comments with task_id=<id>`. Extract acceptance criteria, linked docs, constraints — exactly as `loop.md` §Step 2 (Claim and read) describes.
3. Plan validation depth and pre-scan scope — exactly as `loop.md` §Step 3 (Plan the validation depth and pre-scan scope) describes. The pre-scan happens in the orchestrator, BEFORE dispatching the worker.
4. Dispatch the worker subagent via the `Agent` tool. **Default `subagent_type: "general-purpose"`** — this is the universally-available type that works in every fresh session, regardless of whether the project's `install.sh` registered named subagents. Named types (e.g. `tasks-worker`) only exist in sessions started AFTER `install.sh` ran in that session; an `Agent` call with an unregistered `subagent_type` FAILS the whole dispatch silently, costing the wave. `general-purpose` + an embedded brief is the reliable path; the worker still operates the same MCP tools and reads the same files. The full brief shape (subject, goal, context, AC, validation depth, **"Do NOT commit" trailer**) is summarized inline in §6a — read that before composing your first dispatch. (Full text remains in `loop.md` §Step 4 as the authoritative source.) **Resolve the dispatch model first:** resolve the `execution`-role model (or apply `--execution-model`) and set each worker `Agent` call's `model:` accordingly — see [loop-shared.md §R](loop-shared.md#r-model-resolution).

**Parallel dispatch shape.** When `--concurrency K >= 2` and the wave has ≥ 2 tasks, the orchestrator MUST issue the `Agent` tool calls for the wave in a **single message** so they execute concurrently — per the platform's parallel-tool-call semantics. Each `Agent` call gets its own `name: "worker-task-<id>"` so it is independently addressable via `SendMessage` later (mirrors `loop.md` §7b's `name:` requirement for verifiers — the same reasoning applies to workers, since the orchestrator may need to send a tight diagnostic back to a single worker without disturbing the others mid-wave).

Sequential dispatch (one Agent call, await, next Agent call) is permitted only when `--concurrency 1` is explicitly set — it is the strictly slower path and exists for diagnostic single-step runs. Each parallel worker `Agent` call MUST set `isolation: "worktree"` (parallel workers in a shared tree can `git restore` each other's edits even on disjoint file sets); the per-worker `.claude/worktrees/agent-<id>` worktree + `worktree-agent-*` branch the harness creates is reclaimed at run-end by §5g (loop-shared.md §N) — the harness never auto-cleans them because an edited worktree counts as "changed".

**Stale-base hazard + post-dispatch base check (MANDATORY for `isolation: "worktree"`).** The worktree harness may base each worktree on a FIXED ref (often the repo's main branch), NOT the orchestrator's current tip — so a worktree can silently start commits behind, and a worker that doesn't self-correct builds on a stale tree (reinventing shipped files, or reverting later registrations). _Incident (2026-06-05, project 36): all four wave-1 worktrees were cut 17 commits stale; two workers self-corrected, two didn't — re-dispatch._ **Base-ref ownership (where the base is chosen).** The `isolation: "worktree"` base ref is selected by the **Claude Code platform Agent-tool harness**, which issues the `git worktree add` and creates `.claude/worktrees/agent-<id>` + the `worktree-agent-*` branch. It is **not owned in this repo**: `grep -rniE "isolation.*worktree|git worktree add" src/ scripts/ packages/` (minus `__tests__`) returns nothing — no in-repo code selects the worktree base ref, so the base-selection logic cannot be changed here. Three required defenses: (1) **write-side** — every brief embeds the §A STEP 0 guard with `<integration-branch>`, `<expected-tip-sha>`, and sentinel paths filled in; (2) **orchestrator** — on each worker's return, BEFORE its verifier, `git -C <worktree> rev-parse HEAD` must equal/descend-from the expected tip, else FAILED DISPATCH (re-dispatch corrected; never integrate a stale-base worktree); (3) **read-side** — pass `base_sha` in the §B envelope so the verifier's first check re-asserts the base and returns `NOT_VERIFIED` on mismatch. **Resolution.** The durable fix — basing new worktrees on the orchestrator's HEAD, or accepting an explicit base-ref parameter — lives ONLY upstream in the platform harness; it is **tracked as an upstream Claude Code platform limitation with no in-repo code change possible** (re-confirmed 2026-06-05 by the empty grep above). Therefore defenses 1–3 are the **standing mandatory mitigation**: they are NOT optional and NOT a stopgap pending an in-repo fix (there is no in-repo fix locus) — they remain mandatory for every `isolation: "worktree"` dispatch until the platform harness bases worktrees on the orchestrator HEAD.

### Step 3c — Await wave completion

The orchestrator waits for ALL worker subagents dispatched in this wave to return their final messages before proceeding to §3d. **No verifier dispatch happens until every worker in the wave has returned** — the verifier round-trip is per-task but the wave's grading phase is unified so the integration audit in §3f sees a coherent post-wave state.

If a worker times out, crashes, or returns an unparseable summary, treat that worker's task as a failed dispatch:

1. Synthesize a `verdict: "NOT_VERIFIED"` evidence object for the verifier slot in §3d (no verifier dispatch for this task — there's nothing to grade against).
2. Add a `wood-fired-tasks:add_comment` citing the worker failure mode (timeout, crash, parse failure) verbatim.
3. Call `wood-fired-tasks:update_task with updates={ "status": "blocked", "verification_evidence": <the NOT_VERIFIED object> }`. The task stays blocked for this loop run; downstream tasks remain open and will surface in §3a's stalled-tasks check at the end.

### Step 3d — Verify each worker via `tasks-verifier`

For EACH worker that returned a real summary (i.e. NOT the crash/timeout/parse-fail path from §3c), the orchestrator MUST dispatch a separate `tasks-verifier` subagent. **This is non-negotiable** — it is the same `tasks-verifier` contract `loop.md` Step 7 uses, and it is mandatory here for exactly the same reason: the verifier's read-only context window is the entire point of generator/critic separation.

Re-read `loop.md` §Step 7 in full — the verifier dispatch shape (§7a build envelope, §7b dispatch, §7c parse + repair, §7d branch on verdict) applies VERBATIM to each worker in this wave's dispatch set. The same `VerifierInputs` envelope, the same `name: "verifier-task-<id>"` requirement, the same `SendMessage` auto-repair patterns, the same generator/critic-separation rule. **Resolve the dispatch model first:** before each verifier `Agent` call, resolve the `validation`-role model (or apply `--validation-model`) and set `model:` accordingly — see [loop-shared.md §R](loop-shared.md#r-model-resolution).

**Anti-fabrication + one-state-mutation-per-turn (applies per task in this wave).** Every evidence value (SHA, row count, exit code, verdict) MUST be copied verbatim from a tool result that ALREADY RETURNED in a prior turn — never composed in the same turn as the producing call. So perform at most ONE state-producing action per turn during verify/commit and let it return before citing it: each task's `commit_shas` / `file_changes` come from a `git rev-parse HEAD` / `git diff --name-only` that returned BEFORE the envelope was built, never batched alongside it. Parallelism applies to *dispatch* (§3b / the parallel-verifier note below), never to "quote a not-yet-returned result." And the orchestrator MUST NOT author `verification_evidence` for any worker's task — each `verifier_session_id` is the SEPARATELY DISPATCHED `tasks-verifier`'s id, never the orchestrator's own session nor a literal like `"orchestrator"` / `"self"` / `"main-loop"`. Full rule + motivating incident: [`loop-shared.md` §L](./loop-shared.md#l-anti-fabrication--evidence-integrity-canon).

**Parallel verifier dispatch.** As with §3b, when the wave has ≥ 2 workers that returned cleanly, the orchestrator SHOULD issue the verifier `Agent` calls for the wave in a single message so they execute concurrently. The verifiers are independent — each grades its own worker's commits against its own acceptance criteria — so parallel dispatch is strictly safe.

**Branch outcomes per task (same rollup table as `loop.md` §7d):**

- `verdict: "PASS"` → commit the worker's changes if not already committed (mirrors `loop.md` §Step 6 — Commit + push). Because loop-dag workers run in ISOLATED worktrees (§3b), their changes must be applied to the integration tree ONE task at a time — `git show --stat <commit>` to confirm each commit holds only that task's files before the next apply; never batch dependent `git apply --index` calls. Full mechanics (shared-file slice recipe + kill-safe re-slice): [`loop-shared.md` §Q](./loop-shared.md#q-worktree-patch-integration-mechanics-loop-dag-run-end--per-wave). Then call `wood-fired-tasks:update_task with updates={ "status": "done", "verification_evidence": <full evidence> }`. Add the close-out comment per `loop.md` §Step 8 template.
- `verdict: "FAIL"` → call `wood-fired-tasks:add_comment` with the failed-checks bullet list, then `wood-fired-tasks:update_task with updates={ "status": "blocked", "verification_evidence": <full evidence> }`. **If the failure produced a follow-up/defect task** (bounce-style: the fix is tracked as its own task), include `"blocked_by": [<defectTaskId>]` in the SAME `update_task` call — the blocking edge and the status flip commit atomically and the task auto-unblocks when the defect closes; a status-only block followed by a separate `add_dependency` is FORBIDDEN (a skipped/failed second call strands the task forever — `check_health` flags these as `blocked-without-edge`). **Downstream tasks (those whose `blocked_by` includes this task) MUST stay `open` and untouched — they will simply never appear on a future frontier** because their `blocked_by` is no longer satisfied. The orchestrator MUST NOT silently re-attempt the failed task within the same loop run. The §3a stalled-tasks check at the end will surface the downstream stall.
- `verdict: "PARTIAL"` → call `wood-fired-tasks:add_comment` listing the UNCHECKABLE criteria, then `wood-fired-tasks:update_task with updates={ "verification_evidence": <full evidence> }` only — status stays `in_progress`. Same load-bearing rule as FAIL: downstream tasks stay open and will not appear on the next frontier (PARTIAL is not the same as `done`/`closed`; `blocked_by` is not satisfied).
- `verdict: "NOT_VERIFIED"` (verifier-emitted) → same handling as `loop.md` §7d NOT_VERIFIED branch (status stays `in_progress`). Same downstream-stays-open rule applies. (A §3c dispatch-failure NOT_VERIFIED is the OTHER case — that path → `blocked`, per the §6c table.)

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

After §3e records the wave summary, run a per-wave integration audit BEFORE recomputing the next frontier — a tighter cadence than `loop.md` §Step 10 (once at termination). Because parallel dispatch in §3b means multiple workers may have touched the same file simultaneously, a per-wave audit catches integration drift while the diff is still small and the orchestrator can still revert before downstream work piles on.

Reuse the §10b–§10e contract from `loop.md` verbatim, with the scope narrowed to **this wave's worker session commit ranges only**:

- §10b detect overlaps (same generated-file exclusion list).
- §10c emit `.planning/loops/<UTC-timestamp>-<project_id>-wave<wave_index>-integration.md` (note the `-wave<wave_index>-` suffix — distinguishes per-wave artifacts from `/tasks:loop`'s one-per-run artifact).
- §10d dispatch one `integration-auditor` subagent per overlap. **Resolve the dispatch model first:** the integration-auditor is a **planning-role** dispatch — before each `integration-auditor` `Agent` call, resolve the `planning`-role model via `resolve_model { project_id, role: 'planning' }` (**`task_id` OMITTED** so the `planning` `constant`/`default` governs; the per-overlap audit grades many tasks' diffs, not one) and set `model:` accordingly (or apply `--planning-model`), per [loop-shared.md §R](loop-shared.md#r-model-resolution). Resolve once and reuse across this wave's per-overlap auditors.
- §10e branch on the rolled-up verdict. **The BROKEN-revert protocol is identical** — flip the affected tasks back to `in_progress`, preserve PASS evidence, append `integration_concern` notes, and re-emit LOOP-RUN.md.

**Post-integration validation (MANDATORY, per wave).** After every PASS
task's patch has been applied and committed to the integration tree (§3d /
loop-shared.md §Q) and BEFORE the overlap audit's verdict is rolled up, run
the project's `<build>` + `<test>` (with the §2c flake filter) on the
**INTEGRATED tree** — not in any worktree. Worker-side green is NOT
sufficient: worktree runs can silently no-op (e.g. linters that ignore
`.claude/**`), and no worker ever validated the COMBINED wave diff. Compare
failing FQNs against the §2c baseline; any new failure is handled as a §10e
BROKEN integration — bisect the wave's per-task commits
(`git stash`-free: re-run the failing test at each of the wave's commits) to
attribute, flip the offending task(s) back to `in_progress` with an
`integration_concern` note, and re-emit LOOP-RUN.md. Do NOT recompute the
next frontier on a red integrated tree.

**Empty-overlap suppression**: if the wave's dispatch set has only one worker, OR if no file overlap exists across the wave's workers, no per-wave integration-audit artifact is emitted (mirrors `loop.md` §10b's empty-overlap suppression rule — keep `.planning/loops/` scannable).

**Per-wave drift/meta guard trigger.** After the overlap audit, if this wave's **union diff** touches CLI/docs/skills paths — illustrative globs `src/cli/**`, `program.addCommand`, `docs/**`, `README.md`, `skills/**` — run the repo's drift/meta guard tests (or full `npm test` as the fallback) BEFORE recomputing the next frontier. A RED drift guard is handled like a §10e BROKEN integration (revert/flag + LOOP-RUN.md note), never silently deferred to §4. See [loop-shared.md §P](loop-shared.md#p-per-wave-driftmeta-guard-trigger) for locating guards generically + the BROKEN-handling contract.

After §3f completes (or is suppressed), return to §3a and recompute the next frontier.

---

## 4. Run-termination integration audit

When the loop terminates (backlog drained, `--max-waves N` hit, or stalled-tasks check fires), run ONE final integration audit across **all worker sessions from all waves in this run**. This is the cross-wave overlap detector — §3f catches within-wave drift; §4 catches the case where wave 2's worker touched a file that wave 1's worker also touched.

**Resolve the dispatch model first (planning role).** As in §3f, the run-termination `integration-auditor` dispatches are **planning-role** dispatches: before each `integration-auditor` `Agent` call resolve the `planning`-role model via `resolve_model { project_id, role: 'planning' }` (**`task_id` OMITTED** → the `planning` `constant`/`default` governs) and set `model:` accordingly (or apply `--planning-model`), per [loop-shared.md §R](loop-shared.md#r-model-resolution); `null` ⇒ inherit the orchestrator's session model. Resolve once and reuse across this run-termination audit's per-overlap auditors.

**Terminal completeness gate (BEFORE declaring drained).** Alongside (just before) this run-termination audit, run the **§O terminal completeness gate** — [loop-shared.md §O](loop-shared.md#o-terminal-completeness-gate-drainedone-invariant--reachability-audit) — same contract as `loop.md` Step 10·0. It runs the `stdio ⊆ remote` parity invariant audit, the reachability smoke for newly-added MCP tools through the **remote** proxy path, AND — unconditionally when the repo ships a distributable — an **artifact-level smoke** (prefer the repo's `smoke:global`; else pack → install the tarball to a temp prefix → run the shipped bin from OUTSIDE the repo), and gates the "backlog drained → done" declaration: **"0 open tasks" alone does NOT declare success — a green §O audit is additionally required.** On RED, materialize a remediation task (the §O carve-out to "don't create tasks during the loop") and surface each gap in the `## Coverage Gaps` LOOP-RUN.md section (§5d) instead of announcing a clean drain. Reuse `loop.md` §Step 10 verbatim for the cross-wave audit. The artifact path is `.planning/loops/<UTC-timestamp>-<project_id>-integration.md` (no `-wave<idx>-` suffix — same naming convention `/tasks:loop` uses). The per-wave artifacts from §3f and the run-termination artifact from §4 coexist — disjoint scopes (within-wave vs cross-wave), independently audit-trail-able, both under `.planning/loops/` (gitignored, same rationale as `/tasks:loop`).

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

- **`## Not-Dispatchable Tasks`** — populated when §2g (feasibility gate) or §3a step 7 (previously-PARTIAL guard) flagged tasks as not dispatch-eligible for this run. One bullet per task: `#<id> — <title> — reason: <feasibility|previously-PARTIAL> — <indicator that matched>`. Distinct from `## Stalled Tasks`: stalled = transitively blocked by a FAIL verdict this run; not-dispatchable = filtered out before any dispatch attempt. Sentinel `_No non-dispatchable tasks._` when empty.

- **`## WSJF Ranking`** — the ranking snapshot §3a step 8's WSJF-ordered frontier sort consumed (per-task scores, `effectiveWsjf`, propagation breakdown, γ/CAP). Full table + header + sentinel rules: [loop-shared.md §M](loop-shared.md#m-loop-runmd-wsjf-ranking-snapshot). For a multi-wave run the snapshot reflects the MOST RECENT wave's frontier ranking (rewritten per-wave on the §5b kill-safe re-emission). Sentinel `_No WSJF ranking: project has no WSJF-scored tasks; selection used the priority + ID (or topological) order._` when the project was unscored.

- **`## Aborted`** — present ONLY for non-graceful terminations (per §5f). Absent on clean backlog-drain runs and on clean `--max-waves N` checkpoints. When present, the body holds: `**Termination reason:**`, `**Termination step:**` (§ identifier), `**State at abort:**` (bullet list of MCP calls / claims / commits made), `**Recommended next step:**` (one-line). Format defined in §5f.

- **`## Retained Worktrees`** — emitted by the §5g teardown: one bullet per `worktree-agent-*` branch it did NOT remove (un-integrated work), as `` `<path>` (branch `<branch>`) — <n> un-integrated patch(es); inspect with `git cherry <base> <branch>` ``. Sentinel `_No retained worktrees — all run worktrees were fully integrated and removed._` on a clean run; `_No worktrees created (no isolated workers dispatched)._` when no `isolation: "worktree"` workers ran.

- **`## Coverage Gaps`** — the §4 terminal completeness gate (loop-shared.md §O) result: one bullet per detected invariant/reachability gap (the failing audit/tool + the remediation task id materialized via the §O carve-out), or the sentinel `_No coverage gaps: terminal invariant + reachability audit green._` when the audit was green. Schema + blocking semantics: [loop-shared.md §O](loop-shared.md#o-terminal-completeness-gate-drainedone-invariant--reachability-audit).

### 5e. NOT committed (intentional)

Same rationale as `loop.md` §9e — `.planning/` is gitignored per project policy. LOOP-RUN.md and the per-wave / run-termination integration-audit artifacts are local-machine per-run audit trails, not versioned artifacts. The orchestrator MUST NOT `git add` any `.planning/loops/` artifact, nor modify `.gitignore`.

### 5f. Termination emit (unconditional)

Whatever path the orchestrator takes to termination — §2f gate refusal (FLAT / DAG_CYCLIC), §2g feasibility wipeout (no tasks dispatch-eligible), §3a stall (frontier empty with open tasks remaining), `--max-waves N` checkpoint, clean backlog drain, user-initiated abort, or an unexpected error in any sub-step — the orchestrator MUST emit a final LOOP-RUN.md before exiting. **The audit trail of WHY a run did not complete is at least as valuable as the audit trail of what it did.**

**Mandatory `## Aborted` section** (per §5d) is emitted whenever termination happens via any path EXCEPT:
- Clean backlog-drain (all open tasks reached `done`/`closed`).
- Clean `--max-waves N` checkpoint where N waves all completed without abort signals.

For every other path, the body MUST include:

```markdown
## Aborted

**Termination reason:** <one-line summary>
**Termination step:** <§ identifier — e.g. §2f, §2g, §3a step 9, user-abort-at-§3b>
**State at abort:** counts for topology_check / list_tasks / get_task / claim_task calls, worker + verifier dispatches, and commits made.
**Recommended next step:** <one-line — e.g. "Edit tasks tagged `hand-replay` and re-invoke", "Decompose epic-sized task #X via /tasks:decompose before re-running", "Resolve cycle in DAG (members: …) and re-invoke">
```

For abort paths that fire *after* one or more waves have completed, the `## Aborted` section is APPENDED to the existing body sections; the `## Wave Summary` table keeps its real rows. For abort paths that fire BEFORE any wave (gate refusal, feasibility wipeout, pre-dispatch user abort), `wave_summary` is empty and shows its sentinel paragraph.

**`tasks_attempted` accounting on abort paths:** only counts tasks the orchestrator actually `claim_task`'d (not tasks it merely fetched). A pure §2f-refusal run reports `tasks_attempted: 0`. A run aborted after claiming 2 tasks reports `tasks_attempted: 2` even if no commits landed.

**Crash-tolerance.** The same per-wave incremental rewrite from §5b protects against mid-run kills, BUT termination emit MUST be wrapped in a `try/finally`-equivalent guard so even an exception in the orchestrator code path (e.g. an MCP call throwing) still produces a final LOOP-RUN.md with `## Aborted` set. The orchestrator's "final exit" code MUST be the LOOP-RUN.md write, not any earlier return.

### 5g. Worktree teardown (run-end, kill-safe)

Terminal step — runs ONCE after §5f's emit, on EVERY termination path — to reclaim the `isolation: "worktree"` worker worktrees (§3b) + `worktree-agent-*` branches the harness never auto-removes (a committed/edited worktree is "changed", so it is never auto-cleaned and they pile up across runs). Discovery-based and integration-gated so it can ONLY ever delete fully-integrated leftovers: enumerate via `git worktree list --porcelain` (paths under `.claude/worktrees/`, branches `worktree-agent-*`); for each, `git cherry <base> <branch>` (where `<base>` is the run's integration branch, usually `main`) and remove only when there are **0** not-integrated (`+`) patches — `git worktree unlock` → `git worktree remove --force` → `git branch -D`, then `git worktree prune` once. Branches with ≥1 un-integrated patch are RETAINED and surfaced in the `## Retained Worktrees` LOOP-RUN.md block (§5d), then LOOP-RUN.md is re-emitted (§5b). Idempotent / kill-safe. **Full procedure + the `/tasks:loop` not-affected rationale: [loop-shared.md §N](loop-shared.md#n-worktree-teardown-loop-dag-run-end).**

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

Per §3c, treat the failing task as `NOT_VERIFIED` → tasks-database status `blocked` for THIS run. The remainder of the wave's workers continue uninterrupted — one worker failure does NOT cancel the wave. Downstream tasks (those whose `blocked_by` includes the failed task) stay open and will surface in the run's final `## Stalled Tasks` section.

### Verifier subagent unreachable for repair

Per §3d, follow `loop.md` §7c's hard-fallback exactly: synthesize `NOT_VERIFIED`, add a tasks-database comment citing the §7b violation, preserve the original verifier's parse-failed output verbatim. Do NOT re-dispatch a fresh verifier — fresh dispatches lack the original verifier's tool-call context and will fabricate checks.

### Per-wave integration audit surfaces BROKEN

Per §3f → §10e BROKEN-revert protocol from `loop.md`: flip the affected tasks back to `in_progress`, preserve PASS evidence, append `integration_concern` notes, re-emit LOOP-RUN.md with a `## Integration Failure` body section. Subsequent waves WILL re-encounter the reverted tasks on the next frontier (because they're back to `in_progress`/`open` and their `blocked_by` is still satisfied), so the loop will re-attempt them in a later wave. This is the load-bearing recovery property — BROKEN overlaps are NOT permanent failures, just retryable ones.

### Stalled tasks (frontier empty but open tasks remain)

Per §3a, surface the stall in the final LOOP-RUN.md `## Stalled Tasks` section. Do NOT try to force-unblock by closing tasks the verifier failed; the FAIL was the verifier's honest judgment and the orchestrator MUST NOT override it (this is the same generator/critic-separation rule `loop.md` Important Rules pins).

### `topology_check` returns something other than FLAT / DAG / DAG_CYCLIC

Defensive halt. Emit a comment in the tasks project's top-level discussion (`add_comment` on the highest-ID open task as a proxy — there is no project-level comment API) citing the unexpected topology value verbatim, then exit. This should be impossible per `TopologyService`'s contract; if it happens it is a data-shape bug worth a separate task.

---

## Important Rules

- **Generator/critic separation.** Same load-bearing rule as `loop.md`. The orchestrator MUST dispatch a SEPARATE `tasks-verifier` subagent per worker (per §3d) and a SEPARATE `integration-auditor` per overlap (per §3f / §4). The orchestrator MUST NOT grade its own dispatches, and MUST NOT author `verification_evidence` itself — `verifier_session_id` is always a separately dispatched verifier's id, never the orchestrator's own session and never a literal like `"orchestrator"` / `"self"` / `"main-loop"`. UPGRADES (FAIL→PASS, etc.) MUST come from a freshly re-dispatched verifier, never from orchestrator observation.
- **Anti-fabrication (load-bearing).** Every evidence value — SHA, row count, dollar figure, exit code, verdict, message count — is quoted verbatim from a tool result that already returned in a prior turn; never composed, predicted, or asserted in the same turn as the producing call (see §3d). Perform at most ONE state-producing action per turn during verify/commit and let it return before citing its result — even though waves dispatch workers/verifiers in parallel, you never quote a not-yet-returned result. _Motivating incident (2026-05-31, project 28 via `/tasks:loop-dag`): an orchestrator batched dependent calls in one message and pre-wrote their results — non-existent git SHAs, metrics it never observed, a wrong exit code, an invented row count — then self-graded with `verifier_session_id="orchestrator-…"` instead of dispatching a verifier. This rule closes that hole._
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

---

## 6. Inline Reference Summaries (compressed — point at canonical sources)

The load-bearing templates this skill needs are owned by **[loop-shared.md](loop-shared.md)** (shared with `/tasks:loop`); the per-wave control flow is owned by **`loop.md`**. The 1-3 line summaries below tell the orchestrator WHERE to look mid-run without having to re-derive the structure.

### 6a. Worker brief template

Dispatch via `Agent` with `subagent_type: "general-purpose"` and `name: "worker-task-<id>"` (the `name:` is REQUIRED — mirrors `loop.md` §7b's verifier-`name:` rule so SendMessage can reach a single worker mid-wave). Brief body: **[loop-shared.md §A](loop-shared.md#a-worker-brief-template)** verbatim, adapted to the task. Closing rule MUST include "Do NOT run `git commit` or `git push`" so the orchestrator owns the commit SHA the verifier will reference.

### 6b. VerifierInputs envelope

Envelope construction + `acceptance_criteria` resolution order + scope-narrowing carve-out: **[loop-shared.md §B](loop-shared.md#b-verifierinputs-envelope-spec)**. Verifier dispatch is `subagent_type: "general-purpose"` with `name: "verifier-task-<id>"` (REQUIRED for SendMessage parse-repair, per `loop.md` §7b). Parse-failure auto-repair patterns: **[loop-shared.md §G](loop-shared.md#g-verifier-parse-failure-patterns)**.

### 6c. Verdict branch outcomes

| Verdict | Tasks-DB update | Commit action | Downstream effect |
|---------|----------------|---------------|-------------------|
| **PASS** | `update_task → status=done`, write evidence | `git add` + `git commit` + `git push` | Downstream becomes frontier-eligible. |
| **FAIL** | `update_task → status=blocked`, write evidence | none | Downstream stays open, never frontier-eligible this run. |
| **PARTIAL** | `update_task` (status stays `in_progress`), write evidence | none | Downstream stays open. PARTIAL ≠ satisfaction. |
| **NOT_VERIFIED (verifier-emitted)** | `update_task` (status stays `in_progress`), write evidence + comment | none | Downstream stays open. Same as `loop.md` §7d — backfill ACs and re-queue. |
| **NOT_VERIFIED (dispatch failure — §3c crash/timeout/parse-fail)** | `update_task → status=blocked`, write synthesized evidence | none | Same as FAIL for THIS run. |

Full PASS commit-message template, close-out comment shape, and declared-scope carve-out: see `loop.md` §Step 6 / §Step 8 / §7d and **[loop-shared.md §E](loop-shared.md#e-declared-scope-narrowing-carve-out)** + **[loop-shared.md §I](loop-shared.md#i-step-8-close-out-comment-template)**. **Generator/critic separation (load-bearing):** orchestrator MUST NOT grade the worker's output; UPGRADES (FAIL→PASS, etc.) MUST come from a freshly re-dispatched `tasks-verifier`.

### 6d. LOOP-RUN.md frontmatter

14 required fields enumerated in **[loop-shared.md §C](loop-shared.md#c-loop-runmd-frontmatter-required-fields)**. Two skill-specific notes: `subagents_dispatched` counts workers + verifiers + integration-auditors across ALL waves; `gate_decision ∈ {"allowed", "blocked"}` only — this skill NEVER writes `auto_ordered`/`overridden` (those are `/tasks:loop`-only per B1 in §2f).

### 6e. Integration-auditor overlap detection

INTEGRATION-AUDIT.md artifact schema (frontmatter + per-overlap body block): **[loop-shared.md §D](loop-shared.md#d-integration-auditmd-schema)**. Overlap definition + generated-file exclusion list + per-overlap dispatch + BROKEN-revert protocol + empty-overlap suppression: see `loop.md` §10b–§10e (the contract `/tasks:loop-dag` §3f / §4 reuses verbatim, scoped per-wave for §3f and run-wide for §4).
