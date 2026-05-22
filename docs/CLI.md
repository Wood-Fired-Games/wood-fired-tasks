# CLI Reference

Agents: start at [`AGENTS.md`](../AGENTS.md); the full read-order contract is in [`docs/AGENT_CONTEXT.md`](AGENT_CONTEXT.md).

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

## Claim Command

### tasks claim \<id\>

Atomically claim an unassigned task. Sets the assignee and transitions status to `in_progress` in a single atomic operation.

**Examples:**

```bash
# Claim task 42
tasks claim 42 --assignee "agent-1"

# Claim with idempotency key for retry safety
tasks claim 42 --assignee "agent-1" --idempotency-key "claim-42-agent-1"
```

**Options:**

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| --assignee | -a | string | Agent/person claiming the task (required) |
| --idempotency-key | | string | Unique key for retry safety (24h TTL) |

**Output:**

```
Task #42 claimed by agent-1

Title: Implement authentication
Status: in_progress
Priority: high
Project: 1
Assignee: agent-1
```

**JSON output:**

```bash
tasks claim 42 --assignee "agent-1" --json
```

```json
{
  "success": true,
  "data": {
    "task": {
      "id": 42,
      "title": "Implement authentication",
      "description": "Add JWT authentication to API",
      "status": "in_progress",
      "priority": "high",
      "project_id": 1,
      "parent_task_id": null,
      "estimated_minutes": null,
      "assignee": "agent-1",
      "created_by": "bob",
      "due_date": "2026-02-20T00:00:00.000Z",
      "created_at": "2026-02-14T12:00:00.000Z",
      "updated_at": "2026-02-14T12:05:00.000Z",
      "version": 2,
      "claimed_at": "2026-02-14T12:05:00.000Z",
      "tags": ["backend", "security"]
    }
  },
  "metadata": {
    "id": 42,
    "assignee": "agent-1"
  }
}
```

The `data` object wraps the full task under the `task` key. The `metadata` block carries the claimed task id and assignee for quick scripting access. `description`, `assignee`, `due_date`, `parent_task_id`, `estimated_minutes`, and `claimed_at` may be `null`. `version` increments by one on every successful claim/update.

**Error handling:**

If the task is already claimed or not in a claimable state, the command exits with code 1 and displays the conflict message.

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

## Diagnostic Commands

These commands operate directly on the local SQLite database file (read from `DATABASE_PATH`, default `./data/tasks.db`). They do not contact the API server.

### tasks doctor

Run diagnostics for database connectivity, disk space, and configuration validity. Useful as a first-line health check when something is misbehaving.

**Example:**

```bash
tasks doctor
```

**Checks performed:**

| Check | What it verifies |
|-------|------------------|
| Database | Opens the SQLite file read-only, runs `SELECT 1`, reports the active journal mode (WAL expected). |
| Disk | Reports free vs total bytes on the partition holding the database. Status is `WARN` below 10% free, `FAIL` below 5%. |
| Config | Parses environment variables against the configuration schema and lists any issues. |

**Exit codes:**

Returns `0` when all checks pass (or only `WARN`). Returns `1` if database, disk, or config status is `FAIL`.

**Output:**

```
Database:  [PASS] Connected (SQLite WAL mode)
Disk:      [PASS] 42.3% free (180.4 GB / 426.7 GB)
Config:    [PASS] All required variables present
```

When a check fails, the corresponding line uses `[FAIL]` (or `[WARN]` for disk usage between 5%–10%). Config failures are followed by per-field issue lines.

**JSON output:**

```bash
tasks doctor --json
```

```json
{
  "success": true,
  "data": {
    "database": {
      "status": "PASS",
      "message": "Connected (SQLite WAL mode)"
    },
    "disk": {
      "status": "PASS",
      "free": 193710571520,
      "total": 458153459712,
      "freePercent": "42.3"
    },
    "config": {
      "status": "PASS",
      "errors": []
    }
  }
}
```

### tasks db-check

Run SQLite `PRAGMA integrity_check` and report database file size. Use after a crash or before a backup to confirm the file is not corrupted.

**Example:**

```bash
tasks db-check
```

**Exit codes:**

Returns `0` when integrity check passes, `1` if it fails (corruption detected).

**Output (PASS):**

```
Integrity:  PASSED
Database:   ./data/tasks.db
Size:       1.42 MB (364 pages x 4096 bytes)
```

**Output (FAIL):**

```
Integrity:  FAILED
Issues:
  - *** in database main ***
  - Page 42: btreeInitPage() returns error code 11
Database:   ./data/tasks.db
Size:       1.42 MB (364 pages x 4096 bytes)
```

**JSON output:**

```bash
tasks db-check --json
```

```json
{
  "success": true,
  "data": {
    "passed": true,
    "message": "ok",
    "dbPath": "./data/tasks.db",
    "sizeBytes": 1490944,
    "pageCount": 364,
    "pageSize": 4096
  }
}
```

When `passed` is `false`, `message` contains the joined integrity issues reported by SQLite.

### tasks backup

Create a hot SQLite backup of the task database using the SQLite Online Backup API. The source database is opened read-only, so backups are safe to run while the API server is live.

**Example:**

```bash
# Default destination: ./tasks-backup-<timestamp>.db
tasks backup

# Custom destination
tasks backup --output /var/backups/tasks/nightly.db
```

**Options:**

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| --output | -o | string | Backup destination path. Default: `./tasks-backup-<ISO-timestamp>.db`. Parent directories are created automatically. |

**Exit codes:**

Returns `0` on success. Returns `1` if the source database is missing or the backup operation fails.

**Output:**

```
Backup created successfully
  Path:   /var/backups/tasks/nightly.db
  Size:   1.42 MB
  Source: ./data/tasks.db
```

**JSON output:**

```bash
tasks backup --output /tmp/snapshot.db --json
```

```json
{
  "success": true,
  "data": {
    "path": "/tmp/snapshot.db",
    "size": 1490944,
    "source": "./data/tasks.db"
  }
}
```

`size` is the size of the backup file in bytes.

### tasks stats

Show task statistics: counts by status, recent activity (last 24h), and per-agent productivity (last 7 days). Reads directly from the database.

**Example:**

```bash
tasks stats
```

**Output:**

```
Task Counts by Status:
  open          12
  in_progress    4
  done          27
  blocked        1
  Total         44

Recent Activity (24h):
  Created:  3
  Updated:  9

Agent Productivity (7 days):
  alice        14 tasks (10 done, 2 in progress)
  bob           8 tasks ( 6 done, 1 in progress)
```

If there are no tasks at all, the command prints `No tasks found.` and exits. If no agent has updated tasks in the last 7 days, the productivity section reads `No agent activity in the last 7 days.`

**JSON output:**

```bash
tasks stats --json
```

```json
{
  "success": true,
  "data": {
    "statusCounts": [
      { "status": "blocked", "count": 1 },
      { "status": "done", "count": 27 },
      { "status": "in_progress", "count": 4 },
      { "status": "open", "count": 12 }
    ],
    "recentActivity": {
      "created": 3,
      "updated": 9
    },
    "agentProductivity": [
      {
        "assignee": "alice",
        "task_count": 14,
        "completed": 10,
        "in_progress": 2
      },
      {
        "assignee": "bob",
        "task_count": 8,
        "completed": 6,
        "in_progress": 1
      }
    ]
  }
}
```

## Reporting Commands

### tasks completed

Dashboard view of tasks that transitioned to `status='done'` within a time interval. Aggregates by project, assignee, priority, and daily throughput. Reads directly from the database.

**Examples:**

```bash
# Last 7 days (default if no range supplied)
tasks completed

# Trailing N days
tasks completed --days 30

# Explicit range (both --since and --until required together)
tasks completed --since 2026-04-01 --until 2026-04-30

# Scope to one project and assignee
tasks completed --days 14 --project 1 --assignee alice
```

**Options:**

| Option | Short | Type | Description |
|--------|-------|------|-------------|
| --days | -d | number | Trailing N days from now. Must be a positive integer. Default: `7` when no range is supplied. |
| --since | | string | Range start (ISO8601, inclusive). Must be paired with `--until`. |
| --until | | string | Range end (ISO8601, inclusive). Must be paired with `--since`. |
| --project | -p | number | Filter by project ID (positive integer). |
| --assignee | -a | string | Filter by assignee name. |

Passing only one of `--since` / `--until` is an error — provide both, or use `--days`.

**Output:**

```
Completion Report
  Range:  2026-05-13T00:00:00.000Z  ->  2026-05-20T00:00:00.000Z
  Total:  4 task(s) completed

ID  Title                         Project        Assignee  Priority  Completed             Time to complete
42  Implement authentication      Project Alpha  alice     high      5/18/2026, 3:42:00 PM 2d 4h
43  Write tests                   Project Alpha  bob       medium    5/19/2026, 9:10:00 AM 1d
...

By project:
  Project Alpha                  3
  Project Beta                   1

By assignee:
  alice                          2
  bob                            2

By priority:
  high                           1
  medium                         3

Daily throughput:
  2026-05-18    2  ##
  2026-05-19    1  #
  2026-05-20    1  #
```

If no tasks completed in the interval, the command prints `No completed tasks in this interval.` after the header.

**JSON output:**

```bash
tasks completed --days 7 --json
```

```json
{
  "success": true,
  "data": {
    "range": {
      "start": "2026-05-13T00:00:00.000Z",
      "end": "2026-05-20T00:00:00.000Z"
    },
    "total": 4,
    "rows": [
      {
        "id": 42,
        "title": "Implement authentication",
        "project_id": 1,
        "assignee": "alice",
        "priority": "high",
        "completed_at": "2026-05-18T15:42:00.000Z",
        "time_to_complete_seconds": 187200
      }
    ],
    "by_project": [
      { "project_id": 1, "count": 3 },
      { "project_id": 2, "count": 1 }
    ],
    "by_assignee": [
      { "assignee": "alice", "count": 2 },
      { "assignee": "bob", "count": 2 }
    ],
    "by_priority": [
      { "priority": "high", "count": 1 },
      { "priority": "medium", "count": 3 }
    ],
    "daily_throughput": [
      { "date": "2026-05-18", "count": 2 },
      { "date": "2026-05-19", "count": 1 },
      { "date": "2026-05-20", "count": 1 }
    ]
  },
  "metadata": {
    "count": 4
  }
}
```

`range` appears only inside `data.range` (the report payload). It is no longer duplicated under `metadata`.

## Shell Completion

### tasks completions \<shell\>

Generate a shell completion script and print it to stdout. Pipe to a file or source it from your shell rc to enable tab-completion for commands, subcommands, status values, and priority values.

**Supported shells:** `bash`, `zsh`.

**Examples:**

```bash
# Bash: append to ~/.bashrc (or drop into /etc/bash_completion.d/)
tasks completions bash >> ~/.bashrc

# Zsh: write to a directory on $fpath and add the directory to fpath in ~/.zshrc
mkdir -p ~/.zsh/completions
tasks completions zsh > ~/.zsh/completions/_tasks
echo 'fpath=(~/.zsh/completions $fpath)' >> ~/.zshrc
```

After restarting your shell (or `source ~/.bashrc` / `compinit` for zsh), pressing TAB after `tasks ` will complete command names. Pressing TAB after `--status ` or `--priority ` will complete valid enum values.

**Arguments:**

| Argument | Type | Description |
|----------|------|-------------|
| shell | string | Required. One of `bash` or `zsh`. Any other value exits with code 1. |

**Exit codes:**

Returns `0` on success. Returns `1` if `shell` is not `bash` or `zsh`.

This command does not honor `--json` — it always emits the raw shell script on stdout.

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
