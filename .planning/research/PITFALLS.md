# Pitfalls Research

**Domain:** Multi-agent coordination (SSE event streaming, workflow automation, atomic claim protocol)
**Researched:** 2026-02-14
**Confidence:** HIGH

## Critical Pitfalls

### Pitfall 1: SSE Connection Memory Leaks from Uncleaned Client Registry

**What goes wrong:**
When SSE clients disconnect (browser tab closed, network failure, timeout), their connection objects remain in the server's active client registry. Over hours/days with multiple agents polling and reconnecting, memory usage grows unbounded until the server crashes or becomes unresponsive.

**Why it happens:**
Node.js HTTP connections don't always fire `close` events reliably, especially with proxy servers, load balancers, or abrupt network failures. Developers register clients in a Map/Set but forget to clean up on all exit paths (normal close, error, timeout). The existing Fastify app has no connection lifecycle management—adding SSE without cleanup patterns guarantees leaks.

**How to avoid:**
1. Track clients in a WeakMap or implement explicit cleanup on ALL exit events: `request.socket.on('close')`, `request.socket.on('error')`, `reply.raw.on('close')`
2. Implement heartbeat/ping mechanism (every 15-30 seconds) to detect stale connections
3. Add connection timeout (e.g., max 10 minutes) and force-close zombies
4. Use `@fastify/sse` plugin (v7+) which handles cleanup automatically vs. raw `reply.raw.write()`
5. Monitor active connection count via metrics endpoint

**Warning signs:**
- Memory usage grows continuously in production (check Node.js heap size)
- Active SSE connection count never decreases
- Server becomes sluggish after 6-12 hours uptime
- OOM crashes during peak agent activity

**Phase to address:**
Phase 1 (SSE Infrastructure) - Implement connection registry with cleanup before any event broadcasting logic. Test with aggressive connect/disconnect cycles.

---

### Pitfall 2: Transaction Upgrade SQLITE_BUSY Despite Busy Timeout

**What goes wrong:**
An atomic claim operation starts with `SELECT` to check task availability (deferred read transaction), then attempts `UPDATE` to claim the task. When two agents try to claim simultaneously, one gets `SQLITE_BUSY` error IMMEDIATELY without respecting the 5-second `busy_timeout` configured in `database.ts`. Transaction fails, agent sees error, claim fails.

**Why it happens:**
SQLite's transaction upgrade behavior: when upgrading from read to write mid-transaction, if another connection holds a write lock, SQLite returns `SQLITE_BUSY` immediately without waiting for `busy_timeout`. The existing codebase uses `db.transaction()` (defaults to `BEGIN DEFERRED`), which starts as read-only and upgrades on first write. This is incompatible with concurrent claim protocols.

Reference: [What to do about SQLITE_BUSY errors despite setting a timeout](https://berthub.eu/articles/posts/a-brief-post-on-sqlite3-database-locked-despite-timeout/)

**How to avoid:**
1. Use `BEGIN IMMEDIATE` for any transaction that will write: `db.prepare('BEGIN IMMEDIATE').run()` before claim logic
2. Wrap repository methods that claim tasks in immediate transactions
3. Implement retry logic with exponential backoff (3 retries, 50ms → 200ms → 800ms) for unavoidable SQLITE_BUSY
4. Add application-level optimistic locking: check `updated_at` timestamp before committing claim
5. Consider advisory locks table for claim coordination if claims become frequent

**Warning signs:**
- `SQLITE_BUSY` errors in logs during concurrent agent operations
- Claim success rate drops below 95% during multi-agent tests
- Retries succeed on second attempt (indicates upgrade issue, not true contention)
- Error happens instantly (within 10ms) despite 5000ms timeout

**Phase to address:**
Phase 2 (Atomic Claim Protocol) - Implement before exposing claim endpoints. Add integration test with 10+ concurrent claim attempts on same task.

---

### Pitfall 3: Cascading Workflow Updates Outside Transaction Boundaries

**What goes wrong:**
Task A transitions to "done" → workflow hook marks parent Task B as "in_progress" → SSE broadcasts "Task A done" event → another workflow marks dependent Task C as "blocked" → database crashes/process killed between updates → Task A is "done" but Task B and C never updated. System state becomes inconsistent. Agents act on stale data, creating cascading errors.

**Why it happens:**
Workflow hooks execute AFTER the initiating transaction commits (post-update hooks for event emission), so cascading state changes happen in separate transactions. If any downstream update fails (validation error, database lock, process crash), earlier changes persist but later ones don't. The service layer in `task.service.ts` only wraps single-entity updates in transactions, not cross-entity workflows.

Reference: [Reliable Workflow Automation Platforms](https://www.stacksync.com/blog/reliable-workflow-automation-platforms-for-real-time-enterprise-sync)

**How to avoid:**
1. Execute ALL cascading state changes within the SAME transaction as the triggering update
2. Implement saga pattern for multi-step workflows: record compensation actions, roll back on failure
3. Use event outbox table: write state changes + events atomically, process events in background
4. Add workflow execution table to track in-progress cascades with status (pending/complete/failed)
5. Make workflow hooks idempotent: check current state before applying changes

**Warning signs:**
- Parent tasks stuck in wrong status after subtask completion
- Dependency states don't match actual task states
- Orphaned workflow events in logs without corresponding state changes
- Integration test failures with "unexpected state" after multi-step workflows
- Data inconsistencies after server restarts mid-operation

**Phase to address:**
Phase 3 (Workflow Automation) - Design transaction boundaries FIRST before implementing hooks. Add chaos testing (kill server mid-workflow).

---

### Pitfall 4: SSE Event Broadcast Race with Transaction Visibility

**What goes wrong:**
Service layer commits transaction → broadcasts SSE event "task created" → agents receive event → query API for new task → get 404 or see stale data. Event arrives before the transaction is visible to other database connections. Agents retry, logs fill with errors, user experience degrades.

**Why it happens:**
SQLite WAL mode has snapshot isolation: readers see database state as of when their transaction started, not the latest committed state. Even with `synchronous = NORMAL`, there's a window where one connection commits but other connections haven't checkpointed the WAL yet. Broadcasting events immediately after `transaction()` returns creates race condition.

Reference: [Isolation In SQLite](https://sqlite.org/isolation.html)

**How to avoid:**
1. Broadcast events INSIDE the transaction before commit (ensures visibility) OR
2. Add small delay (10-50ms) after commit before broadcasting to allow WAL checkpoint
3. Include full entity data in SSE events (event payload contains task object, not just ID)
4. Implement event sequence numbers: clients reject events with gaps, request backfill
5. Use `PRAGMA wal_checkpoint(TRUNCATE)` after critical writes (impacts performance)

**Warning signs:**
- Clients log "404 Not Found" immediately after receiving creation events
- Data appears "eventually" after 50-500ms delay
- High retry rates in agent code after event reception
- Integration tests flake with timing-dependent failures
- Event sequence numbers show gaps in client logs

**Phase to address:**
Phase 1 (SSE Infrastructure) - Test event → query timing before integrating with workflows. Add artificial delay and verify data visibility.

---

### Pitfall 5: HTTP/1.1 Six-Connection SSE Limit Per Domain

**What goes wrong:**
Multi-agent system on single machine opens 8+ EventSource connections to track different task contexts (project updates, assigned tasks, blocked tasks, comments). Browser hits 6-connection limit per domain. New SSE connections hang, agents stop receiving updates, polling fallback never implemented. System appears broken.

**Why it happens:**
HTTP/1.1 spec limits browsers to 6 concurrent connections per origin. Each EventSource consumes one connection. MCP agents on the same machine share browser connection pool if using browser-based HTTP client. The existing system has no connection multiplexing or pooling strategy.

Reference: [Limit of 6 concurrent EventSource connections](https://bugs.chromium.org/p/chromium/issues/detail?id=275955)

**How to avoid:**
1. Use HTTP/2 for Fastify server (supports ~100 concurrent streams per connection)
2. Multiplex multiple event topics over SINGLE SSE connection (filter client-side)
3. Implement event topic subscription protocol: clients specify which events they want
4. Use different subdomains for different event types (tasks.localhost, projects.localhost)
5. Document connection limits and recommend HTTP/2 in deployment guide

**Warning signs:**
- SSE connections hang in "pending" state after 6th connection
- Browser DevTools shows connection pool exhausted
- Agents receive events for some tasks but not others (inconsistent behavior)
- Connection works in isolation but fails in multi-agent scenario
- Works in production (HTTP/2) but fails in local dev (HTTP/1.1)

**Phase to address:**
Phase 1 (SSE Infrastructure) - Design single-connection multiplexing before implementing multiple event endpoints. Test with 10+ concurrent clients.

---

### Pitfall 6: Missing SSE Reconnection with Last-Event-ID Resume

**What goes wrong:**
Agent loses network connection for 30 seconds → reconnects to SSE endpoint → misses events that occurred during disconnection → operates on stale state → makes incorrect decisions (claims already-claimed task, transitions task in wrong state). Data divergence grows over time.

**Why it happens:**
Basic SSE implementation doesn't track event IDs or implement resume-from-last-event logic. Clients reconnect but server streams from "now" instead of missed events. The EventSource API supports `Last-Event-ID` header for resumption, but server must implement event buffering and replay logic.

Reference: [Server-Sent Events: A Comprehensive Guide](https://medium.com/@moali314/server-sent-events-a-comprehensive-guide-e4b15d147576)

**How to avoid:**
1. Assign sequential ID to every event: `id: ${timestamp}-${sequence}\n`
2. Buffer recent events (last 1000 or 5-minute window) in memory
3. On connection, check `Last-Event-ID` header and replay missed events
4. Implement event retention strategy: buffer critical events longer than informational
5. Add full-state snapshot endpoint for clients that missed too many events

**Warning signs:**
- Agents request full task list after every reconnection (expensive)
- State divergence between long-running vs. recently-reconnected agents
- Duplicate actions (claiming task twice) after network blip
- Logs show "missed N events during disconnect" warnings
- Integration tests fail with intermittent network simulation

**Phase to address:**
Phase 1 (SSE Infrastructure) - Implement event ID and buffering before production use. Test reconnection with network chaos (disconnect for 1s, 10s, 60s).

---

### Pitfall 7: Workflow Hook Infinite Loop from Self-Triggering

**What goes wrong:**
Workflow hook triggers on task status change → updates parent task → parent update triggers same hook → updates parent's parent → spirals until stack overflow or circular dependency detected. Server crashes or becomes unresponsive. Database fills with redundant updates.

**Why it happens:**
Workflow automation hooks fire on EVERY update without checking if the update was caused by automation itself. The existing service layer has no hook execution context tracking. Circular task hierarchies (rare but possible with bugs) + cascading updates = infinite loop.

Reference: [Make.com AI Agents: Patterns and Pitfalls](https://www.taskfoundry.com/2025/08/make-ai-agents-patterns-pitfalls-automation.html)

**How to avoid:**
1. Add execution context flag: `{ source: 'automation' | 'user' }` to skip hooks for automation updates
2. Implement maximum cascade depth: fail after 5 levels of workflow propagation
3. Track update chain: `[task1 → task2 → task3]` and detect cycles before executing
4. Use idempotency: check if automation would make any actual change before executing
5. Add circuit breaker: disable hooks if update rate exceeds threshold (100/sec)

**Warning signs:**
- CPU spikes to 100% during simple status transitions
- Database transaction count explodes (1000+ transactions for single user action)
- Logs show same task updated repeatedly (task-123 updated 50 times in 1 second)
- Stack trace shows recursive service method calls
- Integration tests timeout during workflow scenarios

**Phase to address:**
Phase 3 (Workflow Automation) - Implement loop detection before enabling any cascading logic. Add fuzzing test with random task hierarchies.

---

### Pitfall 8: Non-Idempotent Workflow Actions Create Duplicate Side Effects

**What goes wrong:**
Network timeout during task claim → client retries → claim succeeds twice (different transaction IDs) → two "task claimed" events broadcast → two notifications sent → two log entries → two API webhooks → downstream systems process duplicate actions. Audit trail corrupted.

**Why it happens:**
Workflow hooks execute on every successful transaction without deduplication. HTTP is not idempotent by default—retry after network failure re-executes full workflow. The service layer doesn't track request IDs or implement idempotency keys. MCP stdio transport retries without client-side dedup.

Reference: [Idempotent Consumer Pattern](https://microservices.io/patterns/communication-style/idempotent-consumer.html)

**How to avoid:**
1. Accept client-provided idempotency key (`X-Idempotency-Key` header) on mutation endpoints
2. Store processed idempotency keys in database table with TTL (24 hours)
3. Check key before executing: if seen, return cached result instead of re-executing
4. Make workflow actions naturally idempotent: "set status to done" not "increment counter"
5. Use event outbox pattern: write events with unique ID, consumer deduplicates

**Warning signs:**
- Duplicate events in SSE stream (same task update broadcast twice)
- Double-counting in metrics/analytics
- Users report duplicate notifications
- Audit logs show identical entries with different timestamps
- Integration tests occasionally produce 2x expected side effects

**Phase to address:**
Phase 2 (Atomic Claim Protocol) + Phase 3 (Workflow Automation) - Implement for claim endpoint first, then extend to all mutations. Test with network fault injection.

---

### Pitfall 9: Prepared Statement Reuse Across Concurrent Transactions

**What goes wrong:**
Repository uses class-level prepared statements (see `TaskRepository` constructor). Two concurrent requests execute → both use same `this.insertTaskStmt` → statements interleave → parameter binding corrupts → Task A gets Task B's data. Silent data corruption, extremely hard to debug.

**Why it happens:**
Better-sqlite3 prepared statements are NOT safe for concurrent use. The existing repository pattern pre-compiles statements for reuse, which works for sequential operations but breaks with async concurrency. Node.js event loop can interleave execution between `stmt.run()` calls.

**How to avoid:**
1. ONLY reuse prepared statements within `db.transaction()` boundaries (synchronous)
2. For async code paths, create statements inline: `db.prepare(...).run(...)` per request
3. Use connection pooling with one connection per concurrent operation
4. Add mutex/semaphore if async concurrency required (defeats performance benefit)
5. Document that better-sqlite3 forces synchronous transaction model

**Warning signs:**
- Random data corruption in high-concurrency scenarios
- Task A occasionally has Task B's title/description
- Test failures only appear with parallel test execution
- Production data inconsistencies that can't be reproduced locally
- Corruption happens more frequently under load

**Phase to address:**
Phase 2 (Atomic Claim Protocol) - Before adding concurrent claim logic, audit statement reuse. Add concurrency stress test (100 simultaneous creates).

---

### Pitfall 10: SSE Event Payload Size Exceeds Buffer Limits

**What goes wrong:**
Task has 500 comments → status update triggers workflow → broadcasts event with full task + all comments → event payload is 2MB → SSE frame exceeds Node.js default buffer → connection drops or event truncated → clients receive malformed JSON → parsing fails → reconnect storm.

**Why it happens:**
SSE spec has no payload size limit, but HTTP servers, proxies, and clients do. Including full entity data (to avoid race conditions from Pitfall #4) seems safe but breaks with large aggregates. The existing schema allows unbounded comment count, unbounded tag count, unbounded description length.

**How to avoid:**
1. Limit event payload size: max 64KB per event (enforce at serialization)
2. Send lightweight event with ID, type, timestamp → client fetches full data if needed
3. Paginate large collections in event payload: include comment count, not all comments
4. Add database constraints: max 1000 comments per task, max 10KB description
5. Implement payload compression for large events (gzip SSE frames)

**Warning signs:**
- SSE connections drop randomly during high-activity periods
- Client logs show JSON parse errors on event reception
- Events arrive incomplete (truncated mid-JSON)
- Memory usage spikes when broadcasting large updates
- Proxy servers (nginx) return 502 errors during event broadcast

**Phase to address:**
Phase 1 (SSE Infrastructure) - Define event payload schema with size limits before implementation. Test with synthetic 1MB+ entities.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Poll for changes instead of SSE | Simpler implementation, no connection management | 10-100x higher database load, 1-5s latency, poor UX | Never (already have polling, this milestone exists to remove it) |
| Use `BEGIN DEFERRED` for all transactions | Default behavior, less typing | Unpredictable SQLITE_BUSY under concurrency, fails Pitfall #2 | Read-only operations only |
| Broadcast events after transaction without delay/buffering | Immediate event delivery, simpler code | Race conditions (Pitfall #4), flaky tests, client confusion | Never in multi-agent context |
| Store SSE clients in plain array without cleanup | Quick prototype, works in dev | Memory leaks (Pitfall #1), production crashes | Never (add cleanup from day 1) |
| Make workflow hooks fire-and-forget async | Non-blocking user requests, faster response | Lost errors, no rollback on failure, inconsistent state | Never (use transactional outbox) |
| Skip idempotency key implementation | Faster initial delivery | Duplicate events (Pitfall #8), corrupted metrics, user complaints | Never for mutation endpoints |
| Reuse prepared statements across requests | Better performance | Silent data corruption (Pitfall #9) under concurrency | Only within `db.transaction()` blocks |
| Include full entity in events | Avoids client queries, prevents race conditions | Payload size issues (Pitfall #10), bandwidth waste | Only for entities with bounded size (<10KB) |
| No event sequence numbers or buffering | Simpler server, less memory | Missed events on reconnect (Pitfall #6), stale client state | Never (Last-Event-ID is SSE spec) |
| Single transaction per operation | Matches REST semantics | Workflow inconsistency (Pitfall #3), partial failures | Acceptable if using event outbox pattern |

---

## Integration Gotchas

Common mistakes when connecting to external services.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| SSE + SQLite WAL | Broadcasting events immediately after `transaction()` return without checking visibility | Delay 10-50ms OR include full data in event OR use `PRAGMA wal_checkpoint` for critical events |
| Fastify + SSE | Using `reply.raw.write()` without proper cleanup hooks | Use `@fastify/sse` plugin v7+ which handles connection lifecycle automatically |
| Better-sqlite3 + Concurrency | Assuming prepared statements are thread-safe because Node is single-threaded | Create statements inline for async code or use only within `db.transaction()` synchronous blocks |
| EventSource + HTTP/1.1 | Opening separate SSE connection per topic/resource type | Multiplex all events over single connection, filter client-side |
| Fastify hooks + Transactions | Putting transaction logic in `preHandler`/`onSend` hooks | Transactions only in route handlers or service layer where rollback is possible |
| SSE + Proxies (nginx/Apache) | Default proxy buffering holds events until buffer full | Set `X-Accel-Buffering: no` header and configure proxy for streaming |
| WAL mode + Docker volumes | Using network-mounted volumes (NFS/SMB) for SQLite WAL files | Use local volumes or bind mounts; WAL requires POSIX locking |
| TypeScript + better-sqlite3 | Type-casting statement results without runtime validation | Validate with Zod schema before type assertion; database could have old data |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Unbounded SSE client registry | Memory usage grows linearly with connection count; never freed | Implement connection timeout (10min), heartbeat detection (30s), max connections per IP | >500 concurrent connections |
| Event broadcast to all clients | CPU spikes with each update; O(N) serialization cost | Implement topic-based subscriptions; clients specify filters | >100 concurrent clients |
| Event buffer without size limit | Memory leak from buffering all events for Last-Event-ID resume | Cap buffer at 1000 events or 5-minute window; implement snapshot API | After 24hr uptime with high event rate |
| No connection backpressure | Slow clients cause memory buildup; server buffers unlimited pending events | Detect slow consumers (buffer >100 events), disconnect them, force reconnect | Clients on 3G/poor networks |
| Workflow cascade without depth limit | Exponential transaction count for deep task hierarchies | Maximum cascade depth of 5 levels; fail-fast with clear error | Task trees >10 levels deep |
| Synchronous event broadcasting | Request latency includes event serialization + delivery time | Use async event queue; decouple HTTP response from broadcast | >50ms per broadcast with >20 clients |
| Claim retries without backoff | Thundering herd when claim fails; all agents retry instantly | Exponential backoff with jitter (50ms → 200ms → 800ms) | >10 concurrent claimants |
| Full task fetch after every event | Database load scales with event rate × client count | Include entity snapshot in event payload | >100 events/sec |

---

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| No SSE connection authentication | Any client can connect and receive all events; data leakage | Validate `X-API-Key` on SSE endpoint same as REST endpoints |
| Broadcasting sensitive data in events | All connected clients receive all events regardless of permissions | Implement per-client event filtering based on authenticated identity |
| No rate limiting on claim endpoint | Malicious agent claims all tasks; denial of service | Rate limit claim attempts: max 10/minute per API key |
| Event payload includes deleted/private data | Clients cache events; deleted comments still visible | Scrub sensitive fields from events; send tombstone records for deletes |
| SSE endpoint exposed without CORS | Any website can connect to SSE stream from user's browser | Configure `@fastify/cors` to whitelist allowed origins |
| Claim endpoint without atomic check-and-set | Race condition allows double-claiming via TOCTOU attack | Use `UPDATE ... WHERE claimed_by IS NULL` atomic constraint check |
| Workflow hooks execute user-provided code | Arbitrary code execution if configuration allows expressions | Use safe state machine DSL; never `eval()` configuration strings |
| No audit log for automated actions | Automated workflow bugs invisible; no accountability | Log all automation-triggered updates with source tracking |

---

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| No indication of SSE connection status | User doesn't know if updates are live or stale | Expose connection state: "connected", "reconnecting", "offline" |
| Events arrive but UI doesn't update | User manually refreshes to see changes; thinks system is broken | Show toast/badge for new events; auto-refresh affected views |
| Workflow runs but user sees no feedback | Status changes happen silently; confusing for debugging | Emit workflow execution events: "Marked 3 dependent tasks as blocked" |
| Claim fails but no explanation why | User retries repeatedly; frustration | Return detailed error: "Task claimed by agent-007 2 seconds ago" |
| SSE reconnection storm floods logs | Developers ignore logs; miss real errors | Quiet mode for expected reconnections; alert on excessive failures |
| Concurrent update conflict lost silently | User's changes overwritten by workflow; data loss | Implement optimistic locking; show merge conflict UI |
| Event ordering not guaranteed | User sees "Task done" before "Task started"; temporal confusion | Include causality chain in events; client reorders before displaying |
| No offline resilience | SSE disconnect breaks entire agent; requires restart | Implement fallback to polling when SSE unavailable for >60s |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **SSE Implementation:** Often missing connection cleanup on `close`/`error` events — verify memory doesn't leak with 100 connect/disconnect cycles
- [ ] **Atomic Claims:** Often missing `BEGIN IMMEDIATE` for write transactions — verify no SQLITE_BUSY with 10 concurrent claims
- [ ] **Event Broadcasting:** Often missing transaction visibility delay — verify no 404s when querying entity immediately after event
- [ ] **Workflow Hooks:** Often missing transaction boundaries for cascading updates — verify parent task updated atomically with child
- [ ] **SSE Reconnection:** Often missing Last-Event-ID buffering and replay — verify no missed events after 30-second disconnect
- [ ] **Idempotency:** Often missing deduplication for retried mutations — verify duplicate request returns same result without side effects
- [ ] **Event Payloads:** Often missing size limits and validation — verify 500-comment task event doesn't break connection
- [ ] **Connection Multiplexing:** Often missing topic filtering — verify 10 clients on same machine don't hit 6-connection limit
- [ ] **Loop Prevention:** Often missing cascade depth limits — verify circular task hierarchy doesn't cause infinite loop
- [ ] **Error Handling:** Often missing SQLITE_BUSY retry logic — verify claims succeed under high contention (>80% success rate)

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| SSE Memory Leak | LOW | Restart server to clear connection registry; implement cleanup; redeploy |
| Transaction Upgrade SQLITE_BUSY | LOW | Add retry logic in client; fix with BEGIN IMMEDIATE; redeploy |
| Workflow Inconsistency | HIGH | Manual database surgery to fix orphaned state; implement saga rollback; may need full data audit |
| Event Broadcast Race | MEDIUM | Clients self-heal on next full sync; add visibility delay; redeploy |
| HTTP/1.1 Connection Limit | LOW | Switch to HTTP/2 or multiplex events; clients reconnect automatically |
| Missed Events on Reconnect | MEDIUM | Clients fetch full state; implement Last-Event-ID; redeploy; clients auto-backfill |
| Workflow Infinite Loop | HIGH | Kill runaway processes; add circuit breaker; fix loop detection; clear pending events |
| Duplicate Side Effects | MEDIUM | Manual deduplication in downstream systems; implement idempotency keys; redeploy |
| Prepared Statement Corruption | HIGH | Restore from backup; fix statement reuse; full data integrity audit required |
| Event Payload Too Large | LOW | Truncate event or split into chunks; add size limit; redeploy; clients refetch |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| SSE Connection Memory Leaks | Phase 1: SSE Infrastructure | Load test: 1000 connect/disconnect cycles, memory stays flat |
| Transaction Upgrade SQLITE_BUSY | Phase 2: Atomic Claim Protocol | Concurrency test: 20 agents claim same task, >95% succeed on first try |
| Cascading Workflow Outside Transaction | Phase 3: Workflow Automation | Integration test: kill server mid-cascade, verify rollback or completion |
| Event Broadcast Race | Phase 1: SSE Infrastructure | Timing test: receive event, immediate query returns 200 OK |
| HTTP/1.1 Six-Connection Limit | Phase 1: SSE Infrastructure | Multi-agent test: 10 clients on localhost, all receive events |
| Missing Last-Event-ID Resume | Phase 1: SSE Infrastructure | Chaos test: disconnect for 10s, reconnect, verify 0 missed events |
| Workflow Hook Infinite Loop | Phase 3: Workflow Automation | Fuzzing test: random task hierarchies, detect cycles before executing |
| Non-Idempotent Actions | Phase 2: Atomic Claim Protocol | Retry test: duplicate request returns 200 + cached result, no duplicate events |
| Prepared Statement Concurrency | Phase 2: Atomic Claim Protocol | Stress test: 100 parallel creates, 0 data corruption |
| Event Payload Size | Phase 1: SSE Infrastructure | Boundary test: 1MB task triggers error, not silent truncation |

---

## Sources

### SSE Implementation

- [GitHub - fastify/sse: Server-Sent Events for Fastify](https://github.com/fastify/sse) - Official Fastify SSE plugin
- [Avoid Fastify's reply.raw and reply.hijack](https://lirantal.com/blog/avoid-fastify-reply-raw-and-reply-hijack-despite-being-a-powerful-http-streams-tool) - Connection cleanup pitfalls
- [Server-Sent Events: A Comprehensive Guide](https://medium.com/@moali314/server-sent-events-a-comprehensive-guide-e4b15d147576) - Last-Event-ID and reconnection
- [EventSource 6-connection limit bug](https://bugs.chromium.org/p/chromium/issues/detail?id=275955) - HTTP/1.1 browser limits
- [How to Implement SSE in React](https://oneuptime.com/blog/post/2026-01-15-server-sent-events-sse-react/view) - Client cleanup patterns

### SQLite Concurrency

- [Write-Ahead Logging - SQLite](https://sqlite.org/wal.html) - Official WAL documentation
- [What to do about SQLITE_BUSY errors despite timeout](https://berthub.eu/articles/posts/a-brief-post-on-sqlite3-database-locked-despite-timeout/) - Transaction upgrade pitfall
- [SQLite Transaction Documentation](https://www.sqlite.org/lang_transaction.html) - BEGIN IMMEDIATE vs DEFERRED
- [Isolation In SQLite](https://sqlite.org/isolation.html) - Snapshot isolation and WAL visibility
- [Atomic Commit In SQLite](https://sqlite.org/atomiccommit.html) - Transaction atomicity guarantees

### Workflow Automation

- [Reliable Workflow Automation Platforms](https://www.stacksync.com/blog/reliable-workflow-automation-platforms-for-real-time-enterprise-sync) - Cascading failures
- [Make.com AI Agents: Patterns and Pitfalls](https://www.taskfoundry.com/2025/08/make-ai-agents-patterns-pitfalls-automation.html) - Infinite loops and self-triggering
- [Queue is not a workflow engine](https://debugg.ai/resources/queue-is-not-a-workflow-engine-durable-execution-temporal-step-functions-2025) - Task queue anti-patterns
- [Idempotent Consumer Pattern](https://microservices.io/patterns/communication-style/idempotent-consumer.html) - Deduplication strategies
- [Event Sourcing and State Machines](https://gist.github.com/eulerfx/4ac420a14422ac960222) - Transaction boundaries

### Event-Driven Architecture

- [Event Sourcing pattern - Azure](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing) - Consistency guarantees
- [State-Machine Replication: Concepts & Advances](https://www.emergentmind.com/topics/state-machine-replication-smr) - Atomicity in concurrent updates
- [Idempotent Command Handling](https://event-driven.io/en/idempotent_command_handling/) - Request deduplication

---

*Pitfalls research for: Multi-agent coordination features (SSE, workflow automation, atomic claims)*
*Researched: 2026-02-14*
*Confidence: HIGH - All critical pitfalls verified with official documentation + recent community sources*
