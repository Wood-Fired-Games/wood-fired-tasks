---
name: bug-smash
description: Autonomous backlog-drain loop. A single orchestrating context picks the highest priority open task from a Wood Fired Bugs project, dispatches a subagent to implement the fix, independently re-validates with the project's build/test/smoke commands, closes the task, commits, pushes, and continues. Use when the user wants to drain an open backlog hands-off without filling the main context with implementation noise.
argument-hint: [project-name] [--max-tasks N]
disable-model-invocation: false
---

# Bug Smash Workflow

You are the **orchestrator** of an autonomous backlog-drain. Your job is *not* to implement fixes yourself — your job is to **plan, dispatch subagents, verify, and commit**, so this single context stays clean and consistent across many task iterations.

The loop is project-agnostic. Validation commands (`build`, `test`, `smoke`) and domain-spec docs are discovered from the target repository's conventions, not hardcoded.

> **Mental model.** Think of yourself as the foreman, not the carpenter. Each task: hand a self-contained brief to a fresh subagent (the carpenter), then independently re-check the work before signing it off. Your context only holds the *plan, summaries, and verification results* — never raw build logs, file scans, or trial-and-error.

---

## 1. Argument Parsing

Parse `$ARGUMENTS` — or, when invoked via natural language ("run bug-smash on project X"), extract the equivalent fields from the request:

- `[project-name-or-id]` — if the value starts with `#` or is a bare integer, treat it as the project ID and skip the name match. Otherwise, do a case-insensitive partial match against project names.
- `--max-tasks N` — optional. Stop the loop after N successful task closures and check in with the user before continuing. Default is **3**. Pass `--max-tasks 0` to loop until the backlog is empty (only do this if the user explicitly asks for unattended drain). If the user invokes via natural language and doesn't state a budget, default to **3** but propose an adjustment in Section 2e if the backlog looks epic-sized.

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

If the loop is non-trivial (≥ 2 tasks) and the spec doc is large (>200 lines), externalize the mental notes into a short cache file at the repo root (e.g. `.bug-smash-spec-excerpts.md`) with one entry per likely-referenced section: doc path + line range + 1-line summary + which task IDs probably need it. Later loop iterations pull from the cache instead of re-deriving section/line refs from memory. Add the cache path to `.gitignore` if not already covered.

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

Record this matrix as a short memo. If the loop is non-trivial (≥ 3 tasks), **write the memo to `.bug-smash-memo.md` at the repo root** so subagents you spawn can read it without you re-explaining. Add the memo path to `.gitignore` if it isn't already covered.

### 2c. Baseline the test suite

**Before touching anything, run `<build>` and `<test>`** and confirm they pass on the unchanged tree. If they don't, the loop must not start — pre-existing breakage will be attributed to the first task and stall everything.

**Trust the exit code, not the summarizer prose.** `bash-summarize` will sometimes prominently flag stderr noise from tests that exercise error paths (e.g. `error: required option '-a, --assignee <name>' not specified` from a CLI argparse fixture). If the exit code is 0 *and* the headline test count matches expectation, the suite is green regardless of how scary the summary reads. Re-run with raw output only if the headline numbers are missing or contradict the exit code.

If the suite is already red:

1. Surface the failure to the user: list each failing test, its file, and a one-line guess at cause.
2. Ask whether to (a) fix the pre-existing breakage as a separate housekeeping commit before the loop starts, or (b) abort.
3. Do not start the loop until the suite is green.

### 2d. Verify your own skill additions (if applicable)

If you (the assistant) **added or modified `skills/tasks/*.md` or other repo files as part of this same session**, the very first validation run will tell you whether those additions broke something. Treat any failure here as a housekeeping commit (separate from any task in the project) before the loop proper. Example: a new skill that references an MCP tool the test suite's `KNOWN_*` set doesn't know about, or a hardcoded skill-file count that's now off-by-one.

### 2e. Identify task-size mismatch (advisory)

Scan the open task list for signals that tasks are **epic-sized rather than bug-sized**:

- Description contains "Acceptance criteria:" with 3+ bullets.
- Description references a multi-phase roadmap document.
- Tags include `roadmap`, `epic`, `milestone`, `phase`.
- `parent_task_id` is null but the task title sounds like a workstream ("Add ESLint and formatter quality gate", "Strengthen migration safety", etc.).

If most open tasks fit those signals, surface this to the user before starting — *unless* the project name or description itself contains the words `roadmap`, `phase`, or `epic` (the user already knows the shape). In the self-identifying case, skip the "are you sure?" framing and ask only for the budget number:

> Project self-identifies as a roadmap. Recommend `--max-tasks=1` (one epic-sized commit per run, with a checkpoint between). Confirm budget (1, 2, or 3) and I'll proceed.

In the non-self-identifying case (you discovered the epic shape but the user didn't telegraph it), use the longer framing:

> The backlog looks epic-sized (e.g. roadmap phases) rather than bug-sized. The smash loop will still work, but each iteration will spawn a long-running subagent and produce a substantial commit. Confirm `--max-tasks N` is set sensibly (recommend 1–3 for epics, 5–10 for true bugs) and that you want me to proceed.

---

## 3. The Loop

For each iteration, the orchestrator goes through **seven steps**. Do not skip ahead.

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
- Validation memo path: `.bug-smash-memo.md`

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

### Step 7 — Close the bugs-db task

```
wood-fired-bugs:add_comment with task_id=<id>, author=<agent>, content=<structured summary>
wood-fired-bugs:update_task with id=<id>, updates={ "status": "done" }
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

Return to Step 1.

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
3. If it happens twice in a session, switch agent types or fall back to inline implementation for that task (and note in the v3 friction log).

### Deployment / smoke blocked

If smoke requires privileged access (sudo, GPU, paid API, interactive UAT) and your environment can't provide it, note this in the task comment as a manual follow-up, confirm the fix via build+tests, and close the task. Don't stall the loop on environment limits.

### Task can't be resolved

After 2–3 honest subagent round-trips, set the task to `blocked` with a comment explaining what was tried and what's still failing. Move on.

---

## Important Rules

- **You are the orchestrator, not the carpenter.** Every implementation goes through a subagent, even small ones. Exceptions only when the user explicitly asks for an inline fix.
- **One task at a time.** Plan → dispatch → verify → commit → close → repeat. No parallel task dispatch within a single project unless tasks are explicitly independent (rare).
- **Validation runs in the orchestrator, not just the subagent.** Re-run; never trust reported numbers.
- **Commit per task.** One task = one commit (plus an optional pre-loop housekeeping commit).
- **Epic-sized tasks → largest coherent slice, defer the rest.** When a task's own acceptance criteria say "incrementally" or "one X per PR" and span more work than fits in a single commit, the orchestrator picks the largest coherent slice that lands cleanly in one commit. Document what was deferred in the close-out comment so the user can promote follow-on tasks. Do *not* let an epic-sized task block the loop, and do *not* split into multiple commits within one task closure.
- **Push after each commit.** Use `-u <remote> <branch>` on the first push if needed.
- **Close duplicates** with a back-reference.
- **Don't create new tasks during the loop.** Note discoveries in comments on related tasks; the user promotes them later.
- **Respect priority order** (urgent > high > medium > low; ties broken by lowest ID).
- **Be honest about manual steps.** If smoke/UAT/deploy was skipped, say so in the comment.
- **Stop when the budget is hit** (default 3 tasks) and check in with the user — don't silently keep going.
- **Stop when the backlog is empty.** Announce completion and exit; no polling.
