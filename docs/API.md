# REST API Reference

Complete reference for the Wood Fired Bugs REST API.

**Base URL:** `http://localhost:3000`

**API Version:** v1 (all endpoints under `/api/v1`)

## Authentication

All endpoints under `/api/v1` require authentication via the `X-API-Key` header.

The `/health` endpoint is public and does not require authentication.

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

[NOTE] API keys are configured via the `API_KEYS` environment variable on the server (comma-separated list).

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

## Health Endpoint

### GET /health

Check service health and database connectivity.

**Authentication:** None (public endpoint)

**Response:** 200 OK

```json
{
  "status": "healthy",
  "timestamp": "2026-02-14T12:00:00.000Z",
  "version": "1.0.0",
  "checks": {
    "database": "ok"
  }
}
```

**Example:**

```bash
curl http://localhost:3000/health
```

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
| search | string | Search in title and description (max 200 chars) |

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

## Interactive Documentation

Swagger UI is available at:

```
http://localhost:3000/documentation
```

The Swagger UI provides:

- Interactive "Try it out" functionality for all endpoints
- Complete request/response schemas
- Authentication support (X-API-Key header)
- Example values for all fields
- Full Zod schema validation details

[TIP] Use Swagger UI to explore the API and test endpoints without writing curl commands.
