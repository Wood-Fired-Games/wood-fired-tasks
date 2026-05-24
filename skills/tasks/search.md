---
name: search
description: Searches tasks by keyword across titles and descriptions. Use when user wants to find tasks, look up work items, or search for specific topics.
argument-hint: [keyword]
disable-model-invocation: false
---

Search for tasks matching a keyword in titles and descriptions.

## Preflight: MCP tools

This skill calls tools on the `wood-fired-bugs` MCP server. The doc uses shorthand `wood-fired-bugs:<tool>`; harness tool names are `mcp__wood-fired-bugs__<tool>`. On `InputValidationError`, load via `ToolSearch` (`select:mcp__wood-fired-bugs__list_tasks`) and retry.

## Workflow

1. **Parse `$ARGUMENTS`** — the first positional token is the keyword; remaining tokens are flags:
   - `--limit N` (optional integer, max 200, default 50). On an invalid value: "Error: --limit must be an integer between 1 and 200".
   - `--project <name-or-id>` (optional). Scopes the search to one project. If numeric or `#`-prefixed → treat as project ID. Otherwise → case-insensitive partial match against project names (call `wood-fired-bugs:list_projects` and pick the unique match; if 0 or >1 match: error).
   - `--all` (optional flag). Bypasses the 3-character minimum below.

2. **Validate keyword length** — minimum 3 characters unless `--all` is set.
   - If keyword is missing or empty: "Error: Search keyword required".
   - If keyword length < 3 and `--all` is NOT set: "Error: keyword must be at least 3 chars (or use --all)". Stop.
   - `--all` allows a 1-2 char or empty keyword for full-scan use cases (e.g. `--project 15 --all` to list every task in a project).

3. **Build filter** — `{ search: keyword, limit: <limit>, project_id?: <project-id> }`. The `limit` is the resolved cap (user's `--limit` value or 50 default). When `--project` was given as a name, substitute the resolved ID from step 1.

4. **Call** `wood-fired-bugs:list_tasks` with the filter built in step 3.

5. **Format search results** — for each matching task:
   - Task ID
   - Title
   - Status (open, in_progress, blocked, done, closed, backlogged)
   - Priority (low, medium, high, urgent)
   - Assignee (or "Unassigned" if null)

   See [_enums.md](_enums.md) for canonical status + priority values (source: `src/types/task.ts`).

6. **Display summary** — distinguish capped from total:
   - If `tasks.length < limit`: `"Found <N> tasks matching '<keyword>'"`.
   - If `tasks.length === limit` AND `total > limit` (the response carries a total/pagination signal): `"Showing <limit> of <total> matches for '<keyword>' — use --limit to see more"`.
   - If a `--project <name-or-id>` filter was applied, append `(scoped to project <name>)`.

7. **Handle no results** — if list_tasks returns empty array:
   - Display: `"No tasks found matching '<keyword>'"` (with project scope appended if applicable).
   - Suggest: `"Try a broader search term, drop --project, or use --all to include 1-2 char keywords."`

## Example Output

```
Search results for 'auth':

#42  [in_progress] HIGH   Implement JWT authentication     (alice)
#55  [open]        MEDIUM Add OAuth provider support       (Unassigned)
#67  [done]        MEDIUM Fix auth token expiration bug    (bob)

Found 3 tasks matching 'auth'
```
