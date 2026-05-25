---
name: search
description: Searches tasks by keyword across titles and descriptions. Use when user wants to find tasks, look up work items, or search for specific topics.
argument-hint: [keyword]
disable-model-invocation: false
---

Search for tasks matching a keyword in titles and descriptions.

## Workflow

1. Extract search keyword from $ARGUMENTS
   - Required: at least 1 character
   - If missing or empty, display error: "Error: Search keyword required"

2. Call `wood-fired-tasks:list_tasks` with filter parameter:
   - filter: { search: keyword }
   - This searches across both title and description fields

3. Format search results:
   - For each matching task, display:
     - Task ID
     - Title
     - Status (open, in_progress, blocked, done)
     - Priority (critical, high, normal, low)
     - Assignee (or "Unassigned" if null)

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
#55  [open]        NORMAL Add OAuth provider support       (Unassigned)
#67  [done]        NORMAL Fix auth token expiration bug    (bob)

Found 3 tasks matching 'auth'
```
