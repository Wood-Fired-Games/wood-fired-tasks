---
name: done
description: "Marks a task as complete by setting status to done. Use when user finishes a task, says mark done, complete, or finished."
argument-hint: [task-id]
disable-model-invocation: false
---

# Mark Task as Done

Marks a task as complete by updating its status to `done`.

## Preflight: identity + MCP tools

**Resolve a real identity** for the optional close-out comment `author` field — do NOT pass the literal `"user"`. Priority: (1) `git config user.email`, (2) `$USER`, (3) `claude-<model>-<purpose>`. Capture as `$AUTHOR`.

Shorthand `wood-fired-bugs:<tool>` ↔ harness name `mcp__wood-fired-bugs__<tool>`. On `InputValidationError`, load via `ToolSearch` (`select:mcp__wood-fired-bugs__update_task,mcp__wood-fired-bugs__get_task,mcp__wood-fired-bugs__add_comment`) and retry.

## Workflow

1. **Parse args**
   - Task ID from `$ARGUMENTS[0]` (positive integer). On missing/invalid: "Please provide a valid task ID." Stop.
   - Optional close-out reason from remaining `$ARGUMENTS` (e.g. `/tasks:done 42 "verified in commit abc123, ship in v1.6.5"`).

2. **MANDATORY pre-check** — call `wood-fired-bugs:get_task` with `id=<id>`. Enforce the documented transition rules below BEFORE mutating:
   - **`open`** → proceed (task closed without formal pickup; common for tiny tasks).
   - **`in_progress`** → proceed (normal flow).
   - **`blocked`** → refuse: "Task <id> is `blocked` (reason: <last BLOCKED comment>). Marking blocked → done would bypass the unblock signal. Either: (a) `/tasks:pick-up <id>` to unblock and start, then `/tasks:done`, OR (b) if the blocker was resolved without work, run `/tasks:add-comment <id> 'unblocked: <why>'` first, then `/tasks:done <id>` once the status moves." Stop.
   - **`done`** → idempotent no-op: "Task <id> already done." Exit 0.
   - **`closed`** / **`cancelled`** → refuse: "Task <id> is terminal (`<status>`). Cannot mark done." Stop.
   - **Any other status** → report verbatim and exit; defensive.

3. **Close-out comment** (optional but recommended for audit trail)
   - If a reason was provided in step 1, call `wood-fired-bugs:add_comment` with `task_id=<id>, author=$AUTHOR, content="DONE: <reason>"` BEFORE the status update. (Same comment-first ordering as `/tasks:blocked` — if the status update fails, the reason is still recorded.)

4. **Update task status**
   - Call `wood-fired-bugs:update_task` with `id=<id>, updates={ "status": "done" }`.

5. **Confirm completion**
   - On success: "Task <id> marked as done by <$AUTHOR>: <title>".
   - On error: report server message; note that the comment (if step 3 ran) WAS recorded, so manual flip is the only outstanding action.

## Valid Status Transitions to Done

The transitions BELOW are enforced by step 2's pre-check — the skill refuses anything else:

- `open` → `done` ✅ (task completed without formal pickup)
- `in_progress` → `done` ✅ (normal completion flow)
- `blocked` → `done` ❌ REFUSED — must unblock first via `/tasks:pick-up` or `/tasks:add-comment`
- `done` → `done` ✅ IDEMPOTENT no-op
- `closed` / `cancelled` → `done` ❌ REFUSED — terminal states cannot be revived; open a new task

## Example Usage

```
/tasks:done 42
/tasks:done 42 "shipped in v1.6.5, commit abc123"
```

Result: "Task 42 marked as done by <author>: Implement authentication" (with a close-out comment recorded if a reason was given).
