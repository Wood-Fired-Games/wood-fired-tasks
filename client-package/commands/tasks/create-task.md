---
name: create-task
description: Creates a new task with configurable project, priority, and assignee. Use when user wants to add a task, create work items, or plan new work.
argument-hint: [title]
disable-model-invocation: false
---

# Create Task Workflow

Creates a new task in the Wood Fired Tasks system with full configuration options.

## Preflight: identity + MCP tools

**Resolve a real identity** before the `created_by` field — do NOT pass the literal `"user"` (that destroys cross-machine audit attribution). In priority order: (1) `git config user.email`, (2) `$USER`, (3) `claude-<model>-<purpose>` (e.g. `claude-opus-4.7-create-task`). Pick once at top of invocation and capture as `$CREATED_BY`.

This skill calls tools on the `wood-fired-tasks` MCP server. Shorthand `wood-fired-tasks:<tool>` ↔ harness name `mcp__wood-fired-tasks__<tool>`. On `InputValidationError`, load via `ToolSearch` (`select:mcp__wood-fired-tasks__create_task,mcp__wood-fired-tasks__list_projects`) and retry.

## Steps

1. **Parse Title**
   - Extract title from $ARGUMENTS

2. **Gather Task Details**

   Ask user for or extract from context:

   - **project**: Use `wood-fired-tasks:list_projects` to show available projects if not specified
   - **priority**: Default 'medium'. Valid values: low, medium, high, urgent
   - **assignee**: Optional. If not specified, leave unset
   - **description**: Optional. If not specified, leave unset
   - **estimated_minutes**: Optional. Estimated work duration in minutes
   - **due_date**: Optional. ISO 8601 format (e.g., 2026-02-15T12:00:00Z)
   - **tags**: Optional. Comma-separated list (e.g., feature, enhancement, refactor)

3. **Create Task**

   Call `wood-fired-tasks:create_task` with all gathered parameters:
   - title: [parsed title]
   - description: [if provided]
   - priority: [selected priority, default 'medium']
   - project_id: [selected project_id]
   - assignee: [if provided]
   - estimated_minutes: [if provided]
   - due_date: [if provided]
   - tags: [if provided]
   - created_by: `$CREATED_BY` from Preflight (NOT the literal "user")

4. **Confirm Creation**

   Display:
   - Task ID
   - Title
   - Priority
   - Project name
   - Assignee (if set)

## Priority Values Reference

Canonical priority values (low → high): `low`, `medium`, `high`, `urgent`. There is no `critical` (use `urgent`) and no `normal` (use `medium`).

## Notes

- Default priority is medium
- All optional parameters can be omitted
- Created by user attribution always included
- Use ISO 8601 format for due dates
