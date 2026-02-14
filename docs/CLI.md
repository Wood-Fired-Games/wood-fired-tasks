# CLI Reference

Complete command-line interface reference for Wood Fired Bugs.

**Binary:** `tasks`

After running `npm link`, the `tasks` command is available globally.

For development without linking, use:

```bash
npx tsx src/cli/bin/tasks.ts <command>
```

or

```bash
npm run cli -- <command>
```

## Global Options

These options work with any command:

| Option | Description |
|--------|-------------|
| --json | Output in machine-readable JSON format (writes to stdout, errors to stderr) |
| --no-input | Disable interactive prompts (fail if required options are missing) |
| --force | Skip confirmation prompts for destructive operations |

**Examples:**

```bash
# Machine-readable JSON output
tasks list --json

# Non-interactive mode (for scripts)
tasks create --title "Task" --project 1 --created-by "bot" --no-input

# Skip delete confirmation
tasks delete 42 --force
```

## Environment Variables

The CLI requires these environment variables to connect to the API server:

| Variable | Description | Default |
|----------|-------------|---------|
| API_BASE_URL | Base URL of the API server | http://localhost:3000 |
| API_KEY | API key for authentication | (none - required) |

[TIP] Add these to your `.bashrc` or `.zshrc`:

```bash
export API_BASE_URL=http://localhost:3000
export API_KEY=your-api-key-here
```

## Task Commands

### tasks create

Create a new task.

**Interactive mode** (prompts for required fields):

```bash
tasks create
```

**Non-interactive mode** (all options specified):

```bash
tasks create \
  --title "Implement feature" \
  --project 1 \
  --created-by "alice" \
  --description "Add new API endpoint" \
  --priority high \
  --assignee "bob" \
  --due "2026-02-20T00:00:00Z" \
  --tags "backend,api"
```

**Options:**

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| --title | -t | string | Task title (required) |
| --project | -p | number | Project ID (required) |
| --created-by | -c | string | Creator name (required) |
| --description | -d | string | Task description |
| --priority | | string | Priority: low, medium, high, urgent (default: medium) |
| --assignee | -a | string | Assignee name |
| --due | | string | Due date in ISO8601 format |
| --tags | | string | Comma-separated tags |

**Output:**

```
Created task #42: Implement feature

Title: Implement feature
Status: open
Priority: high
Project: 1
Assignee: bob
Created by: alice
Due: 2026-02-20T00:00:00Z
Tags: backend, api
```

**JSON output:**

```bash
tasks create --title "Test" --project 1 --created-by "me" --json
```

```json
{
  "success": true,
  "data": {
    "id": 42,
    "title": "Test",
    "status": "open",
    "priority": "medium",
    "project_id": 1,
    "created_by": "me",
    "created_at": "2026-02-14T12:00:00.000Z",
    "updated_at": "2026-02-14T12:00:00.000Z",
    "tags": []
  }
}
```

### tasks list

List tasks with optional filters.

**Examples:**

```bash
# List all tasks
tasks list

# Filter by project
tasks list --project 1

# Filter by status
tasks list --status open

# Filter by assignee
tasks list --assignee alice

# Search by keyword
tasks list --search "authentication"

# Filter by tags
tasks list --tags bug,urgent

# Multiple filters
tasks list --project 1 --status in_progress --assignee bob
```

**Options:**

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| --project | -p | number | Filter by project ID |
| --status | -s | string | Filter by status (open, in_progress, done, closed, blocked) |
| --assignee | -a | string | Filter by assignee name |
| --search | | string | Search in title and description |
| --tags | | string | Filter by tags (comma-separated) |
| --due-before | | string | Tasks due before date (ISO8601) |
| --due-after | | string | Tasks due after date (ISO8601) |

**Output:**

```
Found 3 tasks:

ID  Title                    Status       Priority  Assignee
42  Implement authentication in_progress  high      alice
43  Write tests              open         medium    bob
44  Deploy to production     blocked      urgent    alice
```

**JSON output:**

```json
{
  "success": true,
  "data": [
    {
      "id": 42,
      "title": "Implement authentication",
      "status": "in_progress",
      "priority": "high",
      "assignee": "alice"
    }
  ],
  "metadata": {
    "count": 1
  }
}
```

### tasks show <id>

Show detailed information about a task.

**Example:**

```bash
tasks show 42
```

**Output:**

```
Task #42: Implement authentication

Title: Implement authentication
Description: Add JWT authentication to API
Status: in_progress
Priority: high
Project: 1
Assignee: alice
Created by: bob
Due date: 2026-02-20T00:00:00Z
Estimated: 240 minutes (4 hours)
Created: 2026-02-14T12:00:00.000Z
Updated: 2026-02-14T13:00:00.000Z
Tags: backend, security

Comments: 2
Dependencies: Blocks 1 task, blocked by 1 task
```

**JSON output:**

```bash
tasks show 42 --json
```

```json
{
  "success": true,
  "data": {
    "id": 42,
    "title": "Implement authentication",
    "description": "Add JWT authentication to API",
    "status": "in_progress",
    "priority": "high",
    "project_id": 1,
    "assignee": "alice",
    "created_by": "bob",
    "due_date": "2026-02-20T00:00:00.000Z",
    "estimated_minutes": 240,
    "created_at": "2026-02-14T12:00:00.000Z",
    "updated_at": "2026-02-14T13:00:00.000Z",
    "tags": ["backend", "security"]
  }
}
```

### tasks update <id>

Update a task. All options are optional (partial update).

**Examples:**

```bash
# Update status
tasks update 42 --status done

# Update assignee and priority
tasks update 42 --assignee bob --priority urgent

# Update multiple fields
tasks update 42 \
  --status in_progress \
  --description "Updated description" \
  --due "2026-03-01T00:00:00Z" \
  --tags "backend,api,urgent"
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| --title | string | Update task title |
| --description | string | Update task description |
| --status | string | Update status (validates transitions) |
| --priority | string | Update priority (low, medium, high, urgent) |
| --assignee | string | Update assignee name |
| --due | string | Update due date (ISO8601 format) |
| --tags | string | Update tags (comma-separated, replaces all tags) |

**Output:**

```
Updated task #42

Title: Implement authentication
Status: done
Priority: high
Assignee: alice
Updated: 2026-02-14T15:00:00.000Z
```

### tasks delete <id>

Delete a task.

**Example:**

```bash
tasks delete 42
```

**With confirmation:**

```
Are you sure you want to delete task #42? (y/N): y
Task #42 deleted successfully
```

**Skip confirmation:**

```bash
tasks delete 42 --force
```

## Project Commands

### tasks project-create

Create a new project.

**Interactive mode:**

```bash
tasks project-create
```

**Non-interactive mode:**

```bash
tasks project-create \
  --name "My Project" \
  --description "Project description"
```

**Options:**

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| --name | -n | string | Project name (required, max 100 chars) |
| --description | -d | string | Project description (optional, max 1000 chars) |

### tasks project-list

List all projects.

**Example:**

```bash
tasks project-list
```

**Output:**

```
Found 2 projects:

ID  Name          Description
1   Project Alpha First project
2   Project Beta  Second project
```

**JSON output:**

```bash
tasks project-list --json
```

### tasks project-show <id>

Show project details.

**Example:**

```bash
tasks project-show 1
```

**Output:**

```
Project #1: Project Alpha

Name: Project Alpha
Description: First project
Created: 2026-02-14T12:00:00.000Z
Updated: 2026-02-14T12:00:00.000Z
```

### tasks project-update <id>

Update a project.

**Example:**

```bash
tasks project-update 1 --name "Updated Name"
tasks project-update 1 --description "New description"
```

**Options:**

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| --name | -n | string | Update project name |
| --description | -d | string | Update project description |

### tasks project-delete <id>

Delete a project.

**Example:**

```bash
tasks project-delete 1
```

**With confirmation:**

```
Are you sure you want to delete project #1? (y/N): y
Project #1 deleted successfully
```

## Dependency Commands

### tasks dep-add <taskId> <blocksTaskId>

Add a dependency relationship (taskId blocks blocksTaskId).

**Example:**

```bash
# Task 42 blocks task 43
tasks dep-add 42 43
```

**Output:**

```
Dependency created: Task 42 blocks Task 43
```

### tasks dep-remove <taskId> <blocksTaskId>

Remove a dependency relationship.

**Example:**

```bash
tasks dep-remove 42 43
```

**Output:**

```
Dependency removed: Task 42 no longer blocks Task 43
```

### tasks dep-list <taskId>

List all dependencies for a task.

**Example:**

```bash
tasks dep-list 42
```

**Output:**

```
Dependencies for task #42:

This task blocks:
- [43] Deploy to production (blocked)

This task is blocked by:
- [41] Write tests (in_progress)
```

**JSON output:**

```bash
tasks dep-list 42 --json
```

```json
{
  "success": true,
  "data": {
    "task_id": 42,
    "blocks": [
      {
        "id": 43,
        "title": "Deploy to production",
        "status": "blocked"
      }
    ],
    "blocked_by": [
      {
        "id": 41,
        "title": "Write tests",
        "status": "in_progress"
      }
    ]
  }
}
```

## Comment Commands

### tasks comment-add <taskId>

Add a comment to a task.

**Interactive mode:**

```bash
tasks comment-add 42
# Prompts for author and content
```

**Non-interactive mode:**

```bash
tasks comment-add 42 \
  --author "alice" \
  --content "This looks great!"
```

**Options:**

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| --author | -a | string | Comment author (required, max 100 chars) |
| --content | -c | string | Comment content (required, max 5000 chars) |

**Output:**

```
Comment added to task #42 by alice
```

### tasks comment-list <taskId>

List all comments for a task.

**Example:**

```bash
tasks comment-list 42
```

**Output:**

```
Comments for task #42:

[alice] 2026-02-14 12:00:00
This looks great!

[bob] 2026-02-14 12:05:00
Thanks for the review!

Total: 2 comments
```

**JSON output:**

```bash
tasks comment-list 42 --json
```

### tasks comment-delete <commentId>

Delete a comment.

**Example:**

```bash
tasks comment-delete 1
```

**With confirmation:**

```
Are you sure you want to delete comment #1? (y/N): y
Comment #1 deleted successfully
```

## Subtask Commands

### tasks subtask-create <parentTaskId>

Create a subtask under a parent task.

**Example:**

```bash
tasks subtask-create 42 \
  --title "Subtask 1" \
  --created-by "alice" \
  --assignee "bob"
```

**Options:**

Same as `tasks create`, except:
- `--project` is inherited from parent task
- `--parent-task-id` is set automatically

### tasks subtask-list <parentTaskId>

List all subtasks of a parent task.

**Example:**

```bash
tasks subtask-list 42
```

**Output:**

```
Subtasks of task #42:

ID  Title      Status  Priority  Assignee
43  Subtask 1  open    medium    bob
44  Subtask 2  open    medium    alice

Total: 2 subtasks
```

**JSON output:**

```bash
tasks subtask-list 42 --json
```

## Health Command

### tasks health

Check API server health.

**Example:**

```bash
tasks health
```

**Output:**

```
Service Status: healthy
Version: 1.0.0
Database: ok
Timestamp: 2026-02-14T12:00:00.000Z
```

**JSON output:**

```bash
tasks health --json
```

```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "version": "1.0.0",
    "checks": {
      "database": "ok"
    },
    "timestamp": "2026-02-14T12:00:00.000Z"
  }
}
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (validation, API error, connection error) |

## Tips

### Using in Scripts

For scripting, use `--json` mode and `--no-input` to avoid interactive prompts:

```bash
#!/bin/bash

# Create a task and capture the ID
RESPONSE=$(tasks create \
  --title "Automated task" \
  --project 1 \
  --created-by "bot" \
  --json \
  --no-input)

TASK_ID=$(echo "$RESPONSE" | jq -r '.data.id')

echo "Created task: $TASK_ID"

# Add a comment
tasks comment-add "$TASK_ID" \
  --author "bot" \
  --content "Task created by automation" \
  --json \
  --no-input
```

### Filtering Tasks

Combine multiple filters for precise queries:

```bash
# High-priority bugs assigned to alice
tasks list \
  --priority high \
  --tags bug \
  --assignee alice

# Overdue open tasks
tasks list \
  --status open \
  --due-before "2026-02-14T00:00:00Z"
```

### Color Output

The CLI uses colored output in terminal mode:

- Green: Success messages
- Red: Error messages
- Yellow: Warnings
- Cyan: Headers and labels

Use `--json` mode to disable colors for piping to other commands.
