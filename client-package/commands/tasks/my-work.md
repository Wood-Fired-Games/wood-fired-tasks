---
name: my-work
description: Lists tasks assigned to the current user grouped by status. Use when user asks about their tasks, assigned work, workload, or what to do next.
disable-model-invocation: false
---

# My Work Workflow

Lists all tasks assigned to the current user, organized by status.

## Steps

1. **Get Current User**
   - Use 'user' as current user identity placeholder

2. **Retrieve Assigned Tasks**
   - Call `wood-fired-tasks:list_tasks` with filter:
     - assignee: 'user'

3. **Group Results by Status**

   Organize tasks in this priority order:
   - **in_progress**: Active work currently being done
   - **blocked**: Needs attention, cannot proceed
   - **open**: Ready to start, not yet begun
   - **done**: Recently completed tasks

4. **Format Output**

   For each task display:
   - Task ID
   - Title
   - Priority
   - Project name

5. **Show Summary Counts**

   Display summary: "X in progress, Y blocked, Z open, W done"

6. **Handle Empty Results**

   If no tasks found, display helpful message:
   - "No tasks currently assigned to you"
   - Suggest using /tasks:search to find other work
   - Suggest using /tasks:project-status to view project activity

## Notes

- Tasks grouped by status for clear prioritization
- Active and blocked tasks appear first
- Summary provides quick workload overview
