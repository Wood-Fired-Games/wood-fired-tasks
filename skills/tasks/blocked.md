---
name: blocked
description: "Marks a task as blocked and records the blocking reason as a comment. Use when user reports a blocker, dependency issue, or impediment on a task."
argument-hint: [task-id] [reason]
disable-model-invocation: false
---

# Mark Task as Blocked

Marks a task as blocked and records the blocking reason as a comment.

## Preflight: identity + MCP tools

**Resolve a real identity** before the comment `author` field — do NOT pass the literal `"user"`. In priority: (1) `git config user.email`, (2) `$USER`, (3) `claude-<model>-<purpose>`. Capture once as `$AUTHOR`.

Shorthand `wood-fired-tasks:<tool>` ↔ harness name `mcp__wood-fired-tasks__<tool>`. On `InputValidationError`, load via `ToolSearch` (`select:mcp__wood-fired-tasks__update_task,mcp__wood-fired-tasks__add_comment,mcp__wood-fired-tasks__get_task`) and retry.

## Workflow

1. **Parse task ID** from `$ARGUMENTS[0]` (positive integer). On missing/invalid: error + exit.

2. **Parse blocking reason** from remaining `$ARGUMENTS`. If missing: "Please provide a reason for the blocker." Stop.

3. **Resolve `$AUTHOR`** per Preflight.

4. **MANDATORY pre-check** — call `wood-fired-tasks:get_task` with `id=<id>`. Reject illegal transitions BEFORE mutating:
   - **`done`** → refuse: "Task <id> is `done`. Blocking a done task would regress it — reopen with `/tasks:pick-up` first if that's what you meant." Stop.
   - **`closed`** → refuse: "Task <id> is terminal (`<status>`). Cannot block. Open a new task if needed." Stop.
   - **`backlogged`** → refuse: "Task <id> is deprioritized (`backlogged`). Move it back to `open` first if you want to block it." Stop.
   - **`blocked`** → idempotency guard: check last comment. If it's `BLOCKED: <same reason>` from the same author within last 60s, abort with "Already blocked by <author> with this reason at <created_at>." Otherwise warn "Already blocked — append additional reason? (y/N)".
   - **`open`** / **`in_progress`** → proceed to step 5.

5. **Comment-first ordering** (audit trail before state change — if step 6 fails, the reason is still on record):
   - Call `wood-fired-tasks:add_comment` with:
     - `task_id`: task ID
     - `author`: `$AUTHOR` (NOT the literal "user")
     - `content`: `"BLOCKED: <reason>"`
   - If comment fails: report error, do NOT proceed to step 6 (task stays in current state, user retries).

6. **Update task status**
   - **If the blocker IS another task** (the reason names a task id, or you just filed a defect/follow-up task for it — the bounce-style flow): call `wood-fired-tasks:update_task` with `id=<id>, updates={ "status": "blocked", "blocked_by": [<blockerTaskIds>] }`. This is ATOMIC — the blocking dependency edge(s) and the status flip commit together (all-or-nothing), so the task auto-unblocks (`blocked` → `open`) when the blocker closes. NEVER set `status: "blocked"` and then `add_dependency` as two calls; if the second call is skipped or fails, the task is blocked forever (no edge ⇒ the workflow engine's auto-unblock never fires). `blocked_by` without `status: "blocked"` is rejected.
   - **Otherwise** (external blocker — vendor, credentials, environment): call `wood-fired-tasks:update_task` with `id=<id>, updates={ "status": "blocked" }`. Note: edge-less blocked tasks never auto-unblock and are flagged by `check_health` (`blocked-without-edge` warning); someone must manually move the task back to `open`.
   - On failure: surface error AND note "Reason comment WAS recorded — manual status flip needed."

7. **Confirm completion**
   - On success: "Task <id> marked as blocked by <$AUTHOR>. Reason: <reason>"
   - On any failure path: explicit reconciliation guidance.

## Valid Status Transitions to Blocked

See [_enums.md](_enums.md) for canonical status values (source: `src/types/task.ts`).

- `open` → `blocked`
- `in_progress` → `blocked`
- (REFUSED) `done` / `closed` → `blocked` (would regress terminal state)
- (REFUSED) `backlogged` → `blocked` (move back to `open` first)
- (IDEMPOTENT) `blocked` → `blocked` with same author + same reason within 60s

## Example Usage

```
/tasks:blocked 42 waiting for API key from vendor
```

Result: "Task 42 marked as blocked. Reason recorded: waiting for API key from vendor"
