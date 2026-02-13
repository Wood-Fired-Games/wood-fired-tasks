# Architecture Patterns

**Domain:** LLM-Accessible Task Tracking Service
**Researched:** 2026-02-13

## Recommended Architecture

### High-Level System Design

```
┌─────────────────────────────────────────────────────────────────┐
│                    Consumers (LLM Agents + Human)                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Claude Code  │  │ Other Agents │  │ Stuart (CLI User)    │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
└─────────┼──────────────────┼─────────────────────┼──────────────┘
          │                  │                     │
          │ MCP Protocol     │ HTTP REST           │ HTTP REST
          │ (stdio/SSE)      │ (JSON)              │ (via CLI)
          │                  │                     │
┌─────────▼──────────────────▼─────────────────────▼──────────────┐
│                  Wood Fired Bugs Service                         │
│  ┌──────────────────────┐      ┌──────────────────────────┐    │
│  │   MCP Server         │      │   REST API Server        │    │
│  │   (Tools)            │      │   (Endpoints)            │    │
│  ├──────────────────────┤      ├──────────────────────────┤    │
│  │ - create_task        │      │ POST   /tasks            │    │
│  │ - get_task           │      │ GET    /tasks/{id}       │    │
│  │ - list_tasks         │      │ GET    /tasks            │    │
│  │ - update_task        │      │ PUT    /tasks/{id}       │    │
│  │ - add_comment        │      │ POST   /tasks/{id}/cmnts │    │
│  │ - search_tasks       │      │ GET    /tasks/search     │    │
│  └──────────┬───────────┘      │ DELETE /tasks/{id}       │    │
│             │                  │ GET    /projects         │    │
│             │                  │ POST   /tags             │    │
│             │                  │ GET    /healthz          │    │
│             │                  └──────────┬───────────────┘    │
│             │                             │                     │
│             └─────────┬───────────────────┘                     │
│                       │                                         │
│              ┌────────▼─────────────────┐                       │
│              │   Auth Middleware        │                       │
│              │   (API Key Validation)   │                       │
│              └────────┬─────────────────┘                       │
│                       │                                         │
│              ┌────────▼─────────────────┐                       │
│              │  Business Logic Layer    │                       │
│              │  - TaskService           │                       │
│              │  - ProjectService        │                       │
│              │  - CommentService        │                       │
│              │  - SearchService         │                       │
│              └────────┬─────────────────┘                       │
│                       │                                         │
│              ┌────────▼─────────────────┐                       │
│              │  Data Access Layer (DAL) │                       │
│              │  - TaskRepository        │                       │
│              │  - ProjectRepository     │                       │
│              │  - CommentRepository     │                       │
│              │  - TagRepository         │                       │
│              └────────┬─────────────────┘                       │
│                       │                                         │
└───────────────────────┼─────────────────────────────────────────┘
                        │
                ┌───────▼────────┐
                │ SQLite Database│
                │   (tasks.db)   │
                └────────────────┘
```

### Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| **MCP Server** | Expose task operations as MCP tools for Claude Code agents. Handle stdio/SSE transport, schema validation via Zod | Business Logic Layer (TaskService, CommentService) |
| **REST API Server** | HTTP endpoints for task CRUD, projects, tags, search. OpenAPI spec generation. Request validation | Auth Middleware → Business Logic Layer |
| **CLI** | Human-friendly command-line interface for task management. Makes HTTP requests internally | REST API Server (as HTTP client) |
| **Auth Middleware** | Validate API keys from headers. Reject unauthorized requests before they reach business logic | REST API Server, reads from environment/config |
| **Business Logic Layer (Services)** | Core domain operations: create tasks, validate relationships, enforce business rules (e.g., no circular dependencies), orchestrate multi-step operations | Data Access Layer (Repositories) |
| **Data Access Layer (Repositories)** | SQLite queries, transactions, schema mapping. Abstracts database details from business logic | SQLite database via ORM/query builder |
| **SQLite Database** | Persistent storage. Single-file database. ACID guarantees. Handles concurrency via WAL mode | Data Access Layer |

### Data Flow

**Creating a Task (via MCP):**
```
1. Claude Code calls create_task MCP tool with parameters
2. MCP Server validates parameters against Zod schema
3. MCP Server calls TaskService.create(data)
4. TaskService validates business rules (project exists, valid status)
5. TaskService calls TaskRepository.insert(task)
6. TaskRepository executes SQL INSERT into tasks table
7. SQLite commits transaction, returns inserted row ID
8. TaskRepository returns Task entity to TaskService
9. TaskService returns Task to MCP Server
10. MCP Server returns tool result to Claude Code
```

**Querying Tasks (via REST):**
```
1. HTTP client sends GET /tasks?status=open&project=wood-fired-platform
2. REST API Server extracts query params, validates
3. Auth Middleware validates API key from X-API-Key header
4. REST endpoint calls TaskService.list(filters)
5. TaskService calls TaskRepository.findByFilters(filters)
6. TaskRepository builds SQL query with WHERE clauses
7. SQLite executes SELECT with filters
8. TaskRepository maps rows to Task entities
9. TaskService returns Task[] to REST endpoint
10. REST endpoint serializes to JSON with Pydantic/Zod schema
11. HTTP response sent to client with tasks array
```

## Patterns to Follow

### Pattern 1: Repository Pattern for Data Access
**What:** Separate data access logic from business logic. Repositories handle SQL queries, business services orchestrate operations.

**When:** Always. Keeps business logic testable and database-agnostic.

**Example:**
```typescript
// Data Access Layer
class TaskRepository {
  async findById(id: number): Promise<Task | null> {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? this.mapRowToTask(row) : null;
  }

  async insert(task: Omit<Task, 'id'>): Promise<Task> {
    const result = db.prepare(
      'INSERT INTO tasks (title, description, status, project_id) VALUES (?, ?, ?, ?)'
    ).run(task.title, task.description, task.status, task.project_id);
    return this.findById(result.lastInsertRowid)!;
  }
}

// Business Logic Layer
class TaskService {
  constructor(private taskRepo: TaskRepository, private projectRepo: ProjectRepository) {}

  async createTask(data: CreateTaskDTO): Promise<Task> {
    // Business rule: project must exist
    const project = await this.projectRepo.findById(data.project_id);
    if (!project) throw new Error('Project not found');

    // Business rule: validate status
    if (!['open', 'in_progress', 'done', 'blocked'].includes(data.status)) {
      throw new Error('Invalid status');
    }

    return this.taskRepo.insert(data);
  }
}
```

### Pattern 2: Schema-Driven Validation
**What:** Define request/response schemas using Zod (TypeScript) or Pydantic (Python). Use schemas for validation AND type generation.

**When:** All API inputs and MCP tool parameters. Ensures LLMs receive predictable, well-documented structures.

**Example:**
```typescript
import { z } from 'zod';

// Schema definition
const CreateTaskSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  status: z.enum(['open', 'in_progress', 'done', 'blocked']),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  project_id: z.number().int().positive(),
  assignee: z.string().optional(),
  due_date: z.string().datetime().optional(),
  tags: z.array(z.string()).optional()
});

// Type inference from schema
type CreateTaskDTO = z.infer<typeof CreateTaskSchema>;

// MCP tool definition
const createTaskTool = {
  name: 'create_task',
  description: 'Create a new task in the tracking system',
  inputSchema: zodToJsonSchema(CreateTaskSchema), // Convert Zod to JSON Schema for MCP
  handler: async (params: CreateTaskDTO) => {
    const validated = CreateTaskSchema.parse(params); // Validates and throws if invalid
    return taskService.createTask(validated);
  }
};

// REST endpoint validation
app.post('/tasks', async (req, reply) => {
  const data = CreateTaskSchema.parse(req.body); // Automatic validation
  const task = await taskService.createTask(data);
  return reply.code(201).send(task);
});
```

### Pattern 3: Optimistic Locking for Concurrent Updates
**What:** Use version column to detect conflicting updates. Prevent lost updates when multiple agents modify same task.

**When:** Update operations on tasks. Critical for multi-agent environments.

**Example:**
```typescript
// Schema includes version column
interface Task {
  id: number;
  title: string;
  // ... other fields
  version: number; // Incremented on every update
  updated_at: Date;
}

// Update with optimistic locking
class TaskRepository {
  async update(id: number, changes: Partial<Task>, expectedVersion: number): Promise<Task> {
    const result = db.prepare(
      `UPDATE tasks
       SET title = ?, description = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND version = ?`
    ).run(changes.title, changes.description, id, expectedVersion);

    if (result.changes === 0) {
      // Either task doesn't exist or version mismatch
      const current = await this.findById(id);
      if (!current) throw new Error('Task not found');
      throw new Error('Conflict: task was modified by another process');
    }

    return this.findById(id)!;
  }
}
```

### Pattern 4: Structured Error Responses for LLMs
**What:** Return error responses with machine-readable codes and helpful messages. LLMs need clear error context to retry or adapt.

**When:** All error conditions in API and MCP tools.

**Example:**
```typescript
// Standard error structure
interface APIError {
  error: {
    code: string;           // Machine-readable error code
    message: string;        // Human-readable description
    details?: unknown;      // Additional context
    field?: string;         // For validation errors
  };
}

// REST API error handler
app.setErrorHandler((error, request, reply) => {
  if (error instanceof z.ZodError) {
    reply.code(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      }
    });
  } else if (error.message.includes('not found')) {
    reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: error.message
      }
    });
  } else {
    reply.code(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred'
      }
    });
  }
});

// MCP tool error handling
const getTaskTool = {
  name: 'get_task',
  handler: async (params: { id: number }) => {
    const task = await taskService.getById(params.id);
    if (!task) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: {
              code: 'NOT_FOUND',
              message: `Task ${params.id} not found`
            }
          })
        }],
        isError: true
      };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(task)
      }]
    };
  }
};
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Exposing Database Entities Directly
**What:** Returning raw database rows in API responses without mapping to DTOs.

**Why bad:** Leaks implementation details, breaks API contracts when schema changes, exposes internal fields not meant for consumption.

**Instead:** Use Data Transfer Objects (DTOs) with explicit field mapping.

```typescript
// BAD: Direct database exposure
app.get('/tasks/:id', async (req, reply) => {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  return row; // Exposes internal_notes, created_by_user_id, etc.
});

// GOOD: DTO mapping
interface TaskDTO {
  id: number;
  title: string;
  description: string;
  status: string;
  priority: string;
  created_at: string;
  // Only fields intended for API consumers
}

app.get('/tasks/:id', async (req, reply) => {
  const task = await taskService.getById(req.params.id);
  const dto: TaskDTO = {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    created_at: task.created_at.toISOString()
  };
  return dto;
});
```

### Anti-Pattern 2: N+1 Query Problem
**What:** Loading related entities one-by-one in a loop instead of batching.

**Why bad:** 100 tasks with comments = 1 query for tasks + 100 queries for comments = terrible performance.

**Instead:** Use JOINs or batch loading.

```typescript
// BAD: N+1 queries
async function getTasksWithComments() {
  const tasks = await db.prepare('SELECT * FROM tasks').all();
  for (const task of tasks) {
    task.comments = await db.prepare('SELECT * FROM comments WHERE task_id = ?').all(task.id);
  }
  return tasks;
}

// GOOD: Single query with JOIN
async function getTasksWithComments() {
  const rows = await db.prepare(`
    SELECT
      t.*,
      json_group_array(
        json_object('id', c.id, 'text', c.text, 'author', c.author)
      ) as comments
    FROM tasks t
    LEFT JOIN comments c ON c.task_id = t.id
    GROUP BY t.id
  `).all();

  return rows.map(row => ({
    ...row,
    comments: JSON.parse(row.comments)
  }));
}
```

### Anti-Pattern 3: Storing JSON Blobs for Structured Data
**What:** Using JSON columns for data that should be relational (tags, comments, dependencies).

**Why bad:** Can't query efficiently, can't enforce constraints, harder to maintain consistency.

**Instead:** Use proper relational tables with foreign keys.

```typescript
// BAD: JSON blob for tags
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  title TEXT,
  tags TEXT -- JSON array like '["bug", "frontend"]'
);

// Can't efficiently query "all tasks with tag 'bug'"
// Can't prevent duplicate tags
// Can't enforce tag naming conventions

// GOOD: Relational many-to-many
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  title TEXT
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE
);

CREATE TABLE task_tags (
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);

-- Efficient query: all tasks with tag 'bug'
SELECT t.* FROM tasks t
JOIN task_tags tt ON tt.task_id = t.id
JOIN tags tag ON tag.id = tt.tag_id
WHERE tag.name = 'bug';
```

### Anti-Pattern 4: Ignoring Database Transactions
**What:** Multi-step operations without transactions, risking partial updates.

**Why bad:** If step 2 fails, step 1 already committed. Leaves inconsistent state.

**Instead:** Wrap multi-step operations in transactions.

```typescript
// BAD: No transaction
async function createTaskWithComments(taskData, comments) {
  const task = await taskRepo.insert(taskData); // Commits
  for (const comment of comments) {
    await commentRepo.insert({ task_id: task.id, ...comment }); // Could fail halfway
  }
}

// GOOD: Transactional
async function createTaskWithComments(taskData, comments) {
  return db.transaction(() => {
    const task = taskRepo.insert(taskData);
    for (const comment of comments) {
      commentRepo.insert({ task_id: task.id, ...comment });
    }
    return task;
  })(); // Commits only if all succeed, rolls back on any error
}
```

## Scalability Considerations

| Concern | At 100 tasks | At 10K tasks | At 100K tasks |
|---------|--------------|--------------|---------------|
| **Database Size** | <1MB, no optimization needed | 10-50MB, ensure indexes on status, project_id, assignee | 100MB-1GB, vacuum regularly, consider archiving closed tasks |
| **Query Performance** | All queries <5ms | Add composite indexes for common filter combinations | Consider full-text search index (FTS5) for description search |
| **Concurrent Writes** | SQLite WAL mode handles this easily | No changes needed, WAL supports multiple readers + 1 writer | If write-heavy, batch updates or consider queuing writes |
| **Backup Strategy** | Manual file copy sufficient | Automated daily backups using SQLite backup API | Incremental backups, retention policy, test restore process |
| **API Response Times** | No pagination needed | Paginate list endpoints (50-100 per page) | Implement cursor-based pagination for stable results |
| **MCP Tool Performance** | All tools <100ms | Optimize commonly used tools (list_tasks), cache project/tag lookups | Consider read replicas if MCP tools dominate usage |

### SQLite Optimization for Scale

```sql
-- Enable WAL mode for better concurrency
PRAGMA journal_mode = WAL;

-- Increase cache size (64MB)
PRAGMA cache_size = -64000;

-- Synchronous mode for balance
PRAGMA synchronous = NORMAL;

-- Critical indexes
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_assignee ON tasks(assignee);
CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC);
CREATE INDEX idx_comments_task_id ON comments(task_id);

-- Composite indexes for common queries
CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX idx_tasks_assignee_status ON tasks(assignee, status) WHERE assignee IS NOT NULL;

-- Full-text search for descriptions (if needed at scale)
CREATE VIRTUAL TABLE tasks_fts USING fts5(title, description, content=tasks, content_rowid=id);
```

## Sources

### Architecture Patterns
- [Designing a RESTful API to interact with SQLite database](https://www.geeksforgeeks.org/python/designing-a-restful-api-to-interact-with-sqlite-database/)
- [GitHub - sqlite-rest](https://github.com/b4fun/sqlite-rest)
- [SQLite for Modern Apps: A Practical First Look (2026)](https://thelinuxcode.com/sqlite-for-modern-apps-a-practical-first-look-2026/)

### API Design for LLMs
- [Designing APIs for LLM Apps](https://www.gravitee.io/blog/designing-apis-for-llm-apps)
- [RestGPT: Connecting LLMs with RESTful APIs](https://restgpt.github.io/)

### MCP Protocol
- [Model Context Protocol Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [How MCP Servers Enable Cross-Platform AI Integration 2026](https://goldeneagle.ai/blog/artificial-intelligence/mcp-servers-cross-platform-ai-2026/)

### SQLite Architecture
- [Architecture of SQLite](https://sqlite.org/arch.html)

---
*Architecture patterns for: Wood Fired Bugs*
*Researched: 2026-02-13*
