# Project State: Wood Fired Bugs

**Last Updated:** 2026-02-17 (Phase 22 complete — v1.4 milestone complete)

## Project Reference

**Core Value:** Any agent on the local network can reliably create, find, and update work items in real time — making this the single source of truth for all Wood Fired Games task tracking.

**Current Focus:** v1.4 Hardening and Polish — improving reliability, observability, and user experience

## Current Position

**Milestone:** v1.4 Hardening and Polish — IN PROGRESS
**Phase:** 22 (complete)
**Phase Name:** Infrastructure Hardening
**Plan:** 1/1 complete
**Status:** MILESTONE COMPLETE

**Progress Bar:**
```
v1.0 ████████████████████ 100% (6/6 phases, 13 plans) — shipped 2026-02-13
v1.1 ████████████████████ 100% (4/4 phases, 10 plans) — shipped 2026-02-13
v1.2 ████████████████████ 100% (3/3 phases, 7 plans)  — shipped 2026-02-14
v1.3 ████████████████████ 100% (3/3 phases, 12 plans) — shipped 2026-02-14
v1.4 ████████████████████ 100% (6/6 phases complete, 14 plans) — milestone complete 2026-02-17
```

## Performance Metrics

**All Milestones:**
- v1.0 MVP: 6 phases, 13 plans, shipped 2026-02-13 (386 tests)
- v1.1 Interface Parity & CLI Polish: 4 phases, 10 plans, shipped 2026-02-13 (357 tests)
- v1.2 Claude Code Skills & Installer: 3 phases, 7 plans, shipped 2026-02-14 (386 tests)
- v1.3 Multi-Agent Coordination: 3 phases, 12 plans, shipped 2026-02-14 (513 tests)

**Current:** 636 tests passing (57 test files), 19,618+ LOC TypeScript, 130+ files

| Phase | Plan | Duration | Tasks | Files | Date |
|-------|------|----------|-------|-------|------|
| 18-database-status-model | 01 | 2 min | 2 | 3 | 2026-02-17 |
| 18-database-status-model | 02 | 4 min | 2 | 5 | 2026-02-17 |
| 19-observability | 01 | 2 min | 3 | 4 | 2026-02-17 |
| 19-observability | 02 | 2 min | 2 | 5 | 2026-02-17 |
| 20-testing-depth | 01 | 3 min | 2 | 4 | 2026-02-17 |
| 20-testing-depth | 02 | 3 min | 2 | 2 | 2026-02-17 |
| 20-testing-depth | 03 | 19 min | 1 | 4 | 2026-02-17 |
| 21-ux-polish | 01 | 3 min | 2 | 8 | 2026-02-17 |
| 21-ux-polish | 02 | 5 min | 2 | 35 | 2026-02-17 |
| 21-ux-polish | 03 | 2 min | 2 | 3 | 2026-02-17 |
| 22-infrastructure-hardening | 01 | 2 min | 2 | 1 | 2026-02-17 |

**v1.4 Results:**
- 6/6 phases complete (17-22), 14 plans executed
- 23/23 requirements implemented
- 636 tests passing (57 test files) -- target was 500+
- Mutation testing at 75.88% baseline

## Accumulated Context

### Key Decisions

- Phase 18-01: `db.backup()` not `VACUUM INTO` — backup API is safe for WAL-mode hot backups while server is running
- Phase 18-01: Open source DB readonly to guarantee no write lock conflict with the running API server
- Phase 18-01: CLI-direct-DB pattern is a legitimate exception for data-safety operations that bypass REST API
- Phase 18-02: backlogged -> open is the ONLY valid transition from backlogged; cannot go directly to in_progress/done/closed/blocked — enforces explicit triage promotion
- Phase 18-02: SQLite table rebuild pattern required for CHECK constraint changes: foreign_keys=OFF, create new, copy, drop FTS triggers, drop old table, rename, recreate indexes + triggers
- Phase 19-01: Use `configSchema.safeParse` (not `loadConfig`/`config`) in doctor.ts — loadConfig calls process.exit(78) on failure, unusable for diagnostic reporting
- Phase 19-01: Use `promisify(statfs)` from `'fs'` (not `fs/promises`) for disk space — direct, no child_process exec needed
- Phase 19-02: `requestIdHeader: false` prevents callers from injecting arbitrary request IDs into Fastify logs (security hardening)
- Phase 19-02: Module-level `_lastRequestId` in CLI client exposes request ID without breaking 20+ existing caller signatures
- Phase 19-02: SSE buffer at 100 (not 1000) per OBSV-03 requirement; traceId logging on only 5 key MCP tools to control blast radius
- Phase 20-01: Removed @fastify/cors and fastify-plugin as genuinely unused dependencies (confirmed via grep)
- Phase 20-01: pino-pretty excluded in knip — convention-loaded by pino, not statically importable
- Phase 20-03: `vitest.related: false` in Stryker — integration tests use createTestApp() factory pattern; related:true would miss them
- Phase 20-03: `thresholds.break: null` — no break threshold on initial run; baseline at 75.88% covered
- Phase 21-01: `withSpinner` uses 500ms delay (not 2s) — fast enough to feel responsive, avoids flash on instant ops
- Phase 21-01: Spinner is presentation concern in commands, not request concern in apiRequest — each command knows its user-facing description
- Phase 21-02: All 24 CLI commands use colorSuccess/colorError/colorWarn/colorInfo from formatters.ts — zero direct chalk imports in commands
- Phase 21-03: Static completion scripts (not dynamic) — avoids API calls during tab completion

See `.planning/PROJECT.md` Key Decisions table for full history.

### Open Questions

None.

### Blockers

None.

### TODOs

1. ~~Phase 17: Core Reliability Fundamentals~~ — COMPLETE (4 plans, shipped 2026-02-17)
2. ~~Phase 18: Database & Status Model~~ — COMPLETE (backup command + backlogged status, 2026-02-17)
3. ~~Phase 19: Observability~~ — COMPLETE (doctor command OBSV-01, request IDs OBSV-02, SSE buffer OBSV-03, 2026-02-17)
4. ~~Phase 20: Testing Depth~~ — COMPLETE (3 plans: knip+CI, property tests, Stryker mutation testing, 2026-02-17)
5. ~~Phase 21: UX Polish~~ — COMPLETE (spinner, color audit, shell completions, 2026-02-17)
6. ~~Phase 22: Infrastructure Hardening~~ — COMPLETE (systemd resource limits + 19 security directives, 2026-02-17)

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 4 | Investigate and fix tasks losing state - completed tasks reverting to open | 2026-02-15 | 9d07d27 | [4-investigate-and-fix-tasks-losing-state-c](./quick/4-investigate-and-fix-tasks-losing-state-c/) |

### Recent Completions

- [x] Phase 22 complete (2026-02-17) — 1 plan: systemd resource limits (MemoryMax=512M, CPUQuota=100%, TasksMax=50) + 19 security directives (INFR-01, INFR-02). v1.4 MILESTONE COMPLETE.
- [x] Phase 21 complete (2026-02-17) — 3 plans: @clack/prompts spinner (UXPL-01), color consistency audit of 24 commands (UXPL-02), bash/zsh shell completions (UXPL-03). 636 tests.
- [x] Phase 20 complete (2026-02-17) — 3 plans: knip unused deps + CI (TEST-03), fast-check property tests (TEST-02), Stryker mutation testing (TEST-01). 607 tests, 75.88% mutation score baseline.
- [x] Phase 19-02: request ID propagation — UUID X-Request-ID on REST, traceId on 5 MCP tools, SSE buffer at 100, CLI client captures request IDs (2026-02-17)
- [x] Phase 19-01: `tasks doctor`, `tasks stats`, `tasks db-check` — offline diagnostics via direct SQLite, statfs, configSchema.safeParse (2026-02-17)
- [x] Phase 18-02: backlogged status — migration 005, type updates, magenta formatter, 28 new tests (2026-02-17)
- [x] Phase 18-01: `tasks backup` command — better-sqlite3 backup API, readonly, 8 tests (2026-02-17)
- [x] Phase 17 complete (2026-02-17) — 4 plans: structured logging, health checks, graceful shutdown, config validation, exit codes, WAL maintenance
- [x] v1.3 milestone archived (2026-02-16)
- [x] Quick Task 4: Fixed stale claim sweep bug (2026-02-15) — 5 new regression tests, 518 total
- [x] v1.4 requirements defined (2026-02-17) — 23 requirements across 6 categories
- [x] v1.4 roadmap created (2026-02-17) — 6 phases (17-22)

## Session Continuity

**What Just Happened:**
Phase 22 complete and verified. v1.4 Hardening and Polish milestone is COMPLETE. All 6 phases (17-22) executed, 23/23 requirements implemented, 636 tests passing.

**What's Next:**
Run `/gsd:complete-milestone` to archive v1.4 and prepare for next version.

**Context for Next Session:**
- v1.4: 6/6 phases complete (17-22), 14 plans executed, 23/23 requirements
- Phase 22 delivered: systemd MemoryMax=512M, CPUQuota=100%, TasksMax=50, 19 security directives
- 636 tests passing across 57 test files
- All planning documents updated and consistent
- Last activity: 2026-02-17 — Phase 22 verified, milestone complete

---
*State tracking started: 2026-02-14 for v1.3*
*Milestone v1.4 started: 2026-02-17*
*Roadmap created: 2026-02-17*
