---
phase: 18-database-status-model
plan: 01
subsystem: database
tags: [better-sqlite3, cli, backup, sqlite, commander]

# Dependency graph
requires: []
provides:
  - "`tasks backup` CLI command using better-sqlite3 Online Backup API"
  - "Readonly SQLite backup with directory auto-creation and JSON mode support"
  - "8 unit tests covering all backup scenarios"
affects: [19-observability, 22-infrastructure-hardening]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "CLI commands that bypass the REST API and access SQLite directly are a legitimate exception pattern for data-layer operations"
    - "better-sqlite3 db.backup(destPath) is the canonical safe approach for hot backups in WAL mode"
    - "Open source DB readonly (new Database(path, { readonly: true })) to avoid write lock conflicts"

key-files:
  created:
    - src/cli/commands/backup.ts
    - src/cli/__tests__/backup.test.ts
  modified:
    - src/cli/bin/tasks.ts

key-decisions:
  - "Use db.backup() not VACUUM INTO — backup API is safe for WAL-mode hot backups while server is running"
  - "Open source DB in readonly mode to guarantee no write lock conflict with the running API server"
  - "Backup reads DATABASE_PATH from process.env directly (no env module import) to avoid API_KEY validation side effects"
  - "Mock better-sqlite3 with vi.fn() function constructor (not class) to support toHaveBeenCalledWith spy assertions"

patterns-established:
  - "CLI-direct-DB pattern: backup command accesses SQLite file directly, bypassing REST API — appropriate only for data-safety operations"

requirements-completed:
  - RELI-05

# Metrics
duration: 2min
completed: 2026-02-17
---

# Phase 18 Plan 01: Backup CLI Command Summary

**`tasks backup` command using better-sqlite3 Online Backup API with readonly source access, directory auto-creation, and terminal/JSON output modes**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-17T19:49:36Z
- **Completed:** 2026-02-17T19:52:18Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Implemented `tasks backup` CLI command that directly accesses SQLite via better-sqlite3, bypassing the REST API
- Opens source database in readonly mode — eliminates write lock conflicts with the running server
- Auto-creates destination directory, supports custom output path via `-o`, reports path/size in terminal and JSON modes
- Added 8 comprehensive tests covering all scenarios: default path, custom path, env var, fallback, dir creation, JSON mode, not-found, cleanup on error
- Registered backup command in the main CLI program (tasks.ts)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create backup command implementation** - `be2b301` (feat)
2. **Task 2: Register backup command and add tests** - `2d44c7c` (feat)

## Files Created/Modified

- `src/cli/commands/backup.ts` — Backup CLI command: readonly DB open, db.backup(), dir creation, error handling, JSON/terminal output
- `src/cli/__tests__/backup.test.ts` — 8 tests covering all backup scenarios with proper better-sqlite3 mock
- `src/cli/bin/tasks.ts` — Added backupCommand import and registration

## Decisions Made

- Used `db.backup()` not `VACUUM INTO` — backup API is the canonical safe approach for WAL-mode hot backups while the server is running
- Opens source DB in readonly mode so the backup never causes write contention with the live server
- Reads `DATABASE_PATH` from `process.env` directly after side-effect importing `env.js` — this loads dotenv without triggering `API_KEY` validation (which would fail in backup-only context)
- Mocked better-sqlite3 constructor using `vi.fn(function MockDatabase(this) {...})` — a class-based mock won't be a spy, so vi.fn() is required for `toHaveBeenCalledWith` assertions

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

- Initial `vi.mock('better-sqlite3')` using an ES class wasn't a spy, causing `toHaveBeenCalledWith` to fail. Fixed by using `vi.fn(function MockDatabase(this) {...})` instead — this is a proper spy that also works as a constructor.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Backup command is fully functional and tested. Can be run standalone without the API server.
- `tasks backup` and `tasks backup -o /path/to/file.db` both work.
- Ready for Phase 18 Plan 02 (backlogged status) or Phase 19 (observability).

---
*Phase: 18-database-status-model*
*Completed: 2026-02-17*
