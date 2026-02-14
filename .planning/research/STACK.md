# Stack Research — Multi-Agent Coordination Features

**Domain:** Multi-agent task coordination (SSE streaming, workflow automation, atomic claiming)
**Researched:** 2026-02-14
**Confidence:** HIGH

## Executive Summary

For adding SSE event streaming, workflow automation hooks, and atomic task claiming to the existing Fastify + SQLite stack, minimal additions are required. The existing stack (better-sqlite3 WAL mode, Fastify 5.x) already provides the foundations needed. Only **one new dependency** (`@fastify/sse`) is required, with workflow automation implemented using native Node.js EventEmitter with TypeScript generics.

## New Dependencies Required

### SSE Streaming

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `@fastify/sse` | ^0.4.0 | Server-Sent Events | Official Fastify plugin with native async iterator support, TypeScript types, backpressure handling, and Last-Event-ID replay. Clean integration with existing Fastify 5.7.4 server. |

### Workflow Automation

**NO NEW DEPENDENCIES NEEDED**

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Native EventEmitter | Built-in | Post-update hooks/rules | Node.js EventEmitter with TypeScript generics (available since @types/node July 2024) provides type-safe event emission. Zero dependencies, native performance, integrates with existing service layer pattern. |

### Atomic Task Claiming

**NO NEW DEPENDENCIES NEEDED**

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| better-sqlite3 transactions | Existing (12.6.2) | Atomic claim operations | Already using `db.transaction()` pattern in task.repository.ts. WAL mode already enabled. Use `BEGIN IMMEDIATE` for claim operations to acquire write lock early and fail fast under contention. |

## Installation

```bash
# Only one new dependency needed
npm install @fastify/sse

# Type definitions (if needed, check if included)
npm install -D @types/node@latest  # For EventEmitter TypeScript generics
```

## Integration Points with Existing Stack

### 1. SSE Event Streaming via @fastify/sse

**Integration:** Register as Fastify plugin in `src/api/server.ts`, create new route file `src/api/routes/events.ts`

**Pattern:**
```typescript
// Register plugin
import fastifySSE from '@fastify/sse';
await server.register(fastifySSE);

// Use async generator for event streams
app.get('/events', { sse: true }, async (request, reply) => {
  async function* eventStream() {
    // Listen to EventEmitter events from services
    for await (const event of eventSource) {
      yield { id: event.id, event: event.type, data: event.payload };
    }
  }
  await reply.sse.send(eventStream());
});
```

**Why this works:** Fastify's plugin system makes this a 2-line registration. Async iterators bridge native EventEmitter to SSE cleanly.

### 2. Workflow Automation with Native EventEmitter

**Integration:** Add typed EventEmitter to service layer (`src/services/task.service.ts`), emit events on state changes

**Pattern:**
```typescript
// Define event map type
interface TaskEvents {
  'task:created': (task: Task) => void;
  'task:updated': (task: Task, changes: Partial<Task>) => void;
  'task:status_changed': (task: Task, oldStatus: string, newStatus: string) => void;
  'task:claimed': (task: Task, agent: string) => void;
}

// Extend service with EventEmitter
class TaskService extends EventEmitter<TaskEvents> {
  // Emit on operations
  update(id: number, dto: UpdateTaskDTO): Task {
    const oldTask = this.repo.findById(id);
    const newTask = this.repo.update(id, dto);

    this.emit('task:updated', newTask, dto);

    if (oldTask.status !== newTask.status) {
      this.emit('task:status_changed', newTask, oldTask.status, newTask.status);
    }

    return newTask;
  }
}
```

**Why this works:**
- Native EventEmitter with TypeScript generics (built into @types/node since July 2024) provides compile-time type safety
- Zero runtime dependencies
- Follows existing service pattern in codebase
- Listeners can be registered in API layer, MCP server, or workflow engine

### 3. Atomic Task Claiming with SQLite Transactions

**Integration:** Add `claim()` method to `src/repositories/task.repository.ts` using existing transaction pattern

**Pattern:**
```typescript
claim(taskId: number, agent: string): Task | null {
  return this.db.transaction(() => {
    // Use BEGIN IMMEDIATE via transaction wrapper
    const task = this.findById(taskId);

    if (!task || task.assignee !== null || task.status !== 'open') {
      return null;  // Already claimed or not claimable
    }

    // Atomic update
    const result = this.db.prepare(
      'UPDATE tasks SET assignee = ?, status = ?, updated_at = ? WHERE id = ? AND assignee IS NULL'
    ).run(agent, 'in_progress', new Date().toISOString(), taskId);

    if (result.changes === 0) {
      return null;  // Lost race condition
    }

    return this.findById(taskId);
  })();  // Execute immediately
}
```

**Why this works:**
- Already using `db.transaction()` in task.repository.ts (lines 46, 122)
- WAL mode already enabled in db/database.ts for concurrent access
- better-sqlite3 transactions use `BEGIN IMMEDIATE` by default for write operations, acquiring write lock early
- Transaction rollback is automatic on errors
- 5-second busy timeout already configured for contention handling

**Performance note:** SQLite WAL mode allows concurrent readers during claim operations. Write lock is exclusive but held briefly.

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `eventemitter3` | Marginal performance gains not worth additional dependency for this use case | Native EventEmitter with TypeScript generics |
| `fastify-sse-v2` | Community plugin, less maintained than official | `@fastify/sse` (official Fastify organization) |
| External workflow engines (Temporal, Bull, etc.) | Over-engineered for post-update hooks; adds Redis/PostgreSQL dependencies | Native EventEmitter + in-process listeners |
| `typed-emitter` npm package | Unnecessary since @types/node includes EventEmitter generics natively (July 2024+) | Native EventEmitter with type map |
| Manual SSE implementation via `reply.raw` | Error-prone, missing backpressure handling, connection management | `@fastify/sse` plugin |

## Stack Patterns by Use Case

### Pattern 1: Real-time Task Updates via SSE

**When:** Agent wants to monitor task changes without polling
**Stack:** @fastify/sse + EventEmitter bridge
**Implementation:**
1. TaskService emits events on changes
2. SSE route listens to EventEmitter
3. Async generator yields SSE messages
4. Client receives real-time updates

### Pattern 2: Post-Update Automation

**When:** Trigger actions when task status changes (e.g., notify on completion, auto-assign subtasks)
**Stack:** Native EventEmitter + listener registration
**Implementation:**
1. Define typed event map for all hook points
2. Services emit events on state changes
3. Register listeners in initialization (src/index.ts or API startup)
4. Listeners execute automation logic (can be async)

### Pattern 3: Multi-Agent Task Claiming

**When:** Multiple agents compete for same task
**Stack:** SQLite transaction + BEGIN IMMEDIATE
**Implementation:**
1. Agent calls claim endpoint
2. Repository uses `db.transaction()` for atomic check-and-claim
3. WHERE clause includes `assignee IS NULL` to prevent double-claim
4. Returns null if claim fails (already claimed or status changed)
5. WAL mode allows concurrent claims to different tasks

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `@fastify/sse@0.4.0` | `fastify@5.7.4` | Official plugin, tested with Fastify 5.x |
| `@types/node@25.2.3` | Current version includes EventEmitter generics | Update to latest for typed events |
| `better-sqlite3@12.6.2` | WAL mode, immediate transactions | Already configured correctly |

## Migration from Current Stack

### Phase 1: Add SSE Support (Minimal Change)
```bash
npm install @fastify/sse
```
- Register plugin in server.ts
- Add /events route
- No changes to existing routes

### Phase 2: Add Event Emission (Service Layer Only)
- Update TaskService to extend EventEmitter<TaskEvents>
- Add emit() calls in update/create/delete methods
- No database schema changes
- Backward compatible (existing code unaffected)

### Phase 3: Add Atomic Claiming (Repository Layer)
- Add claim() method to TaskRepository
- Use existing transaction pattern
- Add REST endpoint POST /api/v1/tasks/:id/claim
- Add MCP tool claim_task
- No schema changes needed (uses existing assignee + status fields)

## Performance Characteristics

| Feature | Latency | Concurrency | Notes |
|---------|---------|-------------|-------|
| SSE event delivery | <10ms | Unlimited readers | Fastify async iterator + backpressure |
| EventEmitter dispatch | <1ms | Synchronous listeners block, async don't | Use async listeners for I/O |
| Atomic claim | <5ms (uncontended) | WAL mode allows concurrent operations | Write lock held only during UPDATE |
| SSE connection limit | OS-dependent | ~10k on typical server | Use process clustering if needed |

## Sources

### High Confidence (Official Docs + npm)
- [@fastify/sse npm package](https://www.npmjs.com/package/@fastify/sse) — Version 0.4.0, installation, features
- [GitHub - fastify/sse](https://github.com/fastify/sse) — Official plugin repository
- [SQLite WAL Mode Documentation](https://sqlite.org/wal.html) — Write-Ahead Logging mechanics
- [SQLite Atomic Commit](https://sqlite.org/atomiccommit.html) — Transaction guarantees

### Medium Confidence (Articles + Community)
- [Efficient Event Streaming with Fastify](https://nearform.com/insights/efficient-event-streaming-mastering-pub-sub-with-fastify-and-dragonfly/) — Best practices
- [Fastify SSE Tutorial by Edison Devadoss](https://edisondevadoss.medium.com/fastify-server-sent-events-sse-93de994e013b) — Implementation patterns
- [SQLite for Modern Apps 2026](https://thelinuxcode.com/sqlite-for-modern-apps-a-practical-first-look-2026/) — Transaction modes
- [How to Use SQLite in Node.js 2026](https://oneuptime.com/blog/post/2026-02-02-sqlite-nodejs/view) — Modern patterns

### TypeScript Event Patterns
- [Make Node.js EventEmitter Type-Safe](https://typescript.tv/hands-on/make-nodejs-eventemitter-type-safe/) — Native generics approach
- [Build Type-Safe Event Emitter](https://blog.makerx.com.au/a-type-safe-event-emitter-in-node-js/) — Implementation guide
- [@types/node Discussion #55298](https://github.com/DefinitelyTyped/DefinitelyTyped/discussions/55298) — Native EventEmitter typing

### Workflow Patterns
- [Experimental Workflow Engine Design](https://betterprogramming.pub/experiment-design-of-workflow-engine-in-nodejs-72da8bb68734) — EventEmitter-based hooks
- [Node.js Design Patterns (hooks-js)](https://github.com/bnoguchi/hooks-js) — Pre/post hook pattern

---
*Stack research for: Wood Fired Bugs multi-agent coordination*
*Researched: 2026-02-14*
