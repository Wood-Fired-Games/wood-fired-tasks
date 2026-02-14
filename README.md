# Wood Fired Bugs

Network-wide task tracking for Wood Fired Games

Wood Fired Bugs is a comprehensive task management system providing three interfaces to the same underlying data: a REST API, a CLI tool, and an MCP server with Claude Code integration. Any agent on the local network can reliably create, find, and update work items in real time.

**Features:**

- REST API with 19 endpoints for full task lifecycle management
- CLI with 19 commands for terminal-based task operations
- MCP server with 16 tools for Claude Code integration
- 10 Claude Code skill files for common workflows
- SQLite database with automatic migrations
- Real-time task tracking across projects, dependencies, comments, and subtasks
- Network-wide access for distributed teams and AI agents

## Quick Start

```bash
# Clone and install
git clone <repository-url>
cd wood-fired-bugs
npm install
npm run build

# Set environment variables
export API_KEYS="your-api-key-here"
export DB_PATH="./data/tasks.db"

# Run database migrations
npm run migrate

# Start the API server
npm start

# Use the CLI
tasks list
tasks create --title "My first task" --project 1 --created-by "me"
```

For detailed setup instructions, see [docs/SETUP.md](docs/SETUP.md).

## Architecture Overview

Wood Fired Bugs provides three interfaces that share a common service layer and SQLite database:

| Interface | Access Method | Port/Protocol | Auth |
|-----------|--------------|---------------|------|
| REST API | HTTP endpoints | 3000 (configurable) | X-API-Key header |
| CLI | `tasks` command | Local executable | API_KEY env var |
| MCP Server | stdio protocol | MCP client integration | None (local access) |

All three interfaces use the same TypeScript services (TaskService, ProjectService, DependencyService, CommentService) and share the same SQLite database.

## Data Model

### Entities

| Entity | Fields |
|--------|--------|
| **projects** | id, name, description, created_at, updated_at |
| **tasks** | id, title, description, status, priority, project_id, parent_task_id, estimated_minutes, assignee, created_by, due_date, created_at, updated_at |
| **task_tags** | id, task_id, tag |
| **dependencies** | id, task_id, blocks_task_id, created_at |
| **comments** | id, task_id, author, content, created_at, updated_at |

### Task Statuses

Valid statuses: `open`, `in_progress`, `done`, `closed`, `blocked`

### Task Priorities

Valid priorities: `low`, `medium`, `high`, `urgent`

### Status Transitions

| From Status | Allowed Transitions |
|-------------|---------------------|
| open | in_progress, blocked, closed |
| in_progress | done, blocked, open |
| blocked | open, in_progress |
| done | closed, open |
| closed | open |

## API Summary

All endpoints under `/api/v1` require authentication via `X-API-Key` header.

Base URL: `http://localhost:3000`

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Service health check (no auth required) |

### Projects

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/v1/projects | Create a new project |
| GET | /api/v1/projects | List all projects |
| GET | /api/v1/projects/:id | Get project by ID |
| PUT | /api/v1/projects/:id | Update project |
| DELETE | /api/v1/projects/:id | Delete project |

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/v1/tasks | Create a new task |
| GET | /api/v1/tasks | List tasks with filters |
| GET | /api/v1/tasks/:id | Get task by ID |
| PUT | /api/v1/tasks/:id | Update task |
| DELETE | /api/v1/tasks/:id | Delete task |
| GET | /api/v1/tasks/:id/subtasks | Get subtasks of a task |

### Comments

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/v1/tasks/:id/comments | Add comment to task |
| GET | /api/v1/tasks/:id/comments | List comments for task |
| DELETE | /api/v1/tasks/:id/comments/:commentId | Delete comment |

### Dependencies

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/v1/tasks/:id/dependencies | Add dependency (this task blocks another) |
| GET | /api/v1/tasks/:id/dependencies | Get dependencies for task |
| DELETE | /api/v1/tasks/:id/dependencies/:blocksTaskId | Remove dependency |

For detailed API documentation including request/response schemas and examples, see [docs/API.md](docs/API.md).

## CLI Summary

The `tasks` command provides terminal access to all task operations.

**Global Flags:**
- `--json` - Output in machine-readable JSON format
- `--no-input` - Disable interactive prompts
- `--force` - Skip confirmation prompts

### Task Commands

| Command | Description |
|---------|-------------|
| tasks create | Create a new task (interactive or with options) |
| tasks list | List tasks with filters |
| tasks show <id> | Show task details |
| tasks update <id> | Update task fields |
| tasks delete <id> | Delete a task |

### Project Commands

| Command | Description |
|---------|-------------|
| tasks project-create | Create a new project |
| tasks project-list | List all projects |
| tasks project-show <id> | Show project details |
| tasks project-update <id> | Update project |
| tasks project-delete <id> | Delete project |

### Dependency Commands

| Command | Description |
|---------|-------------|
| tasks dep-add <taskId> <blocksTaskId> | Add dependency relationship |
| tasks dep-remove <taskId> <blocksTaskId> | Remove dependency |
| tasks dep-list <taskId> | List dependencies for task |

### Comment Commands

| Command | Description |
|---------|-------------|
| tasks comment-add <taskId> | Add comment to task |
| tasks comment-list <taskId> | List comments for task |
| tasks comment-delete <commentId> | Delete comment |

### Subtask Commands

| Command | Description |
|---------|-------------|
| tasks subtask-create <parentTaskId> | Create a subtask |
| tasks subtask-list <parentTaskId> | List subtasks |

### Health

| Command | Description |
|---------|-------------|
| tasks health | Check server health |

For detailed CLI documentation including all options and examples, see [docs/CLI.md](docs/CLI.md).

## MCP Tools Summary

The MCP server exposes 16 tools for Claude Code integration.

| Tool | Description |
|------|-------------|
| create_task | Create a new task in a project |
| get_task | Get a task by its ID |
| update_task | Update an existing task |
| list_tasks | List tasks with optional filters |
| delete_task | Delete a task by its ID |
| list_subtasks | List all subtasks of a parent task |
| get_subtasks | Get all subtasks of a parent task |
| create_project | Create a new project |
| get_project | Get a project by its ID |
| list_projects | List all projects |
| update_project | Update an existing project |
| delete_project | Delete a project by its ID |
| add_comment | Add a comment to a task |
| get_comments | Get all comments for a task |
| delete_comment | Delete a comment by ID |
| check_health | Check service health status |

For detailed MCP documentation including tool schemas and Claude Code skill files, see [docs/MCP.md](docs/MCP.md).

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | HTTP server port | 3000 |
| HOST | HTTP server host | 0.0.0.0 |
| API_KEYS | Comma-separated API keys for authentication | (none - auth disabled) |
| LOG_LEVEL | Logging level (debug, info, warn, error) | info |
| NODE_ENV | Environment (development, production) | (none) |
| DB_PATH | Path to SQLite database file | ./data/tasks.db |
| API_BASE_URL | Base URL for CLI API calls | http://localhost:3000 |
| API_KEY | API key for CLI authentication | (none) |

[NOTE] API_KEYS is required for the API server to enable authentication. Without it, all authenticated endpoints will reject requests.

[NOTE] API_BASE_URL and API_KEY are used by the CLI to connect to the API server.

## Development

### Key Commands

```bash
# Development mode with hot reload
npm run dev

# Run tests (386 tests across 36 files)
npm test

# Watch mode for tests
npm run test:watch

# Build TypeScript
npm run build

# Run CLI in development (without building)
npm run cli -- <command>

# Run MCP server in development
npm run mcp:dev
```

### Database

The project uses SQLite with better-sqlite3 driver and automatic migrations via Umzug. Migrations are located in `src/db/migrations/`.

To run migrations manually:

```bash
npm run migrate
```

### Testing

Test suite includes:
- 386 tests across 36 test files
- Unit tests for services, routes, and MCP tools
- Integration tests for API endpoints
- E2E tests for CLI commands
- Skill file validation tests

## License

ISC
