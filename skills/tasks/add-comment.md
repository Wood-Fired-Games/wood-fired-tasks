---
name: add-comment
description: "Adds a comment to a task. Use when user wants to add a note, leave feedback, or annotate a task with additional context."
argument-hint: [task-id] [comment]
disable-model-invocation: false
---

# Add Comment to Task

Adds a comment to a task with user-provided content.

## Preflight: identity + MCP tools

**Resolve a real identity** before the `author` field — do NOT pass the literal `"user"` (that destroys cross-machine audit attribution). In priority order: (1) `git config user.email`, (2) `$USER`, (3) `claude-<model>-<purpose>` (e.g. `claude-opus-4.7-add-comment`). Pick once at top of invocation.

This skill calls tools on the `wood-fired-bugs` MCP server. The doc uses shorthand `wood-fired-bugs:<tool>`; harness tool names are `mcp__wood-fired-bugs__<tool>`. If a call returns `InputValidationError`, load via `ToolSearch` (`select:mcp__wood-fired-bugs__add_comment`) and retry.

## Workflow

1. **Parse task ID**
   - Extract task ID from `$ARGUMENTS[0]` (required, positive integer).
   - If missing or invalid: "Please provide a valid task ID".

2. **Parse comment text**
   - Extract comment from remaining `$ARGUMENTS` (required).
   - If not provided, ask user: "Please provide the comment content".

3. **Resolve author identity** (per Preflight above) — capture as `$AUTHOR` for this run.

4. **Pre-flight task existence check**
   - Call `wood-fired-bugs:get_task` with `id=<task-id>` (cheap; gives a clean "task not found" error before mutating).
   - On `404` / not-found: "Task <id> not found — check the ID or list with `/tasks:my-work`." Stop.

5. **Idempotency check** (avoid double-comment from accidental retry)
   - Call `wood-fired-bugs:get_comments` with `task_id=<id>`. If the most recent comment matches `(author=$AUTHOR, content=<your text>)` AND was created within the last 60s, warn: "Identical comment from <author> exists at <created_at> — append anyway? (y/N)". Default abort on N or no response.

6. **Add comment**
   - Call `wood-fired-bugs:add_comment` with:
     - `task_id`: task ID from step 1
     - `author`: `$AUTHOR` from step 3 (NOT the literal "user")
     - `content`: comment text from step 2

7. **Confirm completion**
   - On success: "Comment added to task <id> by <author>".
   - On error: report the server message AND suggest a retry path (e.g. "rerun once after checking ToolSearch loaded `mcp__wood-fired-bugs__add_comment`").

## Example Usage

```
/tasks:add-comment 42 Verified this works in production
```

Result: "Comment added to task 42"
