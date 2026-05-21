# REST API Reference

Complete reference for the Wood Fired Bugs REST API.

**Base URL:** `http://localhost:3000`

**API Version:** v1 (all endpoints under `/api/v1`)

## Authentication

All endpoints under `/api/v1` require authentication via the `X-API-Key` header. The authenticated `/health/detailed` route also requires `X-API-Key`. In production, the Swagger UI (`/docs`, `/docs/json`) is gated — see [Production gating](#production-gating) below.

The only public, unauthenticated endpoint is `/health` (minimal liveness probe).

### Example Request

```bash
curl -H "X-API-Key: your-key-here" \
  http://localhost:3000/api/v1/tasks
```

### Unauthorized Response

If the API key is missing or invalid, you'll receive a 401 error:

```json
{
  "error": "UNAUTHORIZED",
  "message": "Missing API key. Provide X-API-Key header."
}
```

or

```json
{
  "error": "UNAUTHORIZED",
  "message": "Invalid API key."
}
```

[IMPORTANT] `API_KEYS` is **REQUIRED**. The server fails to start (exit code 78, `EX_CONFIG`) if `API_KEYS` is unset or empty — there is no "auth disabled" fallback mode.

- Format: a comma-separated list of one or more keys. Each entry is either a bare key (`abc123def456...`) or a labelled key (`abc123def456...:ci-runner`). Labels appear in audit logs and never expose the raw key.
- **Production length requirement:** when `NODE_ENV=production`, each key must be at least **32 characters**. Keys that are shorter, repeat a single character, or contain placeholder phrases (`changeme`, `placeholder`, `example`, `change-me-to-a-real-key`) or values (`test`, `dev`) cause the server to refuse to start.
- In non-production environments the length floor is not enforced, but the server still rejects every request when no keys are configured (fail-closed). Generate keys with a CSPRNG, e.g. `openssl rand -hex 32`.

## Error Handling

The API uses standard HTTP status codes and returns error details in JSON format.

### Common Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 204 | No Content (successful deletion) |
| 400 | Bad Request (validation error) |
| 401 | Unauthorized (missing or invalid API key) |
| 404 | Not Found |
| 409 | Conflict (claim already taken, invalid state transition) |
| 500 | Internal Server Error |

### Error Response Format

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable error message"
}
```

### Validation Errors

For validation errors (400), the API uses Zod schemas and returns detailed error information:

```json
{
  "error": "VALIDATION_ERROR",
  "message": "Validation failed",
  "details": [
    {
      "path": ["title"],
      "message": "Title is required"
    }
  ]
}
```

## Health Endpoints

There are two health routes. `/health` is the public liveness probe; `/health/detailed` is an authenticated diagnostic endpoint that exposes component status and runtime statistics.

### GET /health

Minimal public health check. Pings the database (the only critical check on the public endpoint) and returns a fixed minimal payload so unauthenticated probes cannot fingerprint the deployment.

**Authentication:** None (public endpoint)

**Response:** 200 OK

```json
{
  "status": "healthy",
  "timestamp": "2026-02-14T12:00:00.000Z",
  "version": "1.0.0"
}
```

**Response:** 503 Service Unavailable (database ping failed) — same shape, with `status: "unhealthy"`.

**Example:**

```bash
curl http://localhost:3000/health
```

[NOTE] This endpoint deliberately omits component checks, SSE client counts, uptime, and event-bus statistics — those previously lived on `/health` and have moved to the authenticated `/health/detailed` route below so they are not exposed to unauthenticated callers. The public route is also allow-listed from global rate limiting so liveness/readiness probes never consume the request budget.

### GET /health/detailed

Authenticated diagnostic health check. Returns component-level status and runtime statistics for the database, the in-process event bus, and the SSE manager.

**Authentication:** Required (`X-API-Key` header). Returns 401 if the key is missing or invalid.

**Response:** 200 OK

```json
{
  "status": "healthy",
  "timestamp": "2026-02-14T12:00:00.000Z",
  "version": "1.0.0",
  "checks": {
    "database": "ok",
    "eventBus": "ok",
    "sseManager": "ok"
  },
  "stats": {
    "eventBus": { "listenerCount": 8 },
    "sseManager": { "clientCount": 0, "uptime": 12345 }
  }
}
```

Field semantics:

| Field | Values | Meaning |
|-------|--------|---------|
| `checks.database` | `ok` \| `failed` | `SELECT 1` against the SQLite database succeeded or threw. |
| `checks.eventBus` | `ok` \| `degraded` \| `unknown` | In-process event bus liveness. |
| `checks.sseManager` | `ok` \| `degraded` \| `unknown` | SSE fan-out manager liveness. |
| `stats.eventBus.listenerCount` | number | Currently-subscribed listener count. |
| `stats.sseManager.clientCount` | number | Live SSE client connections. |
| `stats.sseManager.uptime` | number | SSE manager uptime in milliseconds. |

**Response:** 503 Service Unavailable (database ping failed) — same shape, with `status: "unhealthy"` and `checks.database: "failed"`.

**Example:**

```bash
curl http://localhost:3000/health/detailed \
  -H "X-API-Key: your-key"
```

[NOTE] `/health/detailed` is **not** gated off in production — it remains available behind `X-API-Key` so operators have a single uniform authenticated probe across environments. Only the unauthenticated `/health` route is intentionally minimal.

## Project Endpoints

### POST /api/v1/projects

Create a new project.

**Request Body:**

```json
{
  "name": "string (required, max 100 chars)",
  "description": "string (optional, max 1000 chars)"
}
```

**Response:** 201 Created

```json
{
  "id": 1,
  "name": "My Project",
  "description": "Project description",
  "created_at": "2026-02-14T12:00:00.000Z",
  "updated_at": "2026-02-14T12:00:00.000Z"
}
```

**Example:**

```bash
curl -X POST http://localhost:3000/api/v1/projects \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Project", "description": "A test project"}'
```

### GET /api/v1/projects

List all projects.

**Response:** 200 OK

```json
[
  {
    "id": 1,
    "name": "Project Alpha",
    "description": "First project",
    "created_at": "2026-02-14T12:00:00.000Z",
    "updated_at": "2026-02-14T12:00:00.000Z"
  }
]
```

**Example:**

```bash
curl http://localhost:3000/api/v1/projects \
  -H "X-API-Key: your-key"
```

### GET /api/v1/projects/:id

Get a project by ID.

**Response:** 200 OK

```json
{
  "id": 1,
  "name": "Project Alpha",
  "description": "First project",
  "created_at": "2026-02-14T12:00:00.000Z",
  "updated_at": "2026-02-14T12:00:00.000Z"
}
```

**Example:**

```bash
curl http://localhost:3000/api/v1/projects/1 \
  -H "X-API-Key: your-key"
```

### PUT /api/v1/projects/:id

Update a project. All fields are optional (partial update).

**Request Body:**

```json
{
  "name": "string (optional, max 100 chars)",
  "description": "string (optional, max 1000 chars)"
}
```

**Response:** 200 OK

```json
{
  "id": 1,
  "name": "Updated Project Name",
  "description": "Updated description",
  "created_at": "2026-02-14T12:00:00.000Z",
  "updated_at": "2026-02-14T13:00:00.000Z"
}
```

**Example:**

```bash
curl -X PUT http://localhost:3000/api/v1/projects/1 \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"name": "Updated Name"}'
```

### DELETE /api/v1/projects/:id

Delete a project.

**Response:** 204 No Content

**Example:**

```bash
curl -X DELETE http://localhost:3000/api/v1/projects/1 \
  -H "X-API-Key: your-key"
```

## Task Endpoints

### POST /api/v1/tasks

Create a new task.

[IMPORTANT] The `status` field is NOT included in the request body. New tasks always start with status `open`.

**Request Body:**

```json
{
  "title": "string (required, max 255 chars)",
  "description": "string (optional, max 5000 chars)",
  "priority": "low|medium|high|urgent (optional, default: medium)",
  "project_id": "number (required, positive integer)",
  "parent_task_id": "number (optional, positive integer for subtasks)",
  "estimated_minutes": "number (optional, 0-10080)",
  "assignee": "string (optional, max 100 chars)",
  "created_by": "string (required, max 100 chars)",
  "due_date": "string (optional, ISO8601 format)",
  "tags": ["array of strings (optional, max 20 tags, each max 50 chars)"]
}
```

**Response:** 201 Created

```json
{
  "id": 42,
  "title": "Implement authentication",
  "description": "Add JWT authentication to API",
  "status": "open",
  "priority": "high",
  "project_id": 1,
  "parent_task_id": null,
  "estimated_minutes": 240,
  "assignee": "alice",
  "created_by": "bob",
  "due_date": "2026-02-20T00:00:00.000Z",
  "created_at": "2026-02-14T12:00:00.000Z",
  "updated_at": "2026-02-14T12:00:00.000Z",
  "tags": ["backend", "security"]
}
```

**Example:**

```bash
curl -X POST http://localhost:3000/api/v1/tasks \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Fix login bug",
    "priority": "high",
    "project_id": 1,
    "created_by": "alice",
    "tags": ["bug", "urgent"]
  }'
```

### GET /api/v1/tasks

List tasks with optional filters.

**Query Parameters (all optional):**

| Parameter | Type | Description |
|-----------|------|-------------|
| project_id | number | Filter by project ID |
| status | string | Filter by status (open, in_progress, done, closed, blocked) |
| assignee | string | Filter by assignee name |
| tags | string | Filter by tags (comma-separated) |
| due_before | string | Tasks due before date (ISO8601) |
| due_after | string | Tasks due after date (ISO8601) |
| updated_before | string | Tasks last updated before date (ISO8601) |
| updated_after | string | Tasks last updated after date (ISO8601) |
| search | string | Search in title and description (max 200 chars, max 32 terms) |
| limit | number | Page size, default 50, max 500 |
| offset | number | Pagination offset, default 0 |

**Response:** 200 OK

```json
[
  {
    "id": 42,
    "title": "Implement authentication",
    "description": "Add JWT authentication to API",
    "status": "in_progress",
    "priority": "high",
    "project_id": 1,
    "parent_task_id": null,
    "estimated_minutes": 240,
    "assignee": "alice",
    "created_by": "bob",
    "due_date": "2026-02-20T00:00:00.000Z",
    "created_at": "2026-02-14T12:00:00.000Z",
    "updated_at": "2026-02-14T13:00:00.000Z",
    "tags": ["backend", "security"]
  }
]
```

**Examples:**

```bash
# All tasks
curl http://localhost:3000/api/v1/tasks \
  -H "X-API-Key: your-key"

# Tasks for project 1
curl "http://localhost:3000/api/v1/tasks?project_id=1" \
  -H "X-API-Key: your-key"

# Open tasks assigned to alice
curl "http://localhost:3000/api/v1/tasks?status=open&assignee=alice" \
  -H "X-API-Key: your-key"

# Search for authentication tasks
curl "http://localhost:3000/api/v1/tasks?search=authentication" \
  -H "X-API-Key: your-key"

# Tasks with bug tag
curl "http://localhost:3000/api/v1/tasks?tags=bug" \
  -H "X-API-Key: your-key"

# Tasks updated since a given timestamp (incremental sync)
curl "http://localhost:3000/api/v1/tasks?updated_after=2026-01-01T00:00:00Z" \
  -H "X-API-Key: your-key"

# Tasks updated within a window
curl "http://localhost:3000/api/v1/tasks?updated_after=2026-01-01T00:00:00Z&updated_before=2026-02-01T00:00:00Z" \
  -H "X-API-Key: your-key"
```

### GET /api/v1/tasks/:id

Get a task by ID.

**Response:** 200 OK

```json
{
  "id": 42,
  "title": "Implement authentication",
  "description": "Add JWT authentication to API",
  "status": "in_progress",
  "priority": "high",
  "project_id": 1,
  "parent_task_id": null,
  "estimated_minutes": 240,
  "assignee": "alice",
  "created_by": "bob",
  "due_date": "2026-02-20T00:00:00.000Z",
  "created_at": "2026-02-14T12:00:00.000Z",
  "updated_at": "2026-02-14T13:00:00.000Z",
  "tags": ["backend", "security"]
}
```

**Example:**

```bash
curl http://localhost:3000/api/v1/tasks/42 \
  -H "X-API-Key: your-key"
```

### PUT /api/v1/tasks/:id

Update a task. All fields are optional (partial update).

[IMPORTANT] Status transitions are validated. See the status transitions table in README.md for allowed transitions.

**Request Body:**

```json
{
  "title": "string (optional, max 255 chars)",
  "description": "string (optional, max 5000 chars)",
  "status": "open|in_progress|done|closed|blocked (optional)",
  "priority": "low|medium|high|urgent (optional)",
  "parent_task_id": "number (optional, positive integer)",
  "estimated_minutes": "number (optional, 0-10080)",
  "assignee": "string (optional, max 100 chars)",
  "due_date": "string (optional, ISO8601 format)",
  "tags": ["array of strings (optional, max 20 tags, each max 50 chars)"]
}
```

**Response:** 200 OK

```json
{
  "id": 42,
  "title": "Implement authentication",
  "description": "Add JWT authentication to API",
  "status": "done",
  "priority": "high",
  "project_id": 1,
  "parent_task_id": null,
  "estimated_minutes": 240,
  "assignee": "alice",
  "created_by": "bob",
  "due_date": "2026-02-20T00:00:00.000Z",
  "created_at": "2026-02-14T12:00:00.000Z",
  "updated_at": "2026-02-14T15:00:00.000Z",
  "tags": ["backend", "security"]
}
```

**Example:**

```bash
curl -X PUT http://localhost:3000/api/v1/tasks/42 \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"status": "done"}'
```

### DELETE /api/v1/tasks/:id

Delete a task.

**Response:** 204 No Content

**Example:**

```bash
curl -X DELETE http://localhost:3000/api/v1/tasks/42 \
  -H "X-API-Key: your-key"
```

### GET /api/v1/tasks/:id/subtasks

Get all subtasks (children) of a parent task.

**Response:** 200 OK

```json
[
  {
    "id": 43,
    "title": "Subtask 1",
    "description": "First subtask",
    "status": "open",
    "priority": "medium",
    "project_id": 1,
    "parent_task_id": 42,
    "estimated_minutes": 60,
    "assignee": "alice",
    "created_by": "bob",
    "due_date": null,
    "created_at": "2026-02-14T12:00:00.000Z",
    "updated_at": "2026-02-14T12:00:00.000Z",
    "tags": []
  }
]
```

**Example:**

```bash
curl http://localhost:3000/api/v1/tasks/42/subtasks \
  -H "X-API-Key: your-key"
```

## Comment Endpoints

Comments are nested under tasks at `/api/v1/tasks/:id/comments`.

### POST /api/v1/tasks/:id/comments

Add a comment to a task.

**Request Body:**

```json
{
  "author": "string (required, max 100 chars)",
  "content": "string (required, max 5000 chars)"
}
```

**Response:** 201 Created

```json
{
  "id": 1,
  "task_id": 42,
  "author": "alice",
  "content": "This looks good, approved!",
  "created_at": "2026-02-14T12:00:00.000Z",
  "updated_at": null
}
```

**Example:**

```bash
curl -X POST http://localhost:3000/api/v1/tasks/42/comments \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"author": "alice", "content": "Great progress!"}'
```

### GET /api/v1/tasks/:id/comments

Get all comments for a task in chronological order.

**Response:** 200 OK

```json
[
  {
    "id": 1,
    "task_id": 42,
    "author": "alice",
    "content": "This looks good, approved!",
    "created_at": "2026-02-14T12:00:00.000Z",
    "updated_at": null
  },
  {
    "id": 2,
    "task_id": 42,
    "author": "bob",
    "content": "Thanks for the review!",
    "created_at": "2026-02-14T12:05:00.000Z",
    "updated_at": null
  }
]
```

**Example:**

```bash
curl http://localhost:3000/api/v1/tasks/42/comments \
  -H "X-API-Key: your-key"
```

### DELETE /api/v1/tasks/:id/comments/:commentId

Delete a comment.

**Response:** 204 No Content

**Example:**

```bash
curl -X DELETE http://localhost:3000/api/v1/tasks/42/comments/1 \
  -H "X-API-Key: your-key"
```

## Dependency Endpoints

Dependencies are nested under tasks at `/api/v1/tasks/:id/dependencies`.

A dependency relationship means "task :id blocks task :blocksTaskId".

### POST /api/v1/tasks/:id/dependencies

Add a dependency relationship (this task blocks another task).

**Request Body:**

```json
{
  "blocks_task_id": "number (required, positive integer)"
}
```

**Response:** 201 Created

```json
{
  "id": 1,
  "task_id": 42,
  "blocks_task_id": 43,
  "created_at": "2026-02-14T12:00:00.000Z"
}
```

**Example:**

```bash
# Task 42 blocks task 43
curl -X POST http://localhost:3000/api/v1/tasks/42/dependencies \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"blocks_task_id": 43}'
```

### GET /api/v1/tasks/:id/dependencies

Get all dependencies for a task (tasks it blocks and tasks that block it).

**Response:** 200 OK

```json
{
  "blocks": [
    {
      "id": 43,
      "title": "Deploy to production",
      "status": "blocked",
      "priority": "high"
    }
  ],
  "blocked_by": [
    {
      "id": 41,
      "title": "Write tests",
      "status": "in_progress",
      "priority": "high"
    }
  ]
}
```

**Example:**

```bash
curl http://localhost:3000/api/v1/tasks/42/dependencies \
  -H "X-API-Key: your-key"
```

### DELETE /api/v1/tasks/:id/dependencies/:blocksTaskId

Remove a dependency relationship.

**Response:** 204 No Content

**Example:**

```bash
# Remove dependency: task 42 no longer blocks task 43
curl -X DELETE http://localhost:3000/api/v1/tasks/42/dependencies/43 \
  -H "X-API-Key: your-key"
```

## Claim Endpoint

### POST /api/v1/tasks/:id/claim

Atomically claim an unassigned task. Sets assignee and transitions status to `in_progress` in a single atomic operation using optimistic locking.

**Request Body:**

```json
{
  "assignee": "string (required, 1-100 chars)"
}
```

**Request Headers (optional):**

| Header | Description |
|--------|-------------|
| X-Idempotency-Key | Unique key for retry safety (24h TTL). If the same key is reused, the original response is returned without re-executing. |

**Response:** 200 OK

```json
{
  "id": 42,
  "title": "Implement authentication",
  "status": "in_progress",
  "assignee": "agent-1",
  "version": 2,
  "claimed_at": "2026-02-14T12:00:00.000Z",
  ...
}
```

**Response:** 409 Conflict (task already claimed or not in valid state)

```json
{
  "error": "CONFLICT",
  "message": "Task is already assigned to another agent"
}
```

**Response:** 404 Not Found

```json
{
  "error": "NOT_FOUND",
  "message": "Task not found"
}
```

**Examples:**

```bash
# Claim a task
curl -X POST http://localhost:3000/api/v1/tasks/42/claim \
  -H "X-API-Key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"assignee": "agent-1"}'

# Claim with idempotency key (safe to retry)
curl -X POST http://localhost:3000/api/v1/tasks/42/claim \
  -H "X-API-Key: your-key" \
  -H "X-Idempotency-Key: claim-42-agent-1" \
  -H "Content-Type: application/json" \
  -d '{"assignee": "agent-1"}'
```

**Concurrency guarantees:**
- Uses CAS (Compare-And-Swap) with a `version` field for optimistic locking
- Uses `BEGIN IMMEDIATE` SQLite transactions to acquire write lock early
- Verified with 20 concurrent agents: exactly 1 success, 19 conflicts, 0 server errors
- Stale claims auto-released after 30 minutes of inactivity

## Event Stream Endpoint

### GET /api/v1/events

Subscribe to real-time task and project change notifications via Server-Sent Events (SSE).

**Query Parameters (all optional):**

| Parameter | Type | Description |
|-----------|------|-------------|
| project_id | number | Only receive events for this project |
| event_types | string | Comma-separated event types to filter (e.g., `task.created,task.claimed`) |

**Request Headers (optional):**

| Header | Description |
|--------|-------------|
| Last-Event-ID | Resume from this event ID after reconnection |

**Event Types:**

| Type | Trigger |
|------|---------|
| task.created | New task created |
| task.updated | Task fields modified |
| task.deleted | Task deleted |
| task.status_changed | Task status transition |
| task.claimed | Task claimed by agent |
| project.created | New project created |
| project.updated | Project modified |
| project.deleted | Project deleted |

**Event Format:**

```
id: 42
event: task.created
data: {"eventType":"task.created","timestamp":"2026-02-14T12:00:00.000Z","data":{"id":42,"title":"New task",...},"metadata":{"source":"user"}}
```

**Heartbeat:**

The server sends a heartbeat comment every 30 seconds to keep the connection alive:

```
:heartbeat
```

**Examples:**

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

# Resume after reconnection
curl -N -H "X-API-Key: your-key" \
  -H "Last-Event-ID: 42" \
  http://localhost:3000/api/v1/events
```

**Reconnection:**

The server buffers up to 1000 events for 5 minutes. Include `Last-Event-ID` header when reconnecting to replay missed events. Events older than 5 minutes are discarded.

**Metadata:**

Each event includes a `metadata.source` field:
- `"user"` — triggered by a direct API call
- `"workflow"` — triggered by workflow automation (parent auto-complete or dependency auto-unblock)

## Interactive Documentation

Swagger UI is available at:

```
http://localhost:3000/docs
```

The raw OpenAPI 3 document is served at `/docs/json`.

The Swagger UI provides:

- Interactive "Try it out" functionality for all endpoints
- Complete request/response schemas
- Authentication support (X-API-Key header)
- Example values for all fields
- Full Zod schema validation details

### Production gating

Swagger UI is **disabled by default in production** (`NODE_ENV=production`). The behaviour is:

| Environment | `ENABLE_SWAGGER_IN_PRODUCTION` | `/docs` and `/docs/json` |
|-------------|-------------------------------|--------------------------|
| `development` or `test` | (ignored) | Exposed, no auth required. |
| `production` | unset / `false` (default) | **Not registered** — returns 404. |
| `production` | `true` | Exposed, but `X-API-Key` is required (same canonical auth plugin as `/api/v1`). |

The in-process OpenAPI spec collector is always loaded so internal tests can introspect route schemas, but the HTTP routes that serve the UI and JSON document are only mounted when the gate above allows it.

[TIP] Use Swagger UI in development to explore the API and test endpoints without writing curl commands. In production, fetch the spec via `/docs/json` with your API key only after opting in with `ENABLE_SWAGGER_IN_PRODUCTION=true`.
