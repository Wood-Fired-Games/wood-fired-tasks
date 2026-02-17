# Requirements: Wood Fired Bugs v1.4

**Defined:** 2026-02-17
**Core Value:** Any agent on the local network can reliably create, find, and update work items in real time — making this the single source of truth for all Wood Fired Games task tracking.

## v1.4 Requirements

Hardening and polish milestone — improving reliability, observability, and user experience.

### Reliability Fundamentals

- [ ] **RELI-01**: Service emits structured JSON logs with `NODE_ENV=production` handling and Pino redaction for sensitive fields
- [ ] **RELI-02**: Health check endpoint (`GET /health`) verifies DB connectivity with `SELECT 1` and reports component status
- [ ] **RELI-03**: Graceful shutdown closes idle connections with `forceCloseConnections: 'idle'` and performs WAL checkpoint
- [ ] **RELI-04**: Connection timeouts configured (`connectionTimeout`, `requestTimeout`, `keepAliveTimeout`) to prevent hung requests
- [ ] **RELI-05**: CLI `tasks backup` command creates SQLite backup using `VACUUM INTO` or `.backup()` API
- [ ] **RELI-06**: Configuration validation at startup fails fast on missing/bad environment variables with clear error messages
- [ ] **RELI-07**: Periodic WAL checkpoint prevents WAL file bloat (automatic or via scheduled task)
- [ ] **RELI-08**: Exit codes follow sysexits.h standard (0=success, 1=general error, 2=misuse) for script integration

### Observability

- [ ] **OBSV-01**: `tasks doctor` command performs self-service diagnostics (DB connectivity, disk space, config validity)
- [ ] **OBSV-02**: Request ID propagated across REST API, MCP, and CLI layers for traceability
- [ ] **OBSV-03**: Event replay buffer (last 100 events in-memory) enables SSE resilience for disconnected clients
- [ ] **OBSV-04**: `tasks stats` command displays task statistics (counts by status, recent activity, agent productivity)
- [ ] **OBSV-05**: `tasks db-check` command runs `PRAGMA integrity_check` for proactive corruption detection

### UX Polish

- [ ] **UXPL-01**: CLI progress indicators display for operations taking longer than 2 seconds
- [ ] **UXPL-02**: Colored CLI output is consistent across all commands with `NO_COLOR` support
- [ ] **UXPL-03**: Shell completions provided for bash and zsh

### Data Model

- [ ] **DATA-01**: New task status "backlogged" added to status lifecycle
- [ ] **DATA-02**: Backlogged tasks are excluded from agent claim operations (agents cannot claim backlogged tasks)
- [ ] **DATA-03**: Backlogged tasks can be transitioned to open by authorized users

### Testing & Quality

- [ ] **TEST-01**: Mutation testing with Stryker validates test suite effectiveness
- [ ] **TEST-02**: Property-based testing with fast-check supplements example-based tests
- [ ] **TEST-03**: Unused dependency detection with knip integrated into CI

### Infrastructure

- [ ] **INFR-01**: systemd service unit includes resource limits (`MemoryMax`, `CPUQuota`)
- [ ] **INFR-02**: systemd security hardening options applied (`DynamicUser`, `ProtectSystem`, etc.)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Rate limiting | Single human + trusted agents; connection limits sufficient |
| Circuit breakers | No external dependencies to fail; Fastify timeout handling sufficient |
| Distributed tracing | Single process; logs with request IDs sufficient |
| Prometheus metrics server | Log-based metrics sufficient for local service |
| Database replication | Single node; daily backups sufficient |
| RBAC / per-user permissions | Single user system |
| JWT/OAuth2 authentication | API key auth sufficient for local service |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| RELI-01 | TBD | Pending |
| RELI-02 | TBD | Pending |
| RELI-03 | TBD | Pending |
| RELI-04 | TBD | Pending |
| RELI-05 | TBD | Pending |
| RELI-06 | TBD | Pending |
| RELI-07 | TBD | Pending |
| RELI-08 | TBD | Pending |
| OBSV-01 | TBD | Pending |
| OBSV-02 | TBD | Pending |
| OBSV-03 | TBD | Pending |
| OBSV-04 | TBD | Pending |
| OBSV-05 | TBD | Pending |
| UXPL-01 | TBD | Pending |
| UXPL-02 | TBD | Pending |
| UXPL-03 | TBD | Pending |
| DATA-01 | TBD | Pending |
| DATA-02 | TBD | Pending |
| DATA-03 | TBD | Pending |
| TEST-01 | TBD | Pending |
| TEST-02 | TBD | Pending |
| TEST-03 | TBD | Pending |
| INFR-01 | TBD | Pending |
| INFR-02 | TBD | Pending |

**Coverage:**
- v1.4 requirements: 23 total
- Mapped to phases: 0
- Unmapped: 23

---
*Requirements defined: 2026-02-17*
*Last updated: 2026-02-17*
