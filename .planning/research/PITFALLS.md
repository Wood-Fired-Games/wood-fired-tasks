# Pitfalls Research: Hardening Phase

**Domain:** Local Node.js/SQLite service hardening
**Context:** Subsequent milestone - adding hardening to existing system (518 tests passing)
**Researched:** 2026-02-17
**Confidence:** HIGH

---

## Critical Pitfalls

### Pitfall 1: Over-Engineering Health Checks for Local Service

**What goes wrong:**
Implementing Kubernetes-style liveness/readiness/startup probes for a local single-user service. The health check hits the database on every request, adds complex failure thresholds, and includes dependency checks that cause restart loops when SQLite is briefly busy. A local service that should be "always up" starts flapping between healthy/unhealthy states due to overly sensitive checks.

**Why it happens:**
Developers apply cloud-native patterns without considering the local context. Kubernetes tutorials show sophisticated health check patterns, but a local service on a single machine doesn't face the same failure modes (network partitions, pod eviction, rolling deploys). The current `/health` endpoint already does `SELECT 1` on every check—sufficient for a local service.

**How to avoid:**
1. **Single endpoint**: Keep one `/health` endpoint, not separate `/live` and `/ready`
2. **Lightweight check**: `SELECT 1` is sufficient—don't run `PRAGMA integrity_check` or count rows
3. **No automatic restarts**: Local service shouldn't self-restart on health failure—log and alert instead
4. **Skip dependency checks**: Don't check SSE connections or background jobs in health—check process health only
5. **Background caching**: If health is polled frequently (>1 req/sec), cache result for 5 seconds

**Warning signs:**
- Health check takes >50ms (should be <5ms for `SELECT 1`)
- Service restarts during SQLite-heavy operations (migrations, bulk imports)
- Logs show health check failures during normal operation
- Health endpoint returns 503 when the service is actually functional

**Phase to address:**
Hardening Phase 1 (Health & Monitoring) - Design health checks for local context, not cloud deployment.

---

### Pitfall 2: Monitoring That Hurts Performance

**What goes wrong:**
Adding OpenTelemetry, Prometheus metrics, or detailed performance profiling that adds 10-30% overhead to a local service. The service was fast (Fastify's ~46k req/sec baseline) but now feels sluggish. SQLite query tracing adds per-query overhead. Memory usage grows from telemetry buffers. The "observability" makes the system less responsive than before.

**Why it happens:**
2025-2026 observability guides recommend 10% sampling for production, but local services don't need continuous telemetry. Default OpenTelemetry instrumentation includes filesystem and HTTP auto-instrumentation that's overkill for a single-user app. Developers add metrics "just in case" without considering the cost per query.

**How to avoid:**
1. **Start with logs**: Structured logging (Pino) is sufficient for local debugging—add metrics only if logs prove insufficient
2. **Disable auto-instrumentation**: Explicitly disable `@opentelemetry/instrumentation-fs` and similar—adds overhead with no value
3. **SQLite profiling off by default**: Use `PRAGMA query_only = ON` for read-only analysis sessions, not production
4. **Metric aggregation, not per-request**: Aggregate metrics in memory, flush every 60 seconds—not per-request
5. **Conditional instrumentation**: Only enable detailed tracing when `DEBUG_PERF=1` env var is set

**Warning signs:**
- Request latency increases by >5ms after adding monitoring
- Memory usage grows continuously (telemetry buffer leak)
- CPU usage spikes during "idle" periods (background metric flushing)
- SQLite `busy_timeout` errors increase (monitoring queries competing with app queries)

**Phase to address:**
Hardening Phase 1 (Health & Monitoring) - Implement monitoring that can be disabled, not monitoring that's always on.

---

### Pitfall 3: SQLite WAL Over-Tuning

**What goes wrong:**
Applying 2025 "production SQLite" recommendations to a local service: `PRAGMA mmap_size = 1GB`, `PRAGMA cache_size = 256MB`, aggressive checkpointing. The service that worked fine now uses excessive memory, checkpointing causes latency spikes, and WAL file grows unbounded because of the event buffer keeping read transactions open. "Hardening" made the database less reliable.

**Why it happens:**
SQLite hardening guides target high-throughput web services, not local single-user apps. The current config (WAL mode, 5s busy timeout, NORMAL synchronous) is already optimal for this use case. Adding `wal_autocheckpoint = 4000` without understanding the access pattern causes problems.

**How to avoid:**
1. **Keep defaults for local service**: Current `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000` are sufficient
2. **Don't increase cache_size unless proven needed**: Default 2MB cache is fine for local queries
3. **Let auto-checkpoint work**: Default 1000 pages is fine—don't increase to 4000 unless profiling shows checkpoint overhead
4. **Monitor WAL size**: If `-wal` file grows >100MB, investigate (likely uncommitted transactions, not config issue)
5. **Keep synchronous = NORMAL**: Don't use FULL (fsync every transaction)—adds latency for minimal durability benefit on local machine

**Warning signs:**
- `.db-wal` file grows to 500MB+ between checkpoints
- Write latency spikes to 50ms+ (checkpoint pauses)
- Memory usage jumps by 100MB+ after "optimizing" SQLite
- `SQLITE_BUSY` errors during checkpointing

**Phase to address:**
Hardening Phase 2 (Database Reliability) - Verify current config is optimal before changing; measure before tuning.

---

### Pitfall 4: Excessive Logging in Production Mode

**What goes wrong:**
Fastify's default Pino logging is configured for `info` level in production, which logs every request. For a local service with SSE connections (30-second heartbeats), logs fill with ping/pong noise. The log file grows to GBs, making it hard to find actual issues. Developers disable logging entirely, losing visibility into real errors.

**Why it happens:**
Fastify defaults to logging all requests at `info` level. The SSE heartbeat at 30 seconds creates 120 log entries/hour per connection just for pings. Pino is fast (50k logs/sec) but still generates I/O. No log rotation means unbounded growth.

**How to avoid:**
1. **Reduce log level for local**: Use `LOG_LEVEL=warn` for local production mode—only log errors and warnings
2. **Exclude heartbeat noise**: Filter out SSE ping events from logs (they're noise)
3. **Log rotation**: Use `pino-roll` or external rotation (logrotate) to prevent unbounded growth
4. **Request sampling**: Log 1% of successful requests, 100% of errors
5. **Structured logs only in production**: Disable `pino-pretty` in production (already done), but also consider disabling request logging entirely for local service

**Warning signs:**
- Log file grows >100MB/day
- `tail -f` shows mostly SSE heartbeat noise
- Disk fills up from logs
- Performance degrades under high event volume (logging overhead)

**Phase to address:**
Hardening Phase 1 (Health & Monitoring) - Configure logging for local service scale, not web-scale.

---

### Pitfall 5: Complex Graceful Shutdown for Local Service

**What goes wrong:**
Implementing Kubernetes-style graceful shutdown (SIGTERM handling, connection draining, 30-second timeout) for a local service. The shutdown handler adds 500 lines of code, 3 new dependencies, and still occasionally hangs. Users press Ctrl+C and wait 10 seconds for shutdown instead of immediate exit. The complexity creates new bugs (shutdown hangs, cleanup failures).

**Why it happens:**
Graceful shutdown guides target orchestrated containers where SIGKILL arrives after 30 seconds. A local service on a developer's machine doesn't need this—SQLite is file-based (no connection pool to drain), SSE connections are local (not user traffic), and the worst case is a 5-second `busy_timeout`. The current cleanup in `onClose` hook is sufficient.

**How to avoid:**
1. **Simple is better**: Current implementation (close SSE connections, clear intervals, close DB) is sufficient
2. **No complex signal handling**: Fastify's `onClose` hook handles normal shutdown; OS will clean up on SIGKILL if needed
3. **Skip connection draining**: For local service, just close SSE connections immediately—no need to wait for in-flight requests
4. **Timeout only for SQLite**: Only complex case is waiting for `busy_timeout`—but that's handled by better-sqlite3 already
5. **Exit on second Ctrl+C**: If shutdown hangs, let user Ctrl+C again to force exit (Node.js default behavior)

**Warning signs:**
- Shutdown takes >5 seconds consistently
- Shutdown handler is >200 lines of code
- Tests for shutdown are flaky (timing-dependent)
- Service hangs on exit occasionally (cleanup deadlock)

**Phase to address:**
Hardening Phase 3 (Operational Hardening) - Keep shutdown simple; verify current `onClose` hook handles edge cases.

---

### Pitfall 6: SSE Connection Monitoring Overhead

**What goes wrong:**
Adding per-connection metrics, detailed heartbeat logging, and connection lifecycle tracking to SSEManager. The event loop spends more time updating metrics than broadcasting events. Memory usage grows from connection metadata. The 30-second heartbeat now includes expensive operations (database checks, metrics flushing).

**Why it happens:**
SSEManager already has proper lifecycle management (cleanup on close/error, max connection age, event buffering). Adding "monitoring" on top duplicates work. Connection count is already available via `this.connections.size`—no need for separate metrics. Heartbeat should be lightweight (empty ping), not an opportunity for health checks.

**How to avoid:**
1. **Don't monitor what's already managed**: SSEManager already tracks connections—don't duplicate
2. **Heartbeat stays lightweight**: Send empty `ping` event, don't run diagnostics
3. **Lazy metrics**: Only calculate connection count when `/health` requests it, not continuously
4. **No per-connection logging**: Don't log every connect/disconnect at INFO level—DEBUG only
5. **Reuse existing cleanup**: Current `reply.raw.on('close')` and `reply.raw.on('error')` handlers are sufficient

**Warning signs:**
- Heartbeat interval callback takes >1ms (should be <0.1ms)
- Memory usage scales with connection count (per-connection metadata)
- Event broadcast latency increases with connection count (not just network time)
- Logs show connection metrics updates more frequently than actual events

**Phase to address:**
Hardening Phase 2 (SSE Reliability) - Verify SSEManager is already robust; don't add monitoring that hurts performance.

---

### Pitfall 7: Idempotency Service Over-Engineering

**What goes wrong:**
The IdempotencyService is already implemented with database-backed storage and hourly cleanup. "Hardening" adds distributed caching, Redis fallback, or complex TTL management. For a local service, this adds dependencies and failure modes. The SQLite-backed idempotency is already atomic and sufficient.

**Why it happens:**
Idempotency guides target distributed systems where nodes don't share state. A local service has one database—SQLite idempotency table is already consistent. Adding Redis "for performance" adds a dependency that can fail. Complex TTL logic adds bugs.

**How to avoid:**
1. **SQLite is sufficient**: Current `idempotency_keys` table with hourly cleanup is optimal for local service
2. **Don't add caching**: No need for Redis/memcached—SQLite is the cache
3. **Simple TTL**: Current cleanup removes entries >24 hours old—sufficient
4. **No distributed concerns**: Ignore "clock skew" issues—they don't apply to single-machine
5. **Monitor table size only**: Alert if `idempotency_keys` grows >10k rows (shouldn't with hourly cleanup)

**Warning signs:**
- IdempotencyService has >500 lines of code
- Added Redis dependency "for idempotency"
- Cleanup logic is complex (priority queues, exponential backoff)
- Idempotency checks take >10ms (should be <1ms with index)

**Phase to address:**
Hardening Phase 2 (API Reliability) - Keep IdempotencyService simple; verify cleanup is working.

---

### Pitfall 8: Adding "Circuit Breakers" for Local Dependencies

**What goes wrong:**
Implementing circuit breaker patterns for SQLite, SSE, and EventBus "to prevent cascade failures." The circuit breaker adds complexity (half-open states, failure thresholds, timeouts) and false positives. SQLite is file-based—it doesn't "go down" like a network service. Circuit opens unnecessarily during heavy load, causing more failures than it prevents.

**Why it happens:**
Microservices resilience patterns are applied to in-process components. Circuit breakers make sense for external HTTP services (payment gateways, third-party APIs), not for local SQLite or in-memory event bus. The "failures" are likely just SQLite busy errors that retry would handle.

**How to avoid:**
1. **No circuit breakers for local resources**: SQLite, EventBus, SSEManager are in-process—use direct error handling
2. **Retry for SQLITE_BUSY**: Use existing `busy_timeout` and application-level retry, not circuit breaker
3. **Fail fast for real errors**: If SQLite is corrupted, circuit breaker won't help—fail fast and alert
4. **Monitor, don't prevent**: Track SQLite busy errors in logs—if >1% of requests, investigate, don't add circuit breaker

**Warning signs:**
- Circuit breaker library added as dependency
- "Half-open" state logic in local service
- Circuit opens during normal operation (heavy batch import)
- Error messages mention "circuit breaker" instead of actual error

**Phase to address:**
Hardening Phase 3 (Resilience) - Don't apply microservice patterns to monolithic local service.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Disable all logging for performance | Faster, cleaner console | No visibility into errors | Never—use WARN level instead of OFF |
| Increase `busy_timeout` to 60s | Fewer SQLITE_BUSY errors | Stalled requests, poor UX | Never—keep 5s, add retry |
| Skip backup strategy "because it's local" | Less code | Data loss on disk failure | Never—implement SQLite backup |
| Add Prometheus metrics "for future" | Looks professional | Memory overhead, complexity | Never—add when needed, not before |
| Use `synchronous = OFF` for speed | 2x faster writes | Corruption on power loss | Never—keep NORMAL |
| Complex health check thresholds | Catches edge cases | Flapping, false positives | Never—keep simple pass/fail |

---

## Integration Gotchas

Common mistakes when hardening Fastify + SQLite + SSE.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Fastify + Pino | Logging every request at INFO | Set `LOG_LEVEL=warn`, exclude SSE heartbeats |
| Fastify + Health | Separate `/live` and `/ready` endpoints | Single `/health` with `SELECT 1` check |
| SQLite + WAL | Setting `wal_autocheckpoint = 4000` for "performance" | Keep default 1000; monitor WAL size first |
| SQLite + Monitoring | Enabling `stmt_scanstatus` for all queries | Profile only slow queries (>100ms), not all |
| SSE + Metrics | Per-connection metrics tracking | Connection count only; no per-connection metadata |
| SSE + Heartbeat | Adding health checks to heartbeat | Keep heartbeat empty—use for liveness only |
| Graceful Shutdown | 30-second timeout with connection draining | Immediate close for local service; OS handles rest |
| Idempotency + Cache | Adding Redis for "performance" | SQLite is sufficient; no external dependencies |

---

## Performance Traps

Patterns that hurt performance when adding hardening.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| OpenTelemetry auto-instrumentation | 20% latency increase | Disable fs/http auto-instrumentation; manual spans only | Any request volume |
| Per-request metrics | CPU spikes, memory growth | Aggregate in memory; flush every 60s | >100 req/sec |
| SQLite query logging | 10x slower queries | Log only slow queries (>100ms) | Any write volume |
| SSE connection metadata | Memory grows with connections | Store only ID and reply object | >100 connections |
| Health check DB query | Latency spikes during checks | `SELECT 1` only; cache for 5s | Health polled >1/sec |
| Log file without rotation | Disk full | Use logrotate or `pino-roll` | >1 day runtime |
| Synchronous logging | Event loop blocking | Use async transport; don't `sync: true` | High log volume |
| Complex shutdown | Hangs, timeouts | Fastify `onClose` hook only; no custom signals | Any restart |

---

## "Looks Done But Isn't" Checklist

Things that appear hardened but are missing critical pieces.

- [ ] **Health Check:** Verifies DB with `SELECT 1`, not `PRAGMA integrity_check` (too slow) or `SELECT COUNT(*)` (unnecessary)
- [ ] **Logging:** Has level configuration (`LOG_LEVEL` env), not just on/off
- [ ] **SQLite:** WAL mode enabled, `synchronous = NORMAL`, `busy_timeout = 5000` (current config is correct)
- [ ] **Backup:** Has automated SQLite backup strategy (copy + verify), not just "we'll restore from git"
- [ ] **SSE:** Connection cleanup on close/error (already implemented), not just timeout
- [ ] **Idempotency:** Has cleanup (hourly), not just insertion
- [ ] **Shutdown:** Fastify `onClose` hook closes DB and SSE (already implemented), not complex signal handling
- [ ] **Monitoring:** Can be disabled without code changes, not always-on

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Monitoring overhead | LOW | Disable telemetry via env var; restart; redesign |
| Health check flapping | LOW | Simplify to `SELECT 1` only; redeploy |
| WAL file too large | LOW | Run `PRAGMA wal_checkpoint(TRUNCATE)`; investigate uncommitted transactions |
| Log disk full | LOW | Rotate/truncate logs; configure rotation; restart |
| Complex shutdown hangs | MEDIUM | Kill process (SQLite is safe); simplify shutdown code; redeploy |
| Circuit breaker false positives | LOW | Remove circuit breaker; use retry logic; redeploy |
| SSE monitoring overhead | LOW | Disable per-connection metrics; restart |

---

## Pitfall-to-Phase Mapping

How hardening phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Over-engineered health checks | Phase 1: Health & Monitoring | Health check returns in <5ms; no restarts during normal ops |
| Monitoring overhead | Phase 1: Health & Monitoring | Latency unchanged after adding monitoring; can disable via env |
| SQLite WAL over-tuning | Phase 2: Database Reliability | WAL file <100MB; checkpoint latency <10ms |
| Excessive logging | Phase 1: Health & Monitoring | Log file <10MB/day; INFO level shows only real events |
| Complex graceful shutdown | Phase 3: Operational Hardening | Shutdown completes in <2s; no custom signal handlers |
| SSE monitoring overhead | Phase 2: SSE Reliability | Heartbeat <0.1ms; no per-connection metadata |
| Idempotency over-engineering | Phase 2: API Reliability | IdempotencyService <200 lines; no external dependencies |
| Circuit breakers for local | Phase 3: Resilience | No circuit breaker library in dependencies |

---

## Key Insight: Local Service ≠ Cloud Service

This is a **local service** for a single human user + agents. It is NOT:
- A distributed microservice
- A multi-tenant SaaS application
- A high-availability production cluster

Hardening should focus on:
1. **Data safety** (SQLite backup, WAL mode)
2. **Developer experience** (fast startup, clear logs, simple restart)
3. **Observability without overhead** (structured logs, optional metrics)

NOT on:
- Kubernetes-style health probes
- Distributed tracing
- Circuit breakers
- Connection pooling
- Horizontal scaling patterns

The current implementation is already well-architected for this use case. Hardening should enhance, not over-engineer.

---

## Sources

### Node.js Hardening & Over-Engineering
- [Node.js Security Baseline 2026](https://medium.com/@Modexa/node-js-security-baseline-defaults-you-should-expect-in-2026-05bf18c093fb) - Context-aware security principles
- [The Overcorrection Phenomenon](https://lrhachedev.medium.com/the-overcorrection-phenomenon-2935eb202181) - How hardening reduces reliability
- [Stop Running node index.js in Production](https://www.beyondthesemicolon.com/stop-running-node-index-js-in-production-a-2025-ready-field-guide/) - Simple deployment patterns
- [Node.js Security Hardening](https://toolstac.com/tool/node.js/security-hardening) - Realistic security assessment

### Fastify & Pino Performance
- [Pino Logger Guide 2026](https://signoz.io/guides/pino-logger/) - Performance benchmarks
- [Fastify Logging Documentation](https://fastify.io/docs/v5.4.x/Reference/Logging/) - Official guidance
- [Production Logging with Pino](https://www.dash0.com/guides/logging-in-node-js-with-pino) - Best practices

### Health Checks & Graceful Shutdown
- [Node.js Health Checks 2026](https://oneuptime.com/blog/post/2026-01-06-nodejs-health-checks-kubernetes/view) - Kubernetes vs local service
- [Graceful Shutdown Handler 2026](https://oneuptime.com/blog/post/2026-01-06-nodejs-graceful-shutdown-handler/view) - Signal handling patterns
- [Kubernetes Health Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/) - When NOT to apply these patterns
- [Node.js Health Check Mistakes](https://article.arunangshudas.com/6-common-mistakes-in-node-js-health-check-implementations-852c62365065) - Common anti-patterns

### SQLite Hardening
- [SQLite WAL Documentation](https://sqlite.org/wal.html) - Official WAL mode guidance
- [SQLite Profiling](https://sqlite.org/profile.html) - When to use (rarely)
- [Sophisticated Simplicity of Modern SQLite](https://shivekkhurana.com/blog/sqlite-in-production/) - 2025 SQLite best practices
- [SQLite Forum: Monitoring](https://www.sqliteforum.com/p/monitoring-and-debugging-sqlite-in) - Profiling overhead discussion

### Observability Anti-Patterns
- [Top Microservices Anti-Patterns 2025](https://www.geeksforgeeks.org/blogs/microservice-anti-patterns/) - Ignoring observability vs over-observability
- [Architectural Anti-Patterns](https://arxiv.org/html/2602.07147v2) - Student research on monitoring mistakes
- [Fastify Monitoring with OpenTelemetry](https://oneuptime.com/blog/post/2026-02-06-monitor-fastify-applications-opentelemetry/view) - Performance overhead details
- [Dynatrace Observability Predictions 2026](https://www.dynatrace.com/news/blog/six-observability-predictions-for-2026/) - When observability helps vs hurts

---

*Pitfalls research for: Wood Fired Bugs hardening milestone*
*Researched: 2026-02-17*
*Confidence: HIGH - All pitfalls verified with official sources + community best practices*
