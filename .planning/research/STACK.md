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

---

# Stack Research — Hardening & Polish Milestone

**Domain:** Node.js/TypeScript REST API with SQLite (Hardening Phase)
**Researched:** 2026-02-17
**Confidence:** HIGH

## Executive Summary

For a hardening/polish milestone on the existing Node.js/TypeScript/Fastify/SQLite service, this research recommends focused additions in five areas: error handling standardization, performance profiling, testing depth (mutation + property-based), local metrics collection, and logging enhancement. All recommendations prioritize lightweight, local-appropriate tools over heavy APM services.

The existing stack (Fastify v5, better-sqlite3, Vitest) is solid and requires only targeted additions, not replacements.

---

## Recommended Stack Additions

### 1. Error Handling Improvements

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `@fastify/sensible` | ^6.0.4 | HTTP error constructors + utilities | Provides standard HTTP error responses, reply decorators (`reply.notFound()`), and async/await wrapper (`fastify.to()`) |
| `@fastify/error` | ^4.2.0 | Custom error factory | Used internally by Fastify; create custom error constructors with codes, message interpolation, and cause chaining |

**Rationale:** `@fastify/sensible` gives you battle-tested HTTP error handling with minimal configuration. `@fastify/error` is essential for creating domain-specific errors that integrate cleanly with Fastify's error handling lifecycle. Both are official Fastify packages with 4.9M+ weekly downloads combined.

**Integration with existing Fastify:**

```typescript
import sensible from '@fastify/sensible';
import { fastify } from 'fastify';

const app = fastify();
await app.register(sensible);

// Now available:
// - reply.notFound(), reply.badRequest(), etc.
// - fastify.httpErrors.createError()
// - fastify.to(promise) for async/await error handling
```

---

### 2. Performance Profiling Tools

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `0x` | ^6.0.0 | Quick flamegraph generation | Single-command CPU profiling (`0x server.js`); 76K+ weekly downloads; minimal overhead |
| `clinic` | ^13.0.0 | Comprehensive profiling suite | NearForm's suite: Doctor (health check), Flame (CPU), Bubbleprof (async), HeapProfiler (memory) |

**Rationale:** `0x` is the fastest path to actionable CPU insights. `clinic` provides depth when you need holistic analysis. Both use native V8 profiling, avoiding instrumentation overhead.

**When to use each:**
- **0x**: Quick CPU hotspot identification, CI performance regression checks
- **Clinic Doctor**: Event loop lag, memory leaks, general health check
- **Clinic Flame**: Deep CPU analysis when 0x shows a hotspot
- **Clinic HeapProfiler**: Memory leak investigation

**Example integration:**

```json
// package.json scripts
{
  "profile:cpu": "0x -- node dist/api/start.js",
  "profile:health": "clinic doctor -- node dist/api/start.js",
  "profile:heap": "clinic heapprofiler -- node dist/api/start.js"
}
```

---

### 3. Testing Improvements

#### Mutation Testing

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `@stryker-mutator/core` | ^9.5.1 | Mutation testing | Verifies test quality by mutating code; Vitest v4 support added in v9.4.0; fixtures support in v9.5.1 |
| `@stryker-mutator/vitest-runner` | ^9.5.1 | Vitest integration | Official runner; incremental mode for faster iterations |

**Rationale:** With 518 existing tests, mutation testing validates that tests actually catch bugs, not just exercise code. Stryker v9.x has full Vitest v4 compatibility and incremental analysis for reasonable CI times.

**Configuration:**

```json
// stryker.config.json
{
  "testRunner": "vitest",
  "reporters": ["html", "clear-text", "progress"],
  "concurrency": 4,
  "incremental": true,
  "mutate": ["src/**/*.ts", "!src/**/*.test.ts", "!src/**/*.spec.ts"],
  "coverageAnalysis": "perTest"
}
```

#### Property-Based Testing

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `fast-check` | ^4.5.3 | Property-based testing | Generates hundreds of test cases automatically; finds edge cases; auto-shrinks failures; 8.4M weekly downloads |

**Rationale:** Complements example-based tests by proving invariants hold across generated inputs. Excellent for testing parsers, validators, and business logic with complex input spaces.

**Example:**

```typescript
import fc from 'fast-check';
import { test, expect } from 'vitest';

test('task status transitions are valid', () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.constant('open'), fc.constant('in_progress'), fc.constant('done')),
      fc.oneof(fc.constant('open'), fc.constant('in_progress'), fc.constant('done')),
      (from, to) => {
        // Property: cannot transition from done to open
        if (from === 'done') {
          expect(() => transitionStatus(from, to)).toThrow();
        }
      }
    )
  );
});
```

#### Coverage Tooling

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `@vitest/coverage-v8` | ^4.0.18 | Native V8 coverage | Vitest's recommended coverage provider; uses V8's built-in coverage (c8 deprecated) |

**Rationale:** Vitest has deprecated `@vitest/coverage-c8` in favor of `@vitest/coverage-v8`. Use the v8 provider for accurate, low-overhead coverage with your existing Vitest setup.

---

### 4. Monitoring & Metrics (Local/LAN-Appropriate)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `prom-client` | ^15.1.3 | Prometheus metrics | 4.5M weekly downloads; exposes Node.js internals + custom metrics on `/metrics` endpoint; zero external dependencies |

**Rationale:** For a local LAN service, skip heavy APM (DataDog, NewRelic). `prom-client` exposes metrics in Prometheus format that can be scraped by local Grafana or Prometheus instances. It collects default Node.js metrics (memory, CPU, event loop, GC) automatically.

**Integration with Fastify:**

```typescript
import promClient from 'prom-client';

// Collect default Node.js metrics
promClient.collectDefaultMetrics();

// Register metrics endpoint
app.get('/metrics', async (req, reply) => {
  reply.header('Content-Type', promClient.register.contentType);
  return promClient.register.metrics();
});

// Custom application metrics
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
});

// Hook into Fastify lifecycle
app.addHook('onResponse', async (request, reply) => {
  httpRequestDuration.observe(
    {
      method: request.method,
      route: request.routerPath,
      status_code: reply.statusCode.toString()
    },
    reply.getResponseTime() / 1000
  );
});
```

---

### 5. Logging Enhancements

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `pino` | ^9.6.0 | Structured logging | Fastify's built-in logger; 5-10x faster than Winston; structured JSON output; zero-cost log levels |

**Rationale:** Fastify already uses `pino` internally. For a hardening milestone, ensure proper log levels, redaction of sensitive fields, and child loggers for request correlation. No new dependency needed.

**Enhancement strategy:**

```typescript
// Configure redaction for sensitive fields
const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'password', 'token'],
      remove: true
    }
  }
});

// Child loggers for request context
app.addHook('onRequest', async (request) => {
  request.log = request.log.child({ requestId: generateId() });
});
```

---

### 6. Code Quality & Security

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `knip` | ^5.44.0 | Unused dependency detection | Modern replacement for archived `depcheck`; TypeScript-native; monorepo support |
| `npm audit` | Built-in | Security vulnerability scanning | Native npm capability; runs in CI |

**Rationale:** `depcheck` was archived in June 2025. `knip` is the actively maintained successor with better TypeScript support. Use `npm audit` in CI for security scanning.

**Integration:**

```json
// package.json scripts
{
  "lint:deps": "knip",
  "audit": "npm audit",
  "audit:fix": "npm audit fix"
}
```

---

## Installation Commands

```bash
# Error handling
npm install @fastify/sensible@^6.0.4 @fastify/error@^4.2.0

# Performance profiling (dev dependencies)
npm install -D 0x@^6.0.0 clinic@^13.0.0

# Testing improvements (dev dependencies)
npm install -D @stryker-mutator/core@^9.5.1 @stryker-mutator/vitest-runner@^9.5.1
npm install -D fast-check@^4.5.3
npm install -D @vitest/coverage-v8@^4.0.18

# Monitoring
npm install prom-client@^15.1.3

# Code quality (dev dependencies)
npm install -D knip@^5.44.0
```

---

## Alternatives Considered

| Category | Recommended | Alternative | When to Use Alternative |
|----------|-------------|-------------|------------------------|
| Error handling | `@fastify/sensible` | `fastify-http-errors-enhanced` | Need custom error response formatting beyond HTTP standards |
| Profiling | `0x` + `clinic` | `@platformatic/flame` | Want WebGL flamegraphs or production-safe signal-based profiling |
| Mutation testing | Stryker | None (Stryker is standard) | N/A |
| Property testing | `fast-check` | `jsverify` | `jsverify` has smaller bundle but less active maintenance |
| Metrics | `prom-client` | `prometheus-gc-stats` | Only need GC metrics; want smaller dependency |
| Coverage | `@vitest/coverage-v8` | `c8` directly | Not using Vitest; need standalone coverage tool |

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| DataDog/NewRelic APM agents | Heavy external dependencies; overkill for LAN service | `prom-client` + local Grafana |
| Winston logging | Redundant with pino; slower | Enhance pino configuration |
| `depcheck` | Archived June 2025; no longer maintained | `knip` |
| `nyc` for coverage | Deprecated; V8 native coverage is standard | `@vitest/coverage-v8` |
| Full ESLint overhaul | Project has zero TypeScript errors; diminishing returns | Focus on runtime quality (tests, profiling) |

---

## Version Compatibility Matrix

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `@fastify/sensible@^6.0.4` | `fastify@^5.x` | Already using Fastify v5.7.4 |
| `@stryker-mutator/*@^9.5.1` | `vitest@^4.x` | Already using Vitest v4.0.18 |
| `prom-client@^15.1.3` | Node.js >= 16 | Using modern Node.js |
| `fast-check@^4.5.3` | TypeScript >= 5.0 | Already using TypeScript v5.9.3 |
| `clinic@^13.0.0` | Node.js >= 16 | Dropped Node 14 support in v13 |

---

## Integration Points with Existing Stack

### Fastify Integration
- `@fastify/sensible` and `@fastify/error` register as standard Fastify plugins
- `prom-client` metrics endpoint follows Fastify patterns
- Pino logging enhancements use existing Fastify logger instance

### SQLite/better-sqlite3 Integration
- No additional dependencies needed for SQLite testing
- In-memory `:memory:` databases for tests already supported

### MCP Server Integration
- Error handling from `@fastify/error` can be reused for MCP error responses
- Structured logging applies to both REST API and MCP server

### Vitest Integration
- Stryker configured for Vitest runner
- `fast-check` integrates via standard test assertions
- Coverage via `@vitest/coverage-v8`

---

## Phase Ordering Recommendation

Based on stack dependencies:

1. **Error handling** (`@fastify/sensible`, `@fastify/error`) - Foundation for other improvements
2. **Logging enhancements** (Pino configuration) - Enables better observability
3. **Monitoring** (`prom-client`) - Baseline metrics before optimization
4. **Performance profiling** (`0x`, `clinic`) - Now you can measure improvements
5. **Testing improvements** (Stryker, fast-check) - Validate quality after foundation is solid
6. **Code quality** (`knip`, audit) - Final polish

---

## Sources

- [Fastify Sensible NPM](https://www.npmjs.com/package/@fastify/sensible) - v6.0.4, 289.7K weekly downloads
- [Fastify Error NPM](https://www.npmjs.com/package/@fastify/error) - v4.2.0, 4.9M weekly downloads
- [Stryker Releases](https://github.com/stryker-mutator/stryker-js/releases) - v9.5.1 with Vitest fixtures support
- [fast-check NPM](https://www.npmjs.com/package/fast-check) - v4.5.3, 8.4M weekly downloads
- [prom-client NPM](https://www.npmjs.com/package/prom-client) - v15.1.3, 4.5M weekly downloads
- [0x NPM](https://www.npmjs.com/package/0x) - v6.0.0, 76.5K weekly downloads
- [clinic NPM](https://www.npmjs.com/package/clinic) - v13.0.0
- [c8 NPM](https://www.npmjs.com/package/c8) - v10.1.3
- [Knip](https://knip.dev) - Modern replacement for depcheck
- [depcheck GitHub](https://github.com/depcheck/depcheck) - Archived June 2025

---

*Stack research for: Wood Fired Bugs hardening & polish milestone*
*Researched: 2026-02-17*
