---
name: blocked
description: "Marks a task as blocked and records the blocking reason as a comment. Use when user reports a blocker, dependency issue, or impediment on a task."
argument-hint: [task-id] [reason]
disable-model-invocation: false
---

# Mark Task as Blocked

Marks a task as blocked and records the blocking reason as a comment.

## Workflow

1. **Parse task ID**
   - Extract task ID from `$ARGUMENTS[0]` (required)
   - Must be a positive integer
   - If missing or invalid, inform user: "Please provide a valid task ID"

2. **Parse blocking reason**
   - Extract reason from remaining `$ARGUMENTS` (required)
   - If not provided, ask user: "Please provide a reason for the blocker"

3. **Update task status**
   - Call `wood-fired-tasks:update_task` with:
     - `id`: task ID from step 1
     - `updates`: `{ "status": "blocked" }`

4. **Record blocking reason**
   - Call `wood-fired-tasks:add_comment` with:
     - `task_id`: task ID from step 1
     - `author`: `"user"`
     - `content`: `"BLOCKED: <reason>"`

5. **Confirm completion**
   - On success: "Task <id> marked as blocked. Reason recorded: <reason>"
   - On error: Report the error message from the server

## Valid Status Transitions to Blocked

The following transitions are valid:
- `open` → `blocked`
- `in_progress` → `blocked`

## Example Usage

```
/tasks:blocked 42 waiting for API key from vendor
```

Result: "Task 42 marked as blocked. Reason recorded: waiting for API key from vendor"
