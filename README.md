# Wood Fired Bugs

Network-wide task tracking for Wood Fired Games

Wood Fired Bugs is a centralized task management service providing a REST API, CLI tool, and MCP server for managing work items across all projects. LLM agents interact via REST or MCP; humans interact via CLI. All three interfaces share a common service layer and SQLite database with full feature parity. Real-time SSE event streaming enables multi-agent coordination with atomic task claiming and workflow automation.

**Key capabilities:**

- REST API with 20 authenticated endpoints for full task lifecycle management
- CLI (`tasks`) with 20 commands for terminal-based operations
- MCP server with 20 tools for native Claude Code integration
- 10 Claude Code skill files for workflow-driven slash commands
- Real-time Server-Sent Events (SSE) for task change notifications
- Atomic task claiming with optimistic locking for multi-agent coordination
- Workflow automation: parent auto-complete and dependency auto-unblock
- SQLite database with WAL mode, FTS5 full-text search, and automatic migrations
- Cross-platform installers for Linux/macOS and Windows

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

## Architecture

```
                    ┌─────────────┐
                    │  SQLite DB  │
                    │  (WAL mode) │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────┴─────┐ ┌───┴────┐ ┌────┴─────┐
        │ REST API  │ │  MCP   │ │   CLI    │
        │ (Fastify) │ │(stdio) │ │(Commander│
        │ port 3000 │ │        │ │   .js)   │
        └─────┬─────┘ └───┬────┘ └────┬─────┘
              │            │            │
        ┌─────┴─────┐ ┌───┴────┐ ┌────┴─────┐
        │ HTTP/SSE  │ │ Claude │ │ Terminal │
        │  Agents   │ │  Code  │ │  (human) │
        └───────────┘ └────────┘ └──────────┘
```

| Interface | Access Method | Transport | Auth |
|-----------|--------------|-----------|------|
| REST API | HTTP endpoints | Port 3000 (configurable) | X-API-Key header |
| CLI | `tasks` command | HTTP to API server | API_KEY env var |
| MCP Server | stdio protocol | MCP client integration | None (local access) |

All three interfaces use the same TypeScript services (TaskService, ProjectService, DependencyService, CommentService) and share the same SQLite database.

## Data Model

### Entities

| Entity | Key Fields |
|--------|------------|
| **projects** | id, name, description, created_at, updated_at |
| **tasks** | id, title, description, status, priority, project_id, parent_task_id, estimated_minutes, assignee, created_by, due_date, version, claimed_at, created_at, updated_at |
| **task_tags** | id, task_id, tag |
| **dependencies** | id, task_id, blocks_task_id, created_at |
| **comments** | id, task_id, author, content, created_at, updated_at |
| **idempotency_keys** | key, response, created_at |

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
| POST | /api/v1/tasks/:id/claim | Atomically claim an unassigned task |
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

### Events

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/v1/events | Subscribe to real-time SSE event stream |

For detailed API documentation including request/response schemas, see [docs/API.md](docs/API.md).

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
| tasks show \<id\> | Show task details |
| tasks update \<id\> | Update task fields |
| tasks delete \<id\> | Delete a task |
| tasks claim \<id\> | Atomically claim an unassigned task |

### Project Commands

| Command | Description |
|---------|-------------|
| tasks project-create | Create a new project |
| tasks project-list | List all projects |
| tasks project-show \<id\> | Show project details |
| tasks project-update \<id\> | Update project |
| tasks project-delete \<id\> | Delete project |

### Dependency Commands

| Command | Description |
|---------|-------------|
| tasks dep-add \<taskId\> \<blocksTaskId\> | Add dependency relationship |
| tasks dep-remove \<taskId\> \<blocksTaskId\> | Remove dependency |
| tasks dep-list \<taskId\> | List dependencies for task |

### Comment Commands

| Command | Description |
|---------|-------------|
| tasks comment-add \<taskId\> | Add comment to task |
| tasks comment-list \<taskId\> | List comments for task |
| tasks comment-delete \<commentId\> | Delete comment |

### Subtask Commands

| Command | Description |
|---------|-------------|
| tasks subtask-create \<parentTaskId\> | Create a subtask |
| tasks subtask-list \<parentTaskId\> | List subtasks |

### Health

| Command | Description |
|---------|-------------|
| tasks health | Check server health |

For detailed CLI documentation including all options and examples, see [docs/CLI.md](docs/CLI.md).

## MCP Tools Summary

The MCP server exposes 20 tools and 1 resource for Claude Code integration.

### Task Tools (8)

| Tool | Description |
|------|-------------|
| create_task | Create a new task in a project |
| get_task | Get a task by its ID |
| update_task | Update an existing task |
| list_tasks | List tasks with optional filters |
| delete_task | Delete a task by its ID |
| claim_task | Atomically claim an unassigned task |
| list_subtasks | List all subtasks of a parent task |
| get_subtasks | Get all subtasks of a parent task |

### Project Tools (5)

| Tool | Description |
|------|-------------|
| create_project | Create a new project |
| get_project | Get a project by its ID |
| list_projects | List all projects |
| update_project | Update an existing project |
| delete_project | Delete a project by its ID |

### Comment Tools (3)

| Tool | Description |
|------|-------------|
| add_comment | Add a comment to a task |
| get_comments | Get all comments for a task |
| delete_comment | Delete a comment by ID |

### Dependency Tools (3)

| Tool | Description |
|------|-------------|
| add_dependency | Add a dependency relationship between tasks |
| remove_dependency | Remove a dependency relationship |
| get_dependencies | Get all dependencies for a task |

### Health Tools (1)

| Tool | Description |
|------|-------------|
| check_health | Check service health status |

### Resources (1)

| URI | Description |
|-----|-------------|
| events://stream | SSE event stream discovery documentation |

For detailed MCP documentation including tool schemas and Claude Code skill files, see [docs/MCP.md](docs/MCP.md).

## Real-Time Events

Wood Fired Bugs streams real-time task and project change notifications via Server-Sent Events (SSE).

### Event Types

| Event | Trigger |
|-------|---------|
| task.created | New task created |
| task.updated | Task fields modified |
| task.deleted | Task deleted |
| task.status_changed | Task status transition |
| task.claimed | Task claimed by agent |
| project.created | New project created |
| project.updated | Project modified |
| project.deleted | Project deleted |

### Subscribing

```bash
# Subscribe to all events
curl -N -H "X-API-Key: your-key" \
  http://localhost:3000/api/v1/events

# Filter by project
curl -N -H "X-API-Key: your-key" \
  "http://localhost:3000/api/v1/events?project_id=1"

# Filter by event type
curl -N -H "X-API-Key: your-key" \
  "http://localhost:3000/api/v1/events?event_types=task.created,task.claimed"
```

### Reconnection

Include `Last-Event-ID` header to resume from where you left off:

```bash
curl -N -H "X-API-Key: your-key" \
  -H "Last-Event-ID: 42" \
  http://localhost:3000/api/v1/events
```

## Multi-Agent Coordination

### Atomic Task Claiming

Multiple agents can race to claim the same task. Exactly one wins; the rest receive a 409 Conflict. This uses optimistic locking with a version field and `BEGIN IMMEDIATE` transactions in SQLite.

```bash
# Claim a task
curl -X POST http://localhost:3000/api/v1/tasks/42/claim \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"assignee": "agent-1"}'

# With idempotency key (safe to retry)
curl -X POST http://localhost:3000/api/v1/tasks/42/claim \
  -H "X-API-Key: your-key" \
  -H "X-Idempotency-Key: unique-key-123" \
  -H "Content-Type: application/json" \
  -d '{"assignee": "agent-1"}'
```

- Verified with 20 concurrent agents: exactly 1 success, 19 conflicts, 0 errors
- Stale claims auto-released after 30 minutes of inactivity
- Idempotency keys prevent duplicate claims (24h TTL)

### Workflow Automation

When tasks change status, the system automatically:

- **Parent auto-complete:** When all subtasks reach `done`, parent task transitions to `done`
- **Dependency auto-unblock:** When a blocking task completes, blocked dependents transition from `blocked` to `open`

Cascades are depth-limited (max 5 levels) and wrapped in transactions for atomicity.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | HTTP server port | 3000 |
| HOST | HTTP server host. Defaults to loopback only; set to `0.0.0.0` (or a specific LAN IP) to expose on the network. | 127.0.0.1 |
| API_KEYS | Comma-separated API keys for authentication | (none - auth disabled) |
| LOG_LEVEL | Logging level (debug, info, warn, error) | info |
| NODE_ENV | Environment (development, production) | (none) |
| DB_PATH | Path to SQLite database file | ./data/tasks.db |
| API_BASE_URL | Base URL for CLI API calls | http://localhost:3000 |
| API_KEY | API key for CLI authentication | (none) |

## Development

### Key Commands

```bash
# Development mode with hot reload
npm run dev

# Run tests (513 tests across 47 files)
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

SQLite with better-sqlite3 driver, WAL mode, and automatic migrations via Umzug. Four migration files in `src/db/migrations/`:

1. `001-initial-schema.ts` - Projects, tasks, task_tags, dependencies, comments
2. `002-task-hierarchy-and-dependencies.ts` - Task hierarchy and dependency tracking
3. `003-comments-and-estimates.ts` - Comments and time estimates
4. `004-claim-protocol.ts` - Version field, claimed_at, idempotency_keys table

### Testing

513 tests across 47 test files covering:
- Service layer unit tests
- API route integration tests (all endpoints)
- MCP tool tests (all tools)
- CLI command tests
- Event system tests (EventBus, SSEManager, events API)
- Claim protocol tests (including 20-agent concurrency)
- Workflow engine tests (auto-complete, auto-unblock, cascade depth)
- Skill file validation tests

## License

ISC
