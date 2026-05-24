---
name: loop
description: Autonomous backlog-drain loop. A single orchestrating context picks the highest priority open task from a Wood Fired Bugs project, dispatches a subagent to implement the fix, independently re-validates with the project's build/test/smoke commands, closes the task, commits, pushes, and continues. Use when the user wants to drain an open backlog hands-off without filling the main context with implementation noise.
argument-hint: [project-name] [--max-tasks N]
disable-model-invocation: false
---

# Task Loop Workflow

You are the **orchestrator** of an autonomous backlog-drain. Your job is *not* to implement fixes yourself — your job is to **plan, dispatch subagents, verify, and commit**, so this single context stays clean and consistent across many task iterations.

The loop is project-agnostic. Validation commands (`build`, `test`, `smoke`) and domain-spec docs are discovered from the target repository's conventions, not hardcoded.

> **Mental model.** Think of yourself as the foreman, not the carpenter. Each task: hand a self-contained brief to a fresh subagent (the carpenter), then independently re-check the work before signing it off. Your context only holds the *plan, summaries, and verification results* — never raw build logs, file scans, or trial-and-error.

---

## 1. Argument Parsing

Parse `$ARGUMENTS` — or, when invoked via natural language ("loop the backlog on project X", "drain project X"), extract the equivalent fields from the request:

- `[project-name-or-id]` — if the value starts with `#` or is a bare integer, treat it as the project ID and skip the name match. Otherwise, do a case-insensitive partial match against project names.
- `--max-tasks N` — optional. Stop the loop after N successful task closures and check in with the user before continuing. Default is **3**. Pass `--max-tasks 0` to loop until the backlog is empty (only do this if the user explicitly asks for unattended drain). If the user invokes via natural language and doesn't state a budget, default to **3** but propose an adjustment in Section 2e if the backlog looks epic-sized.
- `--i-know-what-im-doing` — optional escape hatch for the §2f topology pre-flight gate (Wave 4.2 / task #319). When the project's `topology_check` returns `DAG` (acyclic dependency edges exist), `/tasks:loop` halts by default — looping over a DAG is the wrong tool; the user should use `/gsd-autonomous` for a milestone or run tasks individually in topological order. Pass `--i-know-what-im-doing` to override the DAG halt and proceed anyway (the override decision is logged in the orchestrator's first prompt and recorded as `gate_decision: overridden` in the LOOP-RUN.md frontmatter). The flag is **tolerated for `DAG`** topology only. It is **explicitly rejected for `DAG_CYCLIC`** — a cycle must be broken before any runner can proceed, no exceptions.

**If no project name/ID is provided:** ask the user. Do not pick one silently.

### Resolve Project ID

Call `wood-fired-bugs:list_projects`, match the argument (by ID if numeric/`#`-prefixed, else by name), store `project_id` + `project_name`. If no match, list available projects and stop.

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

**Cross-repo scope detection** (referenced by §2c, §2e, §2f, and Step 4). While reading the open task list, scan each task's `description` + `acceptance_criteria` for absolute paths that point OUTSIDE the CWD repo. The orchestrator looks up the project's **canonical sibling-repo set** — this is a project-level convention, NOT a hardcoded universal — from (in order):

1. The repo's own `.tasks-loop-memo.md` (if §2b wrote one in a prior run).
2. `AGENTS.md` / `CLAUDE.md` / `README.md` for an explicit "sibling repos" or "monorepo neighbours" section.
3. The user, if neither source declares the set.

For each candidate sibling path, match BOTH the leading-`~` form AND the expanded `$HOME/...` form (task descriptions often mix the two). A path match in either the `description` or `acceptance_criteria` field flags the task as **cross-repo** and records the target repo(s) alongside the task ID in the same mental notes / cache file from the previous paragraph (`cross_repo: [<abs path>, ...]` per task). A task may target more than one sibling repo — collect them all.

> **Example** — Wood Fired Games' canonical sibling-repo set is the seven paths below. Substitute whatever set is documented in YOUR project's conventions; the list is illustrative, not a baked-in constant:
>
> ```
> ~/wood-fired-engine            /home/<user>/wood-fired-engine
> ~/wood-fired-platform          /home/<user>/wood-fired-platform
> ~/wood-fired-docs              /home/<user>/wood-fired-docs
> ~/project-brogue               /home/<user>/project-brogue
> ~/wood-fired-thought-capture   /home/<user>/wood-fired-thought-capture
> ~/.claude                      /home/<user>/.claude
> ~/.local                       /home/<user>/.local
> ```

If the cross-repo classification ends up non-empty, §2c will baseline tests in EVERY detected repo (not just CWD) and Step 4 briefs will carry the per-repo working dir + baseline numbers. If the set is empty, the rest of the loop behaves as before — single-repo. Either way, record the outcome (even if it's "no cross-repo tasks detected") so future readers of the cache know the scan ran.

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

**Trust the exit code, not the summarizer prose.** `bash-summarize` will sometimes prominently flag stderr noise from tests that exercise error paths (e.g. `error: required option '-a, --assignee <name>' not specified` from a CLI argparse fixture). If the exit code is 0 *and* the headline test count matches expectation, the suite is green regardless of how scary the summary reads. Re-run with raw output only if the headline numbers are missing or contradict the exit code.

If the suite is already red:

1. Surface the failure to the user: list each failing test, its file, and a one-line guess at cause.
2. Ask whether to (a) fix the pre-existing breakage as a separate housekeeping commit before the loop starts, or (b) abort.
3. Do not start the loop until the suite is green.

**Cross-repo baselining (when §2a flagged ≥ 1 task as cross-repo).** The CWD baseline above is necessary but NOT sufficient. The orchestrator MUST baseline tests in EVERY repo that appears in any task's `cross_repo: [...]` set from §2a — not just CWD. Without this, pre-existing flakes in a sibling repo will get attributed to whichever subagent first cd's into it, and the loop will stall mid-flight when verification fails on a flake the orchestrator never saw coming. (Real-world failure mode: Wave 1 drain of project 15 was invoked from `wood-fired-bugs` but tasks #309 / #310 lived in `wood-fired-engine/tooling/wfg-cc-telemetry`; CWD baseline ran clean, sibling-repo baseline never ran, and 3 pre-existing E2E flakes — `RestartIdempotency`, `ShimSocket`, `ShimLatency` — only surfaced during #309 verification mid-loop.)

For each unique sibling repo `R` in the union of all `cross_repo` sets:

1. Discover that repo's `<build>` and `<test>` commands using the same §2b heuristics (`CLAUDE.md`/`AGENTS.md`, `package.json`/`*.sln`/`Makefile`, README, CI workflows). Do NOT assume CWD's commands transfer — sibling repos may use a different stack.
2. Run the repo's `<build>` then `<test>` from `R` as cwd. Capture the exit codes and the headline pass/fail counts.
3. Record the per-repo result alongside the cross-repo classification: `{repo: <abs path>, build_status: <ok|fail>, test_status: <ok|fail>, test_baseline: "<N passing, M failing>", known_flakes: [<test names>]}`. This becomes the "per-repo flake landscape" that Step 4 briefs cite.

**Surface failures per-repo before dispatching the first worker.** If ANY sibling repo's baseline is red, the orchestrator MUST surface the failures grouped by repo (one section per repo, listing failing test names + one-line cause guess) and ask the user whether to (a) housekeeping-fix each red repo before the loop, (b) proceed with the failing tests pinned as `known_flakes` so Step 4 / Step 5 don't re-flag them, or (c) abort. Do NOT silently treat a sibling-repo failure as the worker's fault later — it isn't.

**Pre-loop sibling-repo state concerns.** For each sibling repo `R` in the cross-repo set, ALSO check:

1. `git -C <R> status --porcelain` — if non-empty, the repo has uncommitted local changes. Surface as a pre-loop concern (the loop may interact badly with the user's in-flight work — e.g. a worker may run `git stash` or commit alongside unrelated dirty files).
2. `git -C <R> rev-parse --abbrev-ref HEAD` — if the result is NOT `main`, the repo is on a feature/topic branch. Surface as a pre-loop concern (the loop typically targets `main`; landing commits on an unintended branch is hard to undo).

The orchestrator MUST NOT auto-stash, auto-switch branches, or otherwise mutate the sibling repo's working tree. Just surface the concerns grouped by repo with a one-line description each, and let the user decide whether to proceed, fix the state, or abort. Example surface:

> Sibling-repo state concerns before loop start:
> - `~/wood-fired-engine`: 3 uncommitted files (`tooling/wfg-cc-telemetry/...`); current branch is `feat/telemetry-redesign` (not `main`).
> - `~/.claude`: clean tree, on `main` — no concerns.
>
> Proceed anyway (worker may interact with in-flight work), pause for user to clean up, or abort?

### 2d. Verify your own skill additions (if applicable)

If you (the assistant) **added or modified `skills/tasks/*.md` or other repo files as part of this same session**, the very first validation run will tell you whether those additions broke something. Treat any failure here as a housekeeping commit (separate from any task in the project) before the loop proper. Example: a new skill that references an MCP tool the test suite's `KNOWN_*` set doesn't know about, or a hardcoded skill-file count that's now off-by-one.

### 2e. Identify task-size mismatch (advisory)

> Cross-repo scope is detected separately in §2a (cross-repo scope detection) and baselined in §2c; this sub-section is only about epic vs. bug sizing within whatever repo set §2a produced.

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

Wave 4.2 (task #319). Before entering §3 The Loop and BEFORE dispatching any worker, the orchestrator MUST call the `topology_check` MCP tool with `{project_id}` and branch on the returned `topology` field. `/tasks:loop` is the right tool ONLY when the project is **FLAT** (zero dependency edges). When edges exist, the loop is the wrong shape — `/gsd-autonomous` (for an ordered milestone) or running tasks individually in topological order is correct instead.

Record the branch outcome in orchestrator state as `gate_decision` for inclusion in the LOOP-RUN.md frontmatter (Step 9). Log the gate decision in the orchestrator's first prompt so a transcript reader sees what was decided and why.

**Branches:**

- **`topology: "FLAT"`** → set `gate_decision = "allowed"`. Proceed to §3 The Loop. No warning needed; this is the canonical case.

- **`topology: "DAG"`** → check whether the invocation arguments include the `--i-know-what-im-doing` flag (see §1 Argument Parsing).
  - If the flag IS present → set `gate_decision = "overridden"`. Proceed to §3 The Loop with a **loud warning** in the orchestrator's first prompt (e.g. `"WARNING: --i-know-what-im-doing override accepted; looping over a DAG with K dependency edges. Tasks may run out of dependency order."`). The override is logged so the human reviewing LOOP-RUN.md sees the explicit opt-in.
  - If the flag is NOT present → set `gate_decision = "blocked"`. HALT the loop immediately. Do NOT dispatch any worker. Emit this message verbatim, substituting the real project id and edge count:

    ```
    Project <id> has <count> dependency edges. Use /gsd-autonomous (for a milestone) or run tasks individually in topological order. Override with --i-know-what-im-doing.
    ```

- **`topology: "DAG_CYCLIC"`** → set `gate_decision = "blocked"` unconditionally. HALT the loop immediately. Do NOT dispatch any worker. The `--i-know-what-im-doing` flag **MUST NOT override** this branch — a cycle in the dependency graph means there is no topological order any runner could follow, so cycles must be broken before any runner can proceed. Emit this message verbatim, substituting the real project id:

    ```
    Project <id> has a dependency cycle (DAG_CYCLIC). Cannot loop — cycles must be broken before any runner can proceed. --i-know-what-im-doing does NOT apply.
    ```

**Blocked-branch behaviour:** when `gate_decision = "blocked"`, the orchestrator does NOT enter §3 The Loop, does NOT claim any task, and does NOT dispatch a worker. Step 9 (LOOP-RUN.md emit) is still permitted — emit a single LOOP-RUN.md with `gate_decision: blocked`, `tasks_attempted: 0`, and the empty-body sentinels — so the run is auditable. Step 10 (integration audit) is skipped (no worker sessions means no overlaps to audit).

---

## 3. The Loop

For each iteration, the orchestrator goes through **ten steps**. Do not skip ahead. Steps 1–9 run per iteration; **Step 10 runs ONCE at loop termination** (after the budget is hit or the backlog drains) — it is the only terminal step.

### Step 1 — Pick the next task

```
wood-fired-bugs:list_tasks with project_id=<id>, status=open
```

Sort by **priority** (urgent > high > medium > low), then by **task ID ascending** (oldest first). Skip tasks already claimed by someone else. Skip tasks whose `get_dependencies` shows unresolved `blocked_by` — mark them `blocked` and move on.

If `list_tasks status=open` returns empty, announce completion and exit. If you've hit `--max-tasks N` for this run, stop and summarise for the user instead of continuing.

**Deduplicate:** if multiple tasks share a root cause, pick the lowest ID and close the rest with a back-reference after the fix lands.

### Step 2 — Claim and read

```
wood-fired-bugs:claim_task with task_id=<id>, assignee=<your agent name>
wood-fired-bugs:get_task with id=<id>
wood-fired-bugs:get_comments with task_id=<id>
wood-fired-bugs:get_dependencies with task_id=<id>
```

Read the task description carefully. Extract:

- **Acceptance criteria** (often a list under "Acceptance criteria:" in the description).
- **Linked docs** — any references to roadmap sections, ADRs, line ranges.
- **Constraints** mentioned in the description ("avoid unrelated refactors", "warning-free", "don't bulk-reformat", etc.).

### Step 3 — Plan the validation depth and pre-scan scope

Using the matrix from Section 2b, decide what validation the orchestrator will run after the subagent returns. Doc-only? Tests only. Runtime? Build + tests + smoke. Be explicit about this *now* so the subagent brief in Step 4 specifies the same depth.

**Pre-scan the scope when the task's acceptance criteria are broad.** If the task says "replace X" or "add Y across the codebase" without naming sites, run a quick `grep` / `find` *yourself* to enumerate the actual sites *before* writing the brief. Concrete site counts ("4 `Record<string,any>` sites at these exact lines") let you scope the slice and write a tight brief. Vague briefs ("find and replace broad anys") cause subagents to drift or over-reach. This pre-scan should be light — read-only, under a minute, no edits.

**Pre-scan failure modes — try multiple patterns.** A single `grep` is brittle: if a dep is installed but `from 'dep'` returns 0 hits, the import may be via a wrapper (`from '@dep/integration'`), a default-export rename, a namespace import (`import * as fc from 'dep'`), or a re-export through a local barrel. Before stating "X doesn't exist" in a brief, try at least: the dep name without an import keyword, common wrapper namespace forms (`@<dep>/`), and a `find` for the conventional test file pattern (e.g. `*.property.test.ts`). A confident "absent" finding in the brief that's wrong wastes subagent time and forces a re-brief.

**Welcome subagent corrections.** If the subagent's report contradicts a factual claim in the brief (e.g. "property tests already exist — the real gap is X"), the subagent is usually right. They had time to investigate; the orchestrator had time to pre-scan. Don't push back to defend the brief; verify, accept, and move on. Note the correction in the close-out comment so the user sees the orchestrator-vs-subagent factual delta.

**If the task's acceptance criteria assume tooling that doesn't exist yet**, document the prerequisite and defer the dependent criterion. Example: a criterion that says "add an explicit lint exception pattern for unavoidable casts" is moot if there's no lint rule that flags casts. Note this in the close-out comment ("deferred — prerequisite tooling: enable `noExplicitAny`"); don't fabricate a stub.

### Step 4 — Dispatch a subagent

This is the load-bearing step. **Do not implement the fix yourself**, no matter how small it looks. Even tiny tasks should go through a subagent so that:

- Your context stays predictable (one summary per task, not 50 tool calls per task).
- Each iteration is independently auditable.
- The orchestrator remains the single source of truth for what passed/failed.

Use the `Agent` tool. Picking the agent type:

| Stack signal | Subagent |
|--------------|----------|
| `.csproj`, `.sln`, `*.cs` files | `dotnet-claude-kit:*` (pick by task shape — `code-review`, `test-engineer`, `build-error-resolver`, etc.) |
| TS/JS/Node/Python/Go/Rust/anything else | `general-purpose` |
| Read-only investigation (no edits) | `Explore` |

If unsure, `general-purpose` is always safe. Don't over-specialise — the brief is the load-bearing part, not the agent type.

Brief template — adapt to the task. Brief size should scale with codebase quality: if you know the repo is already well-typed and well-tested, prefer thinner briefs (keep the constraint list intact but drop worked-example idioms); if the repo is messy, beef up the "decisions in the brief" and "preferred idioms" sections.

```
You are implementing wood-fired-bugs task #<id> ("<title>") from project "<project_name>".
Working dir is `<repo_root>`. Do NOT commit — the orchestrator will commit after verifying your work.

## Working dir / Cross-repo context

<for single-repo tasks: just restate the working dir line above; this subsection can be omitted.>
<for cross-repo tasks (flagged in §2a, baselined in §2c) — REQUIRED:>

- Primary working dir: `<absolute path to the sibling repo this task targets>` — `cd` here before any edits or validation runs.
- Why this isn't CWD: this task's acceptance criteria reference files under `<that path>`, which is outside the orchestrator's CWD (`<orchestrator CWD>`).
- Per-repo baseline (from §2c):
  - Build: `<repo's build command>` — currently `<ok | fail>`.
  - Tests: `<repo's test command>` — currently `<N passing, M failing>`.
  - Known pre-existing flakes (do NOT attribute these to your changes): `<test names from §2c known_flakes>`.
- Per-repo state at loop start: `<branch>` branch, `<clean | N uncommitted files>` working tree. If you need to add new commits, target `main` unless instructed otherwise.

## Acceptance criteria (from the bugs database, verbatim)

<paste the task description's "Acceptance criteria:" block here>

## Relevant domain context (excerpts only, not the whole doc)

<paste the relevant section/line range from the domain spec doc(s) you read in Section 2a>

## Repository conventions (already discovered — don't re-evaluate)

- Stack: <language, runtime, key frameworks>
- Build: `<build command>`
- Tests: `<test command>` (current baseline: <N> tests / <M> files passing)
- Existing CI patterns: <one-line summary>
- Source tree shape: <one-line summary>
- Validation memo path: `.tasks-loop-memo.md`

## Required deliverables

<concrete list — files to create, scripts to add, exact CLI entry points>

## Hard constraints

- Don't touch <out-of-scope areas>.
- Don't bulk-edit existing source unless absolutely required (and explain why if you do).
- Don't modify <config files unrelated to this task>.
- Build must stay green: `<build>` ends with zero errors.
- Test suite must stay green: `<test>` ends with the same pass count as baseline.
- <Any task-specific constraints — warning-free, format-untouched, no console additions, etc.>

## Validation steps (run all before reporting back)

1. `<build>`
2. `<test>` — must still report <N> passing
3. <task-specific check, e.g. `npm run lint` must be warning-free>

Iterate until all pass. If you conclude a check can only be satisfied by relaxing rules / scope, relax and document the choice in the summary.

## Reporting back

Return a tight summary (under 400 words):
- Tooling / version chosen (if a choice was made).
- Files created or modified (full paths).
- Decisions and trade-offs (with one-line rationale each).
- Things you tried and disabled / deferred (so future tasks pick them up).
- Output of each validation step (pass/fail + headline numbers only).
- One-line suggested commit message.

Do NOT commit. Do NOT push. Do NOT modify the bugs database. The orchestrator owns those.
```

**Decision rules in the brief:**

- If a choice exists (tool A vs B, approach X vs Y), the orchestrator should pick one in the brief — based on the domain doc and stated preferences. Don't ask the subagent to choose; that drags decision-making into a context that lacks the project's full picture.
- Pass **excerpts** of domain docs, not the whole doc. The subagent doesn't need 500 lines of roadmap; it needs the 20 lines that anchor this task.
- When the brief asks the subagent to add a CI job, tell it explicitly: copy pinned action SHAs from a neighbouring job in the same workflow rather than fetching new ones. Otherwise the subagent may pick `@v4`-style floating refs that violate the project's pinning convention.
- **Audit-with-budget pattern.** When the acceptance criteria is "ensure X for every Y" (e.g. "every data-semantic migration has a targeted test", "every cast site is localised"), brief the subagent to *audit first, then act within a budget*. Typical budget: 1-2 fixes per iteration. If the audit surfaces 3+ gaps, the subagent adds **one** representative fix as a worked example, lists the remaining gaps in their summary, and the orchestrator records them in the close-out comment as recommended follow-on tasks. This prevents one task closure from ballooning into a sweep and keeps each commit coherent.
- Always end with "Do NOT commit". The orchestrator must stage and verify before any commit lands.

### Step 5 — Verify the subagent's claim

When the subagent returns its summary:

1. `git status` — confirm only the files the subagent named were modified. **If a file the subagent claimed to change is missing from `git status`, re-read it.** Subagents occasionally report a change they planned but didn't actually write; this catches it.
2. Read each modified file for obvious deviations from the brief (don't audit every line — sample the changes the summary highlighted). **Watch specifically for silent-pass gates**: a new CI job, npm script, or assertion that passes trivially (no-op, always-true condition, doesn't actually run the underlying tool). A gate that doesn't exercise the real check is worse than no gate — it gives false confidence forever. If you see one, re-brief and remove it (don't accept the compromise just because validation passed).
3. **Independently re-run the validation commands** from Step 3. Do not trust the subagent's reported numbers without re-running. Use `bash-summarize` for long-output commands (tests, full builds with many files) to keep raw output out of context; use plain `Bash` for short-output commands (typical `lint`, `npm run build` on small projects) where the summarizer overhead exceeds the savings. **Trust the exit code over the prose**: if the summarizer flags an error but exit is 0 and headline numbers match expectation, it's noise from a test exercising an error path. The `[bash-summarize] cmd=... exit=N` trailer line printed *by the wrapper itself* is the authoritative exit code — when the model's natural-language prose says "the exit code is likely 1" but the trailer shows `exit=0`, the trailer wins. The model's prose can hallucinate exit codes from scary stderr lines.
4. **Test re-run exception for declarative diffs.** If the entire diff is confined to config files (`tsconfig.json`, `*.config.*`, `package.json`, `.github/**`), documentation (`docs/**`, `README.md`, `*.md`), or no-behavior-change declarative modifiers (e.g. adding `override`/`readonly`/access modifiers to existing fields with identical initializers), you may skip the test re-run and validate with `build` + `lint` only. Note this in the close-out comment. Default is still to re-run tests — only skip when the diff truly cannot change runtime behaviour.
5. If validation now fails, send the subagent (or a new one) back with the failure output and a tight diagnostic prompt. Do *not* try to fix it inline in the orchestrator context — that defeats the pattern.
6. If validation passes, proceed.

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

### Step 7 — Dispatch tasks-verifier

The orchestrator MUST dispatch a separate `tasks-verifier` subagent to grade the work BEFORE closing the bugs task. This is non-negotiable — see the "Generator/critic separation" callout under Important Rules. The verifier reads the acceptance criteria, inspects the commits + diff the worker produced, and emits a structured PASS/FAIL/PARTIAL verdict. Full input/output contract: [`docs/verifier-contract.md`](../../docs/verifier-contract.md).

**Even a worker who reports "no changes needed" still triggers verifier dispatch** with `commit_shas: []` and `file_changes: []`. The contract treats an empty `commit_shas` as a strong negative signal — the verifier will mark file-referencing criteria FAIL unless they are truly observable without a diff (e.g. a doc-only "confirm X is documented at path Y" criterion that the verifier can satisfy by Read alone).

#### 7a. Build the `VerifierInputs` envelope

The orchestrator constructs a single JSON object matching the `VerifierInputs` interface in the contract:

```ts
const verifierInputs = {
  task_id: <id>,
  acceptance_criteria: <string>,         // see resolution rules below
  worker_subagent_session_id: <string>,  // opaque handle from the Step 4 Agent call
  commit_shas: <string[]>,               // from Step 6's `git rev-parse HEAD` / commit hash
  file_changes: <string[]>,              // from Step 6's `git diff --name-only <prev>..HEAD`
};
```

**Resolving `acceptance_criteria`** (in order):

1. Read the task's `acceptance_criteria` column via `wood-fired-bugs:get_task` (Wave 1.3 surfaces this as a first-class field).
2. If that column is NULL/empty, fall back to extracting the "ACCEPTANCE CRITERIA:" / "Acceptance criteria:" block from the task description (existing convention from Step 2).
3. If neither exists, **skip the verifier dispatch entirely** and proceed straight to Step 8 with `verification_evidence: { verdict: "NOT_VERIFIED", checks: [], verified_at: <iso8601> }` plus a comment noting "no acceptance criteria to grade against — verifier skipped". This is the documented escape hatch.

**Resolving `commit_shas` + `file_changes`**: after Step 6's `git commit`, capture `git rev-parse HEAD` and `git diff --name-only <pre-commit-sha>..HEAD`. If Step 6 produced multiple commits, list them in chronological order. If the worker reported "no changes needed" and Step 6 produced no commit at all, pass empty arrays — do NOT fabricate.

#### 7b. Dispatch the verifier subagent

Use the `Agent` tool. **Default to `subagent_type: "general-purpose"` with the verifier prompt embedded in the brief** — this works regardless of how the user installed the project. The named `subagent_type: "tasks-verifier"` is only registered for sessions started AFTER the user ran `install.sh`; in any fresh session the named agent is typically unavailable, and an Agent call with an unknown subagent_type FAILS the entire dispatch. Defaulting to general-purpose + embedded prompt is the reliable path.

Embed the full body of [`skills/agents/tasks-verifier.md`](../agents/tasks-verifier.md) as the Agent's prompt prefix (the orchestrator reads the file at run time so prompt updates flow automatically), followed by a fenced JSON block containing the `VerifierInputs` envelope. The contract requires the verifier's FINAL message to be a single JSON object parseable as `VerificationEvidence` — restate this hard constraint at the bottom of the brief so the model doesn't wrap the JSON in prose or a markdown fence.

```
Agent(
  subagent_type: "tasks-verifier",  // or "general-purpose" + embedded prompt body
  description: "Grade task #<id> against acceptance criteria",
  prompt: <<-EOF
Here is your VerifierInputs envelope. Follow docs/verifier-contract.md and the tasks-verifier subagent definition exactly. Your final message MUST be a single JSON object parseable as VerificationEvidence.

```json
${JSON.stringify(verifierInputs, null, 2)}
```
EOF
)
```

The verifier subagent's `tools:` frontmatter is restricted to read-only operations (Read, Grep, Glob, Bash with a git/test allowlist, and the read-only wood-fired-bugs MCP tools). It cannot Edit, Write, commit, push, or mutate the bugs database — by design. See `skills/agents/tasks-verifier.md` for the enforced allowlist.

**Bounds recap** (cite `docs/verifier-contract.md` §Bounds): the verifier MUST stay within **≤ 30 tool calls** and **≤ 5 minutes** wall-clock. The subagent self-throttles at 25 tool calls. If the orchestrator observes the bound exceeded, treat the run as `verdict: "PARTIAL"` with a synthetic final SKIP check noting the bound that triggered.

#### 7c. Parse + validate the verifier's output

Parse the verifier's final message as JSON. Validate against `VerificationEvidenceSchema` (`src/schemas/task.schema.ts`). Reject anything that does not match the schema.

**Common verifier emission bug — auto-repair, do NOT silently accept:** the schema's `checks[i].status` enum is `PASS | FAIL | SKIP` only; `PARTIAL` is a TOP-LEVEL `verdict` value, NEVER a per-check status. If the verifier emits `status: "PARTIAL"` (observed twice in early runs — known model failure mode), the orchestrator MUST re-dispatch the SAME verifier session via `SendMessage` with a tight diagnostic: "you emitted `status: \"PARTIAL\"` on check N — that's invalid (enum is PASS|FAIL|SKIP). Re-emit with `status: \"SKIP\"` and `evidence_url_or_text` starting `UNCHECKABLE: <reason>`, then recompute the top-level verdict per the rollup table." If the verifier wasn't dispatched with a `name:` (and thus is unreachable via SendMessage), dispatch a fresh verifier with the same envelope plus an explicit "your predecessor emitted invalid status='PARTIAL' — use SKIP+UNCHECKABLE instead" guardrail at the top of the brief.

On any other parse failure (malformed JSON, missing required fields, etc.), synthesize `{ verdict: "NOT_VERIFIED", checks: [], verified_at: <iso8601> }` and proceed to the `NOT_VERIFIED` branch below.

**Sanity-check the verdict against the rollup table** (contract §Verdict rollup rules). The orchestrator is allowed exactly ONE class of override: **rollup-driven DOWNGRADES**. Examples:
- Verifier emitted `verdict: "PASS"` but a check has `status: "FAIL"` → override `verdict` to `FAIL`.
- Verifier emitted `verdict: "PASS"` but a check has `status: "SKIP"` → override `verdict` to `PARTIAL`.

**Orchestrator MUST NOT upgrade a verdict** (FAIL→PARTIAL, FAIL→PASS, PARTIAL→PASS, NOT_VERIFIED→anything) on its own observation. If new evidence appears that would warrant an upgrade (e.g. the orchestrator runs a live smoke the verifier could not), the orchestrator MUST re-dispatch a fresh verifier with the new evidence embedded in the envelope (`additional_observations: ["<orchestrator-observed evidence>", ...]`). The fresh verifier's verdict is authoritative — the orchestrator never grades. **This is the load-bearing guarantee of the Generator/critic separation rule under Important Rules.**

If a verifier's verdict is wrong because the verifier mis-scoped the ACs (e.g. counted runtime-only criteria against a design-only task), the orchestrator MUST re-dispatch with a tighter `acceptance_criteria` scoping note — never silently drop checks the verifier emitted.

#### 7d. Branch on verdict

The verdict controls whether the task closes, blocks, or stays in_progress. **Do NOT skip a branch.** Each branch writes the full verifier evidence into `tasks.verification_evidence` via Wave 1.4's `update_task` field.

- **`verdict: "PASS"`** → proceed to Step 8 (close task as done). Pass the full verifier evidence object as `updates.verification_evidence` in the Step 8 `wood-fired-bugs:update_task` call. The status transition to `done` is gated on PASS — no other verdict reaches Step 8's `status: "done"` write.

- **`verdict: "FAIL"`** → the task is NOT done. The orchestrator MUST:
  1. Call `wood-fired-bugs:add_comment` with the failed checks formatted as a markdown bulleted list (one bullet per `checks[i]` with `status: "FAIL"`, citing the check `name` and its `evidence_url_or_text`).
  2. Call `wood-fired-bugs:update_task` with `updates: { "status": "blocked", "verification_evidence": <full evidence> }`.
  3. Do NOT call Step 8's close-as-done path. Move on to the next task in the loop.

  ```
  wood-fired-bugs:add_comment with task_id=<id>, author=<agent>, content=
    "Verifier verdict: FAIL.\n\nFailed checks:\n- <check.name>: <check.evidence_url_or_text>\n- ..."
  wood-fired-bugs:update_task with id=<id>, updates={
    "status": "blocked",
    "verification_evidence": <full evidence object>
  }
  ```

- **`verdict: "PARTIAL"`** → the task is neither closed nor blocked; it stays in_progress so a follow-on attempt can finish the UNCHECKABLE criteria. The orchestrator MUST:
  1. Call `wood-fired-bugs:add_comment` listing the UNCHECKABLE criteria (the `checks[i]` with `status: "SKIP"` and `evidence_url_or_text` starting with `UNCHECKABLE:`), one bullet per skipped check.
  2. Call `wood-fired-bugs:update_task` with `updates: { "verification_evidence": <full evidence> }` only — do NOT change `status`. The task stays `in_progress`.
  3. Move on to the next task in the loop.

  ```
  wood-fired-bugs:add_comment with task_id=<id>, author=<agent>, content=
    "Verifier verdict: PARTIAL.\n\nUNCHECKABLE criteria (need follow-on):\n- <check.name>: <check.evidence_url_or_text>\n- ..."
  wood-fired-bugs:update_task with id=<id>, updates={
    "verification_evidence": <full evidence object>
  }
  ```

- **`verdict: "NOT_VERIFIED"`** → treat as PARTIAL but with a comment noting the verifier produced no checks (no acceptance criteria to grade against, or the verifier's output failed schema validation). Status stays `in_progress`. This is the documented no-acceptance-criteria escape hatch — surface it so the user can backfill criteria and re-queue.

  ```
  wood-fired-bugs:add_comment with task_id=<id>, author=<agent>, content=
    "Verifier verdict: NOT_VERIFIED — no acceptance criteria available, or verifier output failed schema validation. Task stays in_progress; backfill acceptance_criteria and re-queue."
  wood-fired-bugs:update_task with id=<id>, updates={
    "verification_evidence": { "verdict": "NOT_VERIFIED", "checks": [], "verified_at": "<iso8601>" }
  }
  ```

Only the PASS branch falls through to Step 8. The FAIL / PARTIAL / NOT_VERIFIED branches all return to Step 1 after writing their comment + evidence.

### Step 8 — Close the bugs-db task

This step runs **only when Step 7 produced `verdict: "PASS"`**. For FAIL / PARTIAL / NOT_VERIFIED, Step 7 already wrote the appropriate `status` + `verification_evidence` and the loop returned to Step 1.

```
wood-fired-bugs:add_comment with task_id=<id>, author=<agent>, content=<structured summary>
wood-fired-bugs:update_task with id=<id>, updates={ "status": "done", "verification_evidence": <full evidence from Step 7> }
```

Comment template:

```
Resolved.

**Tooling / approach pick:** <if a choice was made — and why>.

**Changes:**
- <file>: <one-line per-file rationale>
- ...

**Disabled / deferred (each a future task in this project):**
- <rule / flag / feature> — reason.

**Validation (independently re-run by orchestrator):**
- <command>: <pass/fail + headline numbers>
- ...

**Commit:** `<hash>` <subject>
```

If duplicates exist, close them with `Resolved by fix to task #<id>. See comment on that task for details.`

Then continue to Step 9 (artifact emission) before returning to Step 1.

### Step 9 — Emit LOOP-RUN.md

The final orchestrator step writes a per-run audit artifact summarizing every task touched during this loop invocation. Contract: [`docs/loop-run-schema.md`](../../docs/loop-run-schema.md). JSON Schema mirror: [`docs/loop-run-schema.json`](../../docs/loop-run-schema.json). In-tree TypeScript schema (for tests + future tooling): [`src/lib/loop-run/schema.ts`](../../src/lib/loop-run/schema.ts). Reference example: [`docs/loop-run-reference-example.md`](../../docs/loop-run-reference-example.md).

#### 9a. Artifact path

```
.planning/loops/<UTC-timestamp>-<project_id>.md
```

- **Directory:** Always `.planning/loops/` — create on first emission.
- **Timestamp:** Compact ISO-8601 UTC, format `YYYYMMDDTHHMMSSZ` (e.g. `20260522T175000Z`). The orchestrator MUST use its own `started_at` (the time the loop began), NOT the per-iteration time — one file per run.
- **project_id:** The numeric wood-fired-bugs project id this loop drained.
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

The YAML frontmatter is the 14 required fields from `docs/loop-run-schema.md` §3 (mirrored field-for-field in `docs/loop-run-schema.json` and `src/lib/loop-run/schema.ts`). Source for each:

| Field | Source |
|---|---|
| `run_id` | UUIDv4 minted once at run start; reused across every re-emission. |
| `project_id` | The `project_id` resolved in §1 (Argument Parsing → Resolve Project ID). |
| `started_at` | Captured at the top of §2 (Pre-Loop Discovery) as RFC 3339 UTC. |
| `ended_at` | `now()` at the moment of this emission, RFC 3339 UTC. |
| `wall_seconds` | `floor((ended_at - started_at).total_seconds())`. |
| `orchestrator_session_id` | `$CLAUDE_SESSION_ID` env var if set; literal string `unknown` otherwise. |
| `total_tokens` | Sum of input + cache_create + cache_read + output across orchestrator + every subagent. **Primary source:** the `<usage>` block returned by each `Agent` call in Steps 4 and 7 (deterministic, immediately available). **Cross-check source:** `agent_transactions_v` filtered by orchestrator + child `session_id`s — authoritative for retrospective audit but not required at emit time. |
| `total_usd` | Same primary/cross-check split as `total_tokens`; cache-discounted. |
| `subagents_dispatched` | Count of distinct subagent sessions spawned this run (worker dispatches in Step 4 + verifier dispatches in Step 7). |
| `tasks_attempted` | Tasks picked up so far (Step 1 increments this counter). |
| `tasks_passed` / `tasks_failed` / `tasks_partial` / `tasks_not_verified` | Decided by the Step 7 verdict for each task. Increments on the corresponding Step 7 branch. |
| `gate_decision` (optional) | Section 2f topology pre-flight gate; set once at run start. `allowed` for FLAT, `overridden` for DAG with `--i-know-what-im-doing`, `blocked` for DAG (no override) or DAG_CYCLIC. Omit the field for pre-#319 emissions (the schema marks it optional for backward compatibility). |

Use orchestrator-observed counts as the primary source; cite `agent_transactions_v` as the cross-check source for any post-run audit. The skill MUST NOT block emission on a live DB connection.

#### 9d. Body sections

All sections from `docs/loop-run-schema.md` §4 are mandatory (empty sections use the documented sentinel paragraphs):

- **`## Tasks Closed`** — one row per task attempted so far. Columns in order: `task_id | title | verdict | evidence_link | subagent_session_id | commit_shas`. Title truncated to ≤ 100 chars with `…`. `commit_shas` is `—` when no commits landed (FAIL / NOT_VERIFIED / "no changes needed" branches).
- **`## Verifier Findings`** — one block per task with verdict `FAIL` or `PARTIAL`, populated from `verification_evidence.checks` cited verbatim (failing check `name` + `evidence_url_or_text`). Sentinel paragraph `_No findings: all attempted tasks verified clean._` when empty.
- **`## Integration Concerns`** — auto-flag when `git diff --name-only` across the worker session SHAs surfaces **≥ 2 distinct worker sessions touching the same file**. Exclude generated / lockfiles (`package-lock.json`, `*.lock`, `dist/**`). One bullet per overlap citing the file path, contributing task IDs, and commit SHAs. Sentinel `_No integration concerns auto-detected._` when empty.
- **`## Cost Breakdown`** — table with one row per participant (`orchestrator` + `subagent:<task_id>`) plus a `TOTAL` row. Columns: `participant | model | input_tokens | cache_create_tokens | cache_read_tokens | output_tokens | usd`. Primary source: orchestrator-observed `<usage>` blocks. Cross-check: `agent_transactions_v` (post-run, not required at emit time).
- **`## Replay Instructions`** — fenced ```bash block with the exact `/tasks:loop` arguments to re-grade this run (project name / id, `--max-tasks`, etc.) plus the verification commands the loop trusted (`npm run build && npm test && npm run lint`).

#### 9e. NOT committed (intentional)

`.planning/` is gitignored per project policy — see the `.gitignore` line `Internal planning + agent workspaces (not for open-source distribution)`. This mirrors gsd convention (`MILESTONE-AUDIT.md` and similar gsd artifacts also live in gitignored `.planning/`). LOOP-RUN.md is therefore a **local-machine per-run audit trail**, not a versioned artifact. The trade-off: replay across machines requires manual sharing (copy the file out, attach to a bugs-db comment, or paste into a PR description). The benefit: open-source distribution stays clean, and per-run forensic detail never leaks into the public history of a fork.

The orchestrator MUST NOT `git add` the `.planning/loops/` artifact. It MUST NOT modify `.gitignore` to make `.planning/loops/` an exception.

Return to Step 1.

### Step 10 — Integration audit (run termination)

This is the **terminal step**. It runs ONCE per loop run — never per iteration — after Step 1's "backlog empty" announcement OR after the `--max-tasks N` budget is hit. The goal is to catch the failure mode the per-task verifier cannot see: **ten green tasks that together break the system**. This is the same role gsd's `MILESTONE-AUDIT.md` plays for cross-phase integration; Step 10 is its `/tasks:loop` analogue. Subagent definition: [`skills/agents/integration-auditor.md`](../agents/integration-auditor.md). Inline schema: [`src/lib/loop-run/integration-audit-schema.ts`](../../src/lib/loop-run/integration-audit-schema.ts).

#### 10a. When this step runs

Step 10 runs ONCE at loop termination, **not per iteration**. Triggers:

- The `--max-tasks N` budget has been hit (the orchestrator is about to stop and check in with the user per Section "Drain Budget / Checkpoints").
- `list_tasks status=open` returned empty (the backlog has drained, the orchestrator is about to exit per Step 1's exit condition).

Step 10 fires AFTER the last Step 9 re-emit of LOOP-RUN.md for the run. Skipping Step 10 because the loop closed only one task is **not allowed** — a single-task loop can still produce an overlap with a prior (pre-loop) commit if the orchestrator picked that task up mid-day, but in practice the overlap detector handles this naturally (one worker session vs zero → no overlap).

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

Artifact path: `.planning/loops/<UTC-timestamp>-<project_id>-integration.md` — same `<UTC-timestamp>-<project_id>` prefix as the run's LOOP-RUN.md, with `-integration` suffix. The skill prose IS the contract; there is no separate `docs/integration-audit-schema.md` (out of scope — LOOP-RUN.md got that treatment in Wave 1.5 only because Wave 1 had a dedicated spec task).

**Frontmatter** (YAML, mirrors `IntegrationAuditFrontmatterSchema` in `src/lib/loop-run/integration-audit-schema.ts`):

```yaml
---
run_id: <UUIDv4 — REUSE the LOOP-RUN.md run_id; same run>
project_id: <integer>
generated_at: <RFC 3339 UTC>
overlap_count: <positive integer — file is only emitted when ≥ 1>
broken_count: <non-negative integer>
risky_count: <non-negative integer>
safe_count: <non-negative integer>
---
```

`broken_count + risky_count + safe_count` MUST equal `overlap_count` by construction — but the schema does NOT enforce the sum invariant (mirrors `LoopRunFrontmatterSchema`'s deliberate non-enforcement; the check is the replay tooling's job).

**Body** — one `## Overlap: <file_path>` block per overlap, ordered most-severe-first (BROKEN before RISKY before SAFE; within a severity, by file_path ascending):

```markdown
## Overlap: <file_path>

- **Tasks:** #<id_a>, #<id_b>
- **Verdict:** SAFE | RISKY | BROKEN
- **Rationale:** <auditor's rationale, ≤ 500 chars>

### Diff from task #<id_a>

\`\`\`diff
<git diff <pre>..HEAD -- <file_path> excerpt restricted to the hunks worker_a touched>
\`\`\`

### Diff from task #<id_b>

\`\`\`diff
<git diff <pre>..HEAD -- <file_path> excerpt restricted to the hunks worker_b touched>
\`\`\`

### Auditor evidence

- <evidence[0]>
- <evidence[1]>
- ...
```

#### 10d. Dispatch the integration-auditor subagent (one per overlap)

For EACH overlap in the deduplicated list, dispatch a separate `integration-auditor` invocation. **One auditor per overlap, NOT one per file** — every (file, task-pair) overlap gets its own verdict and evidence trail.

Use the `Agent` tool. Prefer `subagent_type: "integration-auditor"` if available — `install.sh` copies `skills/agents/integration-auditor.md` to `~/.claude/agents/integration-auditor.md`, so a user who ran the installer has the named agent registered. If the named agent is unavailable, fall back to `subagent_type: "general-purpose"` and embed the full body of `skills/agents/integration-auditor.md` as the Agent's prompt prefix, followed by a fenced JSON block containing the per-overlap envelope.

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

The integration-auditor's `tools:` frontmatter is restricted to read-only operations (Read, Grep, Glob, Bash with a strict git-read allowlist, and the read-only wood-fired-bugs MCP tools). It cannot Edit, Write, commit, push, or mutate the bugs database — by design. See `skills/agents/integration-auditor.md` for the enforced allowlist.

**Bounds recap**: the integration-auditor MUST stay within **≤ 15 tool calls** and **≤ 3 minutes** wall-clock per overlap. Bounds are tighter than `tasks-verifier`'s because the audit scope is one file × two hunks. If the bound is exceeded, the auditor self-emits `RISKY` with a note that the bound was hit.

**Parse + validate**: parse each auditor's final message as JSON. Reject anything that does not match `IntegrationOverlapSchema`. On parse failure or schema-validation failure, synthesize a fallback `{verdict: "RISKY", rationale: "auditor output unparseable", evidence: ["<note about the parse error>"]}` for that overlap — never silently drop an overlap, never auto-promote to SAFE.

#### 10e. Branch on rolled-up verdict

After every auditor returns (sequentially or in parallel — orchestrator's choice), roll up the verdicts:

- **No BROKEN, no RISKY** (all SAFE) → emit INTEGRATION-AUDIT.md at the path from §10c. **Do NOT revert any tasks.** Loop run is clean.
- **No BROKEN, ≥ 1 RISKY** (mix of SAFE + RISKY) → emit INTEGRATION-AUDIT.md. **Do NOT revert any tasks.** RISKY warnings are surfaced for human review; the loop run is NOT marked failed.
- **≥ 1 BROKEN** → emit INTEGRATION-AUDIT.md AND execute the BROKEN-revert protocol:

  1. For each task ID that appears in a BROKEN overlap, call `wood-fired-bugs:update_task` to flip it from `done` back to `in_progress`, **preserving** the verifier's PASS evidence (append an `integration_concern` note rather than replacing the existing `verification_evidence` object):

     ```
     wood-fired-bugs:update_task with id=<task_id>, updates={
       "status": "in_progress",
       "verification_evidence": {
         ...<existing PASS evidence>,
         "integration_concern": "BROKEN overlap on <file_path> with task #<other_id>; see .planning/loops/<artifact-path>"
       }
     }
     ```

  2. For each reverted task, call `wood-fired-bugs:add_comment` explaining the integration concern, citing the auditor's verdict and rationale:

     ```
     wood-fired-bugs:add_comment with task_id=<task_id>, author=<agent>, content=
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

Same agent = full context preserved; the re-brief can be short ("you previously did X, do Y instead, because Z"). If two re-briefs don't land the right outcome, mark the bugs-db task `blocked` with a comment listing what was tried, then move on.

### Subagent goes off-script

If the subagent committed despite being told not to, or modified files outside the brief's scope, do not paper over it:

1. `git reset` the bad changes if they're staged.
2. Re-brief with explicit "you previously did X, do not do that — here's why".
3. If it happens twice in a session, switch agent types or fall back to inline implementation for that task (and note the recurrence to the user — repeated off-script behaviour from the same agent type is a signal worth a skill update).

### Deployment / smoke blocked

If smoke requires privileged access (sudo, GPU, paid API, interactive UAT) and your environment can't provide it, note this in the task comment as a manual follow-up, confirm the fix via build+tests, and close the task. Don't stall the loop on environment limits.

### Task can't be resolved

After 2–3 honest subagent round-trips, set the task to `blocked` with a comment explaining what was tried and what's still failing. Move on.

---

## Important Rules

- **Generator/critic separation.** The orchestrator MUST dispatch a SEPARATE `tasks-verifier` subagent to grade each closed task. The orchestrator MUST NOT grade its own dispatches — the verifier's read-only context window is the entire point. Orchestrator validation (Step 5: build/test/lint) is necessary but not sufficient; the verifier checks the ACCEPTANCE CRITERIA, not the build. See Step 7 and [`docs/verifier-contract.md`](../../docs/verifier-contract.md) for the contract; `skills/agents/tasks-verifier.md` enforces the read-only tool surface. **The orchestrator's ONLY allowed local override is a rollup-driven DOWNGRADE** (e.g. `verdict: "PASS"` with a `FAIL` check → override to `FAIL`). UPGRADES (FAIL→PASS, PARTIAL→PASS, NOT_VERIFIED→anything) MUST come from a freshly re-dispatched verifier with the additional evidence in its envelope — never from the orchestrator's own judgment. Silently dropping checks the verifier emitted, or upgrading verdicts on observation, is forbidden.
- **You are the orchestrator, not the carpenter.** Every implementation goes through a subagent, even small ones. Exceptions only when the user explicitly asks for an inline fix.
- **One task at a time.** Plan → dispatch → verify → commit → close → repeat. No parallel task dispatch within a single project unless tasks are explicitly independent (rare).
- **Validation runs in the orchestrator, not just the subagent.** Re-run; never trust reported numbers.
- **Commit per task.** One task = one commit (plus an optional pre-loop housekeeping commit).
- **Epic-sized tasks → largest coherent slice, defer the rest.** When a task's own acceptance criteria say "incrementally" or "one X per PR" and span more work than fits in a single commit, the orchestrator picks the largest coherent slice that lands cleanly in one commit. Document what was deferred in the close-out comment so the user can promote follow-on tasks. Do *not* let an epic-sized task block the loop, and do *not* split into multiple commits within one task closure. **Inverse:** if all sub-deliverables are small independent config tweaks (each 5-15 lines, no shared touch points), they CAN fit in one commit together — that IS the largest coherent slice. Don't artificially fragment a task whose deliverables don't conflict.
- **Push after each commit.** Use `-u <remote> <branch>` on the first push if needed.
- **Close duplicates** with a back-reference.
- **Don't create new tasks during the loop.** Note discoveries in comments on related tasks; the user promotes them later.
- **Respect priority order** (urgent > high > medium > low; ties broken by lowest ID).
- **Be honest about manual steps.** If smoke/UAT/deploy was skipped, say so in the comment.
- **Stop when the budget is hit** (default 3 tasks) and check in with the user — don't silently keep going.
- **Stop when the backlog is empty.** Announce completion and exit; no polling.
