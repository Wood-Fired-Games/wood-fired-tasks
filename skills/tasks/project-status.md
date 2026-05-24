---
name: project-status
description: "Shows project overview with task counts grouped by status and completion percentage. Use when user asks about project status, progress, overview, dashboard, or summary."
disable-model-invocation: false
---

# Project Status Overview

## Preflight: MCP tools

This skill calls tools on the `wood-fired-bugs` MCP server. The doc uses shorthand `wood-fired-bugs:<tool>`; harness tool names are `mcp__wood-fired-bugs__<tool>`. On `InputValidationError`, load via `ToolSearch` (`select:mcp__wood-fired-bugs__list_projects,mcp__wood-fired-bugs__list_tasks`) and retry.

## Purpose
Show high-level overview of all projects with task counts broken down by status and completion percentage.

## Process

### 1. Retrieve all projects
Call `wood-fired-bugs:list_projects` with empty parameters to get all projects.

### 2. Check for project filter
If $ARGUMENTS contains a project name or ID:
- Filter to show only that specific project's details
- Otherwise, process all projects

### 3. For each project, aggregate task data
For every project returned:

a. Call `wood-fired-bugs:list_tasks` with filter: { project_id: project.id }

b. Group tasks by status (canonical values: `open`, `in_progress`, `done`, `closed`, `blocked`, `backlogged` — see [_enums.md](_enums.md), source: `src/types/task.ts`). Display labels are title-cased for readability:
- Open
- In Progress
- Done
- Blocked
- Closed
- Backlogged

c. Calculate completion percentage: (done + closed) / total * 100

### 4. Format project output
For each project, display:

```
## <Project Name>
Total: <count> tasks | Completion: <percentage>%
- Open: <count>
- In Progress: <count>
- Done: <count>
- Blocked: <count>
- Closed: <count>
- Backlogged: <count>
```

### 5. Generate highlights section
After all projects are shown, add highlights:

- ATTENTION: Flag projects with blocked tasks (blocked count > 0) as needing attention
- Flag projects with high completion (>80%) as nearly done
- Show overall totals across all projects (total tasks, overall completion %)

### 6. Handle empty state
If no projects exist, display message: "No projects found. Use /tasks:create-task to get started."

## Output Format
- Group by project
- Show status breakdown with counts
- Display completion percentage per project
- Highlight blocked tasks and high-completion projects
- Provide overall summary statistics
