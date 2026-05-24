---
name: pick-up
description: Assigns a task to the current user and sets status to in_progress. Use when user wants to start working on a task, pick up a task, or claim a task.
argument-hint: [task-id]
disable-model-invocation: false
---

Assign a task to the current user and transition it to in_progress status.

## Preflight: identity + MCP tools

**Resolve a real identity** before the `assignee` field — do NOT pass the literal `"user"` (that turns every machine's `/tasks:my-work` into a noise-floor of "everyone's tasks"). In priority order: (1) `git config user.email`, (2) `$USER`, (3) `claude-<model>-<purpose>`. Pick once at top of invocation and capture as `$ASSIGNEE`.

This skill calls tools on the `wood-fired-bugs` MCP server. Shorthand `wood-fired-bugs:<tool>` ↔ harness name `mcp__wood-fired-bugs__<tool>`. On `InputValidationError`, load via `ToolSearch` (`select:mcp__wood-fired-bugs__claim_task,mcp__wood-fired-bugs__get_task`) and retry.

## Workflow

1. **Parse task ID** from `$ARGUMENTS[0]` (positive integer). On missing/invalid: error + exit.

2. **Resolve assignee** per Preflight → `$ASSIGNEE`.

3. **MANDATORY pre-check** — call `wood-fired-bugs:get_task` with `id=<id>`. Branch on current status:
   - **`open`** → proceed to step 4.
   - **`in_progress`** with assignee == `$ASSIGNEE` → idempotent re-pickup; just print "Already yours" and exit.
   - **`in_progress`** with different assignee → warn "Task <id> is claimed by <other>. Steal? (y/N)". Default abort on no response.
   - **`blocked`** → warn "Task <id> is blocked: <reason from last BLOCKED comment>. Unblock and start? (y/N)". On Y, set status to `in_progress` AND add comment `"UNBLOCKED via /tasks:pick-up by $ASSIGNEE"`.
   - **`done`** OR **`closed`** → **require explicit confirmation**: "Task <id> is `<status>`. Reopen? Type `reopen <id>` to confirm." Plain `y` is not enough — typos on done tasks are too costly to allow loose confirmation.
   - **Any other status** → report verbatim and exit; defensive.

4. **Atomic claim via `claim_task` (NOT `update_task`)** — the dedicated tool encodes race-condition protection that `update_task` does not:
   - Call `wood-fired-bugs:claim_task` with `task_id=<id>, assignee=$ASSIGNEE`.
   - On race-loss (another runner won the claim between our get_task and claim_task): re-fetch and re-evaluate — do NOT force.

5. **Confirm successful pickup:**
   - Display: "Task <id> claimed by <$ASSIGNEE>, status now `in_progress`."
   - Show task title, priority, estimated time (if set), and the `verification_evidence` summary if non-null (so the user sees prior verifier history before they start).

## Valid Status Transitions

- `open` → `in_progress` — normal pickup.
- `blocked` → `in_progress` — requires confirm + audit comment.
- `in_progress` (self) → `in_progress` — idempotent no-op.
- `in_progress` (other) → `in_progress` (self) — requires `(y/N)` confirm.
- `done` / `closed` → `in_progress` — requires typed `reopen <id>` confirmation.

## Error Handling

- Invalid task ID format: `"Error: Task ID must be a positive integer."`
- Task not found: `"Task <id> not found — list with /tasks:my-work or /tasks:search."`
- Race-loss on claim: `"Lost race to <other>. Re-pick later or pick a different task."`
- API errors: display server message + suggest ToolSearch retry.
