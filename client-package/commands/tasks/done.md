---
name: done
description: "Marks a task as complete by setting status to done. Use when user finishes a task, says mark done, complete, or finished."
argument-hint: [task-id]
disable-model-invocation: false
---

# Mark Task as Done

Marks a task as complete by updating its status to `done`.

## Workflow

1. **Validate task ID**
   - Extract task ID from `$ARGUMENTS[0]` (required)
   - Must be a positive integer
   - If missing or invalid, inform user: "Please provide a valid task ID"

2. **Update task status**
   - Call `wood-fired-tasks:update_task` with:
     - `id`: task ID from step 1
     - `updates`: `{ "status": "done" }`

3. **Confirm completion**
   - On success: "Task <id> marked as done: <title>"
   - On error: Report the error message from the server

## Valid Status Transitions to Done

The following transitions are valid:
- `open` → `done` (task completed without formal pickup)
- `in_progress` → `done` (normal completion flow)
- `blocked` → `in_progress` → `done` (requires unblocking first)

If the task is currently `blocked`, it must be moved to `open` or `in_progress` before marking as done.

## Example Usage

```
/tasks:done 42
```

Result: "Task 42 marked as done: Implement authentication"
