---
phase: quick-5
plan: 01
subsystem: database
tags: [sqlite, better-sqlite3, umzug, mcp, reliability, concurrency]

# Dependency graph
requires: []
provides:
  - Exclusive SQLite migration lock preventing concurrent startup race conditions
  - MCP startup retry wrapper for transient SQLITE_BUSY/SQLITE_LOCKED errors
affects: [mcp-server, database-migrations]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - BEGIN EXCLUSIVE transaction for single-writer migration serialization
    - Exponential-style retry with delay for transient contention errors

key-files:
  created: []
  modified:
    - src/db/migrate.ts
    - src/mcp/index.ts

key-decisions:
  - "Use BEGIN EXCLUSIVE (not BEGIN IMMEDIATE) to fully block concurrent migration discovery + application"
  - "Retry window: 3 attempts x 500ms = max 1.5s added startup latency, well within Claude Code connection timeout"
  - "isTransientError checks SQLITE_BUSY, SQLITE_LOCKED, and BEGIN EXCLUSIVE in message to catch all contention paths"

patterns-established:
  - "Migration lock pattern: wrap umzug.up() in BEGIN EXCLUSIVE / COMMIT / ROLLBACK for multi-process safety"
  - "Retry wrapper pattern: mainWithRetry() wraps main() without changing its signature"

requirements-completed: [QUICK-5]

# Metrics
duration: 2min
completed: 2026-02-18
---

# Quick Task 5: MCP Server Startup Reliability Summary

**SQLite exclusive migration lock and transient-error retry wrapper closing the two most common paths to permanent MCP server startup failure**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-02-18T21:50:38Z
- **Completed:** 2026-02-18T21:53:15Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Migration serialization: concurrent MCP startups no longer race — only one process applies migrations while others wait and then find nothing pending
- Startup retry: transient SQLITE_BUSY/SQLITE_LOCKED errors during startup are retried up to 3 times (500ms apart) before reporting fatal failure
- Zero test regressions: all 839 tests continue to pass

## Task Commits

1. **Task 1: Serialize migrations with exclusive SQLite transaction lock** - `6119b18` (fix)
2. **Task 2: Add startup retry for transient SQLite errors in MCP entry point** - `63434ad` (fix)

## Files Created/Modified

- `src/db/migrate.ts` - `runMigrations()` now wraps `umzug.up()` in `BEGIN EXCLUSIVE` / `COMMIT` / `ROLLBACK`
- `src/mcp/index.ts` - Added `isTransientError()`, `mainWithRetry()`, replaced `main().catch()` call site

## Decisions Made

- Used `BEGIN EXCLUSIVE` rather than `BEGIN IMMEDIATE`: EXCLUSIVE fully blocks all other readers and writers during migration discovery + application, eliminating any window for a second process to begin applying the same migration.
- Retry parameters (3 attempts, 500ms delay): adds at most 1.5s to worst-case startup — well within Claude Code's connection timeout. Chosen conservatively to not mask genuine failures.
- `isTransientError` also checks for `"BEGIN EXCLUSIVE"` in the message: better-sqlite3 may include the failed statement in its SQLITE_BUSY error message; this ensures we catch all representations.

## Deviations from Plan

### Out-of-Scope Items Noted

**Pre-existing TypeScript build error in `src/api/server.ts`:**
- `tsc` fails with `TS2345: Argument of type 'FastifyBaseLogger' is not assignable to parameter of type 'Logger'. Property 'msgPrefix' is missing.`
- Confirmed pre-existing (present before any changes, verified via git stash).
- Does not affect test execution (Vitest uses `tsx` directly).
- Logged to `deferred-items.md` in this task directory.

---

**Total deviations:** 0 auto-fixes. Pre-existing build error noted and deferred (out of scope).

## Issues Encountered

- Plan's verify step used `--testPathPattern` (Jest flag) but project uses Vitest. Ran tests with correct Vitest syntax instead — no impact on outcome.
- `npm run build` fails due to pre-existing `src/api/server.ts` type error (unrelated to this task). Verified pre-existence via stash, noted in deferred-items.md, continued as planned.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- MCP server startup is now hardened against the two most common failure modes
- Pre-existing TypeScript build error in `src/api/server.ts` should be addressed separately to restore `dist/` output

---
*Phase: quick-5*
*Completed: 2026-02-18*
