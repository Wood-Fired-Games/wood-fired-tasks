---
name: log-bug
description: Creates a bug report task with high priority. Use when user reports a bug, mentions an issue, or asks to log a problem.
argument-hint: [title] [description]
disable-model-invocation: false
---

# Log Bug Workflow

Creates a high-priority bug task in the Wood Fired Tasks system.

## Preflight: identity + MCP tools

**Resolve a real identity** for `created_by` — do NOT pass the literal `"user"`. In priority: (1) `git config user.email`, (2) `$USER`, (3) `claude-<model>-<purpose>`. Capture as `$CREATED_BY`.

Shorthand `wood-fired-tasks:<tool>` ↔ harness name `mcp__wood-fired-tasks__<tool>`. On `InputValidationError`, load via `ToolSearch` (`select:mcp__wood-fired-tasks__create_task,mcp__wood-fired-tasks__list_tasks,mcp__wood-fired-tasks__list_projects`) and retry.

## Steps

1. **Parse arguments — deterministic rule:**
   - **Title**: text up to the first sentence terminator (`. `, `? `, `! `, `;`, end-of-input, or a newline). If `$ARGUMENTS` begins with a quoted string, use that as title verbatim and treat the rest as description.
   - **Description**: everything after the title (if any).
   - **Priority override**: if `--priority urgent` (or `high|medium|low`) appears anywhere in `$ARGUMENTS`, use it; otherwise default `high`.

2. **Select project**
   - If a `--project <id>` arg is present, use it directly.
   - Otherwise call `wood-fired-tasks:list_projects`, present the list, ask user to pick. If only one project exists, default to it without prompting.
   - On empty project list: "No projects exist — create one first with the wood-fired-tasks UI or API. Cannot log a bug into nothing." Stop.

3. **Duplicate / reopen check**
   - Call `wood-fired-tasks:list_tasks` with `project_id=<id>` and a title-keyword filter (first 3 significant words of the parsed title).
   - If a matching task exists in `open`, `in_progress`, or `blocked` status: "Possible duplicate: #<existing_id> '<title>' (status=<status>). Reopen / comment on it instead? (y/N/new)". `y` → pivot to `/tasks:add-comment` on the existing task. `N` → create the new one. `new` → also create (override duplicate guard).
   - If matching task exists in `done` / `closed`: same prompt with "Reopen" framing → pivot to `/tasks:pick-up`.

4. **Create bug task**
   - Call `wood-fired-tasks:create_task` with:
     - `title`: parsed title
     - `description`: parsed description (if any)
     - `priority`: from step 1 override or default `'high'`
     - `project_id`: from step 2
     - `created_by`: `$CREATED_BY` (NOT the literal "user")
     - `tags`: `['bug']` plus any user-supplied tags

5. **Confirm creation**
   - Display task ID, title, priority, created_by, project.
   - If `--priority urgent`, also suggest `/tasks:pick-up <id>` immediately if a human is available.

## Priority values

Canonical priority enum: `low | medium | high | urgent`. There is no `critical` (use `urgent`) and no `normal` (use `medium`). Default for new bugs is `high`; `urgent` is for prod-down / data-loss scenarios.

## Notes

- Duplicate-check is a STRONG guard — most "log a bug" sessions produce dupes when the same crash is reported by multiple people.
- Always carry real `created_by` so audit trail survives across machines.
