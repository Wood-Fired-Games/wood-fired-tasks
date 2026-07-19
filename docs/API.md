# REST API Reference

Agents: start at [`AGENTS.md`](../AGENTS.md); the full read-order contract is in [`docs/AGENT_CONTEXT.md`](AGENT_CONTEXT.md).

Reference for the Wood Fired Tasks REST API. Covers the core
task/project/dependency/comment/WSJF/model surfaces; a few auxiliary routes
(e.g. `GET /api/v1/projects/:id/dependency-graph`, and the `/me`, `/auth`,
`/web` surfaces) are enumerated in [`docs/INTERFACES.md`](INTERFACES.md).

**Base URL:** `http://localhost:3000`

**API Version:** v1 (all endpoints under `/api/v1`)

## Authentication

All endpoints under `/api/v1` require authentication via a Personal Access Token (PAT) presented as the `Authorization: Bearer <pat>` header. The authenticated `/health/detailed` route also requires a Bearer PAT. In production, the Swagger UI (`/docs`, `/docs/json`) is gated — see [Production gating](#production-gating) below.

The only public, unauthenticated endpoint is `/health` (minimal liveness probe).

Mint a PAT via the web UI (`/me`), `tasks login` (OIDC device flow), or `tasks db mint-token` (headless bootstrap). PAT values start with `wft_pat_`. See [SETUP.md](SETUP.md) for the full minting and bootstrap flow.

### Example Request

```bash
curl -H "Authorization: Bearer wft_pat_your-token-here" \
  http://localhost:3000/api/v1/tasks
```

### Unauthorized Response

If the token is missing or invalid, you'll receive a 401 error:

```json
{
  "error": "UNAUTHORIZED",
  "message": "Missing or invalid Authorization header. Provide a Bearer PAT."
}
```

or

```json
{
  "error": "UNAUTHORIZED",
  "message": "Invalid token."
}
```

[IMPORTANT] At least one valid PAT must exist for the server to be usable. PATs are minted and revoked at runtime (web `/me`, `tasks login`, or `tasks db mint-token`) — there is no static key list in the environment and no "auth disabled" fallback mode.

## Error Handling

The API uses standard HTTP status codes and returns error details in JSON format.

### Common Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 204 | No Content (successful deletion) |
| 400 | Bad Request (validation error) |
| 401 | Unauthorized (missing or invalid Bearer PAT) |
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

## Paginated list shape

All authenticated list endpoints (`GET /api/v1/tasks`, `GET /api/v1/projects`, `GET /api/v1/tasks/:id/subtasks`, `GET /api/v1/tasks/:id/comments`) return a paginated envelope rather than a bare array:

```json
{
  "data": [ /* array of items for this page */ ],
  "total": 137,
  "limit": 50,
  "offset": 0
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `data` | array | Items for the current page. |
| `total` | number | Total matching rows across the full result set (independent of `limit`/`offset`). |
| `limit` | number | Effective page size (default `50`, max `500`). |
| `offset` | number | Effective offset (default `0`). |

**Bounds:**
- `limit` must be `1 <= limit <= 500`; values outside that range return `400 VALIDATION_ERROR`.
- `offset` must be `>= 0`; negative values return `400 VALIDATION_ERROR`.
- Paginate by advancing `offset` in `limit`-sized steps until `offset + data.length >= total`.

[NOTE] This is a breaking change for raw-array clients that predate the pagination rollout (task #192, commit `ee72306`). The CLI and MCP layers unwrap the envelope transparently and fall back to bare-array parsing for older servers; direct HTTP consumers must read `data` to access items.

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

**Authentication:** Required (`Authorization: Bearer <pat>` header). Returns 401 if the token is missing or invalid.

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
  -H "Authorization: Bearer wft_pat_your-token"
```

[NOTE] `/health/detailed` is **not** gated off in production — it remains available behind a Bearer PAT so operators have a single uniform authenticated probe across environments. Only the unauthenticated `/health` route is intentionally minimal.

## Project Endpoints

### POST /api/v1/projects

Create a new project.

**Request Body:**

```json
{
  "name": "string (required, max 100 chars)",
  "description": "string (optional, max 1000 chars)",
  "value_charter": "ValueCharter object (optional) — see Value charter below",
  "model_policy": "ModelPolicy | null (optional) — per-project model routing; see Models & model-policy Endpoints"
}
```

**Response:** 201 Created

```json
{
  "id": 1,
  "name": "My Project",
  "description": "Project description",
  "value_charter": null,
  "created_at": "2026-02-14T12:00:00.000Z",
  "updated_at": "2026-02-14T12:00:00.000Z"
}
```

**Example:**

```bash
curl -X POST http://localhost:3000/api/v1/projects \
  -H "Authorization: Bearer wft_pat_your-token" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Project", "description": "A test project"}'
```

[NOTE] `value_charter` is the per-project reference frame for WSJF Business-Value scoring (see [WSJF Endpoints](#wsjf-endpoints)). It is optional and defaults to `null`; projects with no charter behave exactly as before, sorting by `priority` then age. The field shape is documented under [Value charter](#value-charter).

[NOTE] `model_policy` is the optional per-project model-routing policy for the **Configurable Task Models** layer. It is accepted on create/update, returned on every project response, and `null` when unset (the global default from `GET /settings/model-policy` applies instead). See [Models & model-policy Endpoints](#models--model-policy-endpoints) for the shape and the resolver route.

### GET /api/v1/projects

List projects (paginated). Returns the envelope `{ data, total, limit, offset }` — see [Paginated list shape](#paginated-list-shape).

**Query Parameters (all optional):**

| Parameter | Type | Description |
|-----------|------|-------------|
| limit | number | Page size, default 50, max 500 |
| offset | number | Pagination offset, default 0 |

**Response:** 200 OK

```json
{
  "data": [
    {
      "id": 1,
      "name": "Project Alpha",
      "description": "First project",
      "created_at": "2026-02-14T12:00:00.000Z",
      "updated_at": "2026-02-14T12:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

**Examples:**

```bash
# First page (default limit 50)
curl http://localhost:3000/api/v1/projects \
  -H "Authorization: Bearer wft_pat_your-token"

# Second page of 25
curl "http://localhost:3000/api/v1/projects?limit=25&offset=25" \
  -H "Authorization: Bearer wft_pat_your-token"
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
  -H "Authorization: Bearer wft_pat_your-token"
```

### PUT /api/v1/projects/:id

Update a project. All fields are optional (partial update).

**Request Body:**

```json
{
  "name": "string (optional, max 100 chars)",
  "description": "string (optional, max 1000 chars)",
  "value_charter": "ValueCharter object (optional) — see Value charter below",
  "model_policy": "ModelPolicy | null (optional) — per-project model routing; see Models & model-policy Endpoints"
}
```

The CLI `tasks project-set-models <id>` command merges a partial `model_policy` through this route.

**Response:** 200 OK

```json
{
  "id": 1,
  "name": "Updated Project Name",
  "description": "Updated description",
  "value_charter": null,
  "created_at": "2026-02-14T12:00:00.000Z",
  "updated_at": "2026-02-14T13:00:00.000Z"
}
```

**Example:**

```bash
curl -X PUT http://localhost:3000/api/v1/projects/1 \
  -H "Authorization: Bearer wft_pat_your-token" \
  -H "Content-Type: application/json" \
  -d '{"name": "Updated Name"}'
```

[NOTE] Setting `value_charter` here bumps the charter's `interview_version` and snapshots the prior charter into `project_charter_history` (readable via [`GET /api/v1/projects/:id/charter-history`](#get-apiv1projectsidcharter-history)). See [Value charter](#value-charter) for the field shape.

### DELETE /api/v1/projects/:id

Delete a project.

**Response:** 204 No Content

**Example:**

```bash
curl -X DELETE http://localhost:3000/api/v1/projects/1 \
  -H "Authorization: Bearer wft_pat_your-token"
```

### GET /api/v1/projects/:id/topology

Classify a project as `FLAT` (parallelizable, `/tasks:loop`), `DAG` (wave-by-wave parallel dispatch, `/tasks:loop-dag`), or `DAG_CYCLIC` (BLOCKED) based on its `task_dependencies` graph (parent/child taxonomy edges are excluded). Delegates to `TopologyService.classify`; backs the `topology_check` MCP tool (including the remote MCP proxy).

**Response:** 200 OK — the body IS the `TopologyReport`.

```json
{
  "topology": "DAG",
  "edges": [
    { "from": 1, "to": 2 }
  ],
  "roots": [1],
  "leaves": [2],
  "advisory": "/tasks:loop-dag"
}
```

- `topology`: one of `FLAT`, `DAG`, `DAG_CYCLIC`.
- `edges`: `{ from, to }` rows where `from` blocks `to`.
- `roots`: task IDs with zero in-degree (sorted ascending).
- `leaves`: task IDs with zero out-degree (sorted ascending).
- `advisory`: one of `/tasks:loop`, `/tasks:loop-dag`, `BLOCKED`.

**Response:** 404 Not Found — project does not exist (ProblemDetails body).

**Example:**

```bash
curl http://localhost:3000/api/v1/projects/1/topology \
  -H "Authorization: Bearer wft_pat_your-token"
```

### GET /api/v1/projects/:id/resolve-model

Resolve the model for a pipeline role. Delegates to `ModelPolicyService.resolveModel(projectId, role, taskId?)` (project policy ?? global default, per-slot merge, jobSize→category routing when `task_id` is supplied). The body IS the resolver output **verbatim** — identical to the stdio/remote `resolve_model` MCP tool: `{ "model": "<id>" }`, `{ "model": "auto" }`, or a bare `null` (inherit). Read-only. Query: `role` (required, `execution|validation|planning`); `task_id` (optional positive int → routes by the task's WSJF power category). **Response:** 200 OK — the resolver output; 404 — project does not exist.

## Models & model-policy Endpoints

The **Configurable Task Models** layer exposes runtime model discovery and the database-wide default `ModelPolicy` over REST so the remote MCP proxy, the dashboard, and the [`/tasks:set-models`](#configurable-models) interview can read/write policy without a stdio MCP connection. Per-project policy rides on the project routes (`model_policy`); the global default lives here; resolution is `GET /projects/:id/resolve-model` above.

A `ModelPolicy` is a per-role (`execution | validation | planning`) object; each role may carry `byCategory` (one of the six power categories `minimal | light | moderate | strong | heavy | maximum` → a model ref), a `default` ref, and — for `planning` — a single `constant` ref. A model ref is a catalog model id or the `auto` sentinel.

### GET /api/v1/models

List the runtime-discovered Claude model catalog (Anthropic Models API, TTL-cached, static fallback when offline / no `ANTHROPIC_API_KEY`). Body is `{ models, stale }` — identical to the stdio `list_models` MCP tool; `stale: true` means the static fallback was served. NEVER throws; always 200.

```json
{ "models": [ { "id": "claude-opus-4-1", "display_name": "Claude Opus 4.1", "family": "opus", "created_at": "2025-08-05" } ], "stale": false }
```

### GET /api/v1/settings/model-policy

Get the database-wide model-policy default (`app_settings.model_policy_default`). **Response:** 200 OK — the stored `ModelPolicy`, or `null` when no default is configured.

### PUT /api/v1/settings/model-policy

Set (or, with a `null` body, clear) the database-wide model-policy default. Body is a `ModelPolicy` (or `null`); an invalid shape is rejected with **400** at the boundary. The 200 body echoes the persisted policy back.

## Task Endpoints

### POST /api/v1/tasks

Create a new task.

[IMPORTANT] The `status` field is NOT included in the request body. New tasks always start with status `open`.

[NOTE] When the project has a value charter, the four WSJF components may be auto-populated at task creation. WSJF fields are not set directly through this endpoint's request body — read and override them through the [WSJF Endpoints](#wsjf-endpoints) below.

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
  -H "Authorization: Bearer wft_pat_your-token" \
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

List tasks with optional filters (paginated). Returns the envelope `{ data, total, limit, offset }` — see [Paginated list shape](#paginated-list-shape).

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
{
  "data": [
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
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

[NOTE] Requests with `limit > 500` or `offset < 0` are rejected with `400 VALIDATION_ERROR`.

**Examples:**

```bash
# First page (default limit 50)
curl http://localhost:3000/api/v1/tasks \
  -H "Authorization: Bearer wft_pat_your-token"

# Second page of 25
curl "http://localhost:3000/api/v1/tasks?limit=25&offset=25" \
  -H "Authorization: Bearer wft_pat_your-token"

# Tasks for project 1
curl "http://localhost:3000/api/v1/tasks?project_id=1" \
  -H "Authorization: Bearer wft_pat_your-token"

# Open tasks assigned to alice
curl "http://localhost:3000/api/v1/tasks?status=open&assignee=alice" \
  -H "Authorization: Bearer wft_pat_your-token"

# Search for authentication tasks
curl "http://localhost:3000/api/v1/tasks?search=authentication" \
  -H "Authorization: Bearer wft_pat_your-token"

# Tasks with bug tag
curl "http://localhost:3000/api/v1/tasks?tags=bug" \
  -H "Authorization: Bearer wft_pat_your-token"

# Tasks updated since a given timestamp (incremental sync)
curl "http://localhost:3000/api/v1/tasks?updated_after=2026-01-01T00:00:00Z" \
  -H "Authorization: Bearer wft_pat_your-token"

# Tasks updated within a window
curl "http://localhost:3000/api/v1/tasks?updated_after=2026-01-01T00:00:00Z&updated_before=2026-02-01T00:00:00Z" \
  -H "Authorization: Bearer wft_pat_your-token"
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
  -H "Authorization: Bearer wft_pat_your-token"
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
  "tags": ["array of strings (optional, max 20 tags, each max 50 chars)"],
  "blocked_by": ["array of task IDs (optional, 1-50; ONLY valid with status: 'blocked')"]
}
```

[NOTE] **Atomic block-with-dependency (task #1004):** pass `blocked_by: [taskIds]`
with `status: "blocked"` to add the blocking dependency edge(s) and flip the status
in ONE transaction (all-or-nothing — a nonexistent blocker, self-reference, or cycle
rolls the whole call back; already-existing edges are skipped). `blocked_by` without
`status: "blocked"` is rejected. Without an edge a blocked task never auto-unblocks
(the `blocked -> open` workflow transition fires only off a dependency edge).

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
  -H "Authorization: Bearer wft_pat_your-token" \
  -H "Content-Type: application/json" \
  -d '{"status": "done"}'
```

### DELETE /api/v1/tasks/:id

Delete a task.

**Response:** 204 No Content

**Example:**

```bash
curl -X DELETE http://localhost:3000/api/v1/tasks/42 \
  -H "Authorization: Bearer wft_pat_your-token"
```

### GET /api/v1/tasks/:id/subtasks

Get subtasks (children) of a parent task (paginated). Returns the envelope `{ data, total, limit, offset }` — see [Paginated list shape](#paginated-list-shape).

**Query Parameters (all optional):**

| Parameter | Type | Description |
|-----------|------|-------------|
| limit | number | Page size, default 50, max 500 |
| offset | number | Pagination offset, default 0 |

**Response:** 200 OK

```json
{
  "data": [
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
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

**Example:**

```bash
curl http://localhost:3000/api/v1/tasks/42/subtasks \
  -H "Authorization: Bearer wft_pat_your-token"
```

### GET /api/v1/tasks/completion-report

Dashboard report of tasks completed (`status=done`) within a time interval.
Supply **either** `days` (trailing window, 1-365) **or** both `start` and `end`
ISO8601 timestamps. Optional `project_id` and `assignee` filters narrow results.

**Query parameters:**

- `days` (optional, integer 1-365) — trailing window from now
- `start` (optional, ISO8601) — required with `end`
- `end` (optional, ISO8601) — required with `start`; must be `>= start`
- `project_id` (optional, positive integer) — filter by project
- `assignee` (optional, 1-100 chars) — filter by assignee

You must supply either `days` or both `start` and `end`. Mixing forms is
rejected with HTTP 400.

**Response:** 200 OK

```json
{
  "range": { "start": "2026-04-21T00:00:00.000Z", "end": "2026-05-21T00:00:00.000Z" },
  "total": 12,
  "rows": [
    {
      "id": 42,
      "title": "Ship completion report",
      "project_id": 1,
      "assignee": "alice",
      "priority": "high",
      "created_at": "2026-05-19T09:00:00.000Z",
      "completed_at": "2026-05-21T14:00:00.000Z",
      "time_to_complete_seconds": 190800
    }
  ],
  "by_project":   [{ "project_id": 1, "count": 8 }],
  "by_assignee":  [{ "assignee": "alice", "count": 5 }],
  "by_priority":  [{ "priority": "high", "count": 6 }],
  "daily_throughput": [{ "date": "2026-05-21", "count": 3 }]
}
```

**Examples:**

```bash
# Trailing 7 days
curl 'http://localhost:3000/api/v1/tasks/completion-report?days=7' \
  -H "Authorization: Bearer wft_pat_your-token"

# Explicit window, filtered by assignee
curl 'http://localhost:3000/api/v1/tasks/completion-report?start=2026-05-01T00:00:00Z&end=2026-05-21T23:59:59Z&assignee=alice' \
  -H "Authorization: Bearer wft_pat_your-token"
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
  -H "Authorization: Bearer wft_pat_your-token" \
  -H "Content-Type: application/json" \
  -d '{"author": "alice", "content": "Great progress!"}'
```

### GET /api/v1/tasks/:id/comments

Get comments for a task in chronological order (paginated). Returns the envelope `{ data, total, limit, offset }` — see [Paginated list shape](#paginated-list-shape).

**Query Parameters (all optional):**

| Parameter | Type | Description |
|-----------|------|-------------|
| limit | number | Page size, default 50, max 500 |
| offset | number | Pagination offset, default 0 |

**Response:** 200 OK

```json
{
  "data": [
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
  ],
  "total": 2,
  "limit": 50,
  "offset": 0
}
```

**Example:**

```bash
curl http://localhost:3000/api/v1/tasks/42/comments \
  -H "Authorization: Bearer wft_pat_your-token"
```

### DELETE /api/v1/tasks/:id/comments/:commentId

Delete a comment.

**Response:** 204 No Content

**Example:**

```bash
curl -X DELETE http://localhost:3000/api/v1/tasks/42/comments/1 \
  -H "Authorization: Bearer wft_pat_your-token"
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
  -H "Authorization: Bearer wft_pat_your-token" \
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
  -H "Authorization: Bearer wft_pat_your-token"
```

### DELETE /api/v1/tasks/:id/dependencies/:blocksTaskId

Remove a dependency relationship.

**Response:** 204 No Content

**Example:**

```bash
# Remove dependency: task 42 no longer blocks task 43
curl -X DELETE http://localhost:3000/api/v1/tasks/42/dependencies/43 \
  -H "Authorization: Bearer wft_pat_your-token"
```

## WSJF Endpoints

WSJF (Weighted Shortest Job First) scores every task on its **Cost of Delay** (Business Value + Time Criticality + Risk/Opportunity-Enablement) divided by **Job Size**, so the autonomous loop runners can drain work by economic value rather than a hand-set `priority` label. Scoring is grounded in a per-project **value charter** and recorded with an append-only history. Projects with no charter and no scored tasks behave exactly as before (sort by `priority` then age).

The four WSJF components are Fibonacci tiers (`1, 2, 3, 5, 8, 13`). The LLM never emits a number: it classifies over closed enums and the server recomputes the components deterministically. A task is treated as scored only when **all four** components are set; otherwise every component is `null` (unscored).

Four of these endpoints back the remote MCP WSJF tools (see [`docs/MCP.md`](MCP.md)): `wsjf_ranking` → `GET /projects/:id/wsjf-ranking`, `wsjf_history` → `GET /tasks/:id/score-history`, `wsjf_health` → `GET /projects/:id/wsjf-health`, `rescore_project` → `POST /projects/:id/rescore`. The `charter-history`, `rescore-runs`, and `GET`/`PUT /tasks/:id/wsjf` endpoints are REST-only (no MCP tool proxy); the task WSJF get/set and charter history are also surfaced via the CLI.

**Authentication:** all WSJF endpoints require a Bearer PAT (same as every `/api/v1` route).

### Value charter

The `value_charter` object on a project (set via [`POST`](#post-apiv1projects) / [`PUT /api/v1/projects/:id`](#put-apiv1projectsid)) is the reference frame for Business-Value scoring:

```json
{
  "mission": "string",
  "value_themes": [
    { "name": "string", "weight": 5, "description": "string" }
  ],
  "time_context": "string",
  "risk_posture": "string",
  "out_of_scope": ["string"],
  "interview_version": 1,
  "updated_at": "2026-02-14T12:00:00.000Z"
}
```

Each `value_themes[].weight` must be a Fibonacci tier (`1, 2, 3, 5, 8, 13`); non-Fibonacci weights are rejected with `400 VALIDATION_ERROR`. `value_charter` is nullable — `null` means the project never ran the charter interview.

### GET /api/v1/projects/:id/wsjf-ranking

Rank a project's tasks by propagation-adjusted WSJF. Backs the `wsjf_ranking` MCP tool. Each task carries its four components, its base vs effective WSJF, and the downstream Cost-of-Delay `propagation` breakdown. Ranking is read-time only and never persisted.

**Query Parameters (optional):**

| Parameter | Type | Description |
|-----------|------|-------------|
| scope | string | `frontier` (default) excludes blocked / not-ready tasks; `all` ranks every task. |

**Response:** 200 OK

```json
{
  "project_id": 1,
  "scope": "frontier",
  "total": 1,
  "ranking": [
    {
      "taskId": 42,
      "scored": true,
      "baseWsjf": 8.0,
      "effectiveWsjf": 11.5,
      "components": { "value": 8, "timeCriticality": 5, "riskOpportunity": 3, "jobSize": 2 },
      "propagation": [
        { "dependentId": 43, "contribution": 7.0 }
      ],
      "evidence": { "value": "…", "timeCriticality": "…", "riskOpportunity": "…", "jobSize": "…" }
    }
  ]
}
```

- Field names are camelCase (`taskId`, `baseWsjf`, `effectiveWsjf`); `baseWsjf` is `null` for an unscored task, `evidence` and `components` are `null` when absent, and each `propagation` edge is `{ dependentId, contribution }` (the γ-decayed downstream Cost-of-Delay contribution).
- `effective_CoD = base_CoD + Σ dependents' base_CoD · γ^(dist−1)`, capped at `base_CoD · CAP` (γ = 0.5, CAP = 3).
- Sort: `effectiveWsjf` DESC, then `created_at` ASC, then `id` ASC.
- Unscored tasks fall back to `priorityFallbackScore` (urgent → 9, high → 6, medium → 3, low → 1) so scored and unscored tasks sort in one coherent space.

**Response:** 404 Not Found — project does not exist. A `DAG_CYCLIC` graph is rejected up front.

**Example:**

```bash
# Frontier ranking (default)
curl http://localhost:3000/api/v1/projects/1/wsjf-ranking \
  -H "Authorization: Bearer wft_pat_your-token"

# Rank every task
curl "http://localhost:3000/api/v1/projects/1/wsjf-ranking?scope=all" \
  -H "Authorization: Bearer wft_pat_your-token"
```

### GET /api/v1/projects/:id/wsjf-health

Lint a project's WSJF state for degeneracies and pitfalls. Backs the `wsjf_health` MCP tool. Non-blocking and advisory — empty findings means healthy.

**Response:** 200 OK

```json
{
  "project_id": 1,
  "healthy": false,
  "scored_task_count": 12,
  "findings": [
    {
      "check": "cod-no-anchor",
      "severity": "warning",
      "message": "No task anchors the Time Criticality column to the 1 tier.",
      "suggestion": "Re-anchor the lowest Time Criticality task to 1 so the column is relatively scaled.",
      "taskIds": [42, 43]
    }
  ]
}
```

`healthy` is `true` ⇔ `findings` is empty. Each finding carries a `severity` (`info` / `warning` / `critical`), a `suggestion`, and the `taskIds` it implicates. The six checks are `degenerate-spread`, `cod-no-anchor`, `job-size-collapsed`, `stale-time-criticality`, `high-fallback-ratio`, and `score-churn`.

**Example:**

```bash
curl http://localhost:3000/api/v1/projects/1/wsjf-health \
  -H "Authorization: Bearer wft_pat_your-token"
```

### POST /api/v1/projects/:id/rescore

Deterministically rescore a project's already-scored tasks against the **current** value charter. Backs the `rescore_project` MCP tool. Opens a rescore run, writes one history row per changed task, and **skips locked components** (a locked component keeps its prior value). The component updates, history rows, and run record commit in a single transaction.

[IMPORTANT] This is a mutation. The body is `.strict()` — unknown keys are rejected (`400`). Well-formed but contradictory per-task submissions do not abort the batch; they are returned per-task in the top-level `errors[]` array (still `200`).

**Request Body:**

```json
{
  "submissions": [
    {
      "task_id": 42,
      "classification": { "theme": "checkout-reliability", "alignment": "core", "severity": "none", "decay": "flat", "jobSizeTier": 2 },
      "features": { "fanout": 3, "deadlineDays": null }
    }
  ],
  "actor_type": "user",
  "actor_id": "stuart"
}
```

`submissions` defaults to `[]`. `classification` / `features` are validated by the same `validateScoreSubmission` gate the stdio `rescore_project` tool runs (not re-implemented here). `actor_type` / `actor_id` are optional and default to the authenticated principal.

**Response:** 200 OK

```json
{
  "run_id": 7,
  "project_id": 1,
  "tasks_evaluated": 12,
  "tasks_changed": 4,
  "tasks_skipped_locked": 2,
  "results": [
    {
      "taskId": 42,
      "changed": true,
      "skippedLocked": ["value"],
      "components": { "value": 8, "timeCriticality": 5, "riskOpportunity": 3, "jobSize": 2 },
      "prevWsjfScore": 6.5,
      "newWsjfScore": 8.0
    }
  ],
  "errors": [
    { "taskId": 99, "errors": ["jobSize=1 contradicts value=13"] }
  ]
}
```

**Example:**

```bash
curl -X POST http://localhost:3000/api/v1/projects/1/rescore \
  -H "Authorization: Bearer wft_pat_your-token" \
  -H "Content-Type: application/json" \
  -d '{"submissions": []}'
```

### GET /api/v1/projects/:id/charter-history

Project value-charter version history (oldest-first). One self-contained snapshot per `interview_version`. Also surfaced via the `tasks charter-history <id>` CLI command.

**Response:** 200 OK

```json
{
  "project_id": 1,
  "total": 1,
  "history": [
    {
      "id": 1,
      "project_id": 1,
      "interview_version": 1,
      "charter": { "mission": "...", "value_themes": [], "interview_version": 1 },
      "change_kind": "overwrite",
      "actor_type": "agent",
      "actor_id": "decompose",
      "changed_at": "2026-02-14T12:00:00.000Z"
    }
  ]
}
```

`change_kind` is `overwrite` or `partial_update` (nullable). Each row is the PRIOR charter snapshot that was replaced when the interview bumped to `interview_version`.

**Example:**

```bash
curl http://localhost:3000/api/v1/projects/1/charter-history \
  -H "Authorization: Bearer wft_pat_your-token"
```

### GET /api/v1/projects/:id/rescore-runs

Chronological `wsjf_rescore_run` rows (oldest-first), read-only projection.

**Response:** 200 OK

```json
{
  "project_id": 1,
  "total": 1,
  "runs": [
    {
      "id": 7,
      "project_id": 1,
      "triggered_at": "2026-02-14T12:00:00.000Z",
      "charter_version": 2,
      "actor_type": "agent",
      "actor_id": "rescore",
      "tasks_evaluated": 12,
      "tasks_changed": 4,
      "tasks_skipped_locked": 2,
      "summary": "..."
    }
  ]
}
```

**Example:**

```bash
curl http://localhost:3000/api/v1/projects/1/rescore-runs \
  -H "Authorization: Bearer wft_pat_your-token"
```

### GET /api/v1/tasks/:id/wsjf

Read a task's four WSJF components plus per-component lock flags. Also surfaced via the CLI.

**Response:** 200 OK

```json
{
  "task_id": 42,
  "scored": true,
  "components": { "value": 8, "timeCriticality": 5, "riskOpportunity": 3, "jobSize": 2 },
  "evidence": { "value": "…", "timeCriticality": "…", "riskOpportunity": "…", "jobSize": "…" },
  "locked": { "value": true, "timeCriticality": false, "riskOpportunity": false, "jobSize": false },
  "source": { "value": "manual", "timeCriticality": "auto", "riskOpportunity": "auto", "jobSize": "auto" },
  "classifications": { "…": "the LLM enum classifications behind the components" },
  "features": { "…": "the deterministic inputs (fan-out, parsed deadline, …)" }
}
```

An unscored task returns `scored: false` and every WSJF field (`components`, `evidence`, `locked`, `source`, `classifications`, `features`) as `null`.

**Example:**

```bash
curl http://localhost:3000/api/v1/tasks/42/wsjf \
  -H "Authorization: Bearer wft_pat_your-token"
```

### PUT /api/v1/tasks/:id/wsjf

Manual-override set/lock of the four WSJF components. Runs the enum + cross-component contradiction gate and writes a `manual` score-history row. A human can pin one component (recording `source: "manual"`) while agents keep estimating the rest; a subsequent rescore never overwrites a locked component.

[IMPORTANT] All four components must be supplied and each must be a Fibonacci tier (`1, 2, 3, 5, 8, 13`). Contradictory combinations (e.g. `jobSize = 1` with `value = 13`) are rejected with `400 VALIDATION_ERROR`. The body is `.strict()` — unknown keys are rejected. The optional `locked` object (booleans per component, **not** a string array) marks which components survive a rescore. `source` is forced to `manual` server-side for the components you set.

**Request Body:**

```json
{
  "value": 8,
  "timeCriticality": 5,
  "riskOpportunity": 3,
  "jobSize": 2,
  "evidence": { "value": "pinned by product owner", "timeCriticality": "…", "riskOpportunity": "…", "jobSize": "…" },
  "locked": { "value": true, "timeCriticality": false, "riskOpportunity": false, "jobSize": false }
}
```

`evidence` and `locked` are optional (and nullable). `locked` keys are `value`, `timeCriticality`, `riskOpportunity`, `jobSize`.

**Response:** 200 OK — same shape as [`GET /api/v1/tasks/:id/wsjf`](#get-apiv1tasksidwsjf).

**Example:**

```bash
curl -X PUT http://localhost:3000/api/v1/tasks/42/wsjf \
  -H "Authorization: Bearer wft_pat_your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "value": 8,
    "timeCriticality": 5,
    "riskOpportunity": 3,
    "jobSize": 2,
    "locked": { "value": true, "timeCriticality": false, "riskOpportunity": false, "jobSize": false }
  }'
```

### GET /api/v1/tasks/:id/score-history

Append-only WSJF score-history timeline (oldest-first), each row carrying its actor, charter version, and rescore-run provenance plus the full LLM classifications and deterministic features (so any score is replayable without the model). Backs the `wsjf_history` MCP tool; also surfaced via the `tasks wsjf-history <id>` CLI command.

**Response:** 200 OK

```json
{
  "task_id": 42,
  "total": 1,
  "history": [
    {
      "id": 1,
      "task_id": 42,
      "project_id": 1,
      "changed_at": "2026-02-14T12:00:00.000Z",
      "trigger": "create",
      "actor_type": "agent",
      "actor_id": "decompose",
      "charter_version": 1,
      "rescore_run_id": null,
      "value": 8,
      "time_criticality": 5,
      "risk_opportunity": 3,
      "job_size": 2,
      "classifications": { "…": "LLM enum classifications" },
      "features": { "…": "deterministic inputs" },
      "evidence": { "value": "…", "timeCriticality": "…", "riskOpportunity": "…", "jobSize": "…" },
      "source": { "value": "auto", "timeCriticality": "auto", "riskOpportunity": "auto", "jobSize": "auto" },
      "locked": { "value": false, "timeCriticality": false, "riskOpportunity": false, "jobSize": false },
      "wsjf_score": 8.0,
      "prev_wsjf_score": null
    }
  ]
}
```

The stdio/remote `wsjf_history` MCP tool additionally annotates each row with a `deltas` map (per-component from→to); the raw REST timeline carries the snapshot columns shown above.

**Example:**

```bash
curl http://localhost:3000/api/v1/tasks/42/score-history \
  -H "Authorization: Bearer wft_pat_your-token"
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
# Claim a task (add the X-Idempotency-Key header to make retries safe)
curl -X POST http://localhost:3000/api/v1/tasks/42/claim \
  -H "Authorization: Bearer wft_pat_your-token" \
  -H "X-Idempotency-Key: claim-42-agent-1" \
  -H "Content-Type: application/json" \
  -d '{"assignee": "agent-1"}'
```

**Concurrency guarantees:**
- Uses CAS (Compare-And-Swap) with a `version` field for optimistic locking
- Uses `BEGIN IMMEDIATE` SQLite transactions to acquire write lock early
- Verified with 20 concurrent agents: exactly 1 success, 19 conflicts, 0 server errors
- Stale claims auto-released after 30 minutes of inactivity; the sweep emits
  a `task.claim_released` SSE event so the former holder can react

**Claim renewal (heartbeat):**

A claim call by the **same assignee** on a task they already hold `in_progress`
is a renewal, not a conflict: it refreshes `claimed_at` (restarting the 30-minute
TTL window) and returns 200 with the refreshed task. A different assignee still
receives 409. `GET /tasks/:id` surfaces `claim_ttl_minutes` and
`claim_remaining_seconds` (computed at read time, present only while a claim is
active) so holders know when to renew.

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
| task.claimed | Task claimed by agent (also emitted on a same-assignee claim renewal) |
| task.claim_released | Stale claim auto-released by the TTL sweep; `data` carries `previous_assignee`, `expired_claimed_at`, `released_at` |
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
curl -N -H "Authorization: Bearer wft_pat_your-token" \
  http://localhost:3000/api/v1/events

# Filter by project
curl -N -H "Authorization: Bearer wft_pat_your-token" \
  "http://localhost:3000/api/v1/events?project_id=1"

# Filter by event type
curl -N -H "Authorization: Bearer wft_pat_your-token" \
  "http://localhost:3000/api/v1/events?event_types=task.created,task.claimed"

# Resume after reconnection
curl -N -H "Authorization: Bearer wft_pat_your-token" \
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
- Authentication support (Authorization: Bearer PAT header)
- Example values for all fields
- Full Zod schema validation details

### Production gating

Swagger UI is **disabled by default in production** (`NODE_ENV=production`). The behaviour is:

| Environment | `ENABLE_SWAGGER_IN_PRODUCTION` | `/docs` and `/docs/json` |
|-------------|-------------------------------|--------------------------|
| `development` or `test` | (ignored) | Exposed, no auth required. |
| `production` | unset / `false` (default) | **Not registered** — returns 404. |
| `production` | `true` | Exposed, but a Bearer PAT is required (same canonical auth plugin as `/api/v1`). |

The in-process OpenAPI spec collector is always loaded so internal tests can introspect route schemas, but the HTTP routes that serve the UI and JSON document are only mounted when the gate above allows it.

[TIP] Use Swagger UI in development to explore the API and test endpoints without writing curl commands. In production, fetch the spec via `/docs/json` with your Bearer PAT only after opting in with `ENABLE_SWAGGER_IN_PRODUCTION=true`.
