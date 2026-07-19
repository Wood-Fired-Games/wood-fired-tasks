---
name: project-status
description: "Shows project overview with task counts grouped by status and completion percentage. Use when user asks about project status, progress, overview, dashboard, or summary."
disable-model-invocation: false
---

# Project Status Overview

## Preflight: MCP tools

This skill calls tools on the `wood-fired-tasks` MCP server. The doc uses shorthand `wood-fired-tasks:<tool>`; harness tool names are `mcp__wood-fired-tasks__<tool>`. On `InputValidationError`, load via `ToolSearch` (`select:mcp__wood-fired-tasks__list_projects,mcp__wood-fired-tasks__list_tasks,mcp__wood-fired-tasks__wsjf_health`) and retry.

## Purpose
Show high-level overview of all projects with task counts broken down by status and completion percentage.

## Process

### 1. Retrieve all projects
Call `wood-fired-tasks:list_projects` with empty parameters to get all projects.

### 2. Check for project filter
If $ARGUMENTS contains a project name or ID:
- Filter to show only that specific project's details
- Otherwise, process all projects

### 3. For each project, aggregate task data
For every project returned:

a. **Issue all `wood-fired-tasks:list_tasks` calls in a SINGLE message with multiple function_calls blocks** — that's the mechanism for parallel tool execution. Do NOT chain them with `await` semantics or list them sequentially across multiple messages. One call per project with filter: `{ project_id: project.id }`. On a workspace with N projects this is one round-trip wave instead of N sequential round-trips.

b. Group tasks by status (canonical values: `open`, `in_progress`, `done`, `closed`, `blocked`, `backlogged` — see [_enums.md](_enums.md), source: `src/types/task.ts`). Display labels are title-cased for readability:
- Open
- In Progress
- Done
- Blocked
- Closed
- Backlogged

c. Calculate completion percentage: `(done + closed) / total * 100`. **Guard against division-by-zero**: when `total === 0`, the percentage is undefined — render `—` (em dash) instead of `0%`. 0% means "work exists but none done"; `—` means "no work exists yet" — the user MUST be able to distinguish.

### 4. Format project output
For each project, display:

**Non-empty project (total > 0):**
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

**Empty project (total = 0):**
```
## <Project Name>
(no tasks) | Completion: —
```
Do NOT render the per-status breakdown for empty projects (every line would be `0` — noise). The single `(no tasks)` line is the entire body.

### 4b. Surface WSJF health findings
For each project being shown, also probe the `wood-fired-tasks:wsjf_health` MCP tool with `{ project_id: project.id }`. This is the non-blocking spec §9 degeneracy / pitfall linter — it is a pure read and writes nothing. Issue these calls in the SAME single message as the §3a `list_tasks` wave (one `wsjf_health` call per project) so the whole status pass stays one round-trip.

The tool returns `{ healthy, scored_task_count, findings[] }`. Each entry in `findings[]` carries `check` (the stable check id), `severity` (`info` | `warning` | `critical`), `message` (a plain-language explanation), and `suggestion` (a concrete fix).

- **`healthy: true` (empty `findings[]`)** → render NOTHING for that project. A healthy backlog is silent — do not print an "OK" line per project (it is noise on a multi-project workspace).
- **`findings[]` non-empty** → under the project's status block, add a `WSJF Health` subsection listing each finding as `- [<severity>] <message> Fix: <suggestion>`. Order findings `critical` → `warning` → `info`. Lead with the highest severity so a past-deadline stale-Time-Criticality (`critical`) finding is the first thing the reader sees.
- If `wsjf_health` is unavailable (the shipped stdio server ALWAYS registers it — `src/mcp/server.ts` always constructs `WsjfHealthService` and passes it to `registerWsjfTools`; absence means an older or non-standard server), skip this subsection silently; status output is never blocked on the linter.

### 5. Generate highlights section
After all projects are shown, add highlights:

- ATTENTION: Flag projects with blocked tasks (blocked count > 0) as needing attention
- Flag projects with high completion (>80%) as nearly done
- Flag any project whose `wsjf_health` returned a `critical` finding (e.g. past-deadline stale Time Criticality) as needing rescore attention.
- Show overall totals across all projects (total tasks, overall completion %)

### 6. Handle empty state
If no projects exist, display message: "No projects found. Use /tasks:create-task to get started."

## Output Format
- Group by project
- Show status breakdown with counts
- Display completion percentage per project
- Highlight blocked tasks and high-completion projects
- Provide overall summary statistics
