# Project State: Wood Fired Bugs

**Last Updated:** 2026-02-17

## Project Reference

**Core Value:** Any agent on the local network can reliably create, find, and update work items in real time — making this the single source of truth for all Wood Fired Games task tracking.

**Current Focus:** v1.4 Hardening and Polish — improving reliability, observability, and user experience

## Current Position

**Milestone:** v1.4 Hardening and Polish — IN PROGRESS
**Phase:** 18 (in progress)
**Phase Name:** Database & Status Model
**Plan:** 18-01 complete (1/2 plans done)
**Status:** In progress

**Progress Bar:**
```
v1.0 ████████████████████ 100% (6/6 phases, 13 plans) — shipped 2026-02-13
v1.1 ████████████████████ 100% (4/4 phases, 10 plans) — shipped 2026-02-13
v1.2 ████████████████████ 100% (3/3 phases, 7 plans)  — shipped 2026-02-14
v1.3 ████████████████████ 100% (3/3 phases, 12 plans) — shipped 2026-02-14
v1.4 ████░░░░░░░░░░░░░░░░  17% (phase 17 complete, phase 18 in progress)
```

## Performance Metrics

**All Milestones:**
- v1.0 MVP: 6 phases, 13 plans, shipped 2026-02-13 (386 tests)
- v1.1 Interface Parity & CLI Polish: 4 phases, 10 plans, shipped 2026-02-13 (357 tests)
- v1.2 Claude Code Skills & Installer: 3 phases, 7 plans, shipped 2026-02-14 (386 tests)
- v1.3 Multi-Agent Coordination: 3 phases, 12 plans, shipped 2026-02-14 (513 tests)

**Current:** 586 tests passing (51 test files), 19,618+ LOC TypeScript, 127+ files

| Phase | Plan | Duration | Tasks | Files | Date |
|-------|------|----------|-------|-------|------|
| 18-database-status-model | 01 | 2 min | 2 | 3 | 2026-02-17 |

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

See `.planning/PROJECT.md` Key Decisions table for full history.

### Open Questions

None.

### Blockers

None.

### TODOs

1. ~~Phase 17: Core Reliability Fundamentals~~ — COMPLETE (4 plans, shipped 2026-02-17)
2. Phase 18: Database & Status Model — ~~backup command~~ DONE, backlogged status remaining
3. Phase 19: Observability — doctor command, request IDs, event replay, stats, db-check
4. Phase 20: Testing Depth — mutation testing, property testing, unused deps
5. Phase 21: UX Polish — progress indicators, colored output, shell completions
6. Phase 22: Infrastructure Hardening — systemd limits, security hardening

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 4 | Investigate and fix tasks losing state - completed tasks reverting to open | 2026-02-15 | 9d07d27 | [4-investigate-and-fix-tasks-losing-state-c](./quick/4-investigate-and-fix-tasks-losing-state-c/) |

### Recent Completions

- [x] Phase 18-01: `tasks backup` command — better-sqlite3 backup API, readonly, 8 tests (2026-02-17)
- [x] Phase 17 complete (2026-02-17) — 4 plans: structured logging, health checks, graceful shutdown, config validation, exit codes, WAL maintenance
- [x] v1.3 milestone archived (2026-02-16)
- [x] Quick Task 4: Fixed stale claim sweep bug (2026-02-15) — 5 new regression tests, 518 total
- [x] v1.4 requirements defined (2026-02-17) — 23 requirements across 6 categories
- [x] v1.4 roadmap created (2026-02-17) — 6 phases (17-22)

## Session Continuity

**What Just Happened:**
Executed Phase 18 Plan 01: `tasks backup` CLI command using better-sqlite3 Online Backup API. Opens source DB readonly, auto-creates directories, supports JSON mode. 8 tests, 586 total passing.

**What's Next:**
Execute Phase 18 Plan 02: Add `backlogged` task status to the data model.

**Context for Next Session:**
- Phase 18-01 complete: `tasks backup` command working
- Next: Phase 18-02 — backlogged status (new status value in task schema)
- 586 tests passing (up from 518 pre-v1.4)
- Last activity: 2026-02-17 — Phase 18-01 complete

---
*State tracking started: 2026-02-14 for v1.3*
*Milestone v1.4 started: 2026-02-17*
*Roadmap created: 2026-02-17*
