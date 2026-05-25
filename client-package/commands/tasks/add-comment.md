---
name: add-comment
description: "Adds a comment to a task. Use when user wants to add a note, leave feedback, or annotate a task with additional context."
argument-hint: [task-id] [comment]
disable-model-invocation: false
---

# Add Comment to Task

Adds a comment to a task with user-provided content.

## Workflow

1. **Parse task ID**
   - Extract task ID from `$ARGUMENTS[0]` (required)
   - Must be a positive integer
   - If missing or invalid, inform user: "Please provide a valid task ID"

2. **Parse comment text**
   - Extract comment from remaining `$ARGUMENTS` (required)
   - If not provided, ask user: "Please provide the comment content"

3. **Get author identity**
   - Use `"user"` as the author placeholder

4. **Add comment**
   - Call `wood-fired-tasks:add_comment` with:
     - `task_id`: task ID from step 1
     - `author`: `"user"`
     - `content`: comment text from step 2

5. **Confirm completion**
   - On success: "Comment added to task <id>"
   - On error: Report the error message from the server

## Example Usage

```
/tasks:add-comment 42 Verified this works in production
```

Result: "Comment added to task 42"
