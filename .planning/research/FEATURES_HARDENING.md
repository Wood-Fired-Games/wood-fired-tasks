# Feature Landscape: Production Hardening and Polish

**Project:** Wood Fired Bugs - Task Tracking Service
**Domain:** Local Node.js/TypeScript service with SQLite, Fastify, SSE, and MCP
**Milestone:** Hardening and Polish (v1.3+)
**Researched:** 2026-02-17
**Research Mode:** Ecosystem (hardening features for local production services)
**Overall Confidence:** HIGH (verified with Fastify docs, systemd manuals, MCP specs, SQLite best practices)

---

## Executive Summary

Wood Fired Bugs is a **single-user, local-first task tracking service** running as a systemd-managed Node.js service. This research focuses on hardening and polish features that improve reliability, observability, and UX without introducing cloud-scale complexity inappropriate for a local service.

**Key insight:** For local services, "production hardening" means **surviving restarts, protecting data, and failing gracefully** - not horizontal scaling or multi-region deployments. The threat model is process crashes, disk failures, and user errors - not malicious attackers.

**Recommended approach:**
- **Table stakes:** Structured logging, health checks, graceful shutdown, DB backups, connection limits
- **Differentiators:** Enhanced CLI UX, SSE resilience, diagnostic commands, systemd hardening
- **Anti-features:** Authentication frameworks, metrics servers, circuit breakers (overkill for local)

---

## Table Stakes (Must-Have Reliability)

Features users expect from any production service. Missing these = service feels unreliable.

| Feature | Why Expected | Complexity | Dependencies | Notes |
|---------|--------------|------------|--------------|-------|
| **Structured JSON Logging** | Debugging failures requires correlatable logs | LOW | Pino (already configured) | Current Pino config good; add `NODE_ENV=production` handling |
| **Health Check Endpoint** | systemd needs to verify service is actually healthy | LOW | Fastify route exists | Expand `/health` to include DB connectivity check |
| **Graceful Shutdown** | SIGTERM should close connections cleanly | LOW | Already implemented | Add `forceCloseConnections: 'idle'` to Fastify config |
| **Connection Timeouts** | Prevent hung requests from consuming resources | LOW | Fastify config | Add `connectionTimeout`, `requestTimeout`, `keepAliveTimeout` |
| **Database Backup Command** | Single SQLite file needs periodic backup | LOW | CLI command | Use `VACUUM INTO` or `backup()` API; daily via systemd timer |
| **Exit Code Standards** | Scripts need to detect success/failure | LOW | CLI entry points | Return 0/1/2 per sysexits.h conventions |
| **Configuration Validation** | Fail fast on missing/bad env vars | LOW | Startup sequence | Validate `API_KEYS`, `DB_PATH`, `PORT` at boot |
| **WAL Mode Maintenance** | SQLite WAL files grow indefinitely | LOW | DB connection | Add `PRAGMA wal_checkpoint(TRUNCATE)` periodic sweep |
| **Process Resource Limits** | Prevent runaway memory from affecting system | LOW | systemd service | Add `MemoryMax`, `CPUQuota` to unit file |
| **SSE Heartbeat** | Proxies timeout idle connections | LOW | SSE plugin | Already configured with 30s heartbeat |

### Critical Notes

**Health Check Depth:**
- **Shallow (`/health/live`):** Process is running (for systemd watchdog)
- **Deep (`/health/ready`):** DB accessible + WAL not corrupted (for load balancing if ever needed)
- Current implementation only has shallow - needs DB connectivity check

**Database Backup Strategy:**
- SQLite makes this easy - hot backup via `.backup()` or `VACUUM INTO`
- For local: daily backups with 7-day retention sufficient
- Store backups in `~/.local/share/wood-fired-bugs/backups/`
- **NOT table stakes:** Continuous replication, point-in-time recovery (overkill)

---

## Differentiators (Polish That Improves Experience)

Features that make the service pleasant to use but aren't strictly required.

| Feature | Value Proposition | Complexity | Dependencies | Notes |
|---------|-------------------|------------|--------------|-------|
| **CLI Progress Indicators** | Long operations (migrations, exports) need feedback | LOW | CLI output layer | Spinner for operations > 2s via `cli-spinners` |
| **Colored CLI Output** | Visual scanning of task lists is faster | LOW | Chalk (already used) | Add consistent color scheme: green=success, red=error, yellow=warning |
| **Task Statistics Command** | `tasks stats` shows productivity metrics | LOW | Query layer | Task completion rate by project, average age, overdue count |
| **SSE Reconnection Logic** | Clients auto-recover from network hiccups | LOW | EventSource config | Document client-side patterns in skills |
| **Diagnostic Command** | `tasks doctor` checks system health | MEDIUM | Health checks | Verify DB, permissions, disk space, version compatibility |
| **Configuration Command** | `tasks config` validates/edits settings | LOW | CLI framework | Show effective config, validate env vars |
| **Request ID Propagation** | Correlate logs across layers | MEDIUM | Middleware | Generate `X-Request-ID` in API, propagate to CLI/MCP |
| **Event Replay Buffer** | SSE clients can catch up after disconnect | MEDIUM | SSE manager | In-memory ring buffer of last 100 events |
| **CLI Shell Completions** | Tab completion for task/project IDs | MEDIUM | CLI framework | Generate completions for bash/zsh |
| **Database Integrity Check** | `tasks db-check` validates SQLite | LOW | DB command | Run `PRAGMA integrity_check`, report issues |

### Most Valuable Differentiators (Prioritize)

1. **`tasks doctor`** - Single command to diagnose "why isn't it working?"
2. **Request ID propagation** - Makes debugging multi-agent issues tractable
3. **Event replay buffer** - SSE resilience for long-running agents
4. **CLI progress indicators** - Immediate UX improvement

---

## Anti-Features (Over-Engineering for Local Service)

Features that seem valuable but create inappropriate complexity for a local, single-user service.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Rate Limiting** | "Prevent abuse" | Single human + trusted agents; adds complexity | Connection limits sufficient |
| **Authentication Framework** | "Security" | Already have API keys; JWT/OAuth2 overkill | Keep simple API key auth |
| **Circuit Breaker** | "Resilience" | No external dependencies to fail | Fastify timeout handling sufficient |
| **Distributed Tracing** | "Observability" | Single process; logs sufficient | Request ID propagation |
| **Metrics Server (Prometheus)** | "Monitoring" | No ops team to monitor; log-based sufficient | Pino metrics in logs |
| **Redis Cache Layer** | "Performance" | SQLite is already fast for local load | Better SQLite tuning |
| **Database Replication** | "High availability" | Single node; backups sufficient | Daily SQLite backups |
| **RBAC / Per-User Permissions** | "Access control" | Single user system | No change needed |
| **Complex Secrets Management** | "Security" | Environment variables sufficient | `.env` file + systemd creds |
| **Horizontal Scaling** | "Future-proofing" | Single machine service | Vertical scaling (better hardware) |

### Key Principle

**Local service constraints are features, not limitations.**

- Single user = no permission complexity
- Single machine = no networking complexity
- Single process = no distributed systems complexity
- Trusted agents = no authentication complexity

Every anti-feature above would add operational burden with no benefit for this use case.

---

## Feature Dependencies

```
Graceful Shutdown
    └──requires──> Health Check (for draining)
                       └──requires──> Fastify Server

Request ID Propagation
    └──requires──> Structured Logging
                       └──requires──> Pino Config

Event Replay Buffer
    └──requires──> SSE Manager (existing)
                           └──requires──> In-Memory Buffer

tasks doctor
    └──requires──> DB Connectivity Check
    └──requires──> Health Check Logic (reuse)
    └──requires──> CLI Framework

Database Backup
    └──requires──> DB Connection
    └──requires──> systemd Timer (optional, can be manual)

WAL Checkpoint
    └──requires──> DB Connection
    └──requires──> Scheduled Execution (ClaimReleaseService pattern)
```

### Dependency Notes

- **Graceful shutdown requires health check:** During shutdown, health check returns 503 to stop new traffic
- **Event replay buffer enhances SSE:** Enables catch-up for disconnected clients
- **Request ID conflicts with silent mode:** Some users want minimal output; make optional

---

## Phase Recommendations

### Phase 1: Reliability Fundamentals

Must-have hardening for production confidence:

1. **Structured logging with request IDs** - Debugging multi-agent interactions
2. **Health check with DB connectivity** - systemd integration
3. **Graceful shutdown tuning** - `forceCloseConnections`, proper timeout handling
4. **Configuration validation** - Fail fast on startup
5. **WAL checkpoint scheduling** - Prevent WAL file bloat

**Rationale:** These prevent data loss and enable debugging. They are the foundation.

### Phase 2: Observability

Understanding what the system is doing:

1. **`tasks doctor` command** - Self-service diagnostics
2. **Database integrity check** - Proactive corruption detection
3. **Request ID propagation** - Trace request flow
4. **Event replay buffer** - SSE resilience

**Rationale:** These help answer "why did X happen?" after the fundamentals are solid.

### Phase 3: UX Polish

Pleasant to use daily:

1. **Progress indicators for long operations** - Feedback during migrations
2. **CLI colored output consistency** - Visual polish
3. **Task statistics command** - Productivity insights
4. **Shell completions** - Power user convenience

**Rationale:** These improve daily use but aren't blockers.

### Phase 4: Infrastructure Hardening

System-level protection:

1. **systemd hardening options** - `DynamicUser`, `ProtectSystem`, `PrivateTmp`
2. **Resource limits** - Memory/CPU quotas
3. **Database backup automation** - Daily via systemd timer
4. **Backup retention policy** - 7-day rotation

**Rationale:** These protect the host system; least urgent for trusted local use.

---

## Complexity Assessment

| Phase | Features | Total Complexity | Risk |
|-------|----------|------------------|------|
| Phase 1: Fundamentals | 5 | LOW | LOW - well-documented patterns |
| Phase 2: Observability | 4 | LOW-MEDIUM | LOW - mostly new commands |
| Phase 3: UX Polish | 4 | LOW | LOW - presentation layer only |
| Phase 4: Infrastructure | 4 | MEDIUM | MEDIUM - systemd changes need testing |

**Overall complexity:** LOW - All features are additive, not architectural changes.

---

## Local Service Specific Considerations

### What "Production" Means Here

| Cloud Service | Wood Fired Bugs |
|---------------|-----------------|
| 99.99% uptime SLA | Survives laptop sleep/resume |
| Horizontal scaling | Restart on crash |
| Multi-region | Home network accessible |
| Compliance requirements | Data doesn't leave machine |
| 24/7 ops team | Stuart checks logs |
| Security team | Common sense |

### Implications for Hardening

1. **No need for:** load balancers, blue/green deploys, canary releases, feature flags
2. **Critical for:** data integrity, graceful restarts, clear error messages
3. **Valuable:** self-diagnostic tools (user is the ops team)

### SSE/MCP Specific Considerations

| Aspect | Cloud Pattern | Local Pattern |
|--------|--------------|---------------|
| SSE connections | Horizontal scaling with sticky sessions | Single process, single client per window |
| MCP errors | Centralized logging, alerting | stderr to Claude Code console |
| Reconnection | Load balancer health checks | Client-side EventSource auto-reconnect |

---

## Confidence Assessment

| Area | Confidence | Reason |
|------|------------|--------|
| Table Stakes | HIGH | Standard Fastify/SQLite patterns well-documented |
| Differentiators | HIGH | CLI UX patterns established, implementation straightforward |
| Anti-Features | HIGH | Clear mismatch with local service constraints |
| Phase Ordering | MEDIUM | Dependencies logical, but could parallelize some |
| Complexity Estimates | HIGH | All features are incremental improvements |

---

## Gaps to Address

1. **MCP stderr handling:** Current implementation may have Windows issues with heavy stderr; need timeout handling
2. **systemd unit testing:** Hard to test in dev; need staging VM
3. **Backup restoration:** How to restore from backup needs documentation
4. **Event buffer sizing:** How many events to buffer? Memory constraints?

---

## Sources

### Fastify & Node.js
- [Fastify Server Configuration Reference](https://fastify.io/docs/latest/Reference/Server/) - Timeout, connection options
- [Fastify Graceful Shutdown Discussion](https://github.com/fastify/fastify/issues/3617) - Connection draining behavior
- [Stop Running node index.js in Production - 2025 Guide](https://www.beyondthesemicolon.com/stop-running-node-index-js-in-production-a-2025-ready-field-guide/) - Deployment patterns
- [Node.js Monitoring Best Practices 2025](https://www.atatus.com/blog/nodejs-monitoring-best-practices/) - Metrics and observability

### SQLite
- [SQLite in Production with WAL](https://medium.com/@victoriadotdev/sqlite-in-production-with-wal-be89e169a606) - WAL mode best practices
- [Backup Strategies for SQLite](https://oldmoe.blog/2024/04/30/backup-strategies-for-sqlite-in-production/) - Hot backup patterns

### systemd
- [systemd.exec(5) Manual](https://man7.org/linux/man-pages/man5/systemd.exec.5.html) - Security hardening options
- [Sandboxing systemd Services](https://ejaaskel.dev/sandboxing-systemd-services/) - Practical hardening guide
- [ProtectSystem Setting - Linux Audit](https://linux-audit.com/systemd/settings/units/protectsystem/) - Filesystem isolation

### SSE
- [Server-Sent Events: A Practical Guide](https://tigerabrodi.blog/server-sent-events-a-practical-guide-for-the-real-world) - Production patterns
- [Ensuring Reliable Streaming with SSE](https://ithy.com/article/sse-streaming-retries-v0p7rdp1) - Reconnection logic
- [MDN Using Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) - Browser behavior

### MCP
- [MCP Error Handling Best Practices](https://mcpcat.io/guides/error-handling-custom-mcp-servers/) - Stdio error handling
- [MCP Stdio Transport Spec](https://cnb.cool/baibaiyaonuli/mcp-for-beginners/-/blob/main/03-GettingStarted/05-stdio-server/README.md) - Transport requirements
- [Complete MCP Guide 2025](https://dev.to/kevinz103/the-complete-mcp-guide-for-developers2025-edition-ana) - Production patterns

### CLI UX
- [Node.js CLI Best Practices](https://openjsf.org/blog/node-js-command-line-interface-applications-best-practices-a-guide) - OpenJS Foundation guide
- [The CLI Book - Error Handling](https://www.oreilly.com/library/view/the-cli-book/9781484231777/A456043_1_En_3_Chapter.html) - CLI patterns
- [CLI Error Handling Best Practices](https://www.grizzlypeaksoftware.com/library/cli-error-handling-and-user-friendly-messages-qgugu9kg) - Error classification

---

*Feature research for: Wood Fired Bugs hardening and polish milestone*
*Researched: 2026-02-17*
