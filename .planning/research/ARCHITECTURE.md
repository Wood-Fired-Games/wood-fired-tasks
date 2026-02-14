# Architecture Research: Multi-Agent Coordination Features

**Domain:** SSE Event Streaming, Workflow Automation, Atomic Claim Protocol
**Researched:** 2026-02-14
**Confidence:** HIGH

## Current Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      REST API (Fastify)                      │
│  /api/v1/tasks, /api/v1/projects, /api/v1/dependencies      │
│  Zod Type Provider + Schema Validation                      │
├─────────────────────────────────────────────────────────────┤
│                   Service Layer (Business Logic)             │
│  ┌──────────────┐  ┌────────────┐  ┌──────────────┐         │
│  │ TaskService  │  │ DepService │  │ CommentSvc   │         │
│  │ - updateTask │  │ - addDep   │  │ - addComment │         │
│  │ - createTask │  │ - removeDep│  │ - deleteComm │         │
│  └──────┬───────┘  └──────┬─────┘  └──────┬───────┘         │
├─────────┴──────────────────┴────────────────┴───────────────┤
│                   Repository Layer (Data Access)             │
│  ┌──────────────┐  ┌────────────┐  ┌──────────────┐         │
│  │ TaskRepo     │  │ DepRepo    │  │ CommentRepo  │         │
│  │ - create()   │  │ - findAll()│  │ - findByTask │         │
│  │ - update()   │  │ - delete() │  │ - create()   │         │
│  └──────┬───────┘  └──────┬─────┘  └──────┬───────┘         │
├─────────┴──────────────────┴────────────────┴───────────────┤
│              Database Layer (SQLite + better-sqlite3)        │
│  WAL mode | Transactions via db.transaction() | FKs enabled │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌──────────┐   │
│  │  tasks   │  │ task_deps│  │ comments  │  │ projects │   │
│  └──────────┘  └──────────┘  └───────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘

Parallel interfaces:
├─ MCP Server (stdio) → wraps same services
└─ CLI (Commander.js) → calls REST API via HTTP client
```

### Current Integration Points

| Layer | How Services Communicate |
|-------|--------------------------|
| **REST → Service** | Fastify decorators (\`fastify.taskService.updateTask()\`) |
| **Service → Repository** | Direct constructor injection |
| **Repository → Database** | better-sqlite3 prepared statements |
| **MCP → Service** | Direct service method calls (same instance as REST) |



## New Feature Integration

### 1. SSE Event Streaming

**What:** Real-time task update notifications via Server-Sent Events

**Integration Points:**

```
TaskService.updateTask()
    ↓
[NEW] EventBus.emit('task.updated', { taskId, changes })
    ↓
├─ SSEManager.broadcast() → sends to connected SSE clients
└─ [Future] WorkflowEngine listens for automation triggers
```

**New Components:**

| Component | Responsibility | Implementation |
|-----------|----------------|----------------|
| `EventBus` | Domain event pub/sub | TypeScript EventEmitter with typed events |
| `SSEManager` | Maintain client connections, broadcast events | Map<connectionId, reply.sse> + event subscriptions |
| `SSERoute` | Fastify SSE endpoint | Route with `{ sse: true }`, uses @fastify/sse plugin |

**Modified Components:**

| Component | Change Required | Reason |
|-----------|----------------|--------|
| `TaskService` | Add EventBus injection + emit calls after state changes | Enable event-driven workflows |
| `DependencyService` | Emit `dependency.added`, `dependency.removed` | Notify blocking status changes |
| `CommentService` | Emit `comment.added` | Activity feed updates |
| `createApp()` | Instantiate EventBus, inject into services | Shared event bus across all consumers |
| `createServer()` | Register SSE route + SSEManager | Enable SSE endpoint |

**Data Flow:**

```
POST /api/v1/tasks/123
    ↓
TaskService.updateTask(123, { status: 'done' })
    ↓ (within transaction)
TaskRepository.update(123, { status: 'done' })
    ↓ (after transaction commits)
EventBus.emit('task.updated', {
  taskId: 123,
  changes: { status: { from: 'in_progress', to: 'done' } },
  timestamp: '2026-02-14T12:00:00Z'
})
    ↓ (async broadcast)
SSEManager.broadcast('task.updated', event)
    ↓
[SSE clients receive event via GET /api/v1/events]
```

**Architectural Pattern: Event Sourcing Lite**

**What:** Services emit domain events after successful state changes; EventBus decouples producers from consumers.

**When to use:** Multi-agent coordination, real-time UIs, audit trails, workflow automation.

**Trade-offs:**
- **Pro:** Decouples event producers from consumers, enables multiple listeners without modifying services
- **Pro:** Events emitted AFTER transactions commit prevent phantom events on rollback
- **Con:** Adds indirection (harder to trace event flow), requires careful error handling in listeners
- **Con:** Events are in-memory only (lost on restart) unless persisted

**Example:**
```typescript
// src/services/task.service.ts
export class TaskService {
  constructor(
    private readonly taskRepo: ITaskRepository,
    private readonly projectRepo: IProjectRepository,
    private readonly eventBus: EventBus // NEW
  ) {}

  updateTask(id: number, input: unknown): Task & { tags: string[] } {
    // ... existing validation ...

    const existing = this.taskRepo.findById(id);
    const updated = this.taskRepo.update(id, result.data);

    // Emit event AFTER successful update
    this.eventBus.emit('task.updated', {
      taskId: id,
      changes: this.diffTask(existing, updated),
      timestamp: new Date().toISOString()
    });

    return updated;
  }
}
```

### 2. Workflow Automation (Post-Update Hooks)

**What:** Execute automated actions when task state changes (e.g., status transitions trigger subtask updates)

**Integration Points:**

```
EventBus.on('task.updated', event => WorkflowEngine.process(event))
    ↓
WorkflowEngine.match(event, rules)
    ↓
WorkflowEngine.execute(action) → calls back to services
    ↓
TaskService.updateTask() / DependencyService.addDependency()
    ↓
(events emitted again, but WorkflowEngine ignores its own changes)
```

**New Components:**

| Component | Responsibility | Implementation |
|-----------|----------------|----------------|
| `WorkflowEngine` | Match events to rules, execute actions | Rule registry + action executor |
| `WorkflowRule` | Define trigger conditions + actions | Interface: `trigger: EventMatcher, action: Action` |
| `ActionExecutor` | Execute workflow actions safely | Wraps service calls with error handling, cycle detection |

**Modified Components:**

| Component | Change Required | Reason |
|-----------|----------------|--------|
| `createApp()` | Instantiate WorkflowEngine, register with EventBus | Enable automation |
| `EventBus` | Add metadata to events (source: 'user' | 'workflow') | Prevent infinite loops |

**Architectural Pattern: Rules Engine**

**What:** Declarative rules define event patterns and corresponding actions; engine matches events and executes actions.

**When to use:** Workflow automation, business rule enforcement, complex conditional logic.

**Trade-offs:**
- **Pro:** Centralized rule management, easy to add/modify rules without changing service code
- **Pro:** Rules are data (can be stored in DB, loaded dynamically in future phases)
- **Con:** Debugging is harder (indirection through rule matching), performance overhead for complex rule sets
- **Con:** Infinite loop risk if rules aren't carefully designed

### 3. Atomic Claim Protocol

**What:** Multiple agents can atomically claim tasks without race conditions (compare-and-swap for assignee field)

**Integration Points:**

```
POST /api/v1/tasks/123/claim { claimant: 'agent-42' }
    ↓
TaskService.claimTask(123, 'agent-42')
    ↓
TaskRepository.claimTask(123, 'agent-42', expectedAssignee: null)
    ↓
[NEW] UPDATE tasks SET assignee = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND (assignee IS NULL OR assignee = ?) AND version = ?
    ↓
Check rows affected: 0 = already claimed, 1 = success
```

**New Components:**

| Component | Responsibility | Implementation |
|-----------|----------------|----------------|
| `TaskRepository.claimTask()` | Atomic CAS-style update | SQLite UPDATE with version check |

**Modified Components:**

| Component | Change Required | Reason |
|-----------|----------------|--------|
| `tasks` table | Add `version INTEGER NOT NULL DEFAULT 1` column | Enable optimistic locking |
| `TaskRepository.update()` | Increment version on all updates | Maintain version consistency |
| `TaskService` | Add `claimTask()` method | Business logic for claiming |
| Task routes | Add `POST /tasks/:id/claim` endpoint | REST API for claim operation |

**Architectural Pattern: Optimistic Locking with Version Field**

**What:** Add version column to table, increment on every update, WHERE clause checks version matches expected value.

**When to use:** Concurrent updates to shared resources, prevent lost updates, task claiming, inventory reservation.

**Trade-offs:**
- **Pro:** No row-level locks, better concurrency than pessimistic locking
- **Pro:** Works with SQLite (no special DB features required)
- **Con:** Clients must handle retry logic when version conflicts occur
- **Con:** Version field adds storage overhead, complicates queries slightly

## Component Dependency Graph

```
New Components:
┌─────────────┐
│  EventBus   │◄──────┐
│ (TypeScript │       │
│ EventEmitter│       │
└──────┬──────┘       │
       │              │
       ├──────────────┼────────────────┐
       │              │                │
       ▼              ▼                ▼
┌─────────────┐ ┌────────────┐ ┌─────────────┐
│ SSEManager  │ │  Workflow  │ │  Services   │
│ - broadcast │ │   Engine   │ │ (modified)  │
│ - subscribe │ │ - match    │ │ - emit()    │
│ - unsubscr. │ │ - execute  │ └─────────────┘
└──────┬──────┘ └──────┬─────┘
       │               │
       │               └────► ActionExecutor
       │                          │
       ▼                          ▼
   SSE Route              Back to Services
   (Fastify)              (circular, with source tag)
```

**Build Order (by feature):**

1. **EventBus Foundation** (prerequisite for SSE + Workflows)
   - Create EventBus (typed EventEmitter)
   - Modify services to inject EventBus
   - Emit events after state changes (task.updated, task.created, etc.)
   - Add tests for event emission

2. **SSE Event Streaming** (depends on EventBus)
   - Add @fastify/sse plugin
   - Create SSEManager (connection registry + broadcast)
   - Create SSE route (GET /api/v1/events)
   - Subscribe SSEManager to EventBus
   - Add tests for SSE delivery

3. **Atomic Claim Protocol** (independent, can be parallel with SSE)
   - Add version column migration
   - Implement TaskRepository.claimTask() with version check
   - Add TaskService.claimTask() business logic
   - Add POST /tasks/:id/claim route
   - Emit 'task.claimed' event via EventBus
   - Add tests for concurrent claims

4. **Workflow Automation** (depends on EventBus, can use SSE for debugging)
   - Create WorkflowRule interface
   - Create WorkflowEngine (rule matching + execution)
   - Create ActionExecutor (wraps service calls)
   - Register default rules
   - Subscribe WorkflowEngine to EventBus
   - Add source metadata to events (prevent loops)
   - Add tests for rule execution + loop prevention

## New Project Structure

```
src/
├── events/                     # NEW: Event-driven infrastructure
│   ├── event-bus.ts           # TypeScript EventEmitter wrapper with types
│   ├── event-types.ts         # Domain event type definitions
│   └── __tests__/
│       └── event-bus.test.ts
├── sse/                        # NEW: Server-Sent Events
│   ├── sse-manager.ts         # Connection registry + broadcast
│   ├── sse-route.ts           # Fastify SSE endpoint
│   └── __tests__/
│       └── sse-manager.test.ts
├── workflows/                  # NEW: Workflow automation
│   ├── workflow-engine.ts     # Rule matching + execution
│   ├── rules.ts               # Default workflow rules
│   ├── action-executor.ts     # Safe service call wrapper
│   └── __tests__/
│       ├── workflow-engine.test.ts
│       └── rules.test.ts
├── services/                   # MODIFIED: Add EventBus
│   ├── task.service.ts        # + emit('task.updated'), + claimTask()
│   ├── dependency.service.ts  # + emit('dependency.added')
│   └── comment.service.ts     # + emit('comment.added')
├── repositories/               # MODIFIED: Add claimTask()
│   └── task.repository.ts     # + claimTask() with version check
├── db/
│   └── migrations/
│       └── 004-add-version-column.ts  # NEW: Version for optimistic locking
├── api/
│   └── routes/
│       └── tasks/
│           └── index.ts       # + POST /:id/claim
└── index.ts                   # MODIFIED: Wire up EventBus, SSEManager, Workflows
```

## Anti-Patterns

### Anti-Pattern 1: Emitting Events Inside Transactions

**What people do:** Call `eventBus.emit()` inside db.transaction() before commit completes.

**Why it's wrong:** If transaction rolls back, event listeners have already acted on uncommitted data (phantom events).

**Do this instead:**
```typescript
// BAD
const result = db.transaction(() => {
  const updated = this.taskRepo.update(id, data);
  this.eventBus.emit('task.updated', { taskId: id }); // WRONG: inside transaction
  return updated;
})();

// GOOD
const updated = db.transaction(() => {
  return this.taskRepo.update(id, data);
})(); // transaction commits here

this.eventBus.emit('task.updated', { taskId: id }); // RIGHT: after commit
return updated;
```

### Anti-Pattern 2: Workflow Infinite Loops

**What people do:** Create workflow rules that trigger each other recursively without loop prevention.

**Why it's wrong:** Rule A updates task → emits event → Rule B updates task → emits event → Rule A triggers again → stack overflow.

**Do this instead:** Add `source` metadata to events and ignore `source: 'workflow'` in rule matching:

```typescript
// BAD
workflow.on('task.updated', event => {
  taskService.updateTask(event.taskId, { priority: 'high' });
  // Emits 'task.updated' again → infinite loop
});

// GOOD
workflow.on('task.updated', event => {
  if (event.source === 'workflow') return; // Skip workflow-triggered events
  taskService.updateTask(event.taskId, { priority: 'high' }, { source: 'workflow' });
});
```

### Anti-Pattern 3: Claiming Without Version Check

**What people do:** Implement claim as simple `UPDATE tasks SET assignee = ? WHERE id = ? AND assignee IS NULL`.

**Why it's wrong:** Race condition between SELECT check and UPDATE — two agents can both see assignee=null, both UPDATE, last write wins (first agent's claim is overwritten).

**Do this instead:** Use version-based CAS (compare-and-swap) pattern in single UPDATE statement.

## Sources

### SSE Event Streaming
- [GitHub - fastify/sse: Server-Sent Events for Fastify](https://github.com/fastify/sse)
- [@fastify/sse npm package](https://www.npmjs.com/package/@fastify/sse)

### Workflow Automation & Event-Driven Architecture
- [Event-Based Architectures in JavaScript: A Handbook for Devs](https://www.freecodecamp.org/news/event-based-architectures-in-javascript-a-handbook-for-devs/)
- [Event-Driven Architecture (EDA) with Node.js: A Modern Approach and Challenges](https://medium.com/@erickzanetti/event-driven-architecture-eda-with-node-js-a-modern-approach-and-challenges-82e7d9932b34)
- [Experimental Design of a Workflow Engine in Node.js](https://betterprogramming.pub/experiment-design-of-workflow-engine-in-nodejs-72da8bb68734)

### Atomic Operations & Optimistic Locking
- [SQLite Is Transactional](https://www.sqlite.org/transactional.html)
- [SQLite Atomic Commit](https://sqlite.org/atomiccommit.html)
- [Working with SQLite | better-sqlite3](https://deepwiki.com/WiseLibs/better-sqlite3/3-working-with-sqlite)
- [Optimistic Locking: Concurrency Control with a Version Column](https://medium.com/@sumit-s/optimistic-locking-concurrency-control-with-a-version-column-2e3db2a8120d)
- [A Guide to Optimistic Locking: Enhancing Database Performance and Scalability](https://systemdesignschool.io/blog/optimistic-locking)

### TypeScript EventEmitter Patterns
- [Make Node.js EventEmitter Type-Safe](https://typescript.tv/hands-on/make-nodejs-eventemitter-type-safe/)
- [Build a type-safe event emitter in Node.js using TypeScript](https://blog.makerx.com.au/a-type-safe-event-emitter-in-node-js/)
- [Mastering EventEmitter in TypeScript](https://www.xjavascript.com/blog/eventemitter-typescript/)

### Fastify Lifecycle & Hooks
- [Hooks | Fastify](https://fastify.dev/docs/latest/Reference/Hooks/)
- [Advanced Fastify: Hooks, Middleware, and Decorators](https://blog.appsignal.com/2023/05/24/advanced-fastify-hooks-middleware-and-decorators.html)

---
*Architecture research for: Multi-Agent Coordination Features*
*Researched: 2026-02-14*
*Confidence: HIGH — All patterns verified with official documentation and production-ready implementations*
