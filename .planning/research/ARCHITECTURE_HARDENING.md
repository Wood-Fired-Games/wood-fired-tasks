# Architecture Research: Hardening Improvements

**Domain:** Task tracking service (Wood Fired Bugs)
**Researched:** 2026-02-17
**Confidence:** HIGH

## Executive Summary

The Wood Fired Bugs architecture is a layered Fastify/SQLite/EventBus system suitable for LAN deployment. Hardening improvements should integrate **vertically** through Fastify plugins and **horizontally** through middleware patterns, avoiding architectural restructuring. The recommended approach uses official Fastify plugins (`@fastify/rate-limit`, `@fastify/under-pressure`) for infrastructure concerns, wraps existing services for observability, and enhances existing shutdown hooks for graceful degradation.

## Current Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Entry Points                             │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                         │
│  │   API   │  │   MCP   │  │   CLI   │                         │
│  │(Fastify)│  │(Server) │  │(Bin)    │                         │
│  └────┬────┘  └────┬────┘  └────┬────┘                         │
├───────┴────────────┴────────────┴───────────────────────────────┤
│                         Service Layer                            │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌───────────┐│
│  │ TaskService │ │ProjectService│ │DependencySvc│ │CommentSvc ││
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘ └─────┬─────┘│
├─────────┴───────────────┴───────────────┴──────────────┴────────┤
│                      Repository Layer                            │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌───────────┐│
│  │TaskRepository│ │ProjectRepo │ │DependencyRepo│ │CommentRepo││
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘ └─────┬─────┘│
├─────────┴───────────────┴───────────────┴───────────────────────┤
│                         Database                                 │
├─────────────────────────────────────────────────────────────────┤
│                      better-sqlite3 (WAL)                        │
└─────────────────────────────────────────────────────────────────┘
│                         Events                                   │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐               │
│  │  EventBus   │ │ SSEManager  │ │WorkflowEngine│               │
│  │(EventEmitter)│ │(SSE Stream) │ │ (Subscriber) │               │
│  └─────────────┘ └─────────────┘ └─────────────┘               │
└─────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Current Implementation |
|-----------|----------------|------------------------|
| API Layer | HTTP routing, auth, validation | Fastify v5 with Zod type provider |
| Service Layer | Business logic, validation | Plain TS classes with custom errors |
| Repository Layer | Data access abstraction | better-sqlite3 wrapper classes |
| EventBus | Decoupled event publishing | Native EventEmitter wrapper |
| SSEManager | Real-time client updates | Fastify SSE plugin wrapper |
| WorkflowEngine | Automated workflows | EventBus subscriber with transaction handling |

## Hardening Integration Strategy

### Principle: Layered Enhancement, Not Replacement

All hardening improvements follow the **Decorator Pattern** — wrap or extend existing components rather than replace them.

```
Before:  Route → Service → Repository → DB
After:   Route → [RateLimit] → [Metrics] → Service → [Retry] → Repository → [CircuitBreaker] → DB
                ↓___________________________|
              Observability (logs, metrics, traces)
```

## Recommended Hardening Components

### 1. Rate Limiting Layer

**What:** Request throttling at the API layer
**Integration Point:** Fastify plugin registration in `server.ts`
**New vs Modified:** New plugin registration, no service changes

```typescript
// Integration in server.ts (new code)
await server.register(import('@fastify/rate-limit'), {
  max: 100,
  timeWindow: '1 minute',
  keyGenerator: (req) => req.headers['x-api-key'] as string || req.ip,
  onExceeding: (req) => {
    req.log.warn(`Rate limit approaching for ${req.id}`);
  },
  onExceeded: (req, reply) => {
    reply.header('Retry-After', 60);
  }
});
```

**Scope:** Global protection against accidental abuse or misconfigured clients

**Why This Pattern:**
- Fastify's encapsulation allows different limits per route prefix
- Uses existing logging infrastructure (`req.log`)
- Integrates with existing API key auth (keyGenerator)

### 2. Health Check Enhancement

**What:** Comprehensive health monitoring beyond basic DB check
**Integration Point:** Extend existing `/api/routes/health.ts`
**New vs Modified:** Modified — enhance existing health route

```typescript
// Enhanced health checks (modified existing)
interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  checks: {
    database: ComponentStatus;
    eventBus: ComponentStatus;
    workflowEngine: ComponentStatus;
    diskSpace: ComponentStatus;
  };
}

// Add to existing health route
async function checkDatabase(db: Database.Database): Promise<ComponentStatus> {
  try {
    db.prepare('SELECT 1').get();
    return { status: 'ok', responseTime: '10ms' };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}
```

**Data Flow Changes:** None — existing endpoint, enhanced payload

### 3. Load Shedding (Under Pressure)

**What:** Automatic 503 responses when system is overloaded
**Integration Point:** Fastify plugin registration
**New vs Modified:** New plugin

```typescript
// Integration in server.ts (new code)
await server.register(import('@fastify/under-pressure'), {
  maxEventLoopDelay: 1000,  // 1 second
  maxHeapUsedBytes: 512 * 1024 * 1024,  // 512MB
  maxRssBytes: 1 * 1024 * 1024 * 1024,   // 1GB
  pressureHandler: (request, reply, type, value) => {
    request.log.warn(`System pressure: ${type} = ${value}`);
    // Continue to let plugin return 503
  }
});
```

**Scope:** Protects against memory leaks, infinite loops, event loop blocking

**Why Not Circuit Breaker:** Circuit breakers are for external dependencies; under-pressure is for process health. SQLite is local, not external.

### 4. Enhanced Graceful Shutdown

**What:** Coordinated shutdown with resource cleanup
**Integration Point:** Extend existing `onClose` hook in `server.ts`
**New vs Modified:** Modified — enhance existing hook

Current state:
```typescript
// Existing code (server.ts lines 104-109)
server.addHook('onClose', async () => {
  clearInterval(idempotencyCleanupInterval);
  claimReleaseService.stop();
  sseManager.shutdown();
  app.workflowEngine.stop();
});
```

Enhanced version:
```typescript
// Enhanced shutdown (modified)
let isShuttingDown = false;

server.addHook('onClose', async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Existing cleanup
  clearInterval(idempotencyCleanupInterval);
  claimReleaseService.stop();
  sseManager.shutdown();
  app.workflowEngine.stop();

  // New: Flush logs
  await server.log.flush?.();

  // New: Close database gracefully
  app.db.pragma('wal_checkpoint(TRUNCATE)');
});

// New: Process signal handlers (add to start.ts)
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
```

**Data Flow Changes:** None — cleanup only

### 5. EventBus Reliability Enhancements

**What:** Event delivery guarantees and error isolation
**Integration Point:** Extend existing `EventBus` class
**New vs Modified:** Modified — enhance existing class

Current (line 42-48 in event-bus.ts):
```typescript
const wrappedHandler = (payload: Events[K]) => {
  try {
    handler(payload);
  } catch (error) {
    console.error(`Error in event handler for ${String(event)}:`, error);
  }
};
```

Enhanced:
```typescript
// Modified event-bus.ts
export class EventBus<Events extends Record<string, unknown>> {
  private emitter: EventEmitter;
  private handlerStats = new Map<string, { success: number; error: number }>();

  // Modified subscribe method
  subscribe<K extends keyof Events>(
    event: K,
    handler: (payload: Events[K]) => void,
    options?: {
      once?: boolean;
      timeout?: number;  // Handler timeout
    }
  ): () => void {
    const wrappedHandler = (payload: Events[K]) => {
      const stats = this.handlerStats.get(event as string) || { success: 0, error: 0 };

      try {
        // New: Timeout protection for async handlers
        if (options?.timeout) {
          const timeout = setTimeout(() => {
            console.error(`Handler timeout for ${String(event)}`);
            stats.error++;
          }, options.timeout);

          Promise.resolve(handler(payload)).finally(() => clearTimeout(timeout));
        } else {
          handler(payload);
        }

        stats.success++;
      } catch (error) {
        console.error(`Error in event handler for ${String(event)}:`, error);
        stats.error++;
      } finally {
        this.handlerStats.set(event as string, stats);
      }
    };

    this.emitter[options?.once ? 'once' : 'on'](event as string, wrappedHandler);

    // New: Return cleanup function (existing)
    return () => {
      this.emitter.off(event as string, wrappedHandler);
    };
  }

  // New: Health check method
  getHealth(): Record<string, { success: number; error: number }> {
    return Object.fromEntries(this.handlerStats);
  }
}
```

**Data Flow Changes:** None — internal enhancement only

### 6. SQLite Connection Resilience

**What:** Retry logic for SQLITE_BUSY and connection issues
**Integration Point:** Extend repository base or database.ts
**New vs Modified:** New wrapper utility

```typescript
// New: src/utils/db-resilience.ts
export async function withRetry<T>(
  operation: () => T,
  options?: {
    maxRetries?: number;
    delayMs?: number;
    onRetry?: (error: Error, attempt: number) => void;
  }
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const delayMs = options?.delayMs ?? 100;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return operation();
    } catch (err) {
      const error = err as Error;
      if (!error.message?.includes('BUSY') || attempt === maxRetries - 1) {
        throw error;
      }
      options?.onRetry?.(error, attempt + 1);
      await new Promise(r => setTimeout(r, delayMs * Math.pow(2, attempt)));
    }
  }
  throw new Error('Unreachable');
}

// Usage in repositories (modified)
claimTask(taskId: number, assignee: string): Task | undefined {
  return withRetry(() => {
    return this.db.transaction(() => {
      // existing claim logic
    })();
  }, {
    maxRetries: 5,
    onRetry: (err, attempt) => console.warn(`Claim retry ${attempt}: ${err.message}`)
  });
}
```

**Why:** better-sqlite3 with WAL mode is already reliable; retries handle edge-case concurrent access

### 7. Metrics Collection Layer

**What:** Request timing, throughput, and custom business metrics
**Integration Point:** Fastify hooks + optional Prometheus endpoint
**New vs Modified:** New metrics service

```typescript
// New: src/services/metrics.service.ts
export class MetricsService {
  private requestTimings = new Map<string, number[]>();
  private counters = new Map<string, number>();

  recordRequestTime(route: string, duration: number) {
    const times = this.requestTimings.get(route) || [];
    times.push(duration);
    if (times.length > 1000) times.shift();  // Keep last 1000
    this.requestTimings.set(route, times);
  }

  incrementCounter(name: string, tags?: Record<string, string>) {
    const key = tags ? `${name}:${JSON.stringify(tags)}` : name;
    this.counters.set(key, (this.counters.get(key) || 0) + 1);
  }

  getStats() {
    const stats: Record<string, { p50: number; p95: number; p99: number; count: number }> = {};
    for (const [route, times] of this.requestTimings) {
      const sorted = [...times].sort((a, b) => a - b);
      stats[route] = {
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        p99: sorted[Math.floor(sorted.length * 0.99)],
        count: times.length
      };
    }
    return stats;
  }
}

// Integration in server.ts (new code)
const metricsService = new MetricsService();
server.addHook('onResponse', async (request, reply) => {
  const duration = reply.elapsedTime;
  metricsService.recordRequestTime(request.routerPath || 'unknown', duration);
});

// Expose via health/metrics route (modified)
fastify.get('/metrics', async () => {
  return {
    requests: metricsService.getStats(),
    counters: Object.fromEntries(metricsService.counters)
  };
});
```

**Scope:** In-memory metrics for debugging; optional Prometheus export for production

### 8. Structured Logging Enhancement

**What:** Consistent log context and correlation IDs
**Integration Point:** Fastify hooks
**New vs Modified:** Modified — enhance existing logging

Current: Basic Pino logging via Fastify
Enhanced:
```typescript
// Add to server.ts (new code)
server.addHook('onRequest', async (request) => {
  request.log = request.log.child({
    requestId: request.id,
    apiKey: request.headers['x-api-key']?.slice(0, 8) + '...'
  });
});

// Service layer: existing error logging enhanced
// Already using request.log.error(error) in error-handler.ts
```

## Component Dependency Map

```
Rate Limiting ──────┐
Under Pressure ─────┼──→ Fastify Server ←── Health Checks (enhanced)
Structured Logging ──┘                           ↑
                                              │
Metrics Service ←─────────────────────────────┘
     ↓
EventBus (enhanced) ←──── SSEManager
     ↓                       ↓
WorkflowEngine ←─────── (clients)
     ↓
Services ────→ Repositories ────→ DB Resilience ────→ better-sqlite3
```

## Build Order (Considering Dependencies)

1. **Health Check Enhancement** — No dependencies, provides foundation
2. **EventBus Reliability** — No dependencies, improves core communication
3. **SQLite Resilience** — No dependencies, improves data layer
4. **Enhanced Graceful Shutdown** — Depends on EventBus, SSEManager, WorkflowEngine (existing)
5. **Structured Logging** — Fastify native, no dependencies
6. **Rate Limiting** — Depends on logging
7. **Under Pressure** — Depends on logging
8. **Metrics Service** — Last, depends on request lifecycle

## Integration Points Summary

| Component | Integration Point | New/Modified | Data Flow Changes |
|-----------|-------------------|--------------|-------------------|
| Rate Limiting | `server.ts` plugin registration | New | None |
| Health Checks | `routes/health.ts` | Modified | Payload structure only |
| Under Pressure | `server.ts` plugin registration | New | Returns 503 when overloaded |
| Graceful Shutdown | `server.ts` `onClose` hook | Modified | None |
| EventBus Reliability | `events/event-bus.ts` | Modified | None |
| SQLite Resilience | `utils/db-resilience.ts` + repos | New | None |
| Metrics Service | `server.ts` hooks + new route | New | Metrics endpoint added |
| Structured Logging | `server.ts` `onRequest` hook | Modified | Log context enhanced |

## Data Flow: Before vs After

### Before (Current)
```
Client → Route → Service → Repository → SQLite
                          ↓
                    EventBus → SSEManager → Clients
```

### After (With Hardening)
```
Client → [RateLimit] → [UnderPressure] → Route → [Metrics] → Service → [Resilience] → Repository → SQLite
   ↓         ↓              ↓
[Logging] [Logging]   [HealthCheck]
   ↓
EventBus (enhanced) → SSEManager → Clients
   ↓
WorkflowEngine
   ↓
[GracefulShutdown]
```

**Key Principle:** All hardening is additive — existing flows remain unchanged

## Scaling Considerations

**Current Scale:** LAN service, single instance

| Concern | Current | With Hardening |
|---------|---------|----------------|
| Concurrent connections | Unlimited | Limited by rate limit (configurable) |
| Memory leaks | Would crash | Under-pressure returns 503 |
| Event loop blocking | Would hang | Under-pressure returns 503 |
| DB contention | Would fail | Retry with exponential backoff |
| Event handler errors | Crashes subscriber | Isolated, logged, continues |
| Graceful shutdown | Basic cleanup | Coordinated with WAL checkpoint |

## Anti-Patterns to Avoid

### Anti-Pattern 1: Circuit Breaker for SQLite
**What people do:** Add circuit breaker to database calls
**Why it's wrong:** SQLite is local, not a network service. Circuit breakers prevent cascading failures to external dependencies; they add complexity for local resources.
**Do this instead:** Use retry logic with exponential backoff for SQLITE_BUSY

### Anti-Pattern 2: Global Error Handler That Swallows Errors
**What people do:** Catch all errors and return 200 with error body
**Why it's wrong:** Makes debugging difficult, hides failures from monitoring
**Do this instead:** Return appropriate HTTP codes (current implementation is correct), log with context

### Anti-Pattern 3: Metrics in Database
**What people do:** Store metrics in SQLite for persistence
**Why it's wrong:** Increases database load, metrics are ephemeral by design
**Do this instead:** In-memory with optional Prometheus export, or log and aggregate externally

### Anti-Pattern 4: Custom Rate Limiting Implementation
**What people do:** Build rate limiting from scratch using EventBus
**Why it's wrong:** Complex, error-prone, not as efficient as Fastify plugin
**Do this instead:** Use `@fastify/rate-limit` — officially maintained, optimized

## Recommended Package Versions

| Package | Version | Purpose |
|---------|---------|---------|
| `@fastify/rate-limit` | ^10.3.0 | Rate limiting |
| `@fastify/under-pressure` | ^9.0.3 | Load shedding |
| `prom-client` | ^15.0.0 | Prometheus metrics (optional) |

## Sources

- [Fastify Rate Limit Documentation](https://www.npmjs.com/package/@fastify/rate-limit) — Official plugin, HIGH confidence
- [Fastify Under Pressure](https://github.com/fastify/under-pressure) — Official plugin, HIGH confidence
- [Node.js EventEmitter Best Practices](https://www.grizzlypeaksoftware.com/library/event-emitters-patterns-and-best-practices-phrhwl0j) — Production patterns, MEDIUM confidence
- [SQLite Busy Handling](https://berthub.eu/articles/posts/a-brief-post-on-sqlite3-database-locked-despite-timeout/) — Technical details on SQLITE_BUSY, MEDIUM confidence
- [Fastify Graceful Shutdown Patterns](https://www.npmjs.com/package/fastify-graceful-shutdown) — Community plugin patterns, MEDIUM confidence
- [OpenTelemetry Fastify Monitoring](https://oneuptime.com/blog/post/2026-02-06-monitor-fastify-applications-opentelemetry/view) — Observability trends, LOW confidence (2026 date)

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Fastify plugin integration | HIGH | Official plugins with clear docs |
| SQLite resilience patterns | HIGH | Well-understood WAL behavior |
| EventBus enhancements | HIGH | Native EventEmitter behavior stable |
| Graceful shutdown | HIGH | Standard Node.js patterns |
| Metrics collection | MEDIUM | Multiple valid approaches |

## Roadmap Implications

Based on this research, suggested phase structure for hardening:

1. **Core Reliability** — Health checks, EventBus reliability, SQLite resilience
   - Low risk, high value
   - No external dependencies
   - Builds foundation for observability

2. **API Protection** — Rate limiting, under pressure, graceful shutdown
   - Depends on core reliability
   - Uses official Fastify plugins
   - Protects against abuse and overload

3. **Observability** — Metrics, structured logging
   - Depends on protected API
   - Optional Prometheus export
   - Useful for debugging but not critical

**Research flags for phases:**
- Phase 1 (Core Reliability): Standard patterns, unlikely to need research
- Phase 2 (API Protection): Plugin configuration may need tuning based on load
- Phase 3 (Observability): Prometheus integration may need environment-specific research

## Open Questions

1. Should metrics include business metrics (task counts, claim rates) or just technical metrics?
2. Should rate limits be configurable per API key or global?
3. Is Prometheus export needed, or is in-memory sufficient for LAN deployment?
4. Should health checks include external dependencies (future webhooks, external MCP)?
