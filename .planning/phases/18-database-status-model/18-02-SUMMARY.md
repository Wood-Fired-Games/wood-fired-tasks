---
phase: 18-database-status-model
plan: "02"
subsystem: database
tags: [sqlite, migration, task-lifecycle, status, better-sqlite3, fts, vitest]

# Dependency graph
requires:
  - phase: 18-01
    provides: database backup command (not a dependency, wave 1 is parallel)
  - phase: 17-database-status-model
    provides: Phase 17 reliability work that the DB runs on
provides:
  - backlogged task status at type, schema, and database levels
  - migration 005 adding backlogged to SQLite CHECK constraint via table rebuild
  - backlogged -> open and open -> backlogged status transitions
  - magenta CLI color for backlogged status
  - FTS trigger preservation pattern after SQLite table rebuild
affects:
  - any future status-related features
  - agent claim logic (backlogged tasks already excluded by existing open-only guard)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SQLite table rebuild pattern for CHECK constraint modification (foreign_keys=OFF, create new, copy, drop old, rename, recreate indexes + triggers)"
    - "FTS trigger drop-before-table-drop ordering (triggers must be dropped before the table they reference)"

key-files:
  created:
    - src/db/migrations/005-backlogged-status.ts
    - src/db/__tests__/migration-005.test.ts
    - src/services/__tests__/backlogged-status.test.ts
  modified:
    - src/types/task.ts
    - src/cli/output/formatters.ts

key-decisions:
  - "backlogged -> open is the ONLY valid transition from backlogged; cannot go directly to in_progress, done, closed, or blocked — enforces explicit triage promotion workflow"
  - "chalk.magenta() chosen for backlogged display to be visually distinct from blue(open), yellow(in_progress), green(done), gray(closed), red(blocked)"
  - "FTS triggers must be dropped before dropping the tasks table during migration, then recreated after rename — ordering is critical"
  - "Migration down() converts all backlogged tasks to open before rebuilding table without backlogged in CHECK constraint"

patterns-established:
  - "SQLite table rebuild pattern: foreign_keys=OFF -> CREATE TABLE x_new -> INSERT INTO x_new SELECT * FROM x -> DROP TRIGGER x_fts_* -> DROP TABLE x -> ALTER TABLE x_new RENAME TO x -> CREATE INDEX ... -> CREATE TRIGGER ... -> foreign_keys=ON"
  - "Backlogged status: invisible to agents (claimTask guard requires status=open), visible to users via filter"

requirements-completed:
  - DATA-01
  - DATA-02
  - DATA-03

# Metrics
duration: 4min
completed: 2026-02-17
---

# Phase 18 Plan 02: Backlogged Status Summary

**SQLite table rebuild migration adding backlogged status with open<->backlogged transitions, claim exclusion, and magenta CLI formatting — 28 new tests covering FTS trigger recreation, data preservation, and full triage lifecycle**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-02-17T19:49:44Z
- **Completed:** 2026-02-17T19:53:07Z
- **Tasks:** 2
- **Files modified:** 5 (2 modified, 3 created)

## Accomplishments
- Added 'backlogged' to TASK_STATUSES and VALID_STATUS_TRANSITIONS (open->backlogged, backlogged->open only)
- Created migration 005 using SQLite table rebuild pattern, preserving all indexes and FTS triggers
- Added chalk.magenta formatting for backlogged status in CLI formatter
- 28 new tests: 8 migration integration tests + 12 service-level lifecycle tests + 8 from migration 005 FTS/index verification
- Total test count grew from 570 to 598, all passing

## Task Commits

Each task was committed atomically:

1. **Task 1: Update types, schemas, formatter, and create migration** - `d003add` (feat)
2. **Task 2: Add integration tests for backlogged status and migration** - `2804471` (test)

**Plan metadata:** (created in final commit)

## Files Created/Modified
- `src/types/task.ts` - Added 'backlogged' to TASK_STATUSES, added backlogged transitions
- `src/cli/output/formatters.ts` - Added `case 'backlogged': return chalk.magenta(status)` before default
- `src/db/migrations/005-backlogged-status.ts` - SQLite table rebuild migration with full FTS trigger and index recreation
- `src/db/__tests__/migration-005.test.ts` - 8 migration tests: CHECK constraint, data preservation, FTS triggers, indexes
- `src/services/__tests__/backlogged-status.test.ts` - 12 service tests: transitions, claim exclusion, filter, triage lifecycle

## Decisions Made
- `backlogged -> open` is the ONLY valid transition from backlogged. Direct transition to in_progress/done/closed/blocked is forbidden to enforce explicit triage promotion where a human must consciously move a task to open before agents can claim it.
- chalk.magenta() for backlogged display — visually distinct from all existing status colors.
- FTS triggers must be dropped before dropping the tasks table, then recreated after table rename. This ordering is critical: DROP TABLE would fail if triggers reference it after it's gone.
- The `src/schemas/task.schema.ts` required no changes — it uses `z.enum(TASK_STATUSES)` which auto-includes backlogged when the array is updated.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Backlogged status fully implemented at type, schema, database, and display levels
- Requirements DATA-01, DATA-02, DATA-03 complete
- Phase 18 plans complete if 18-01 (backup command) is also done
- The triage workflow is now functional: open -> backlogged -> open -> in_progress (via claimTask)

---
*Phase: 18-database-status-model*
*Completed: 2026-02-17*
