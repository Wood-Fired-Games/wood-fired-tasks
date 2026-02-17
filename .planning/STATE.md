# Project State: Wood Fired Bugs

**Last Updated:** 2026-02-17 (Phase 19-02 complete)

## Project Reference

**Core Value:** Any agent on the local network can reliably create, find, and update work items in real time — making this the single source of truth for all Wood Fired Games task tracking.

**Current Focus:** v1.4 Hardening and Polish — improving reliability, observability, and user experience

## Current Position

**Milestone:** v1.4 Hardening and Polish — IN PROGRESS
**Phase:** 20 (next)
**Phase Name:** Testing Depth
**Plan:** —
**Status:** Ready to plan

**Progress Bar:**
```
v1.0 ████████████████████ 100% (6/6 phases, 13 plans) — shipped 2026-02-13
v1.1 ████████████████████ 100% (4/4 phases, 10 plans) — shipped 2026-02-13
v1.2 ████████████████████ 100% (3/3 phases, 7 plans)  — shipped 2026-02-14
v1.3 ████████████████████ 100% (3/3 phases, 12 plans) — shipped 2026-02-14
v1.4 ████████████░░░░░░░░  50% (phases 17-19 complete, 3/6 phases remaining)
```

## Performance Metrics

**All Milestones:**
- v1.0 MVP: 6 phases, 13 plans, shipped 2026-02-13 (386 tests)
- v1.1 Interface Parity & CLI Polish: 4 phases, 10 plans, shipped 2026-02-13 (357 tests)
- v1.2 Claude Code Skills & Installer: 3 phases, 7 plans, shipped 2026-02-14 (386 tests)
- v1.3 Multi-Agent Coordination: 3 phases, 12 plans, shipped 2026-02-14 (513 tests)

**Current:** 598 tests passing (52 test files), 19,618+ LOC TypeScript, 127+ files

| Phase | Plan | Duration | Tasks | Files | Date |
|-------|------|----------|-------|-------|------|
| 18-database-status-model | 01 | 2 min | 2 | 3 | 2026-02-17 |
| 18-database-status-model | 02 | 4 min | 2 | 5 | 2026-02-17 |
| 19-observability | 01 | 2 min | 3 | 4 | 2026-02-17 |
| 19-observability | 02 | 2 min | 2 | 5 | 2026-02-17 |

**v1.4 Targets:**
- 6 phases planned (17-22)
- 23 requirements to implement
- Maintain 500+ passing tests
- Add mutation testing coverage

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

See `.planning/PROJECT.md` Key Decisions table for full history.

### Open Questions

None.

### Blockers

None.

### TODOs

1. ~~Phase 17: Core Reliability Fundamentals~~ — COMPLETE (4 plans, shipped 2026-02-17)
2. ~~Phase 18: Database & Status Model~~ — COMPLETE (backup command + backlogged status, 2026-02-17)
3. ~~Phase 19: Observability~~ — COMPLETE (doctor command OBSV-01, request IDs OBSV-02, SSE buffer OBSV-03, 2026-02-17)
4. Phase 20: Testing Depth — mutation testing, property testing, unused deps
5. Phase 21: UX Polish — progress indicators, colored output, shell completions
6. Phase 22: Infrastructure Hardening — systemd limits, security hardening

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 4 | Investigate and fix tasks losing state - completed tasks reverting to open | 2026-02-15 | 9d07d27 | [4-investigate-and-fix-tasks-losing-state-c](./quick/4-investigate-and-fix-tasks-losing-state-c/) |

### Recent Completions

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
Phase 19-02 complete — request ID propagation shipped. UUID v4 X-Request-ID on all REST responses, traceId logging on 5 key MCP tools, SSE buffer at 100 events, CLI client captures request IDs. 598 tests passing.

**What's Next:**
Phase 19 is now complete (both plans done). Move to Phase 20: Testing Depth — mutation testing, property testing, unused deps.

**Context for Next Session:**
- v1.4 progress: 3/6 phases complete (17, 18, 19)
- Phase 19: doctor command (OBSV-01) + request ID propagation (OBSV-02, OBSV-03)
- 598 tests passing across 52 test files
- Next: Phase 20 (mutation testing, property testing, unused deps)
- Last activity: 2026-02-17 — Phase 19-02 complete

---
*State tracking started: 2026-02-14 for v1.3*
*Milestone v1.4 started: 2026-02-17*
*Roadmap created: 2026-02-17*
