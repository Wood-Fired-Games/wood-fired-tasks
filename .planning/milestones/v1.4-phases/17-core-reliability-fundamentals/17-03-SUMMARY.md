# Phase 17, Plan 03: Graceful Shutdown with WAL Checkpoint

## Summary

Successfully implemented graceful shutdown with idle connection closing and WAL checkpointing, plus periodic WAL checkpoints to prevent file bloat.

## Changes Made

### 1. Created `src/utils/exit-codes.ts`
- sysexits.h standard exit codes with JSDoc documentation
- Values: EX_OK (0), EX_USAGE (64), EX_DATAERR (65), EX_SOFTWARE (70), EX_CONFIG (78), etc.
- Used throughout the application for consistent error handling

### 2. Updated `src/api/start.ts`
- Imports `ExitCodes` from config/env.ts for standard exit codes
- Calls `loadConfig()` at startup for fail-fast validation
- Graceful shutdown sequence:
  1. Clear periodic checkpoint interval
  2. Stop accepting new connections (`await server.close()`)
  3. Run WAL checkpoint with TRUNCATE mode
  4. Close database connection
  5. Exit with `ExitCodes.EX_OK` (0)
- Error handling: exits with `ExitCodes.EX_SOFTWARE` (70) on shutdown errors
- Periodic WAL checkpoint every 15 minutes (configurable via WAL_CHECKPOINT_INTERVAL_MS)

### 3. Updated `src/api/server.ts`
- Configured `forceCloseConnections: 'idle'` for graceful shutdown
- Timeout configurations prevent hung connections:
  - `connectionTimeout`: 120000ms (2 min)
  - `requestTimeout`: 60000ms (1 min)
  - `keepAliveTimeout`: 10000ms (10 sec)

## Verification

- [x] TypeScript compiles without errors
- [x] All 518 existing tests pass
- [x] SIGTERM triggers graceful shutdown
- [x] WAL checkpoint runs during shutdown
- [x] Database connection closes cleanly
- [x] Exit codes follow sysexits.h standard

## Success Criteria

1. [x] Service gracefully shuts down on SIGTERM/SIGINT
2. [x] Idle connections are closed with forceCloseConnections: 'idle'
3. [x] WAL checkpoint runs during shutdown (pragma wal_checkpoint(TRUNCATE))
4. [x] Periodic WAL checkpoint runs every 15 minutes
5. [x] Exit codes follow sysexits.h standard (0=success, 70=software error)
6. [x] Shutdown completes within reasonable time
