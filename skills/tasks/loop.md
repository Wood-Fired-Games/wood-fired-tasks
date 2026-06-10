---
name: loop
description: Autonomous backlog-drain loop. A single orchestrating context picks the highest priority open task from a Wood Fired Tasks project, dispatches a subagent to implement the fix, independently re-validates with the project's build/test/smoke commands, closes the task, commits, pushes, and continues. Use when the user wants to drain an open backlog hands-off without filling the main context with implementation noise.
argument-hint: [project-name] [--max-tasks N]
disable-model-invocation: false
---

# Task Loop Workflow

You are the **orchestrator** of an autonomous backlog-drain. Your job is *not* to implement fixes yourself — your job is to **plan, dispatch subagents, verify, and commit**, so this single context stays clean and consistent across many task iterations.

The loop is project-agnostic. Validation commands (`build`, `test`, `smoke`) and domain-spec docs are discovered from the target repository's conventions, not hardcoded.

> **Mental model.** Think of yourself as the foreman, not the carpenter. Each task: hand a self-contained brief to a fresh subagent (the carpenter), then independently re-check the work before signing it off. Your context only holds the *plan, summaries, and verification results* — never raw build logs, file scans, or trial-and-error.

## Preflight: identity + MCP tools

**Resolve a real identity** before any `assignee` (on `claim_task`) or `author` (on `add_comment`) field — do NOT pass the literal `"user"` (that destroys cross-machine audit attribution). In priority order: (1) `git config user.email`, (2) `$USER`, (3) `claude-<model>-<purpose>` (e.g. `claude-opus-4.7-loop`). Pick once at top of invocation and capture as `$ASSIGNEE` (used for both `assignee` and `author` throughout this run). Detailed enforcement rules already embedded in the worker-brief / claim / comment sections below — this block is the canonical pointer.

This skill calls tools on the `wood-fired-tasks` MCP server. Shorthand `wood-fired-tasks:<tool>` ↔ harness name `mcp__wood-fired-tasks__<tool>`. On `InputValidationError`, load via `ToolSearch` (`select:mcp__wood-fired-tasks__list_projects,mcp__wood-fired-tasks__list_tasks,mcp__wood-fired-tasks__get_task,mcp__wood-fired-tasks__get_comments,mcp__wood-fired-tasks__get_dependencies,mcp__wood-fired-tasks__claim_task,mcp__wood-fired-tasks__update_task,mcp__wood-fired-tasks__add_comment,mcp__wood-fired-tasks__topology_check,mcp__wood-fired-tasks__wsjf_ranking,mcp__wood-fired-tasks__wsjf_health,mcp__wood-fired-tasks__resolve_model,mcp__wood-fired-tasks__list_models`) and retry. (`wsjf_ranking` is consumed by Step 1's WSJF-ordered selection; `wsjf_health` by §2g's loop-start health surfacing; `resolve_model` / `list_models` by the Step 4 / §7b dispatch-model resolution per [loop-shared.md §R](loop-shared.md#r-model-resolution).)

---

## 1. Argument Parsing

Parse `$ARGUMENTS` — or, when invoked via natural language ("loop the backlog on project X", "drain project X"), extract the equivalent fields from the request:

- `[project-name-or-id]` — if the value starts with `#` or is a bare integer, treat it as the project ID and skip the name match. Otherwise, do a case-insensitive partial match against project names.
- `--max-tasks N` — optional. Stop the loop after N successful task closures and check in with the user before continuing. Default is **3**. Pass `--max-tasks 0` to loop until the backlog is empty (only do this if the user explicitly asks for unattended drain). If the user invokes via natural language and doesn't state a budget, default to **3** but propose an adjustment in Section 2e if the backlog looks epic-sized.
- `--i-know-what-im-doing` — optional opt-out of §2f's auto-ordering. When the project's `topology_check` returns `DAG` (acyclic dependency edges), the loop by default computes a topological execution order and proceeds (Wave 11; supersedes the Wave 4.2 / #319 halt behaviour). Pass `--i-know-what-im-doing` to **skip** the topological sort and fall back to plain priority + ID ordering — recorded as `gate_decision: overridden` in the LOOP-RUN.md frontmatter, with a loud warning in the first prompt. The flag is **tolerated for `DAG`** topology only. It is **explicitly rejected for `DAG_CYCLIC`** — a cycle must be broken before any runner can proceed, no exceptions. (The flag's original purpose — override the pre-Wave-11 halt — is moot now that the DAG branch auto-resolves; the flag is retained so existing invocations keep parsing and so users can force flat ordering for diagnostic runs.)

- `--execution-model <ref>` / `--validation-model <ref>` / `--planning-model <ref>` — optional. Force a single model ref for every worker / verifier / planning dispatch this run, bypassing per-project/per-category `resolve_model` for that role. `<ref>` accepts a concrete model id or `auto`. Resolution + dispatch-time fallback: [loop-shared.md §R](loop-shared.md#r-model-resolution).

**If no project name/ID is provided:** ask the user. Do not pick one silently.

### Resolve Project ID

Call `wood-fired-tasks:list_projects`, match the argument (by ID if numeric/`#`-prefixed, else by name), store `project_id` + `project_name`. If no match, list available projects and stop.

---

## 2. Pre-Loop Discovery (run ONCE, before any task is touched)

This is the most important section. Skipping any sub-step here causes the entire loop to misbehave.

### 2a. Read the project's domain spec doc(s)

Look for one or more spec docs that the tasks reference:

- A doc named in the project's description (e.g. `docs/CODE_QUALITY_ROADMAP.md`).
- `README.md`, `ROADMAP.md`, `ARCHITECTURE.md` at the repo root.
- ADRs / PRDs / SPECs under `docs/`, `.planning/`, or similar.

**Read these in full once.** They are the source of truth subagents will need excerpts from. Keep mental notes — section numbers, line ranges, acceptance-criteria patterns — so you can quote them in subagent briefs without re-reading.

If the loop is non-trivial (≥ 2 tasks) and the spec doc is large (>200 lines), externalize the mental notes into a short cache file at the repo root (e.g. `.tasks-loop-spec-excerpts.md`) with one entry per likely-referenced section: doc path + line range + 1-line summary + which task IDs probably need it. Later loop iterations pull from the cache instead of re-deriving section/line refs from memory. Add the cache path to `.gitignore` if not already covered.

**Cross-repo scope detection** (canonical block — §2c, §2e, §2f, and Step 4 all defer here; this is the ONLY site that describes the rules). While reading the open task list, scan each task's `description` + `acceptance_criteria` for absolute paths that point OUTSIDE the CWD repo. The orchestrator looks up the project's **canonical sibling-repo set** — this is a project-level convention, NOT a hardcoded universal — from (in order):

1. The repo's own `.tasks-loop-memo.md` (if §2b wrote one in a prior run).
2. `AGENTS.md` / `CLAUDE.md` / `README.md` for an explicit "sibling repos" or "monorepo neighbours" section.
3. The user, if neither source declares the set.

For each candidate sibling path, match BOTH the leading-`~` form AND the expanded `$HOME/...` form (task descriptions often mix the two). A path match in either the `description` or `acceptance_criteria` field flags the task as **sibling-repo-targeted** and records the target repo(s) alongside the task ID in the same mental notes / cache file from the previous paragraph (`cross_repo: [<abs path>, ...]` per task). A task may target more than one sibling repo — collect them all.

> **Example** — Wood Fired Games' canonical sibling-repo set: `~/wood-fired-engine`, `~/wood-fired-platform`, `~/wood-fired-docs`, `~/project-brogue`, `~/wood-fired-thought-capture`, `~/.claude`, `~/.local` (match both leading-`~` and expanded `/home/<user>/...` forms). Substitute whatever set is documented in YOUR project's conventions; the list is illustrative, not a baked-in constant.

If the sibling-repo classification ends up non-empty — including via user-confirmed soft-signal matches from the next sub-block — §2c will baseline tests in EVERY detected repo (not just CWD) and Step 4 briefs will carry the per-repo working dir + baseline numbers. If the set is empty, the rest of the loop behaves as before — single-repo. Either way, record the outcome (even if it's "no sibling-repo tasks detected") so future readers of the cache know the scan ran.

**Soft-signal matching for schema-coupled identifiers** (extends the absolute-path scan above). Real-world sibling-repo dependence often hides behind schema-coupled identifiers that never literally appear as a path in the task text:

- DB **view names** (frequently a `*_v` suffix convention).
- DB **table names** (often a domain prefix like `agent_`, `task_`, `analytics_`).
- **Migration file references** of the form `<timestamp>-<slug>.up.sql`.
- Shared **schema versions**, **package identifiers**, or **service names** that the project's conventions tie to a sibling repo.

In addition to the absolute-path matching above, the orchestrator SHOULD do a second-pass scan of each task's `description` + `acceptance_criteria` for schema-coupled identifiers using patterns documented in the project's own conventions. Look up the patterns in the same order as the sibling-repo set: (1) the repo's `.tasks-loop-memo.md` (if §2b wrote one in a prior run), (2) `AGENTS.md` / `CLAUDE.md` / `README.md` for an explicit "schema conventions" or "sibling-repo identifiers" section, (3) the user, if neither source declares the patterns.

**Soft-signal matches are weaker than path matches — they do NOT automatically classify the task as sibling-repo-targeted.** Instead, the orchestrator MUST surface each soft-signal match to the user with a one-line confirmation prompt before classifying:

> "Task #<id> may touch sibling repo `<path>` (matched `<identifier>` against `<convention>` from `<source>`); is it?"

Only after the user confirms YES does the orchestrator record the match in the same mental notes / cache file under `cross_repo: [<abs path>, ...]` for that task. A NO answer is recorded too (so the same identifier doesn't re-prompt on the next loop iteration).

> **Example** — illustrative, not a baked-in pattern: Wood Fired Games' analytics DB uses a `*_v` view-name convention (e.g. `agent_events_v`, `agent_transactions_v`, `loop_runs_v`), and those views live in `~/wood-fired-engine/tooling/wfg-cc-telemetry`. A task description that mentions `agent_events_v` without spelling out the absolute path would soft-match this convention and prompt: *"Task #<id> mentions `agent_events_v` — this matches the `*_v` analytics-DB view convention (source: `AGENTS.md`); does this task touch `~/wood-fired-engine/tooling/wfg-cc-telemetry`?"* Substitute whatever schema-coupling conventions are documented in YOUR project — the `*_v` pattern is shown as an example the orchestrator looks up from project conventions, not a hardcoded universal.

**Per-task working-directory rule for sibling-repo tasks.** Step 4 briefs MUST `cd <abs path>` before any edits or validation runs when the task is flagged for a sibling repo. The brief carries the per-repo baseline numbers from §2c so the worker can tell its own regressions apart from pre-existing flakes. (Embedded in the brief template body — see [loop-shared.md §A](loop-shared.md#a-worker-brief-template) "Working dir / Cross-repo context" subsection.)

**Declared scope narrowing detection (design-only landings, slice-of-epic, etc.).** A task's *intent* may be narrower than its acceptance-criteria text suggests (precedents: Wave 5 / #320 `/tasks:decompose`, Wave 7.1 / #323 `/tasks:audit` — both landed design-only). When the orchestrator decides at planning time (Step 3) to narrow scope, it MUST record a `scope:` annotation against the task in the same cache file used by the sibling-repo scan. **Full annotation fields (label, in-scope bullets, deferred bullets, follow-on task IDs), the planning-judgment detection signals, and the "MUST NOT silently narrow" rule live in [loop-shared.md §H](loop-shared.md#h-declared-scope-narrowing-detection).** The annotation is the prerequisite for the Step 7d declared-scope carve-out — without it, the carve-out does NOT apply.

### 2b. Discover validation commands

Read project conventions from (in order):

1. `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` at repo root.
2. `package.json` `scripts`, `Makefile`, `*.sln`, `pyproject.toml`, etc.
3. `README.md` Development / Testing sections.
4. Existing CI workflows (`.github/workflows/*.yml`) — these reveal what the team treats as canonical gates.
5. Ask the user once if none of the above are conclusive.

Build a per-task validation matrix you can reuse:

| Change type | Validation depth |
|-------------|-----------------|
| Doc-only | build (sanity), tests (regression). Skip smoke. |
| Tooling / config (lint, deps, CI) | build, tests, plus the new tooling's own check. |
| Type-only refactor | build (stricter), tests. Skip smoke unless behavior could change. |
| Runtime / API / DB change | build, tests, smoke. |
| Migration | build, tests, smoke, plus migration round-trip. |

Record this matrix as a short memo. If the loop is non-trivial (≥ 3 tasks), **write the memo to `.tasks-loop-memo.md` at the repo root** so subagents you spawn can read it without you re-explaining. Add the memo path to `.gitignore` if it isn't already covered.

### 2c. Baseline the test suite

**Before touching anything, run `<build>` and `<test>`** and confirm they pass on the unchanged tree. If they don't, the loop must not start — pre-existing breakage will be attributed to the first task and stall everything.

**Trust the exit code, not the summarizer prose.** `bash-summarize` and `ask-local` are **optional** local CLI wrappers that summarize long output / file reads to keep context clean — *not* dependencies. If they aren't installed (`command not found`), ignore every mention of them and use plain `Bash` / `Read`; the loop works identically. Read every "prefer `bash-summarize`/`ask-local`" below as "use if available, else plain `Bash`/`Read`." When you do use `bash-summarize`, it will sometimes prominently flag stderr noise from tests that exercise error paths (e.g. `error: required option '-a, --assignee <name>' not specified` from a CLI argparse fixture). If the exit code is 0 *and* the headline test count matches expectation, the suite is green regardless of how scary the summary reads. Re-run with raw output only if the headline numbers are missing or contradict the exit code.

If the suite is already red:

1. Surface the failure to the user: list each failing test, its file, and a one-line guess at cause.
2. Ask whether to (a) fix the pre-existing breakage as a separate housekeeping commit before the loop starts, or (b) abort.
3. Do not start the loop until the suite is green.

**Sibling-repo baselining (when §2a flagged ≥ 1 task as targeting a sibling repo — see §2a "Cross-repo scope detection" for the canonical rules).** The CWD baseline above is necessary but NOT sufficient. The orchestrator MUST baseline tests in EVERY repo that appears in any task's `cross_repo: [...]` set from §2a — not just CWD. Without this, pre-existing flakes in a sibling repo will get attributed to whichever subagent first cd's into it, and the loop will stall mid-flight when verification fails on a flake the orchestrator never saw coming. (Real-world failure mode: Wave 1 drain of project 15 was invoked from `wood-fired-tasks` but tasks #309 / #310 lived in `wood-fired-engine/tooling/wfg-cc-telemetry`; CWD baseline ran clean, sibling-repo baseline never ran, and 3 pre-existing E2E flakes — `RestartIdempotency`, `ShimSocket`, `ShimLatency` — only surfaced during #309 verification mid-loop.)

For each unique sibling repo `R` in the union of all `cross_repo` sets:

1. Discover that repo's `<build>` and `<test>` commands using the same §2b heuristics (`CLAUDE.md`/`AGENTS.md`, `package.json`/`*.sln`/`Makefile`, README, CI workflows). Do NOT assume CWD's commands transfer — sibling repos may use a different stack.
2. Run the repo's `<build>` then `<test>` from `R` as cwd. Capture the exit codes and the headline pass/fail counts.
3. Record the per-repo result alongside the §2a classification: `{repo: <abs path>, build_status: <ok|fail>, test_status: <ok|fail>, test_baseline: "<N passing, M failing>", known_flakes: [<test names>]}`. This becomes the "per-repo flake landscape" that Step 4 briefs cite.

**Surface failures per-repo before dispatching the first worker.** If ANY sibling repo's baseline is red, the orchestrator MUST surface the failures grouped by repo (one section per repo, listing failing test names + one-line cause guess) and ask the user whether to (a) housekeeping-fix each red repo before the loop, (b) proceed with the failing tests pinned as `known_flakes` so Step 4 / Step 5 don't re-flag them, or (c) abort. Do NOT silently treat a sibling-repo failure as the worker's fault later — it isn't.

**Pre-loop sibling-repo state concerns.** For each sibling repo `R` in the §2a-flagged set, ALSO check:

1. `git -C <R> status --porcelain` — if non-empty, the repo has uncommitted local changes. Surface as a pre-loop concern (the loop may interact badly with the user's in-flight work — e.g. a worker may run `git stash` or commit alongside unrelated dirty files).
2. `git -C <R> rev-parse --abbrev-ref HEAD` — if the result is NOT `main`, the repo is on a feature/topic branch. Surface as a pre-loop concern (the loop typically targets `main`; landing commits on an unintended branch is hard to undo).

The orchestrator MUST NOT auto-stash, auto-switch branches, or otherwise mutate the sibling repo's working tree. Just surface the concerns grouped by repo with a one-line description each, and let the user decide whether to proceed, fix the state, or abort. Example surface:

> Sibling-repo state concerns before loop start:
> - `~/wood-fired-engine`: 3 uncommitted files (`tooling/wfg-cc-telemetry/...`); current branch is `feat/telemetry-redesign` (not `main`).
> - `~/.claude`: clean tree, on `main` — no concerns.
>
> Proceed anyway (worker may interact with in-flight work), pause for user to clean up, or abort?

**Known-flake exclusions via `.flaky-tests.json`.** Repos with chronically flaky tests opt in to first-class flake handling by committing a `.flaky-tests.json` at the repo root. **Full schema (versioned envelope), per-runner exclude-by-FQN filter table, auto-application rule, candidate-for-promotion rule, and the reinforcement that unknown failures still trigger pre-existing-breakage policy — all live in [loop-shared.md §F](loop-shared.md#f-flaky-testsjson-handling).** The orchestrator MUST read each baselined repo's `.flaky-tests.json` and feed its entries into that repo's `known_flakes` record (file is authoritative; union with any ad-hoc user-confirmed flakes).

**Brief-template embedding rule.** When dispatching a Step 4 subagent, the orchestrator MUST embed the "Test filter cheat sheet" block from the brief template (see [loop-shared.md §A](loop-shared.md#a-worker-brief-template)) in any brief whose target cwd matches the .NET (`.sln` / `.csproj` / `global.json`) or Node-vitest (`package.json` with `vitest` in deps) detection — the cheat sheet is what stops the subagent from guessing MTP filter syntax mid-run.

### 2d. Verify your own skill additions (if applicable)

If you (the assistant) **added or modified `skills/tasks/*.md` or other repo files as part of this same session**, the very first validation run will tell you whether those additions broke something. Treat any failure here as a housekeeping commit (separate from any task in the project) before the loop proper. Example: a new skill that references an MCP tool the test suite's `KNOWN_*` set doesn't know about, or a hardcoded skill-file count that's now off-by-one.

### 2e. Identify task-size mismatch (advisory)

> Sibling-repo scope is detected separately in §2a (the canonical "Cross-repo scope detection" block) and baselined in §2c; this sub-section is only about epic vs. bug sizing within whatever repo set §2a produced.

Scan the open task list for signals that tasks are **epic-sized rather than bug-sized**:

- Description contains "Acceptance criteria:" with 3+ bullets.
- Description references a multi-phase roadmap document.
- Tags include `roadmap`, `epic`, `milestone`, `phase`.
- `parent_task_id` is null but the task title sounds like a workstream ("Add ESLint and formatter quality gate", "Strengthen migration safety", etc.).

If most open tasks fit those signals, surface this to the user before starting — *unless* the project name or description itself contains the words `roadmap`, `phase`, or `epic` (the user already knows the shape). In the self-identifying case, skip the "are you sure?" framing and ask only for the budget number:

> Project self-identifies as a roadmap. Recommend `--max-tasks=1` (one epic-sized commit per run, with a checkpoint between). Confirm budget (1, 2, or 3) and I'll proceed.

In the non-self-identifying case (you discovered the epic shape but the user didn't telegraph it), use the longer framing:

> The backlog looks epic-sized (e.g. roadmap phases) rather than bug-sized. The smash loop will still work, but each iteration will spawn a long-running subagent and produce a substantial commit. Confirm `--max-tasks N` is set sensibly (recommend 1–3 for epics, 5–10 for true bugs) and that you want me to proceed.

### 2f. Topology pre-flight gate

Wave 4.2 (task #319) introduced this gate as a halt-on-DAG safety net; Wave 11 makes the DAG branch **auto-resolve** (compute a topological execution order and proceed rather than halt). Cycles still halt unconditionally — they are unresolvable. The historical halt message remains documented below for diagnostic continuity and is exercised when the user opts out via `--i-know-what-im-doing`.

Before entering §3 The Loop and BEFORE dispatching any worker, the orchestrator MUST call the `topology_check` MCP tool with `{project_id}` and branch on the returned `topology` field. **Fallback when `topology_check` is unavailable** (the tool is CONDITIONALLY registered — `src/mcp/server.ts` omits it when no `topologyService` is wired): do NOT assume a value was returned. Derive the topology yourself from per-task `wood-fired-tasks:get_dependencies` edges (or the `tasks topology` CLI), classify it as FLAT / DAG / DAG_CYCLIC, and branch identically; cache the derived edge list for §2f's Kahn sort so it is not re-fetched.

Record the branch outcome in orchestrator state as `gate_decision` for inclusion in the LOOP-RUN.md frontmatter (Step 9). Log the gate decision in the orchestrator's first prompt so a transcript reader sees what was decided and why.

**Branches:**

- **`topology: "FLAT"`** → set `gate_decision = "allowed"`. Proceed to §3 The Loop. Step 1 uses the default priority + ID ordering. No topological sort needed; this is the canonical zero-edges case.

- **`topology: "DAG"`** — check whether the invocation arguments include the `--i-know-what-im-doing` flag (see §1 Argument Parsing).
  - If the flag is **NOT** present → set `gate_decision = "auto_ordered"`. Compute the topological execution order described in **"Topological execution order"** below and proceed to §3 The Loop. Step 1 consumes the precomputed order. Log a one-line note in the first prompt naming the count of dependency edges + first 3 ordered task IDs so the transcript reader sees what was decided.
  - If the flag **IS** present → set `gate_decision = "overridden"`. Skip the topological sort; Step 1 falls back to the default priority + ID ordering. Emit a **loud warning** in the orchestrator's first prompt (e.g. `"WARNING: --i-know-what-im-doing override accepted; skipping topological sort on a DAG with K dependency edges. Tasks may run out of dependency order."`). The override is logged so the human reviewing LOOP-RUN.md sees the explicit opt-in.

    For backward-compatibility with pre-Wave-11 readers and tooling, the canonical pre-Wave-11 halt message remains documented here even though it is no longer emitted by default. It is preserved verbatim so downstream parsers that scan LOOP-RUN.md transcripts for the historical text still find it:

    ```
    Project <id> has <count> dependency edges. Use /tasks:loop-dag (for wave-by-wave parallel dispatch) or run tasks individually in topological order. Override with --i-know-what-im-doing.
    ```

- **`topology: "DAG_CYCLIC"`** → set `gate_decision = "blocked"` unconditionally. HALT the loop immediately. Do NOT dispatch any worker. The `--i-know-what-im-doing` flag **MUST NOT override** this branch — a cycle in the dependency graph means there is no topological order any runner could follow, so cycles must be broken before any runner can proceed. Emit this message verbatim, substituting the real project id:

    ```
    Project <id> has a dependency cycle (DAG_CYCLIC). Cannot loop — cycles must be broken before any runner can proceed. --i-know-what-im-doing does NOT apply.
    ```

**Topological execution order** (computed when `gate_decision = "auto_ordered"`):

The orchestrator computes the execution order itself — this is mechanical graph work that does not need a subagent and does not need user confirmation. Sorting a DAG is the kind of problem computers solve perfectly; do it.

1. Fetch all open tasks for the project via `wood-fired-tasks:list_tasks` with `status=open` and `limit=200`. Capture `id`, `priority`, `created_at` per task.
2. Take the edge list from `topology_check.edges`. Each `{from, to}` edge means "task `from` must complete before task `to`" — i.e. `to` depends on `from`.
3. Reduce the graph to the relevant set:
   - If the user specified a curated subset of task IDs in the invocation (e.g. `project 15 329, 331, 332`), restrict the node set to those IDs. Drop edges whose `from` endpoint is outside the curated set — those external dependencies are treated as already-satisfied (the user has implicitly opted out of them by curating). Log a one-line note in the first prompt naming the dropped external dep IDs so the user can sanity-check.
   - Otherwise, restrict to the open-task set. Drop edges whose `from` endpoint is `done` or `closed` (already satisfied) or missing from the open-task list.
4. Run **Kahn's algorithm** to produce the order:
   - Compute in-degree per node within the filtered graph.
   - Initialize the ready queue with nodes whose in-degree is 0.
   - At each step, tie-break the ready queue by: **priority DESC** (`urgent` > `high` > `medium` > `low`), then **`created_at` ASC** (older first), then **`id` ASC**.
   - Pop the highest-ranked ready node, append it to the output order, decrement in-degree of its successors, and push any newly-zeroed successors onto the ready queue.
   - Repeat until the queue is empty.
5. If at the end any node still has non-zero in-degree, there is a residual cycle in the filtered graph (which `topology_check` should have caught — surface this as a bug and HALT with `gate_decision = "blocked"` to be safe).
6. Store the resulting order as orchestrator state for Step 1 to consume.

For small graphs (≤ 30 nodes) compute this in-head or with one short Bash invocation; for larger graphs prefer piping the edges + tasks through a Node/Python one-liner. Correctness matters more than tool choice — but the orchestrator MUST NOT ask the user to do this work. The user invoked the loop precisely to skip this kind of bookkeeping.

**Blocked-branch behaviour:** when `gate_decision = "blocked"`, the orchestrator does NOT enter §3 The Loop, does NOT claim any task, and does NOT dispatch a worker. Step 9 (LOOP-RUN.md emit) is still permitted — emit a single LOOP-RUN.md with `gate_decision: blocked`, `tasks_attempted: 0`, and the empty-body sentinels — so the run is auditable. Step 10 (integration audit) is skipped (no worker sessions means no overlaps to audit).
### 2g. WSJF health surfacing (loop start)
Run ONCE, after §2f's gate is decided and BEFORE the first Step 1 selection. Probe `wood-fired-tasks:wsjf_health` with `{ project_id }` — the non-blocking spec §9 degeneracy / pitfall linter (pure read; writes nothing). It returns `{ healthy, scored_task_count, findings[] }`; each entry in `findings[]` carries `check`, `severity` (`info` | `warning` | `critical`), `message`, and `suggestion`. **`healthy: true`** → one-line `"WSJF health: OK (<scored_task_count> scored task(s), no degeneracies)."` and proceed. **`findings[]` non-empty** → print a `WSJF Health` block in the first prompt listing each as `- [<severity>] <message> Fix: <suggestion>`, ordered `critical` → `warning` → `info`, warning the operator that the WSJF ordering Step 1 consumes may be degenerate (near-identical scores, or a past-deadline task with stale Time Criticality). The findings are **advisory only — they NEVER block the loop**, never change the gate decision, and never auto-rescore. If `wsjf_health` is unavailable (CONDITIONALLY registered — `src/mcp/server.ts` omits it when no linter is wired), skip this surfacing silently and proceed to §3.

---

## 3. The Loop

For each iteration, the orchestrator goes through **ten steps**. Do not skip ahead. Steps 1–9 run per iteration; **Step 10 runs ONCE at loop termination** (after the budget is hit or the backlog drains) — it is the only terminal step.

### Step 1 — Pick the next task

```
wood-fired-tasks:list_tasks with project_id=<id>, status=open
```

Task selection depends on the `gate_decision` recorded in §2f:

- **`gate_decision = "allowed"`** (FLAT topology) or **`gate_decision = "overridden"`** (DAG with explicit opt-out) → sort by **priority** (urgent > high > medium > low), then by **task ID ascending** (oldest first). This is the default flat ordering. **WSJF override — see "WSJF-ordered selection" below: if the project carries ≥ 1 WSJF-scored task, this priority+id sort is replaced by the `wsjf_ranking` order.**
- **`gate_decision = "auto_ordered"`** (DAG, auto-resolved) → pop the next task from the head of the topological execution order computed in §2f. The order already encodes priority + age + id tie-breaking; do NOT re-sort. If the head task is already claimed / `done` / `closed` (race with a concurrent runner), skip it and pop the next; do not fall back to the flat sort. (WSJF ordering does NOT apply here — `auto_ordered` already respects the dependency topology; re-sorting by WSJF would violate `blocked_by` edges. The topological tie-break stays priority + age + id.)

**WSJF-ordered selection (replaces the priority + ID sort when the project is WSJF-scored).** Under `gate_decision ∈ {"allowed", "overridden"}`, before applying the default sort, probe the `wsjf_ranking` MCP tool (scope from the §2f gate: `"frontier"`). **If ≥ 1 returned `ranking[]` entry has `scored: true`**, consume that order head-first (it is pre-sorted descending by `effectiveWsjf`, unscored tasks placed via `priorityFallbackScore`, ties by created_at/id) and record the snapshot per §M. **If NO entry is scored**, fall back to the **priority + ID ordering UNCHANGED** (the probe is a no-op). WSJF is strictly opt-in. Full procedure + scope-derivation table: [loop-shared.md §M](loop-shared.md#m-loop-runmd-wsjf-ranking-snapshot).

In all cases: skip tasks already claimed by someone else. Skip tasks whose `get_dependencies` shows unresolved `blocked_by` — mark them `blocked` and move on. (Under `auto_ordered`, this should NOT fire for in-set dependencies — the order guarantees them satisfied — but it can still fire for external deps the user curated out, or for race conditions with a concurrent runner.)

If `list_tasks status=open` returns empty, announce completion and exit. If you've hit `--max-tasks N` for this run, stop and summarise for the user instead of continuing.

**Deduplicate:** if multiple tasks share a root cause, pick the lowest ID and close the rest with a back-reference after the fix lands.

### Step 2 — Claim and read

```
wood-fired-tasks:claim_task with task_id=<id>, assignee=<your agent name>
wood-fired-tasks:get_task with id=<id>
wood-fired-tasks:get_comments with task_id=<id>
wood-fired-tasks:get_dependencies with task_id=<id>
```

Read the task description carefully. Extract:

- **Acceptance criteria** (often a list under "Acceptance criteria:" in the description).
- **Linked docs** — any references to roadmap sections, ADRs, line ranges.
- **Constraints** mentioned in the description ("avoid unrelated refactors", "warning-free", "don't bulk-reformat", etc.).

### Step 3 — Plan the validation depth and pre-scan scope

Using the matrix from Section 2b, decide what validation the orchestrator will run after the subagent returns. Doc-only? Tests only. Runtime? Build + tests + smoke. Be explicit about this *now* so the subagent brief in Step 4 specifies the same depth.

**Pre-scan the scope when the task's acceptance criteria are broad.** If the task says "replace X" or "add Y across the codebase" without naming sites, run a quick `grep` / `find` *yourself* to enumerate the actual sites *before* writing the brief. Concrete site counts ("4 `Record<string,any>` sites at these exact lines") let you scope the slice and write a tight brief. Vague briefs ("find and replace broad anys") cause subagents to drift or over-reach. This pre-scan should be light — read-only, under a minute, no edits. **Pre-scan failure modes — try multiple patterns.** A single `grep` is brittle: if a dep is installed but `from 'dep'` returns 0 hits, the import may be via a wrapper (`from '@dep/integration'`), a default-export rename, a namespace import (`import * as fc from 'dep'`), or a re-export through a local barrel. Before stating "X doesn't exist" in a brief, try at least: the dep name without an import keyword, common wrapper namespace forms (`@<dep>/`), and a `find` for the conventional test file pattern (e.g. `*.property.test.ts`). A confident "absent" finding in the brief that's wrong wastes subagent time and forces a re-brief.

**Welcome subagent corrections.** If the subagent's report contradicts a factual claim in the brief (e.g. "property tests already exist — the real gap is X"), the subagent is usually right. They had time to investigate; the orchestrator had time to pre-scan. Don't push back to defend the brief; verify, accept, and move on. Note the correction in the close-out comment so the user sees the orchestrator-vs-subagent factual delta. **If the task's acceptance criteria assume tooling that doesn't exist yet**, document the prerequisite and defer the dependent criterion. Example: a criterion that says "add an explicit lint exception pattern for unavoidable casts" is moot if there's no lint rule that flags casts. Note this in the close-out comment ("deferred — prerequisite tooling: enable `noExplicitAny`"); don't fabricate a stub.

### Step 4 — Dispatch a subagent

This is the load-bearing step. **Do not implement the fix yourself**, no matter how small it looks. Even tiny tasks should go through a subagent so that:

- Your context stays predictable (one summary per task, not 50 tool calls per task).
- Each iteration is independently auditable.
- The orchestrator remains the single source of truth for what passed/failed.

Use the `Agent` tool with the Claude Code platform's default `general-purpose` subagent type. This skill deliberately does NOT pin the orchestrator to any third-party agent plugin — briefs are the load-bearing part, not the agent type, and depending on an external plugin would couple the skill's behaviour to a tool that may not be installed on every host. For read-only investigation steps where no edits are needed, the platform's `Explore` subagent type is the right choice.

If the user has installed third-party stack-specialist agents (e.g. a .NET-focused plugin) and wants the orchestrator to prefer them on matching stacks, the user should configure that routing themselves — the skill stays vendor-neutral by default.

**Brief template body lives in [loop-shared.md §A](loop-shared.md#a-worker-brief-template).** Adapt the template to the task; keep the structure (Acceptance criteria, Repository conventions, Test filter cheat sheet, Hard constraints, Validation steps, Reporting back). For tasks flagged in §2a as targeting a sibling repo, populate the "Working dir / Cross-repo context" subsection per the canonical rules in §2a. **Resolve the dispatch model first:** before this worker `Agent` call, resolve the `execution`-role model (or apply `--execution-model`) and set `model:` accordingly — see [loop-shared.md §R](loop-shared.md#r-model-resolution).

The brief's decision rules (pick A-vs-B yourself, pass excerpts not whole docs, copy pinned action SHAs from neighbouring CI jobs, audit-with-budget pattern, always end with "Do NOT commit") are documented inline at the bottom of [loop-shared.md §A](loop-shared.md#a-worker-brief-template).

### Step 5 — Verify the subagent's claim

When the subagent returns its summary:

1. `git status` — confirm only the files the subagent named were modified. **If a file the subagent claimed to change is missing from `git status`, re-read it.** Subagents occasionally report a change they planned but didn't actually write; this catches it.
2. Read each modified file for obvious deviations from the brief (don't audit every line — sample the changes the summary highlighted). **Watch specifically for silent-pass gates**: a new CI job, npm script, or assertion that passes trivially (no-op, always-true condition, doesn't actually run the underlying tool). A gate that doesn't exercise the real check is worse than no gate — it gives false confidence forever. If you see one, re-brief and remove it (don't accept the compromise just because validation passed).
3. **Independently re-run the validation commands** from Step 3. Do not trust the subagent's reported numbers without re-running. Prefer `bash-summarize` *if it's available* (optional — see the note in §2c) for long-output commands (tests, full builds with many files) to keep raw output out of context; use plain `Bash` for short-output commands (typical `lint`, `npm run build` on small projects) where the summarizer overhead exceeds the savings, and for everything if the wrapper isn't installed. **Trust the exit code over the prose**: if the summarizer flags an error but exit is 0 and headline numbers match expectation, it's noise from a test exercising an error path. When `bash-summarize` is in use, the `[bash-summarize] cmd=... exit=N` trailer line printed *by the wrapper itself* is the authoritative exit code — when the model's natural-language prose says "the exit code is likely 1" but the trailer shows `exit=0`, the trailer wins. The model's prose can hallucinate exit codes from scary stderr lines. **Regression-delta computation (load-bearing — no stash dance required).** The subagent's "Reporting back" block now contains two FQN sets: **Baseline (pre-edit)** and **Post-edit**. Compute `regressions_introduced_by_this_change = post_edit_failures - baseline_failures` (set difference on the FQN strings, applied AFTER the §2c `.flaky-tests.json` exclusion filter both sets were captured under). If the delta is empty, the subagent's work is clean (modulo any new tests added in this change — those count separately). If the delta is non-empty, those FQNs are real regressions introduced by this change and trigger the re-brief loop in item #5 below — the orchestrator does NOT need to stash the working tree and re-baseline to determine pre-existing-vs-new, because the subagent already captured the pre-edit set before touching code. If the subagent's report is missing either FQN block (or the two blocks were captured under different exclusion flags), treat that as a brief-deviation per Step 5's error-handling clause and re-brief.
4. **Test re-run exception for declarative diffs.** If the entire diff is confined to config files (`tsconfig.json`, `*.config.*`, `package.json`, `.github/**`), documentation (`docs/**`, `README.md`, `*.md`), or no-behavior-change declarative modifiers (e.g. adding `override`/`readonly`/access modifiers to existing fields with identical initializers), you may skip the test re-run and validate with `build` + `lint` only. Note this in the close-out comment. Default is still to re-run tests — only skip when the diff truly cannot change runtime behaviour.
5. If validation now fails, send the subagent (or a new one) back with the failure output and a tight diagnostic prompt. Do *not* try to fix it inline in the orchestrator context — that defeats the pattern.
6. **Narrow carve-out — inline orchestrator post-correction.** The orchestrator MAY apply a *purely mechanical* fix in-context (no SendMessage round-trip) when ALL four conjunctive conditions hold AND none of the anti-criteria match. **Full conditions, anti-criteria, and audit-trail requirements live in [loop-shared.md §J](loop-shared.md#j-step-5-inline-orchestrator-post-correction-carve-out).** When the carve-out fires, the inline fix MUST be documented in the Step 8 close-out comment under a separate **"Orchestrator post-correction:"** bullet so the audit trail is preserved.
7. If validation passes, proceed.

If after 2 round-trips the task isn't validating green, **stop the loop and ask the user**. Don't burn through the backlog with half-broken commits.

### Step 6 — Commit + push

Stage **only** the files modified by the fix — never `git add -A` or `git add .`. Use a commit message that:

- States the change concisely in the subject (under 70 chars).
- References the task ID and title in the body.
- Notes any disabled / deferred items so future tasks pick them up.
- Mentions the validation result at the bottom.

```bash
git add <specific files>
git commit -m "<subject>

<body>

Resolves task #<id>: <title>"
git push
```

If push fails because the branch has no upstream, run `git push --set-upstream origin <branch>` once. If push fails for any other reason (auth, conflict), note it in the task comment as a manual follow-up and continue to the next task — don't block the loop.

**Anti-fabrication + one-state-mutation-per-turn (load-bearing — applies to this step and Steps 7–8).** Every evidence value (SHA, row count, exit code, verdict) MUST be copied verbatim from a tool result that ALREADY RETURNED in a prior turn — never composed, predicted, or quoted in the same turn as the call that produces it. So perform at most ONE state-producing action per turn and let it return before citing its result: never batch a `git commit` with the `update_task` / `add_comment` that cites its SHA, nor a query with the comment that cites its output. Full rule + motivating incident: [`loop-shared.md` §A](./loop-shared.md#l-anti-fabrication--evidence-integrity-canon).

If the Step 5 carve-out fired and the orchestrator took an inline post-correction, Step 8's close-out comment MUST include a separate **"Orchestrator post-correction:"** bullet listing the file(s) changed and a one-line rationale, so the audit trail survives.

### Step 7 — Dispatch tasks-verifier

The orchestrator MUST dispatch a separate `tasks-verifier` subagent to grade the work BEFORE closing the bugs task. This is non-negotiable — see the "Generator/critic separation" callout under Important Rules. The verifier reads the acceptance criteria, inspects the commits + diff the worker produced, and emits a structured PASS/FAIL/PARTIAL verdict. Full input/output contract: [`docs/verifier-contract.md`](../../docs/verifier-contract.md).

**The orchestrator MUST NOT author `verification_evidence` for its own work.** The `verifier_session_id` MUST be the id of a SEPARATELY DISPATCHED `tasks-verifier` — never the orchestrator's own session, nor a literal like `"orchestrator"` / `"self"` / `"main-loop"`. Synthesizing an evidence object yourself (outside the documented `NOT_VERIFIED` escape hatch in §7c) is fabrication. Canon: [`loop-shared.md` §A](./loop-shared.md#l-anti-fabrication--evidence-integrity-canon).

**Even a worker who reports "no changes needed" still triggers verifier dispatch** with `commit_shas: []` and `file_changes: []`. The contract treats an empty `commit_shas` as a strong negative signal — the verifier will mark file-referencing criteria FAIL unless they are truly observable without a diff (e.g. a doc-only "confirm X is documented at path Y" criterion that the verifier can satisfy by Read alone).

#### 7a. Build the `VerifierInputs` envelope

**Envelope spec lives in [loop-shared.md §B](loop-shared.md#b-verifierinputs-envelope-spec).** Build the envelope per that contract; pass it to the verifier in the prompt. The shared block documents:

- The full `VerifierInputs` TypeScript interface (fields: `task_id`, `acceptance_criteria`, `worker_subagent_session_id`, `commit_shas`, `file_changes`).
- The `acceptance_criteria` resolution order (column → description block → skip-with-NOT_VERIFIED escape hatch).
- The `commit_shas` + `file_changes` capture rules (post-Step-6 `git rev-parse HEAD` + `git diff --name-only`, empty arrays on "no changes needed").
- The **scope-narrowed envelope** rules for declared design-only / slice-of-epic tasks: narrow `acceptance_criteria` to in-scope bullets only, populate `additional_observations` with the SCOPE: header so the verifier doesn't fabricate SKIP checks for deferred runtime ACs.

**Cross-reference: this is the ONLY legitimate path for an intentional narrowed-scope closure to reach PASS.** Without §2a's scope annotation, the orchestrator passes the full AC list and accepts whatever verdict the verifier returns — there is no inline shortcut, and §7c's "no upgrades" rule still binds. The §7d declared-scope carve-out (below) is a status-level decision predicated on this envelope construction; it does NOT bypass it.

#### 7b. Dispatch the verifier subagent

Use the `Agent` tool. **Resolve the dispatch model first** — resolve the `validation`-role model (or apply `--validation-model`) and set `model:` accordingly, per [loop-shared.md §R](loop-shared.md#r-model-resolution). **Default to `subagent_type: "general-purpose"` with the verifier prompt embedded in the brief** — this works regardless of how the user installed the project. The named `subagent_type: "tasks-verifier"` is only registered for sessions started AFTER the user ran `install.sh`; in any fresh session the named agent is typically unavailable, and an Agent call with an unknown subagent_type FAILS the entire dispatch. Defaulting to general-purpose + embedded prompt is the reliable path.

**REQUIRED: pass `name: "verifier-task-<id>"` on every verifier Agent call.** The `name:` parameter makes the agent addressable via `SendMessage` after its first message returns, which is what §7c's auto-repair path needs to round-trip schema fixes WITHOUT losing the verifier's context. A verifier dispatched without a `name:` is unreachable for repair; if it emits a schema-violating envelope (wrong field names, extra strict-mode fields, etc.) the orchestrator has no choice but to synthesize NOT_VERIFIED and silently drop real findings. That is the failure mode this rule prevents. Re-dispatching a fresh verifier via `Agent` is **NOT** an acceptable fallback — the fresh subagent has no context and will fabricate checks (observed once in Wave 11; #332 incident); per §7c the unreachable-verifier path is now "synthesize NOT_VERIFIED + log the §7b violation", never "dispatch fresh and hope".

Embed the full body of [`skills/agents/tasks-verifier.md`](../agents/tasks-verifier.md) as the Agent's prompt prefix (the orchestrator reads the file at run time so prompt updates flow automatically), followed by a fenced JSON block containing the `VerifierInputs` envelope. The contract requires the verifier's FINAL message to be a single JSON object parseable as `VerificationEvidence` — restate this hard constraint at the bottom of the brief so the model doesn't wrap the JSON in prose or a markdown fence.

```
Agent(
  subagent_type: "tasks-verifier",  // or "general-purpose" + embedded prompt body
  name: "verifier-task-<id>",       // REQUIRED — makes SendMessage repair reachable (§7c)
  description: "Grade task #<id> against acceptance criteria",
  prompt: <<-EOF
Here is your VerifierInputs envelope. Follow docs/verifier-contract.md and the tasks-verifier subagent definition exactly. Your final message MUST be a single JSON object parseable as VerificationEvidence.

```json
${JSON.stringify(verifierInputs, null, 2)}
```
EOF
)
```

The verifier subagent's `tools:` frontmatter is restricted to read-only operations (Read, Grep, Glob, Bash with a git/test allowlist, and the read-only wood-fired-tasks MCP tools). It cannot Edit, Write, commit, push, or mutate the tasks database — by design. See `skills/agents/tasks-verifier.md` for the enforced allowlist.

**Bounds recap** (cite `docs/verifier-contract.md` §Bounds): the verifier MUST stay within **≤ 30 tool calls** and **≤ 5 minutes** wall-clock. The subagent self-throttles at 25 tool calls. If the orchestrator observes the bound exceeded, treat the run as `verdict: "PARTIAL"` with a synthetic final SKIP check noting the bound that triggered.

#### 7c. Parse + validate the verifier's output

Parse the verifier's final message as JSON. Validate against `VerificationEvidenceSchema` (`src/schemas/task.schema.ts`). Reject anything that does not match the schema.

**Common verifier emission bugs — auto-repair via `SendMessage`, do NOT silently accept.** The verifier model frequently emits semantically-correct findings inside a schema-violating envelope (the schema is `.strict()`). Silently dropping a verifier's real findings is forbidden — the orchestrator MUST attempt repair before falling through to `NOT_VERIFIED`. Repair always goes via `SendMessage` to the SAME verifier session (which §7b mandates was dispatched with a `name:`).

**Five known parse-failure patterns + the diagnostic message to send for each (verbatim diagnostic strings) live in [loop-shared.md §G](loop-shared.md#g-verifier-parse-failure-patterns).** The patterns cover: (1) `status: "PARTIAL"` on a per-check entry (enum violation), (2) wrong per-check field name (`criterion` instead of `name`), (3) extra strict-mode fields, (4) missing required field, (5) malformed JSON (markdown fence / preamble). For each pattern, the orchestrator sends `SendMessage(to: "verifier-task-<id>", message: <diagnostic>)` and re-parses. Cap auto-repair at **2 SendMessage round-trips per verifier session** — beyond that, synthesize NOT_VERIFIED and stop. **Hard fallback (verifier unreachable for repair):** if the verifier was dispatched WITHOUT a `name:` (a §7b violation), `SendMessage` cannot reach it. Do NOT re-dispatch a fresh verifier — fresh dispatches lack the original verifier's tool-call context and **will fabricate checks** (observed once in Wave 11 / #332; fresh verifier invented entirely new check names for a different task). Instead, synthesize `{ verdict: "NOT_VERIFIED", checks: [], verified_at: <iso8601> }`, add a tasks-database comment explicitly citing the §7b violation ("verifier dispatched without `name:` — schema-repair was unreachable; original findings preserved below for audit"), and preserve the original verifier's parse-failed output verbatim in the comment so a human reviewer can recover the findings. On parse failures NOT in the known-pattern list above (or after 2 failed repair round-trips), synthesize `{ verdict: "NOT_VERIFIED", checks: [], verified_at: <iso8601> }` and proceed to the `NOT_VERIFIED` branch below. Always preserve the verifier's parse-failed output in a tasks-database comment so the findings are not silently lost.

**Sanity-check the verdict against the rollup table** (contract §Verdict rollup rules). The orchestrator is allowed exactly ONE class of override: **rollup-driven DOWNGRADES**. Examples:
- Verifier emitted `verdict: "PASS"` but a check has `status: "FAIL"` → override `verdict` to `FAIL`.
- Verifier emitted `verdict: "PASS"` but a check has `status: "SKIP"` → override `verdict` to `PARTIAL`.

**Orchestrator MUST NOT upgrade a verdict** (FAIL→PARTIAL, FAIL→PASS, PARTIAL→PASS, NOT_VERIFIED→anything) on its own observation. If new evidence appears that would warrant an upgrade (e.g. the orchestrator runs a live smoke the verifier could not), the orchestrator MUST re-dispatch a fresh verifier with the new evidence embedded in the envelope (`additional_observations: ["<orchestrator-observed evidence>", ...]`). The fresh verifier's verdict is authoritative — the orchestrator never grades. **This is the load-bearing guarantee of the Generator/critic separation rule under Important Rules.**

If a verifier's verdict is wrong because the verifier mis-scoped the ACs (e.g. counted runtime-only criteria against a design-only task), the orchestrator MUST re-dispatch with a tighter `acceptance_criteria` scoping note — never silently drop checks the verifier emitted.

#### 7d. Branch on verdict

The verdict controls whether the task closes, blocks, or stays in_progress. **Do NOT skip a branch.** Each branch writes the full verifier evidence into `tasks.verification_evidence` via Wave 1.4's `update_task` field.

- **`verdict: "PASS"`** → proceed to Step 8 (close task as done). Pass the full verifier evidence object as `updates.verification_evidence` in the Step 8 `wood-fired-tasks:update_task` call. The status transition to `done` is gated on PASS — no other verdict reaches Step 8's `status: "done"` write.

- **`verdict: "FAIL"`** → the task is NOT done. The orchestrator MUST:
  1. Call `wood-fired-tasks:add_comment` with the failed checks formatted as a markdown bulleted list (one bullet per `checks[i]` with `status: "FAIL"`, citing the check `name` and its `evidence_url_or_text`).
  2. Call `wood-fired-tasks:update_task` with `updates: { "status": "blocked", "verification_evidence": <full evidence> }`.
  3. Do NOT call Step 8's close-as-done path. Move on to the next task in the loop.

  ```
  wood-fired-tasks:add_comment with task_id=<id>, author=<agent>, content=
    "Verifier verdict: FAIL.\n\nFailed checks:\n- <check.name>: <check.evidence_url_or_text>\n- ..."
  wood-fired-tasks:update_task with id=<id>, updates={
    "status": "blocked",
    "verification_evidence": <full evidence object>
  }
  ```

- **`verdict: "PARTIAL"`** → the task is neither closed nor blocked; it stays in_progress so a follow-on attempt can finish the UNCHECKABLE criteria. The orchestrator MUST:
  1. Call `wood-fired-tasks:add_comment` listing the UNCHECKABLE criteria (the `checks[i]` with `status: "SKIP"` and `evidence_url_or_text` starting with `UNCHECKABLE:`), one bullet per skipped check.
  2. Call `wood-fired-tasks:update_task` with `updates: { "verification_evidence": <full evidence> }` only — do NOT change `status`. The task stays `in_progress`.
  3. Move on to the next task in the loop.

  ```
  wood-fired-tasks:add_comment with task_id=<id>, author=<agent>, content=
    "Verifier verdict: PARTIAL.\n\nUNCHECKABLE criteria (need follow-on):\n- <check.name>: <check.evidence_url_or_text>\n- ..."
  wood-fired-tasks:update_task with id=<id>, updates={
    "verification_evidence": <full evidence object>
  }
  ```

  - **Carve-out — declared scope narrowing closes the task.** When §2a annotated the task with `scope: design-only` (or similar) AND Step 7a passed `additional_observations` per the "Scope-narrowed envelope" sub-block, a PARTIAL rollup whose SKIP checks all cite *in-scope* ACs MAY transition `status` to `done` while preserving `verdict: "PARTIAL"` in `verification_evidence`. **Full carve-out rules (conjunctive preconditions, audit-trail requirements, close-out comment template) live in [loop-shared.md §E](loop-shared.md#e-declared-scope-narrowing-carve-out).** This is a *status* decision, NOT a verdict upgrade — without §2a's `scope:` annotation upstream, the carve-out does NOT apply and the default PARTIAL branch (task stays `in_progress`) is the only path.

- **`verdict: "NOT_VERIFIED"`** → treat as PARTIAL but with a comment noting the verifier produced no checks (no acceptance criteria to grade against, or the verifier's output failed schema validation). Status stays `in_progress`. This is the documented no-acceptance-criteria escape hatch — surface it so the user can backfill criteria and re-queue.

  ```
  wood-fired-tasks:add_comment with task_id=<id>, author=<agent>, content=
    "Verifier verdict: NOT_VERIFIED — no acceptance criteria available, or verifier output failed schema validation. Task stays in_progress; backfill acceptance_criteria and re-queue."
  wood-fired-tasks:update_task with id=<id>, updates={
    "verification_evidence": { "verdict": "NOT_VERIFIED", "checks": [], "verified_at": "<iso8601>" }
  }
  ```

Only the PASS branch falls through to Step 8. The FAIL / PARTIAL / NOT_VERIFIED branches all return to Step 1 after writing their comment + evidence.

### Step 8 — Close the task

This step runs **only when Step 7 produced `verdict: "PASS"`**. For FAIL / PARTIAL / NOT_VERIFIED, Step 7 already wrote the appropriate `status` + `verification_evidence` and the loop returned to Step 1.

```
wood-fired-tasks:add_comment with task_id=<id>, author=<agent>, content=<structured summary>
wood-fired-tasks:update_task with id=<id>, updates={ "status": "done", "verification_evidence": <full evidence from Step 7> }
```

**Close-out comment template lives in [loop-shared.md §I](loop-shared.md#i-step-8-close-out-comment-template).** Required fields: tooling pick, changes (per-file), disabled/deferred, validation results, flake exclusions / candidate-for-promotion bullets (conditional on `known_flakes` non-empty), commit hash + subject. If duplicates exist, close them with `Resolved by fix to task #<id>. See comment on that task for details.`

Then continue to Step 9 (artifact emission) before returning to Step 1.

### Step 9 — Emit LOOP-RUN.md

The final orchestrator step writes a per-run audit artifact summarizing every task touched during this loop invocation. Contract: [`docs/loop-run-schema.md`](../../docs/loop-run-schema.md). JSON Schema mirror: [`docs/loop-run-schema.json`](../../docs/loop-run-schema.json). In-tree TypeScript schema (for tests + future tooling): [`src/lib/loop-run/schema.ts`](../../src/lib/loop-run/schema.ts). Reference example: [`docs/loop-run-reference-example.md`](../../docs/loop-run-reference-example.md).

#### 9a. Artifact path

```
.planning/loops/<UTC-timestamp>-<project_id>.md
```

- **Directory:** Always `.planning/loops/` — create on first emission.
- **Timestamp:** Compact ISO-8601 UTC, format `YYYYMMDDTHHMMSSZ` (e.g. `20260522T175000Z`). The orchestrator MUST use its own `started_at` (the time the loop began), NOT the per-iteration time — one file per run.
- **project_id:** The numeric wood-fired-tasks project id this loop drained.
- One file per run. The path is stable across re-emissions within the run.

#### 9b. Incremental rewrite (kill-safe)

The orchestrator re-emits LOOP-RUN.md **after EACH task closes** (i.e. at the end of every Step 8, including FAIL / PARTIAL / NOT_VERIFIED branches from Step 7). Use the `Write` tool to replace the file in place — same path, full new contents. This guarantees that if the loop is killed mid-run (SIGINT, host crash, context window blown), the file on disk still reflects the state at the last completed task.

```
# Pseudocode — runs after each Step 8 close (or Step 7 non-PASS branch)
artifact_path = ".planning/loops/" + started_at_compact + "-" + project_id + ".md"
ended_at = <now UTC, RFC 3339>
wall_seconds = floor((ended_at - started_at).total_seconds())
contents = build_loop_run_md(frontmatter, tasks_so_far, findings_so_far, ...)
Write(artifact_path, contents)
```

`ended_at` and `wall_seconds` update each iteration; the counts reflect only what's closed so far. A final emission after the budget is hit (or after the backlog drains) produces the run's true final state.

#### 9c. Frontmatter construction

**14 required fields enumerated in [loop-shared.md §C](loop-shared.md#c-loop-runmd-frontmatter-required-fields).** Source-of-truth for each: see that table. The YAML frontmatter mirrors `docs/loop-run-schema.md` §3, `docs/loop-run-schema.json`, and `src/lib/loop-run/schema.ts` field-for-field.

Use orchestrator-observed counts as the primary source; cite `agent_transactions_v` as the cross-check source for any post-run audit. The skill MUST NOT block emission on a live DB connection.

#### 9d. Body sections

All sections from `docs/loop-run-schema.md` §4 are mandatory (empty sections use the documented sentinel paragraphs):

- **`## Tasks Closed`** — one row per task attempted so far. Columns in order: `task_id | title | verdict | evidence_link | subagent_session_id | commit_shas`. Title truncated to ≤ 100 chars with `…`. `commit_shas` is `—` when no commits landed (FAIL / NOT_VERIFIED / "no changes needed" branches).
- **`## Verifier Findings`** — one block per task with verdict `FAIL` or `PARTIAL`, populated from `verification_evidence.checks` cited verbatim (failing check `name` + `evidence_url_or_text`). Sentinel paragraph `_No findings: all attempted tasks verified clean._` when empty.
- **`## Integration Concerns`** — auto-flag when `git diff --name-only` across the worker session SHAs surfaces **≥ 2 distinct worker sessions touching the same file**. Exclude generated / lockfiles (`package-lock.json`, `*.lock`, `dist/**`). One bullet per overlap citing the file path, contributing task IDs, and commit SHAs. Sentinel `_No integration concerns auto-detected._` when empty.
- **`## Cost Breakdown`** — table with one row per participant (`orchestrator` + `subagent:<task_id>`) plus a `TOTAL` row. Columns: `participant | model | input_tokens | cache_create_tokens | cache_read_tokens | output_tokens | usd`. Primary source: orchestrator-observed `<usage>` blocks. Cross-check: `agent_transactions_v` (post-run, not required at emit time).
- **`## Replay Instructions`** — fenced ```bash block with the exact `/tasks:loop` arguments to re-grade this run (project name / id, `--max-tasks`, etc.) plus the verification commands the loop trusted (`npm run build && npm test && npm run lint`).
- **`## WSJF Ranking`** — the ranking snapshot Step 1's WSJF-ordered selection consumed (per-task scores, `effectiveWsjf`, propagation breakdown, γ/CAP). Full table + header + sentinel rules: [loop-shared.md §M](loop-shared.md#m-loop-runmd-wsjf-ranking-snapshot). Sentinel `_No WSJF ranking: project has no WSJF-scored tasks; selection used the priority + ID (or topological) order._` when the project was unscored or WSJF was never probed.
- **`## Coverage Gaps`** — the §O terminal-completeness-gate result: one bullet per detected invariant/reachability gap (failing audit/tool + remediation task id), or the sentinel when green. Schema + semantics: [loop-shared.md §O](loop-shared.md#o-terminal-completeness-gate-drainedone-invariant--reachability-audit).

#### 9e. NOT committed (intentional)

`.planning/` is gitignored per project policy (`.gitignore`: `Internal planning + agent workspaces (not for open-source distribution)`). LOOP-RUN.md is therefore a **local-machine per-run audit trail**, not a versioned artifact: replay across machines requires manual sharing (copy out / attach to a task comment / paste into a PR), but open-source distribution stays clean and per-run forensic detail never leaks into a fork's public history. The orchestrator MUST NOT `git add` the `.planning/loops/` artifact, and MUST NOT modify `.gitignore` to make it an exception.

Return to Step 1.

### Step 10 — Integration audit (run termination)

This is the **terminal step**. It runs ONCE per loop run — never per iteration — after Step 1's "backlog empty" announcement OR after the `--max-tasks N` budget is hit. The goal is to catch the failure mode the per-task verifier cannot see: **ten green tasks that together break the system**. Per-task verifiers grade one task's diff in isolation; only a cross-task auditor sees the union of every worker's edits to the same symbol and can catch the composition bugs that emerge there. Subagent definition: [`skills/agents/integration-auditor.md`](../agents/integration-auditor.md). Inline schema: [`src/lib/loop-run/integration-audit-schema.ts`](../../src/lib/loop-run/integration-audit-schema.ts).

#### 10·0. Terminal completeness gate (before declaring drained)

BEFORE the loop exits / declares the backlog drained, run the **§O terminal completeness gate** — [loop-shared.md §O](loop-shared.md#o-terminal-completeness-gate-drainedone-invariant--reachability-audit) — alongside (just before) the integration audit below. It runs the `stdio ⊆ remote` parity invariant audit, the reachability smoke for newly-added MCP tools through the **remote** path, AND — unconditionally when the repo ships a distributable — an **artifact-level smoke** (prefer the repo's `smoke:global`; else pack → install the tarball to a temp prefix → run the shipped bin from OUTSIDE the repo), and gates the "drained → done" declaration: **"0 open tasks" alone does NOT declare success — a green §O audit is additionally required.** On RED it materializes a remediation task (the §O carve-out) and records the gap in the `## Coverage Gaps` section instead of announcing a clean drain.

#### 10a. When this step runs

Step 10 runs ONCE at loop termination, **not per iteration**. Triggers: the `--max-tasks N` budget was hit (orchestrator about to stop + check in per "Drain Budget / Checkpoints"), or `list_tasks status=open` returned empty (backlog drained, about to exit per Step 1). It fires AFTER the last Step 9 re-emit of LOOP-RUN.md. Skipping Step 10 because the loop closed only one task is **not allowed** — a single-task loop can still overlap a prior (pre-loop) commit if picked up mid-day, though in practice the overlap detector handles this (one worker session vs zero → no overlap).

#### 10b. Detect overlaps

Compute the set of worker session commit ranges from the loop run. For each pair of worker sessions (i, j) with `i < j`, run:

```bash
git diff --name-only <worker_i_pre_sha>..<worker_i_post_sha>
git diff --name-only <worker_j_pre_sha>..<worker_j_post_sha>
```

An **overlap** is a file path that appears in ≥ 2 distinct worker sessions' commit sets. Build a deduplicated list of `{file_path, task_ids: [...]}` pairs (task_ids in ascending order, deduped).

**Generated-file exclusion list** — mirrors Step 9d's Integration Concerns auto-flag exactly so the two views never disagree:

- `package-lock.json`
- `*.lock` (any file ending in `.lock`)
- `dist/**`
- `coverage/**`
- `.agent-context.json`

Exclude these from BOTH overlap detection AND the auditor input. Auto-generated noise must not consume the auditor's tool budget.

**Empty-overlap suppression**: if the deduplicated overlap list is empty after exclusions, **do NOT emit INTEGRATION-AUDIT.md** and proceed to "Final LOOP-RUN.md re-emit" below. Avoiding noise when the loop ran clean is load-bearing UX — `.planning/loops/` stays scannable.

#### 10c. INTEGRATION-AUDIT.md schema

Artifact path: `.planning/loops/<UTC-timestamp>-<project_id>-integration.md` — same `<UTC-timestamp>-<project_id>` prefix as the run's LOOP-RUN.md, with `-integration` suffix. The skill prose IS the contract; there is no separate `docs/integration-audit-schema.md` (out of scope — LOOP-RUN.md got that treatment in Wave 1.5 only because Wave 1 had a dedicated spec task). The verdict set is **SAFE | RISKY | BROKEN**.

**Frontmatter + body template lives in [loop-shared.md §D](loop-shared.md#d-integration-auditmd-schema).** The shared block enumerates the YAML frontmatter fields (`IntegrationAuditFrontmatterSchema` in `src/lib/loop-run/integration-audit-schema.ts`: `run_id`, `project_id`, `generated_at`, `overlap_count`, `broken_count`, `risky_count`, `safe_count`) and the per-`## Overlap: <file_path>` body block. The count invariant (`broken_count + risky_count + safe_count == overlap_count`) is documented but NOT schema-enforced (mirrors `LoopRunFrontmatterSchema`'s deliberate non-enforcement; the check is the replay tooling's job).

#### 10d. Dispatch the integration-auditor subagent (one per overlap)

For EACH overlap in the deduplicated list, dispatch a separate `integration-auditor` invocation. **One auditor per overlap, NOT one per file** — every (file, task-pair) overlap gets its own verdict and evidence trail.

Use the `Agent` tool. **Default to `subagent_type: "general-purpose"` with the auditor prompt embedded in the brief** — same rule as Step 7's verifier dispatch (line 571). The named `subagent_type: "integration-auditor"` is only registered for sessions started AFTER the user ran `install.sh`; in any fresh session the named agent is typically unavailable, and an `Agent` call with an unknown `subagent_type` FAILS the entire dispatch (the orchestrator then can't audit the overlap and §10e's BROKEN-revert protocol won't fire — silent loss of the cross-task safety net). Defaulting to `general-purpose` + embedded prompt is the reliable path.

**Recommendation for repeat users:** run `install.sh` once on the workstation. It copies `skills/agents/integration-auditor.md` to `~/.claude/agents/integration-auditor.md` and registers the named agent. The named agent's `tools:` frontmatter enforces a read-only tool surface (Read, Grep, Glob, restricted Bash, read-only wood-fired-tasks MCP tools), preventing an auditor from accidentally mutating code or the tasks database. The general-purpose fallback honors the read-only contract via prompt-only constraint — equivalent functional contract, but no harness-level enforcement. Both paths satisfy §10e; the named agent is strictly safer.

```
Agent(
  subagent_type: "integration-auditor",  // or "general-purpose" + embedded prompt body
  description: "Audit overlap on <file_path> between tasks #<id_a> and #<id_b>",
  prompt: <<-EOF
Here is your overlap envelope. Follow skills/agents/integration-auditor.md exactly. Your final message MUST be a single JSON object parseable as IntegrationOverlap (see src/lib/loop-run/integration-audit-schema.ts).

```json
{
  "file_path": "<path>",
  "task_ids": [<id_a>, <id_b>],
  "diff_a": "<unified diff hunks from task_a's commits, restricted to file_path>",
  "diff_b": "<unified diff hunks from task_b's commits, restricted to file_path>"
}
```
EOF
)
```

The integration-auditor's `tools:` frontmatter is restricted to read-only operations (Read, Grep, Glob, Bash with a strict git-read allowlist, and the read-only wood-fired-tasks MCP tools). It cannot Edit, Write, commit, push, or mutate the tasks database — by design. See `skills/agents/integration-auditor.md` for the enforced allowlist.

**Bounds recap**: the integration-auditor MUST stay within **≤ 15 tool calls** and **≤ 3 minutes** wall-clock per overlap. Bounds are tighter than `tasks-verifier`'s because the audit scope is one file × two hunks. If the bound is exceeded, the auditor self-emits `RISKY` with a note that the bound was hit.

**Parse + validate**: parse each auditor's final message as JSON. Reject anything that does not match `IntegrationOverlapSchema`. On parse failure or schema-validation failure, synthesize a fallback `{verdict: "RISKY", rationale: "auditor output unparseable", evidence: ["<note about the parse error>"]}` for that overlap — never silently drop an overlap, never auto-promote to SAFE.

#### 10e. Branch on rolled-up verdict

After every auditor returns (sequentially or in parallel — orchestrator's choice), roll up the verdicts:

- **No BROKEN, no RISKY** (all SAFE) → emit INTEGRATION-AUDIT.md at the path from §10c. **Do NOT revert any tasks.** Loop run is clean.
- **No BROKEN, ≥ 1 RISKY** (mix of SAFE + RISKY) → emit INTEGRATION-AUDIT.md. **Do NOT revert any tasks.** RISKY warnings are surfaced for human review; the loop run is NOT marked failed.
- **≥ 1 BROKEN** → emit INTEGRATION-AUDIT.md AND execute the BROKEN-revert protocol:

  1. For each task ID that appears in a BROKEN overlap, call `wood-fired-tasks:update_task` to flip it from `done` back to `in_progress`, **preserving** the verifier's PASS evidence (append an `integration_concern` note rather than replacing the existing `verification_evidence` object):

     ```
     wood-fired-tasks:update_task with id=<task_id>, updates={
       "status": "in_progress",
       "verification_evidence": {
         ...<existing PASS evidence>,
         "integration_concern": "BROKEN overlap on <file_path> with task #<other_id>; see .planning/loops/<artifact-path>"
       }
     }
     ```

  2. For each reverted task, call `wood-fired-tasks:add_comment` explaining the integration concern, citing the auditor's verdict and rationale:

     ```
     wood-fired-tasks:add_comment with task_id=<task_id>, author=<agent>, content=
       "Integration auditor verdict: BROKEN.\n\nOverlap on `<file_path>` with task #<other_id>:\n<auditor rationale>\n\nReverting to in_progress. See INTEGRATION-AUDIT.md for the full evidence trail."
     ```

  3. Mark the loop run as **failed** for this run. The `LoopRunFrontmatterSchema` is locked (Wave 3.1 / task #316 does NOT permit adding a `run_marked_failed` column), so failure is conveyed via a new body section in the **final LOOP-RUN.md re-emit**.

**Final LOOP-RUN.md re-emit**: after Step 10 produces verdicts AND after any BROKEN-revert task updates land, re-emit Step 9 ONE final time with:

- Updated `tasks_passed` / `tasks_partial` counts reflecting the reverted tasks (reverted tasks drop out of `tasks_passed` and back into `tasks_partial` since they are now in_progress with a verifier PASS but an integration concern).
- A new `## Integration Failure` body section (BROKEN case only) summarizing what was reverted, citing the INTEGRATION-AUDIT.md path, and listing the affected task IDs. Sentinel paragraph is NOT used — the section is only present when the integration audit triggered reverts.
- The existing `## Integration Concerns` Step 9d auto-flag stays as-is — it is the lightweight per-iteration overlap detector and is now augmented (not replaced) by INTEGRATION-AUDIT.md's deeper auditor-graded view.

#### 10f. NOT committed

Same rationale as Step 9e — `.planning/` is gitignored and INTEGRATION-AUDIT.md lives alongside LOOP-RUN.md as a per-run audit trail, not a versioned artifact. The orchestrator MUST NOT `git add` the `.planning/loops/<...>-integration.md` artifact. It MUST NOT modify `.gitignore`. Cross-reference: see Step 9e for the full open-source-distribution rationale.

After Step 10 completes, the loop terminates. Do NOT return to Step 1.

---

## Pre-Existing Breakage Handling

The skill distinguishes three failure classes:

| Failure | Where it came from | Where it gets fixed |
|---------|--------------------|---------------------|
| **Caused by your fix** | Subagent's changes introduced it. | Same commit. Subagent iterates until green; if a test failed because behaviour correctly changed, update the test (do not revert the fix). |
| **Pre-existing, surfaced by Section 2c baseline** | Already failing on `main` before the loop started. | Separate housekeeping commit *before* the loop's first task commit. Subject like `fix(tests): <one-line description>`. |
| **Pre-existing, surfaced by your skill addition** | You added a skill file or other artifact that exposed a stale assertion. | Separate housekeeping commit; in the body, reference the skill-addition commit that exposed it. |

Always note in the task comment whether the task closure involved a separate housekeeping commit so reviewers can audit it.

---

## Drain Budget / Checkpoints

The default `--max-tasks N=3` exists because long unattended loops accumulate small misunderstandings. After N successful closures, stop and summarise for the user:

- Tasks closed this run (IDs + one-line subjects).
- Tasks deferred (IDs + reason).
- Suggested next batch + an estimated scope flag for each (S/M/L based on description size + linked docs).
- Whether the user should review the commits before continuing.

The user can then run the skill again with the same project name to resume.

If the user explicitly asked to "drain the whole backlog" or "run until empty", set `--max-tasks 0` and skip the checkpoint.

---

## Error Handling

### Build / test fails — or orchestrator detects a brief deviation — after subagent returns

Use `SendMessage` to the same agent ID (not a new Agent call) whenever the orchestrator needs the subagent to iterate. This applies to:

- **Validation failures** (build/test/lint regressed).
- **Quality deviations on a passing build** — silent-pass gates, no-op scripts, fabricated checks, scope creep, hard-constraint violations the orchestrator catches during Step 5 inspection.
- **Discovered constraints that change scope** — e.g. the subagent surfaced a tooling constraint not in the brief (`formatter.enabled: false` in biome config) and proposed a compromise. Re-brief with the constraint acknowledged and the right policy (accept, defer the deliverable cleanly, or split the work) — don't accept compromises that introduce anti-patterns just to ship.

Same agent = full context preserved; the re-brief can be short ("you previously did X, do Y instead, because Z"). If two re-briefs don't land the right outcome, mark the task `blocked` with a comment listing what was tried, then move on.

### Subagent goes off-script

If the subagent committed despite being told not to, or modified files outside the brief's scope, do not paper over it:

1. `git reset` the bad changes if they're staged.
2. Re-brief with explicit "you previously did X, do not do that — here's why".
3. If it happens twice in a session, switch agent types or fall back to inline implementation for that task (and note the recurrence to the user — repeated off-script behaviour from the same agent type is a signal worth a skill update).

### Deployment / smoke blocked

If smoke requires privileged access (sudo, GPU, paid API, interactive UAT) and your environment can't provide it, note this in the task comment as a manual follow-up, confirm the fix via build+tests, and close the task. Don't stall the loop on environment limits.

### Task can't be resolved

After 2–3 honest subagent round-trips, set the task to `blocked` with a comment explaining what was tried and what's still failing. Move on.

### `topology_check` returns something other than FLAT / DAG / DAG_CYCLIC

Defensive halt. Emit a comment in the tasks project's top-level discussion (`add_comment` on the highest-ID open task as a proxy — there is no project-level comment API) citing the unexpected topology value verbatim, then exit. This should be impossible per `TopologyService`'s contract; if it happens it is a data-shape bug worth a separate task.

---

## Important Rules

- **Generator/critic separation.** The orchestrator MUST dispatch a SEPARATE `tasks-verifier` subagent to grade each closed task. The orchestrator MUST NOT grade its own dispatches — the verifier's read-only context window is the entire point. Orchestrator validation (Step 5: build/test/lint) is necessary but not sufficient; the verifier checks the ACCEPTANCE CRITERIA, not the build. See Step 7 and [`docs/verifier-contract.md`](../../docs/verifier-contract.md) for the contract; `skills/agents/tasks-verifier.md` enforces the read-only tool surface. **The orchestrator's ONLY allowed local override is a rollup-driven DOWNGRADE** (e.g. `verdict: "PASS"` with a `FAIL` check → override to `FAIL`). UPGRADES (FAIL→PASS, PARTIAL→PASS, NOT_VERIFIED→anything) MUST come from a freshly re-dispatched verifier with the additional evidence in its envelope — never from the orchestrator's own judgment. Silently dropping checks the verifier emitted, or upgrading verdicts on observation, is forbidden.
- **You are the orchestrator, not the carpenter.** Every implementation goes through a subagent, even small ones. Exceptions only when the user explicitly asks for an inline fix.
- **One task at a time.** Plan → dispatch → verify → commit → close → repeat. No parallel task dispatch within a single project unless tasks are explicitly independent (rare). Respect priority order (urgent > high > medium > low; ties broken by lowest ID).
- **Validation runs in the orchestrator, not just the subagent.** Re-run; never trust reported numbers.
- **Commit per task.** One task = one commit (plus an optional pre-loop housekeeping commit). Push after each commit; use `-u <remote> <branch>` on the first push if needed.
- **Epic-sized tasks → largest coherent slice, defer the rest.** When a task's own acceptance criteria say "incrementally" or "one X per PR" and span more work than fits in a single commit, the orchestrator picks the largest coherent slice that lands cleanly in one commit. Document what was deferred in the close-out comment so the user can promote follow-on tasks. Do *not* let an epic-sized task block the loop, and do *not* split into multiple commits within one task closure. **Inverse:** if all sub-deliverables are small independent config tweaks (each 5-15 lines, no shared touch points), they CAN fit in one commit together — that IS the largest coherent slice. Don't artificially fragment a task whose deliverables don't conflict.
- **Close duplicates** with a back-reference.
- **Don't create new tasks during the loop.** Note discoveries in comments on related tasks; the user promotes them later — EXCEPT the §O terminal-gate remediation-task carve-out ([loop-shared.md §O](loop-shared.md#o-terminal-completeness-gate-drainedone-invariant--reachability-audit)): a RED terminal invariant/reachability audit MUST materialize a remediation task and surface it in `## Coverage Gaps`.
- **Be honest about manual steps.** If smoke/UAT/deploy was skipped, say so in the comment.
- **Stop when the budget is hit** (default 3 tasks) and check in with the user — don't silently keep going. **Stop when the backlog is empty:** announce completion and exit; no polling.
- **Anti-fabrication (load-bearing).** Every evidence value (SHA, row count, exit code, verdict) is quoted from a tool result that already returned in a prior turn — never composed in the same turn as the producing call (Step 6); and the orchestrator never authors its own `verification_evidence` — the verdict comes from a separately dispatched `tasks-verifier` (Step 7). Full rule, honest-scope statement, and the 2026-05-31 motivating incident: [`loop-shared.md` §A](./loop-shared.md#l-anti-fabrication--evidence-integrity-canon).
