---
name: my-work
description: Lists tasks assigned to the current user grouped by status. Use when user asks about their tasks, assigned work, workload, or what to do next.
disable-model-invocation: false
---

# My Work Workflow

Lists all tasks assigned to the current user, organized by status.

## Preflight: identity + MCP tools

**Resolve a real identity** before the `assignee` filter — do NOT pass the literal `"user"` (that turns every machine's `/tasks:my-work` into a noise-floor of "everyone's tasks"). In priority order: (1) `git config user.email`, (2) `$USER`, (3) `claude-<model>-<purpose>` (e.g. `claude-opus-4.7-my-work`). Pick once at top of invocation and capture as `$ME`.

This skill calls tools on the `wood-fired-bugs` MCP server. Shorthand `wood-fired-bugs:<tool>` ↔ harness name `mcp__wood-fired-bugs__<tool>`. On `InputValidationError`, load via `ToolSearch` (`select:mcp__wood-fired-bugs__list_tasks`) and retry.

## Steps

1. **Resolve identity** (per Preflight above) → `$ME`.

2. **Retrieve Assigned Tasks**
   - Call `wood-fired-bugs:list_tasks` with filter:
     - assignee: `$ME` (NOT the literal "user")

3. **Group Results by Status**

   See [_enums.md](_enums.md) for canonical status values (source: `src/types/task.ts`).

   Organize tasks in this priority order:
   - **in_progress**: Active work currently being done
   - **blocked**: Needs attention, cannot proceed
   - **open**: Ready to start, not yet begun
   - **done**: Recently completed tasks
   - **backlogged**: Deprioritized — not abandoned, can be picked back up
   - **closed**: Terminal (skipped from active display by default)

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
