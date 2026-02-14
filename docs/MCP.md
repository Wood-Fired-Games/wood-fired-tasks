# MCP Server and Claude Code Integration

Complete reference for the Wood Fired Bugs MCP server and Claude Code skill files.

## Overview

Wood Fired Bugs exposes task management capabilities via the Model Context Protocol (MCP), enabling direct integration with Claude Code and other MCP-compatible clients.

The MCP server provides:

- 16 tools for task, project, comment, dependency, and health operations
- stdio transport for seamless Claude Code integration
- 10 pre-built skill files for common workflows
- Shared SQLite database with the REST API and CLI

## MCP Server

### Transport

The MCP server uses stdio transport for communication with MCP clients.

### Entry Points

**Production (after build):**

```bash
node dist/mcp/index.js
```

**Development:**

```bash
npx tsx src/mcp/index.ts
```

or

```bash
npm run mcp:dev
```

### Server Name

`wood-fired-bugs`

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| DB_PATH | Path to SQLite database file | ./data/tasks.db |

[NOTE] The MCP server creates its own database connection. It does NOT call the REST API.

## Configuration

### Claude Code Setup

Add this configuration to `~/.claude.json` in the `mcpServers` section:

```json
{
  "mcpServers": {
    "wood-fired-bugs": {
      "command": "node",
      "args": ["/absolute/path/to/wood-fired-bugs/dist/mcp/index.js"],
      "env": {
        "DB_PATH": "/absolute/path/to/wood-fired-bugs/data/tasks.db"
      }
    }
  }
}
```

[IMPORTANT] Use absolute paths for both the MCP server script and the database file.

### Automatic Installation

The provided installers handle configuration automatically:

**Linux/macOS:**

```bash
./install.sh
```

**Windows:**

```powershell
.\install.ps1
```

Both installers:
1. Copy skill files to `~/.claude/commands/tasks/`
2. Add or update the MCP server configuration in `~/.claude.json`
3. Set the DB_PATH environment variable for the MCP server

## Tools Reference

The MCP server exposes 16 tools organized by domain.

### Task Tools (7 tools)

#### create_task

Create a new task in a project.

**Input Schema:**

```json
{
  "title": "string (required, max 255 chars)",
  "description": "string (optional, max 5000 chars)",
  "priority": "low|medium|high|urgent (optional, default: medium)",
  "project_id": "number (required, positive integer)",
  "parent_task_id": "number (optional, positive integer)",
  "estimated_minutes": "number (optional, 0-10080)",
  "assignee": "string (optional, max 100 chars)",
  "created_by": "string (required, max 100 chars)",
  "due_date": "string (optional, ISO8601 format)",
  "tags": ["array of strings (optional, max 20 tags)"]
}
```

**Usage:** When Claude Code needs to create a new task, bug report, or work item.

#### get_task

Get a task by its ID.

**Input Schema:**

```json
{
  "id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to fetch task details, inspect a task, or show task information.

#### update_task

Update an existing task by ID.

**Input Schema:**

```json
{
  "id": "number (required, positive integer)",
  "updates": {
    "title": "string (optional, max 255 chars)",
    "description": "string (optional, max 5000 chars)",
    "status": "open|in_progress|done|closed|blocked (optional)",
    "priority": "low|medium|high|urgent (optional)",
    "parent_task_id": "number (optional, positive integer)",
    "estimated_minutes": "number (optional, 0-10080)",
    "assignee": "string (optional, max 100 chars)",
    "due_date": "string (optional, ISO8601 format)",
    "tags": ["array of strings (optional)"]
  }
}
```

**Usage:** When Claude Code needs to modify task fields, change status, update assignee, or adjust priority.

#### list_tasks

List tasks with optional filters.

**Input Schema:**

```json
{
  "project_id": "number (optional, positive integer)",
  "status": "string (optional, task status)",
  "assignee": "string (optional, assignee name)",
  "tags": ["array of strings (optional)"],
  "due_before": "string (optional, ISO8601)",
  "due_after": "string (optional, ISO8601)",
  "search": "string (optional, max 200 chars)"
}
```

**Usage:** When Claude Code needs to find tasks, filter by criteria, or search for specific work items.

#### delete_task

Delete a task by its ID.

**Input Schema:**

```json
{
  "id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to remove a task permanently.

#### list_subtasks

List all subtasks (children) of a parent task.

**Input Schema:**

```json
{
  "task_id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to see the breakdown of a parent task into subtasks.

#### get_subtasks

Get all subtasks (children) of a parent task.

**Input Schema:**

```json
{
  "task_id": "number (required, positive integer)"
}
```

**Usage:** Alternative to list_subtasks for retrieving child tasks.

### Project Tools (5 tools)

#### create_project

Create a new project.

**Input Schema:**

```json
{
  "name": "string (required, max 100 chars)",
  "description": "string (optional, max 1000 chars)"
}
```

**Usage:** When Claude Code needs to create a new project container for tasks.

#### get_project

Get a project by its ID.

**Input Schema:**

```json
{
  "id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to fetch project details.

#### list_projects

List all projects.

**Input Schema:**

```json
{}
```

**Usage:** When Claude Code needs to see all available projects or help users select a project.

#### update_project

Update an existing project by ID.

**Input Schema:**

```json
{
  "id": "number (required, positive integer)",
  "updates": {
    "name": "string (optional, max 100 chars)",
    "description": "string (optional, max 1000 chars)"
  }
}
```

**Usage:** When Claude Code needs to modify project name or description.

#### delete_project

Delete a project by its ID.

**Input Schema:**

```json
{
  "id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to remove a project permanently.

### Comment Tools (3 tools)

#### add_comment

Add a comment to a task.

**Input Schema:**

```json
{
  "task_id": "number (required, positive integer)",
  "author": "string (required, max 100 chars)",
  "content": "string (required, max 5000 chars)"
}
```

**Usage:** When Claude Code needs to add notes, feedback, or context to a task.

#### get_comments

Get all comments for a task in chronological order.

**Input Schema:**

```json
{
  "task_id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to review discussion history or see task annotations.

#### delete_comment

Delete a comment by ID.

**Input Schema:**

```json
{
  "comment_id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to remove a comment.

### Dependency Tools (3 tools)

#### add_dependency

Add a dependency relationship between tasks.

**Input Schema:**

```json
{
  "task_id": "number (required, positive integer)",
  "blocks_task_id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to mark that task_id blocks blocks_task_id (creates a blocking relationship).

#### remove_dependency

Remove a dependency relationship between tasks.

**Input Schema:**

```json
{
  "task_id": "number (required, positive integer)",
  "blocks_task_id": "number (required, positive integer)"
}
```

**Usage:** When Claude Code needs to remove a blocking relationship.

#### get_dependencies

Get all dependencies for a task.

**Input Schema:**

```json
{
  "task_id": "number (required, positive integer)"
}
```

**Returns:** Both tasks that this task blocks AND tasks that block this task.

**Usage:** When Claude Code needs to understand task dependencies and blockers.

### Health Tools (1 tool)

#### check_health

Check service health status, database connectivity, and version information.

**Input Schema:**

```json
{}
```

**Usage:** When Claude Code needs to verify the MCP server and database are functioning correctly.

## Skill Files

Wood Fired Bugs provides 10 pre-built skill files in the `/tasks:` namespace.

After installation, these skills are available as slash commands in Claude Code.

### /tasks:create-task

**Description:** Creates a new task with configurable project, priority, and assignee.

**Use when:** User wants to add a task, create work items, or plan new work.

**Workflow:** Prompts for title, project, priority, assignee, and other task details, then creates the task using the create_task MCP tool.

### /tasks:show-task

**Description:** Shows full details of a task including comments and dependencies.

**Use when:** User wants to see task details, inspect a task, or review a specific task.

**Workflow:** Fetches task data, comments, and dependencies in parallel, then displays comprehensive task information.

### /tasks:my-work

**Description:** Lists tasks assigned to the current user grouped by status.

**Use when:** User asks about their tasks, assigned work, workload, or what to do next.

**Workflow:** Filters tasks by current user assignee, groups by status (open, in_progress, blocked, done), and displays organized summary.

### /tasks:project-status

**Description:** Shows project overview with task counts grouped by status and completion percentage.

**Use when:** User asks about project status, progress, overview, dashboard, or summary.

**Workflow:** Lists all projects, retrieves tasks for each, calculates counts by status, computes completion percentage, and displays project dashboard.

### /tasks:search

**Description:** Searches tasks by keyword across titles and descriptions.

**Use when:** User wants to find tasks, look up work items, or search for specific topics.

**Workflow:** Accepts search keyword from arguments, calls list_tasks with search filter, displays matching results.

### /tasks:log-bug

**Description:** Creates a bug report task with high priority.

**Use when:** User reports a bug, mentions an issue, or asks to log a problem.

**Workflow:** Prompts for title and description, sets priority to high, creates task with bug tag.

### /tasks:done

**Description:** Marks a task as complete by setting status to done.

**Use when:** User finishes a task, says mark done, complete, or finished.

**Workflow:** Validates status transition, updates task status to done using update_task MCP tool.

### /tasks:blocked

**Description:** Marks a task as blocked and records the blocking reason as a comment.

**Use when:** User reports a blocker, dependency issue, or impediment on a task.

**Workflow:** Updates task status to blocked, adds comment with blocking reason for context.

### /tasks:pick-up

**Description:** Assigns a task to the current user and sets status to in_progress.

**Use when:** User wants to start working on a task, pick up a task, or claim a task.

**Workflow:** Assigns task to current user, transitions status to in_progress, confirms assignment.

### /tasks:add-comment

**Description:** Adds a comment to a task.

**Use when:** User wants to add a note, leave feedback, or annotate a task with additional context.

**Workflow:** Prompts for comment content, adds comment to specified task using add_comment MCP tool.

## How It Works

### Architecture

```
Claude Code
    |
    | (stdio)
    |
MCP Server (dist/mcp/index.js)
    |
    | (better-sqlite3)
    |
SQLite Database (tasks.db)
```

The MCP server:

1. Creates its own database connection to the SQLite database
2. Uses the same service layer as the REST API (TaskService, ProjectService, etc.)
3. Shares the same schema and data with the API and CLI
4. Does NOT call the REST API (direct database access)

### Data Flow

When Claude Code uses a skill file:

1. Skill file logic determines which MCP tool(s) to call
2. MCP tool receives parameters from Claude Code
3. Tool calls the appropriate service method (e.g., TaskService.createTask)
4. Service performs database operations via better-sqlite3
5. Result is returned to Claude Code as structured data

### Database Sharing

All three interfaces (API, CLI, MCP) share the same SQLite database:

- **API Server:** Long-lived connection, handles HTTP requests
- **CLI:** Per-command connection, executes and closes
- **MCP Server:** Long-lived connection, handles stdio messages

SQLite's WAL mode enables concurrent reads and sequential writes across all interfaces.

## Troubleshooting

### MCP server not appearing in Claude Code

1. Check that `~/.claude.json` has the correct configuration
2. Verify the `command` path points to the compiled MCP server (`dist/mcp/index.js`)
3. Verify the `DB_PATH` in the config points to a valid database file
4. Restart Claude Code after configuration changes

### MCP tools return "database error"

1. Check that the database file exists at `DB_PATH`
2. Verify file permissions allow read/write access
3. Run `npm run migrate` to ensure the schema is up to date
4. Check that the database file is not locked by another process

### Skill files not showing up

1. Verify skill files are copied to `~/.claude/commands/tasks/`
2. Check that each skill file has valid frontmatter (name, description fields)
3. Restart Claude Code to reload skill files

### Data not syncing between API and MCP

The API and MCP server share the same database file. If changes made via the API don't appear in MCP (or vice versa):

1. Verify both are using the same `DB_PATH`
2. Check that SQLite is in WAL mode (handled automatically by the app)
3. If using Docker or VMs, ensure the database file is on a shared volume

[TIP] Use the `check_health` MCP tool to verify database connectivity from within Claude Code.

## Next Steps

- Try the skill files in Claude Code: `/tasks:create-task`, `/tasks:my-work`, `/tasks:project-status`
- Explore the 16 MCP tools for custom workflows
- Read the [API.md](API.md) reference for REST API details
- Read the [CLI.md](CLI.md) reference for command-line usage
