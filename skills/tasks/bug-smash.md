---
name: bug-smash
description: Autonomous bug-fixing loop. Picks the highest priority open task from a project, fixes it, validates with the project's build/test/smoke commands, closes the task, commits, pushes, and continues until none remain. Use when the user wants to autonomously drain a backlog.
argument-hint: [project-name]
disable-model-invocation: false
---

# Bug Smash Workflow

You are an autonomous bug-fixing agent. Your job is to work through the open tasks in a single Wood Fired Bugs project, fixing them one at a time with full validation, until none remain.

This skill is **project-agnostic**. Validation commands (`build`, `test`, `smoke`, `play`) are read from the target repository's conventions — they are NOT hardcoded here. Discover them once at the start and reuse them for the whole loop.

---

## 1. Argument Parsing

Parse the project name from `$ARGUMENTS`:

- **If an argument is provided:** treat it as a case-insensitive partial match against project names.
- **If no argument is provided:** ask the user which project to smash. Do not pick one silently.

### Resolve Project ID

Call `wood-fired-bugs:list_projects` and match the argument against project names. If no match is found, list available projects and stop:

```
Project "<argument>" not found.

Available projects:
  - <Project A> (id: 1)
  - <Project B> (id: 2)
  ...

Usage: /tasks:bug-smash [project-name]
```

Store the resolved `project_id` and `project_name` for the entire loop.

---

## 2. Discover Validation Commands (once, before the loop)

Before fixing anything, figure out how this repository builds, tests, and smoke-tests itself. Read project conventions from (in order of preference):

1. `CLAUDE.md`, `AGENTS.md`, or `CONTRIBUTING.md` in the repo root.
2. `package.json` `scripts`, `Makefile`, or `*.sln` for build/test entry points.
3. `README.md` "Development" / "Testing" sections.
4. Ask the user once if none of the above are conclusive.

Record the discovered commands as a plain checklist for the duration of the loop. For example, a TypeScript repo's checklist might be:

- **Build:** `npm run build`
- **Test:** `npm test`
- **Lint/typecheck:** `npm run lint && npm run typecheck`
- **Smoke:** `npm start` (verify clean startup, then stop)

A .NET repo's checklist might be:

- **Build:** `dotnet build --configuration Release`
- **Test:** `dotnet test --configuration Release`
- **Smoke:** start the service binary, verify health endpoint, stop

If the project has its own automated fix workflow (e.g. `/gsd:quick`, `dotnet-claude-kit:tdd`, repo-specific slash commands), record that too and use it in Step 5 instead of hand-implementing fixes.

---

## 3. The Loop

### Step 1: Find the Highest Priority Open Task

```
wood-fired-bugs:list_tasks with project_id=<project_id>, status=open
```

**Priority ranking** (highest to lowest): `urgent` > `high` > `medium` > `low`.
Among tasks of equal priority, prefer the **lowest task ID** (oldest first).

**If no open tasks remain:** announce completion and stop:

```
All open tasks in <project_name> have been resolved. Bug smash complete.
```

**Deduplicate:** if multiple tasks share the same root cause, pick the one with the lowest ID. After fixing it, close all duplicates with a comment referencing the fix.

### Step 2: Pick Up the Task

```
wood-fired-bugs:claim_task with task_id=<id>, assignee="<your agent name>"
```

If the task is already claimed by someone else, skip it and try the next-highest priority task.

Read full context in parallel:

```
wood-fired-bugs:get_task        with id=<id>
wood-fired-bugs:get_comments    with task_id=<id>
wood-fired-bugs:get_dependencies with task_id=<id>
```

If `get_dependencies` shows blockers that are not yet `done`, set this task to `blocked` and move on — do not work on a task whose dependencies are open.

### Step 3: Fix the Issue

Use the repository's standard fix workflow recorded in Step 2's discovery. In rough order of preference:

1. **Repo-native automated workflow** (e.g. `/gsd:quick <summary>` in a GSD project) — let it plan, implement, and verify.
2. **Manual implementation** — read the relevant files, apply the smallest fix that addresses the root cause, follow the repo's coding conventions.

**Do not duplicate work.** If you invoke a repo-native workflow, let it handle implementation. Don't re-implement on top of it.

### Step 4: Validate the Fix

Run the validation checklist you recorded in Section 2. **All checks must pass before closing the task.**

#### 4a. Build

Run the project's build command. Zero errors required. New warnings introduced by the fix should be addressed; pre-existing warnings are acceptable.

#### 4b. Tests

Run the project's test command. Zero failures, zero errors. If a test fails because the fix correctly changed behavior, update the test — do not revert the fix. If a test fails for an unrelated reason, note it in the task comment and proceed.

#### 4c. Smoke Test

Run the project's smoke / startup command from Section 2. Verify:
- The service/process starts without errors.
- No crash, hang, or unhandled exceptions in the first 10–15 seconds.
- The most basic happy-path interaction (health check, "hello world" request, dungeon renders, etc.) succeeds.

If the smoke step requires privileged access (e.g. `sudo docker`) or interactive input and that is blocked in your environment, **note it as a manual follow-up in the task comment and proceed.** Do not let environment limits stall the entire loop.

#### 4d. Optional: Play Test / Acceptance

If the project defines a higher-level acceptance check (interactive play test, end-to-end suite, manual UAT), run it when feasible. If it requires the user, note it in the comment and ask for verification.

### Step 5: Close the Task

After validation passes, add a comment summarizing what was done:

```
wood-fired-bugs:add_comment with task_id=<id>, author="<your agent name>", content=<summary>
```

The comment should include:
- **Root cause** — what was actually wrong.
- **Change** — which files were modified and why.
- **Validation** — what passed (build, tests, smoke).
- **Commit hash** — once committed in Step 6.
- **Caveats** — anything skipped (e.g. "docker deploy not verified — requires sudo").

Then close the task:

```
wood-fired-bugs:update_task with id=<id>, updates={ "status": "done" }
```

**Close duplicates:** if other open tasks describe the same root cause, close them with a back-reference:

```
Resolved by fix to task #<id>. See comment on that task for details.
```

### Step 6: Commit and Push

Stage only the files modified by this fix — never use `git add -A` or `git add .`. Commit with a descriptive message that references the task:

```bash
git add <specific files>
git commit -m "fix: <concise description>

Resolves task #<id>: <task title>"
git push
```

**If push fails (SSH, auth, conflict):** note it in the task comment as a manual follow-up and continue to the next task. Do not block the loop on push failures.

### Step 7: Loop

Return to Step 1 and find the next highest priority open task.

---

## Error Handling

### Build / Test Fails After Fix

1. Analyze the error and apply a targeted follow-up fix.
2. Re-run validation.
3. Do not close the task until validation is green.

If two correction attempts still leave validation red, set the task to `blocked` with a comment explaining what was tried and what's still failing — then move on.

### Deployment / Smoke Step Blocked

Note the limitation in the task comment, confirm the fix works via build + tests, close the task with the caveat. Do not stall the loop on environment-specific blockers.

### Task Cannot Be Fixed

After ~2–3 honest attempts:

1. Add a comment explaining what was tried and what's blocking resolution.
2. Set status to `blocked`.
3. Move to the next task.

### Mid-Loop Interruption

If the loop is interrupted (context limit, manual stop, environment failure), the next invocation can resume by simply rerunning the skill — `list_tasks status=open` always reflects current state, and any task left `in_progress` claimed by you will be reclaimable.

---

## Important Rules

- **One task at a time.** Complete the full cycle (fix → validate → close → commit → push) before starting the next.
- **Never skip validation.** Build + tests must pass before closing any task. Smoke is best-effort, document any skips.
- **Commit per task.** One task = one commit, with the task ID in the message.
- **Push after each commit.** Keep the remote current so reviewers can follow along.
- **Close duplicates.** If the same root cause appears in multiple tasks, fix once and close all of them with a back-reference.
- **Don't create new tasks during the loop.** If you discover unrelated issues, note them in comments on related tasks — the user can promote them to standalone tasks later.
- **Respect priority order.** Always work on the highest-priority available task.
- **Be honest about manual steps.** If a validation or deploy step needs the user (sudo, interactive UAT), say so in the comment and move on instead of pretending it passed.
- **Stop when finished.** When `list_tasks status=open` returns empty, announce completion and exit — do not keep polling.
