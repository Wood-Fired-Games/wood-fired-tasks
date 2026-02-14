---
name: create-task
description: Creates a new task with configurable project, priority, and assignee. Use when user wants to add a task, create work items, or plan new work.
argument-hint: [title]
disable-model-invocation: false
---

# Create Task Workflow

Creates a new task in the Wood Fired Bugs system with full configuration options.

## Steps

1. **Parse Title**
   - Extract title from $ARGUMENTS

2. **Gather Task Details**

   Ask user for or extract from context:

   - **project**: Use `wood-fired-bugs:list_projects` to show available projects if not specified
   - **priority**: Default 'medium'. Valid values: low, medium, high, urgent
   - **assignee**: Optional. If not specified, leave unset
   - **description**: Optional. If not specified, leave unset
   - **estimated_minutes**: Optional. Estimated work duration in minutes
   - **due_date**: Optional. ISO 8601 format (e.g., 2026-02-15T12:00:00Z)
   - **tags**: Optional. Comma-separated list (e.g., feature, enhancement, refactor)

3. **Create Task**

   Call `wood-fired-bugs:create_task` with all gathered parameters:
   - title: [parsed title]
   - description: [if provided]
   - priority: [selected priority, default 'medium']
   - project_id: [selected project_id]
   - assignee: [if provided]
   - estimated_minutes: [if provided]
   - due_date: [if provided]
   - tags: [if provided]
   - created_by: 'user'

4. **Confirm Creation**

   Display:
   - Task ID
   - Title
   - Priority
   - Project name
   - Assignee (if set)

## Priority Values Reference

Valid priority values: low, medium, high, urgent

## Notes

- Default priority is medium
- All optional parameters can be omitted
- Created by user attribution always included
- Use ISO 8601 format for due dates
