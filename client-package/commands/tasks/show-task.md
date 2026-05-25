---
name: show-task
description: Shows full details of a task including comments and dependencies. Use when user wants to see task details, inspect a task, or review a specific task.
argument-hint: [task-id]
disable-model-invocation: false
---

Retrieve and display comprehensive information about a specific task.

## Workflow

1. Extract task ID from $ARGUMENTS[0]
   - Required: must be a positive integer
   - If missing or invalid, display error and exit

2. Fetch task data in parallel:
   - Call `wood-fired-tasks:get_task` with id parameter
   - Call `wood-fired-tasks:get_comments` with task_id parameter
   - Call `wood-fired-tasks:get_dependencies` with task_id parameter

3. Handle task not found:
   - If get_task returns error, display "Task <id> not found"
   - Exit workflow

4. Format and display task details:

   **Header:**
   - Task ID and title
   - Status with visual indicator (✓ done, ⏸ blocked, ▶ in_progress, ○ open)
   - Priority level

   **Core Details:**
   - Description (full text)
   - Assignee (or "Unassigned")
   - Project name
   - Created by and timestamp
   - Last updated timestamp

   **Optional Fields:**
   - Estimated time (if set)
   - Due date (if set)
   - Tags (comma-separated list if any)

   **Dependencies:**
   - Tasks this task blocks (if any)
   - Tasks blocking this task (if any)
   - Show ID, title, and status for each dependency

   **Comments:**
   - Chronological list of comments
   - For each: author, timestamp, content
   - If no comments, display "No comments yet"

5. Display formatted output to user

## Error Handling

- Invalid task ID format: "Error: Task ID must be a positive integer"
- Task not found: "Task <id> not found"
- API errors: Display error message from server
