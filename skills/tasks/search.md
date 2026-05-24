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

1. Extract search keyword from $ARGUMENTS
   - Required: at least 1 character
   - If missing or empty, display error: "Error: Search keyword required"

2. Call `wood-fired-bugs:list_tasks` with filter parameter:
   - filter: { search: keyword }
   - This searches across both title and description fields

3. Format search results:
   - For each matching task, display:
     - Task ID
     - Title
     - Status (open, in_progress, blocked, done, closed, backlogged)
     - Priority (low, medium, high, urgent)
     - Assignee (or "Unassigned" if null)

   See [_enums.md](_enums.md) for canonical status + priority values (source: `src/types/task.ts`).

4. Display summary:
   - Total count of matching tasks
   - Example: "Found 5 tasks matching 'authentication'"

5. Handle no results:
   - If list_tasks returns empty array:
     - Display: "No tasks found matching '<keyword>'"
     - Suggest: "Try a broader search term or different keyword"

## Example Output

```
Search results for 'auth':

#42  [in_progress] HIGH   Implement JWT authentication     (alice)
#55  [open]        MEDIUM Add OAuth provider support       (Unassigned)
#67  [done]        MEDIUM Fix auth token expiration bug    (bob)

Found 3 tasks matching 'auth'
```
