---
phase: 19-observability
plan: 01
subsystem: cli
tags: [better-sqlite3, commander, chalk, statfs, zod]

requires:
  - phase: 18-database-status-model
    provides: backup.ts direct-DB pattern (readonly open, CLI-direct-DB exception)

provides:
  - tasks doctor: DB connectivity, disk space (statfs), config validity (configSchema.safeParse) diagnostics command
  - tasks stats: status counts, 24h activity, 7-day agent productivity SQL queries command
  - tasks db-check: PRAGMA integrity_check + database size reporting command
  - All three commands: offline (API-server-independent), --json mode, readonly DB access

affects: [19-02, 20-testing-depth, 21-ux-polish]

tech-stack:
  added: []
  patterns:
    - CLI-direct-DB: diagnostic commands open SQLite readonly (no API server needed)
    - configSchema.safeParse: validate config without triggering process.exit(78)
    - promisify(statfs): disk space check via Node.js fs module (not child_process/exec)

key-files:
  created:
    - src/cli/commands/doctor.ts
    - src/cli/commands/stats.ts
    - src/cli/commands/db-check.ts
  modified:
    - src/cli/bin/tasks.ts

key-decisions:
  - "Use configSchema.safeParse (not loadConfig/config) in doctor.ts — loadConfig calls process.exit(78) on failure"
  - "Use promisify(statfs) from 'fs' (not fs/promises) for disk space — matches plan spec exactly"
  - "All three commands open DB with { readonly: true } — consistent with backup.ts pattern, no write-lock risk"

patterns-established:
  - "Diagnostic commands use direct SQLite access (no REST API dependency) for offline reliability"
  - "Config validation in CLI uses configSchema.safeParse, never the lazy-loaded config proxy"

requirements-completed: [OBSV-01, OBSV-04, OBSV-05]

duration: 2min
completed: 2026-02-17
---

# Phase 19 Plan 01: Observability Diagnostic Commands Summary

**Three offline CLI diagnostic commands (doctor, stats, db-check) using direct SQLite readonly access following the backup.ts pattern**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-17T20:28:50Z
- **Completed:** 2026-02-17T20:31:39Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- `tasks doctor` reports DB connectivity (WAL mode detection), disk space (statfs with warn/fail thresholds), and config validity (configSchema.safeParse with issue listing)
- `tasks stats` queries task counts by status, 24h created/updated activity, and 7-day agent productivity via SQL GROUP BY
- `tasks db-check` runs PRAGMA integrity_check and reports database size (pages x page_size)
- All three commands work with API server down (direct SQLite), support --json output, set process.exitCode=1 on failure

## Task Commits

Each task was committed atomically:

1. **Task 1: Create tasks doctor command** - `76aff05` (feat)
2. **Task 2: Create tasks stats and db-check commands** - `aded808` (feat)
3. **Task 3: Register all three commands in CLI entry point** - `5acfcc1` (feat)

**Plan metadata:** (docs commit pending)

## Files Created/Modified

- `src/cli/commands/doctor.ts` - DB connectivity + disk space (statfs) + config validity (configSchema.safeParse) diagnostics
- `src/cli/commands/stats.ts` - Task status counts, 24h activity, 7-day agent productivity SQL queries
- `src/cli/commands/db-check.ts` - PRAGMA integrity_check + database size reporting
- `src/cli/bin/tasks.ts` - Imports and registers all three new diagnostic commands

## Decisions Made

- Used `configSchema.safeParse` (not `loadConfig`/`config`) in doctor.ts — `loadConfig` and the `config` proxy both call `process.exit(78)` on validation failure, making them unusable for diagnostic reporting
- Used `promisify(statfs)` from `'fs'` (not `fs/promises`) for disk space check — plan specified this pattern explicitly
- All three commands open DB with `{ readonly: true }` — consistent with established backup.ts pattern, no write-lock risk with running server

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 19-02 can proceed: request IDs and event replay observability features
- All 598 existing tests continue to pass
- CLI help now shows doctor, stats, and db-check commands

## Self-Check: PASSED

- src/cli/commands/doctor.ts: FOUND
- src/cli/commands/stats.ts: FOUND
- src/cli/commands/db-check.ts: FOUND
- 19-01-SUMMARY.md: FOUND
- commit 76aff05 (Task 1): FOUND
- commit aded808 (Task 2): FOUND
- commit 5acfcc1 (Task 3): FOUND

---
*Phase: 19-observability*
*Completed: 2026-02-17*
