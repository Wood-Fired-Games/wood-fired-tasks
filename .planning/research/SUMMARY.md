# Project Research Summary

**Project:** Wood Fired Bugs - Task Tracking Service
**Domain:** Local Node.js/SQLite service hardening and polish milestone (v1.3+)
**Researched:** 2026-02-17
**Confidence:** HIGH

## Executive Summary

This research covers the hardening and polish phase for an existing task tracking service built on Fastify, SQLite (better-sqlite3), and native EventEmitter. The service is a single-user, local-first application running as a systemd-managed Node.js service with 518 passing tests. The key insight from this research is that **local service hardening is fundamentally different from cloud service hardening** — the focus must be on data safety, graceful restarts, and clear error messages rather than horizontal scaling, distributed tracing, or multi-region deployments.

The recommended approach is to add **minimal, high-value hardening** that enhances the existing architecture without over-engineering. This means focused additions in five areas: error handling standardization with `@fastify/sensible`, optional performance profiling with `0x` and `clinic`, testing depth through mutation testing (Stryker) and property-based testing (fast-check), local-appropriate metrics collection via `prom-client`, and logging enhancement using Pino's built-in capabilities. The existing stack is already well-architected — the hardening phase should build upon these foundations rather than replace them.

The primary risks identified are **over-engineering** and **observability overhead**. Research shows that applying cloud-native patterns (Kubernetes-style health probes, OpenTelemetry auto-instrumentation, circuit breakers) to a local SQLite service adds complexity without benefit and can degrade performance. The mitigation strategy is to follow the principle of **layered enhancement, not replacement** — wrapping existing components through decorator patterns and using official Fastify plugins rather than custom implementations.

## Key Findings

### Recommended Stack Additions

The existing stack (Fastify v5.7.4, better-sqlite3 v12.6.2, Vitest v4.0.18) requires only targeted additions, not replacements. All new dependencies are official Fastify packages or well-established tools with high weekly download counts.

**Core additions for hardening:**
- **`@fastify/sensible@^6.0.4`** (289.7K weekly downloads): HTTP error constructors and reply decorators (`reply.notFound()`, `reply.badRequest()`) — provides battle-tested HTTP error handling with minimal configuration
- **`@fastify/error@^4.2.0`** (4.9M weekly downloads): Custom error factory with codes, message interpolation, and cause chaining — integrates cleanly with Fastify's error handling lifecycle
- **`0x@^6.0.0`** (76.5K weekly downloads): Single-command CPU flamegraph generation — fastest path to actionable CPU insights for local profiling
- **`clinic@^13.0.0`**: NearForm's comprehensive profiling suite (Doctor, Flame, Bubbleprof, HeapProfiler) — for holistic analysis when 0x shows hotspots
- **`@stryker-mutator/core@^9.5.1`**: Mutation testing with Vitest v4 support — validates that 518 existing tests actually catch bugs, not just exercise code
- **`fast-check@^4.5.3`** (8.4M weekly downloads): Property-based testing for finding edge cases through generated inputs — complements example-based tests
- **`prom-client@^15.1.3`** (4.5M weekly downloads): Prometheus metrics for local/LAN-appropriate monitoring — exposes Node.js internals + custom metrics without external APM dependencies
- **`@vitest/coverage-v8@^4.0.18`**: Native V8 coverage provider — Vitest's recommended replacement for deprecated c8
- **`knip@^5.44.0`**: Modern replacement for archived `depcheck` — detects unused dependencies with better TypeScript support

**What NOT to add:** DataDog/NewRelic APM agents (overkill for LAN service), Winston logging (redundant with Pino), `depcheck` (archived June 2025), circuit breaker libraries (inappropriate for local SQLite), Redis cache layer (SQLite is already fast for local load).

### Expected Features

**Table Stakes (Must-Have Reliability):**
- Structured JSON logging with `NODE_ENV=production` handling — users expect correlatable logs for debugging
- Health check endpoint with DB connectivity check (`SELECT 1`) — systemd needs to verify service health
- Graceful shutdown with `forceCloseConnections: 'idle'` — SIGTERM should close connections cleanly
- Connection timeouts (`connectionTimeout`, `requestTimeout`, `keepAliveTimeout`) — prevent hung requests
- Database backup command using `VACUUM INTO` or `.backup()` API — single SQLite file needs periodic backup
- Exit code standards (0/1/2 per sysexits.h) — scripts need to detect success/failure
- Configuration validation at startup — fail fast on missing/bad env vars (`API_KEYS`, `DB_PATH`, `PORT`)
- WAL mode maintenance — periodic `PRAGMA wal_checkpoint(TRUNCATE)` to prevent WAL file bloat
- Process resource limits via systemd (`MemoryMax`, `CPUQuota`) — prevent runaway memory from affecting system

**Differentiators (Polish That Improves Experience):**
- **`tasks doctor` command** — self-service diagnostics (highest priority differentiator)
- Request ID propagation across API/CLI/MCP layers — makes debugging multi-agent issues tractable
- Event replay buffer (last 100 events in-memory) — SSE resilience for disconnected clients
- CLI progress indicators for operations > 2s — immediate UX improvement for long operations
- Colored CLI output consistency — visual scanning of task lists is faster
- Task statistics command (`tasks stats`) — productivity metrics and insights
- Database integrity check command (`tasks db-check`) — proactive corruption detection
- Shell completions for bash/zsh — power user convenience

**Anti-Features (Over-Engineering for Local Service):**
- Rate limiting — single human + trusted agents; connection limits sufficient
- Authentication frameworks beyond simple API keys — JWT/OAuth2 overkill for local service
- Circuit breakers — no external dependencies to fail; Fastify timeout handling sufficient
- Distributed tracing — single process; logs with request IDs sufficient
- Prometheus metrics server with continuous scraping — log-based metrics sufficient
- Database replication — single node; daily backups sufficient
- RBAC / per-user permissions — single user system
- Complex secrets management — `.env` file + systemd credentials sufficient
- Horizontal scaling patterns — single machine service

### Architecture Integration

The recommended hardening approach follows the **Decorator Pattern** — wrap or extend existing components rather than replace them. All hardening is additive; existing flows remain unchanged.

**Major components and integration points:**
1. **Rate Limiting Layer** — Fastify plugin registration (`@fastify/rate-limit`) with 100 req/min limit per API key; provides global protection against accidental abuse
2. **Health Check Enhancement** — Extend existing `/health` route with component status (DB, EventBus, disk space); keep lightweight (`SELECT 1` only, not `PRAGMA integrity_check`)
3. **Load Shedding** — Fastify plugin (`@fastify/under-pressure`) for automatic 503 responses when overloaded (event loop delay > 1s, heap > 512MB)
4. **Enhanced Graceful Shutdown** — Extend existing `onClose` hook with idempotency guard, log flush, and WAL checkpoint; keep simple (no complex signal handling)
5. **EventBus Reliability** — Add handler timeout protection, error stats, and health check method; isolated error handling prevents subscriber crashes
6. **SQLite Connection Resilience** — New `withRetry()` wrapper utility with exponential backoff for `SQLITE_BUSY` errors; transactions use existing `BEGIN IMMEDIATE` pattern
7. **Metrics Collection Layer** — In-memory metrics service with optional Prometheus export; aggregate in memory, flush periodically (not per-request)
8. **Structured Logging Enhancement** — Fastify hooks for request ID propagation; Pino redaction for sensitive fields; child loggers for request correlation

**Data flow (with hardening):**
```
Client -> [RateLimit] -> [UnderPressure] -> Route -> [Metrics] -> Service -> [Resilience] -> Repository -> SQLite
   ↓         ↓              ↓
[Logging] [Logging]   [HealthCheck]
```

### Critical Pitfalls

**1. Over-Engineering Health Checks for Local Service**
Implementing Kubernetes-style liveness/readiness probes causes restart loops and flapping states. The current `/health` endpoint doing `SELECT 1` is sufficient. **Avoid:** separate `/live` and `/ready` endpoints, `PRAGMA integrity_check` in health, automatic restarts on health failure. **Instead:** Single lightweight endpoint, cache result for 5 seconds if polled frequently, log and alert rather than restart.

**2. Monitoring That Hurts Performance**
OpenTelemetry or detailed Prometheus metrics can add 10-30% overhead to a local service. Default auto-instrumentation includes filesystem and HTTP instrumentation that's overkill. **Avoid:** Per-request metrics, continuous telemetry, `instrumentation-fs` auto-instrumentation. **Instead:** Start with structured logs, aggregate metrics in memory with 60-second flush, disable auto-instrumentation, enable detailed tracing only when `DEBUG_PERF=1`.

**3. SQLite WAL Over-Tuning**
Applying high-throughput web service recommendations (`mmap_size = 1GB`, `cache_size = 256MB`, `wal_autocheckpoint = 4000`) causes memory bloat and checkpoint latency spikes. **Avoid:** Increasing cache_size unless proven needed, manual checkpoint tuning, `synchronous = FULL`. **Instead:** Current config (`journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`) is optimal; monitor WAL size and investigate if >100MB rather than tuning.

**4. Excessive Logging in Production Mode**
Fastify's default `info` level logging with SSE heartbeats (30-second pings) creates GBs of log files. **Avoid:** Logging every request at INFO for local service, unbounded log growth, SSE ping noise in logs. **Instead:** Use `LOG_LEVEL=warn` for local production, filter SSE heartbeat events, implement log rotation, sample successful requests (1%) vs errors (100%).

**5. Complex Graceful Shutdown for Local Service**
Kubernetes-style graceful shutdown (30-second timeouts, connection draining, complex signal handling) adds 500 lines of code and still hangs. SQLite is file-based (no connection pool), SSE connections are local. **Avoid:** Complex signal handlers, connection draining, 30-second timeouts, shutdown libraries. **Instead:** Current `onClose` hook (close SSE, clear intervals, close DB) is sufficient; let OS clean up on SIGKILL if needed.

**6. SSE Connection Monitoring Overhead**
Adding per-connection metrics and detailed heartbeat logging causes event loop to spend more time updating metrics than broadcasting events. **Avoid:** Per-connection metadata, metrics in heartbeat callback, logging every connect/disconnect at INFO. **Instead:** Connection count only via `this.connections.size`, lazy metrics calculation, empty `ping` events, DEBUG-only connection logging.

**7. Idempotency Service Over-Engineering**
The existing SQLite-backed idempotency with hourly cleanup is atomic and sufficient. Adding Redis "for performance" adds failure modes. **Avoid:** Distributed caching, complex TTL management, "clock skew" handling. **Instead:** Keep current `idempotency_keys` table, simple 24-hour TTL, monitor table size (alert if >10k rows).

**8. Circuit Breakers for Local Dependencies**
Circuit breakers make sense for external HTTP services, not in-process SQLite or EventBus. They add complexity and false positives. **Avoid:** Circuit breaker libraries, "half-open" states for local resources. **Instead:** Direct error handling, retry with exponential backoff for `SQLITE_BUSY`, fail fast for real errors.

## Implications for Roadmap

Based on research, suggested phase structure for hardening:

### Phase 1: Core Reliability Fundamentals
**Rationale:** Foundation must be solid before adding observability; these prevent data loss and enable debugging
**Delivers:** Error handling standardization, health checks, graceful shutdown tuning, config validation, WAL maintenance
**Addresses (from FEATURES.md):** Structured JSON logging, health check endpoint, graceful shutdown, connection timeouts, exit codes, config validation, WAL checkpoint
**Uses (from STACK.md):** `@fastify/sensible`, `@fastify/error`, existing Pino configuration
**Avoids (from PITFALLS.md):** Over-engineered health checks (keep `SELECT 1` only), complex graceful shutdown (enhance existing hook, don't replace)
**Research flags:** Standard patterns — skip additional research

### Phase 2: Database Reliability
**Rationale:** Data layer hardening protects against the most critical failure mode (data loss)
**Delivers:** SQLite resilience wrapper, backup command, integrity check command, idempotency verification
**Addresses (from FEATURES.md):** Database backup command, database integrity check, WAL mode maintenance
**Uses (from STACK.md):** Native better-sqlite3 transactions, `VACUUM INTO` / `.backup()` API
**Avoids (from PITFALLS.md):** WAL over-tuning (keep current config), idempotency over-engineering (SQLite is sufficient)
**Research flags:** Standard SQLite patterns — skip additional research

### Phase 3: API Protection
**Rationale:** Protect against accidental abuse and resource exhaustion after fundamentals are solid
**Delivers:** Rate limiting, load shedding (under-pressure), connection limits
**Addresses (from FEATURES.md):** Connection timeouts (already in Phase 1), process resource limits
**Uses (from STACK.md):** `@fastify/rate-limit`, `@fastify/under-pressure`
**Avoids (from PITFALLS.md):** Circuit breakers for local resources
**Research flags:** Plugin configuration may need tuning based on actual load — light research recommended

### Phase 4: Observability
**Rationale:** Understanding system behavior requires baseline metrics and structured logging; doing this after protection ensures observability doesn't hurt performance
**Delivers:** Request ID propagation, metrics service, structured logging enhancement, `tasks doctor` command
**Addresses (from FEATURES.md):** Request ID propagation, diagnostic command (`tasks doctor`), event replay buffer
**Uses (from STACK.md):** `prom-client` for local metrics, Pino configuration
**Avoids (from PITFALLS.md):** Monitoring overhead (aggregate in memory, flush periodically), SSE connection monitoring overhead
**Research flags:** Prometheus integration may need environment-specific research if user wants external scraping

### Phase 5: Testing Depth
**Rationale:** Validate quality after foundation is solid; mutation testing is slow and should run on mature codebase
**Delivers:** Mutation testing (Stryker), property-based testing (fast-check), coverage reporting (v8)
**Uses (from STACK.md):** `@stryker-mutator/core`, `@stryker-mutator/vitest-runner`, `fast-check`, `@vitest/coverage-v8`
**Research flags:** Mutation testing configuration may need iteration — light research recommended

### Phase 6: UX Polish
**Rationale:** Daily-use improvements are lowest priority for hardening but complete the milestone
**Delivers:** CLI progress indicators, colored output consistency, task statistics, shell completions
**Addresses (from FEATURES.md):** CLI progress indicators, colored CLI output, task statistics, shell completions
**Avoids (from PITFALLS.md):** N/A — these are safe presentation-layer changes
**Research flags:** Standard CLI patterns — skip additional research

### Phase 7: Infrastructure Hardening
**Rationale:** System-level protection is least urgent for trusted local use but completes hardening
**Delivers:** systemd hardening options, resource limits, backup automation, retention policy
**Addresses (from FEATURES.md):** Process resource limits, database backup automation
**Avoids (from PITFALLS.md):** N/A — systemd changes are well-documented
**Research flags:** systemd unit testing requires staging VM — medium research recommended

### Phase Ordering Rationale

The order follows **dependency chains** identified in architecture research:
1. Core reliability must come first — everything else depends on stable error handling and health checks
2. Database reliability is next — protects against data loss, enables safe experimentation in later phases
3. API protection follows — protects against abuse but requires healthy service to protect
4. Observability comes after protection — ensures monitoring doesn't hurt performance and has stable baseline to measure
5. Testing depth follows — mutation testing on unstable codebase produces noisy results
6. UX polish is last — presentation layer changes don't affect system reliability
7. Infrastructure hardening is final — least critical for single-user local service

**Risk mitigation:** This ordering avoids the pitfall of "monitoring a broken system" — by the time observability is added, the service is already reliable. It also ensures that if earlier phases run long, the critical hardening (Phases 1-2) is already complete.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (API Protection):** Rate limit thresholds need tuning based on actual usage patterns; `@fastify/rate-limit` configuration may need iteration
- **Phase 4 (Observability):** If Prometheus export is desired for external scraping, integration details need validation; in-memory metrics are standard
- **Phase 7 (Infrastructure):** systemd unit testing requires VM or container setup; hard to test in dev environment

Phases with standard patterns (skip research-phase):
- **Phase 1 (Core Reliability):** Well-documented Fastify patterns, official plugins
- **Phase 2 (Database Reliability):** SQLite WAL behavior is well-understood, standard patterns
- **Phase 5 (Testing):** Stryker and fast-check have clear Vitest integration docs
- **Phase 6 (UX Polish):** Established CLI patterns, low technical risk

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All recommendations verified with official Fastify documentation, npm download statistics, and version compatibility matrices |
| Features | HIGH | Feature categorization (table stakes vs differentiators vs anti-features) based on local service constraints analysis; aligns with systemd and SSE best practices |
| Architecture | HIGH | Integration patterns use official Fastify plugins; decorator pattern is standard for hardening; dependency chains are logical |
| Pitfalls | HIGH | All 8 critical pitfalls verified with multiple sources (official docs, community best practices, SQLite documentation); many are known anti-patterns |

**Overall confidence:** HIGH

### Gaps to Address

1. **MCP stderr handling:** Current implementation may have Windows issues with heavy stderr; need timeout handling validation during Phase 1
2. **Event buffer sizing:** How many events to buffer for replay? Memory constraints need validation during Phase 4
3. **Backup restoration:** How to restore from backup needs documentation; not just backup strategy
4. **Rate limit thresholds:** 100 req/min is a starting point; actual usage patterns may require adjustment during Phase 3
5. **Prometheus export:** Decision needed on whether local Grafana/Prometheus is desired or if log-based metrics are sufficient

## Sources

### Primary (HIGH confidence)
- [@fastify/sensible NPM](https://www.npmjs.com/package/@fastify/sensible) — v6.0.4, 289.7K weekly downloads
- [@fastify/error NPM](https://www.npmjs.com/package/@fastify/error) — v4.2.0, 4.9M weekly downloads
- [Stryker Releases](https://github.com/stryker-mutator/stryker-js/releases) — v9.5.1 with Vitest fixtures support
- [fast-check NPM](https://www.npmjs.com/package/fast-check) — v4.5.3, 8.4M weekly downloads
- [prom-client NPM](https://www.npmjs.com/package/prom-client) — v15.1.3, 4.5M weekly downloads
- [0x NPM](https://www.npmjs.com/package/0x) — v6.0.0, 76.5K weekly downloads
- [SQLite WAL Documentation](https://sqlite.org/wal.html) — Official WAL mode guidance
- [systemd.exec(5) Manual](https://man7.org/linux/man-pages/man5/systemd.exec.5.html) — Security hardening options
- [Fastify Server Configuration Reference](https://fastify.io/docs/latest/Reference/Server/) — Timeout, connection options

### Secondary (MEDIUM confidence)
- [Stop Running node index.js in Production - 2025 Guide](https://www.beyondthesemicolon.com/stop-running-node-index-js-in-production-a-2025-ready-field-guide/) — Simple deployment patterns for local services
- [SQLite in Production with WAL](https://medium.com/@victoriadotdev/sqlite-in-production-with-wal-be89e169a606) — WAL mode best practices
- [Sandboxing systemd Services](https://ejaaskel.dev/sandboxing-systemd-services/) — Practical hardening guide
- [Server-Sent Events: A Practical Guide](https://tigerabrodi.blog/server-sent-events-a-practical-guide-for-the-real-world) — Production patterns
- [Node.js CLI Best Practices](https://openjsf.org/blog/node-js-command-line-interface-applications-best-practices-a-guide) — OpenJS Foundation guide

### Tertiary (LOW confidence / Validation needed)
- [OpenTelemetry Fastify Monitoring](https://oneuptime.com/blog/post/2026-02-06-monitor-fastify-applications-opentelemetry/view) — Observability trends (2026 date, needs validation)
- [Dynatrace Observability Predictions 2026](https://www.dynatrace.com/news/blog/six-observability-predictions-for-2026/) — When observability helps vs hurts

---
*Research completed: 2026-02-17*
*Ready for roadmap: yes*
*Next step: Requirements definition for Phase 1 (Core Reliability)*
