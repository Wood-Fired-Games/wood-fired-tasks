---
name: log-bug
description: Creates a bug report task with high priority. Use when user reports a bug, mentions an issue, or asks to log a problem.
argument-hint: [title] [description]
disable-model-invocation: false
---

# Log Bug Workflow

Creates a high-priority bug task in the Wood Fired Tasks system.

## Steps

1. **Parse Arguments**
   - Extract title from $ARGUMENTS (first quoted string or first few words)
   - Extract optional description from remaining $ARGUMENTS

2. **Select Project**
   - If no project specified, call `wood-fired-tasks:list_projects` to show available projects
   - Ask user to select project from list
   - Store selected project_id

3. **Create Bug Task**
   - Call `wood-fired-tasks:create_task` with:
     - title: [parsed title]
     - description: [parsed description if provided]
     - priority: 'high' (always high for bugs)
     - project_id: [selected project_id]
     - created_by: 'user'
     - tags: ['bug']

4. **Confirm Creation**
   - Display task ID and title
   - Confirm bug logged successfully

## Priority Values Reference

Valid priority values: low, medium, high, urgent

## Notes

- All bugs default to high priority
- Bug tag automatically applied
- Created by user attribution included
