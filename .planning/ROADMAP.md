# Roadmap: Wood Fired Bugs v1.4 Hardening and Polish

**Defined:** 2026-02-17
**Milestone:** v1.4 Hardening and Polish
**Previous Phase Completed:** 16
**Starting Phase:** 17
**Depth:** Standard

---

## Phases

- [ ] **Phase 17: Core Reliability Fundamentals** - Service reliability, health checks, graceful shutdown, logging
- [x] **Phase 18: Database & Status Model** - Backup command, backlogged status lifecycle (completed 2026-02-17)
- [ ] **Phase 19: Observability** - Doctor command, request IDs, stats, integrity checks
- [ ] **Phase 20: Testing Depth** - Mutation testing, property testing, unused deps detection
- [ ] **Phase 21: UX Polish** - Progress indicators, colored output, shell completions
- [ ] **Phase 22: Infrastructure Hardening** - systemd resource limits, security hardening

---

## Phase Details

### Phase 17: Core Reliability Fundamentals
**Goal:** Service runs reliably with proper logging, health monitoring, graceful shutdown, and configuration validation

**Depends on:** Phase 16 (completed)

**Requirements:** RELI-01, RELI-02, RELI-03, RELI-04, RELI-06, RELI-07, RELI-08

**Success Criteria** (what must be TRUE):
1. User can query `/health` endpoint and see DB connectivity status (SELECT 1 succeeds)
2. Service emits structured JSON logs in production mode with sensitive fields redacted
3. Service gracefully shuts down on SIGTERM: closes idle connections and performs WAL checkpoint
4. Service fails fast at startup with clear error message if required env vars are missing/invalid
5. Service returns sysexits.h standard exit codes (0=success, 1=general error, 2=misuse) for script integration
6. WAL file size stays bounded due to periodic checkpoint (not growing unbounded)

**Plans:** 4 plans in 3 waves

**Plan List:**
- [ ] **17-01-PLAN.md** — Configuration validation and structured logging (RELI-01, RELI-06)
- [ ] **17-02-PLAN.md** — Health check endpoint and connection timeouts (RELI-02, RELI-04)
- [ ] **17-03-PLAN.md** — Graceful shutdown and WAL checkpointing (RELI-03, RELI-07, RELI-08)
- [ ] **17-04-PLAN.md** — Tests for reliability features (TDD plan)

**Wave Structure:**
```
Wave 1: 17-01 (config/logging), 17-02 (health/timeouts) — parallel
Wave 2: 17-03 (shutdown/WAL) — depends on 17-01
Wave 3: 17-04 (tests) — depends on 17-01, 17-02, 17-03
```

---

### Phase 18: Database & Status Model
**Goal:** Data is safely backed up and backlogged status enables task triage workflow

**Depends on:** Phase 17

**Requirements:** RELI-05, DATA-01, DATA-02, DATA-03

**Success Criteria** (what must be TRUE):
1. User can run `tasks backup` and creates a valid SQLite backup file
2. User can create a task with status "backlogged"
3. Agents attempting to claim a backlogged task receive clear rejection (backlogged tasks excluded from claim operations)
4. Authorized users can transition backlogged tasks to "open" status
5. Status lifecycle correctly includes backlogged -> open -> in_progress -> done -> closed

**Plans:** 2/2 plans complete

**Plan List:**
- [ ] **18-01-PLAN.md** — SQLite backup CLI command (RELI-05)
- [ ] **18-02-PLAN.md** — Backlogged status lifecycle, migration, and tests (DATA-01, DATA-02, DATA-03)

**Wave Structure:**
```
Wave 1: 18-01 (backup command), 18-02 (backlogged status) — parallel
```

---

### Phase 19: Observability
**Goal:** Users can diagnose issues, trace requests, and monitor system health

**Depends on:** Phase 18

**Requirements:** OBSV-01, OBSV-02, OBSV-03, OBSV-04, OBSV-05

**Success Criteria** (what must be TRUE):
1. User can run `tasks doctor` and see diagnostics: DB connectivity, disk space, config validity
2. Request IDs propagate across REST API, MCP, and CLI layers (visible in logs/responses)
3. SSE clients reconnecting with Last-Event-ID receive replay of last 100 events
4. User can run `tasks stats` and see task counts by status, recent activity, agent productivity
5. User can run `tasks db-check` and see PRAGMA integrity_check results

**Plans:** 2 plans in 1 wave

**Plan List:**
- [ ] **19-01-PLAN.md** — CLI diagnostic commands: doctor, stats, db-check (OBSV-01, OBSV-04, OBSV-05)
- [ ] **19-02-PLAN.md** — Request ID propagation and SSE buffer reduction (OBSV-02, OBSV-03)

**Wave Structure:**
```
Wave 1: 19-01 (CLI diagnostics), 19-02 (request IDs + SSE buffer) — parallel
```

---

### Phase 20: Testing Depth
**Goal:** Test suite quality is validated beyond line coverage

**Depends on:** Phase 19

**Requirements:** TEST-01, TEST-02, TEST-03

**Success Criteria** (what must be TRUE):
1. Mutation testing with Stryker runs and reports mutation score
2. Property-based tests with fast-check supplement example-based tests
3. Unused dependency detection with knip runs in CI and reports findings
4. CI fails if unused dependencies are detected (or explicit exclusions documented)

**Plans:** TBD

---

### Phase 21: UX Polish
**Goal:** CLI experience is polished with visual feedback and convenience features

**Depends on:** Phase 20

**Requirements:** UXPL-01, UXPL-02, UXPL-03

**Success Criteria** (what must be TRUE):
1. CLI displays progress indicator for operations taking longer than 2 seconds
2. All CLI commands produce consistent colored output respecting NO_COLOR environment variable
3. Shell completions work for bash and zsh (tab completion for commands, flags, and task IDs)

**Plans:** TBD

---

### Phase 22: Infrastructure Hardening
**Goal:** Service runs securely with resource limits under systemd

**Depends on:** Phase 21

**Requirements:** INFR-01, INFR-02

**Success Criteria** (what must be TRUE):
1. systemd service unit includes MemoryMax and CPUQuota limits
2. systemd security hardening options applied (DynamicUser, ProtectSystem, etc.)
3. Service starts and runs correctly with hardened systemd configuration

**Plans:** TBD

---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 17. Core Reliability | 0/4 | Not started | - |
| 18. Database & Status | 0/2 | Complete    | 2026-02-17 |
| 19. Observability | 0/2 | Not started | - |
| 20. Testing Depth | 0/TBD | Not started | - |
| 21. UX Polish | 0/TBD | Not started | - |
| 22. Infrastructure | 0/TBD | Not started | - |

---

## Coverage

**v1.4 Requirements: 23 total**

| Phase | Requirements | Count |
|-------|--------------|-------|
| 17 | RELI-01, RELI-02, RELI-03, RELI-04, RELI-06, RELI-07, RELI-08 | 7 |
| 18 | RELI-05, DATA-01, DATA-02, DATA-03 | 4 |
| 19 | OBSV-01, OBSV-02, OBSV-03, OBSV-04, OBSV-05 | 5 |
| 20 | TEST-01, TEST-02, TEST-03 | 3 |
| 21 | UXPL-01, UXPL-02, UXPL-03 | 3 |
| 22 | INFR-01, INFR-02 | 2 |

**Total Mapped: 23/23 (100%)**
**Orphans: 0**

---

## Dependencies

```
Phase 17 (Core Reliability)
    ↓
Phase 18 (Database & Status)
    ↓
Phase 19 (Observability)
    ↓
Phase 20 (Testing Depth)
    ↓
Phase 21 (UX Polish)
    ↓
Phase 22 (Infrastructure)
```

Rationale:
- Core reliability must be solid before adding data features
- Database reliability and backup needed before observability that queries DB
- Testing depth relies on stable codebase
- UX polish is presentation layer (lowest priority)
- Infrastructure hardening is final system-level protection

---

## Research Flags

Phases needing deeper research during planning:
- **Phase 17 (Core Reliability):** MCP stderr handling validation on Windows
- **Phase 19 (Observability):** Event buffer sizing for replay (memory constraints)
- **Phase 22 (Infrastructure):** systemd unit testing requires VM or container setup

Standard patterns (skip research):
- **Phase 18 (Database):** Standard SQLite backup patterns
- **Phase 20 (Testing):** Stryker and fast-check have clear Vitest integration
- **Phase 21 (UX):** Established CLI patterns

---

## Anti-Features (Out of Scope)

Per REQUIREMENTS.md, these are explicitly excluded from v1.4:
- Rate limiting — single human + trusted agents; connection limits sufficient
- Circuit breakers — no external dependencies to fail; Fastify timeout handling sufficient
- Distributed tracing — single process; logs with request IDs sufficient
- Prometheus metrics server — log-based metrics sufficient for local service
- Database replication — single node; daily backups sufficient
- RBAC / per-user permissions — single user system
- JWT/OAuth2 authentication — API key auth sufficient for local service

---

*Last updated: 2026-02-17*
*Next step: /gsd:execute-phase 19*
