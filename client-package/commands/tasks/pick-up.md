---
name: pick-up
description: Assigns a task to the current user and sets status to in_progress. Use when user wants to start working on a task, pick up a task, or claim a task.
argument-hint: [task-id]
disable-model-invocation: false
---

Assign a task to the current user and transition it to in_progress status.

## Workflow

1. Extract task ID from $ARGUMENTS[0]
   - Required: must be a positive integer
   - If missing or invalid, display error and exit

2. Get current user identity
   - Use 'user' as placeholder for current user
   - In production, this would be the authenticated user's identifier

3. Check current task status (optional but recommended):
   - Call `wood-fired-bugs:get_task` to retrieve current state
   - If task is already in_progress or done, inform user before updating:
     - "Task <id> is already <status>"
     - Ask for confirmation to proceed

4. Update task assignment and status:
   - Call `wood-fired-bugs:update_task` with:
     - id: task ID from arguments
     - updates: {
         assignee: 'user',
         status: 'in_progress'
       }

5. Confirm successful pickup:
   - Display: "Task <id> assigned to <user> and set to 'in_progress'"
   - Show task title for context
   - Show priority level
   - Mention estimated time if present

## Valid Status Transitions

- `open` → `in_progress` (normal task pickup)
- `blocked` → `in_progress` (unblocking and starting work)
- `in_progress` → `in_progress` (reassignment to current user)
- `done` → `in_progress` (reopening completed task)

## Error Handling

- Invalid task ID format: "Error: Task ID must be a positive integer"
- Task not found: "Task <id> not found"
- API errors: Display error message from server
