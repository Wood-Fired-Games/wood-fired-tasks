---
phase: 08-cli-command-expansion
plan: 01
subsystem: cli
tags: [commander, clack-prompts, task-management, crud]

# Dependency graph
requires:
  - phase: 07-core-cli-infrastructure
    provides: "Global --json flag, confirmAction prompts, jsonOutput helpers, error handling patterns"
provides:
  - "Delete command with safety confirmation prompt"
  - "Show command with formatted detail view"
  - "Complete CRUD operation set for tasks (create, list, update, delete, show)"
affects: [cli-expansion, user-workflows]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Confirmation prompt pattern for destructive operations"
    - "Pre-fetch pattern (fetch task before delete to show details)"

key-files:
  created:
    - src/cli/commands/delete.ts
    - src/cli/commands/show.ts
    - src/cli/__tests__/delete.test.ts
    - src/cli/__tests__/show.test.ts
  modified:
    - src/cli/api/client.ts
    - src/cli/bin/tasks.ts

key-decisions:
  - "Delete command fetches task first to display what will be deleted (better UX)"
  - "Delete shows cancellation message instead of silent exit (user feedback)"
  - "Both commands follow Phase 7 patterns (optsWithGlobals for --json, error handling)"

patterns-established:
  - "Pattern 1: Pre-fetch entity before destructive operation to show user what they're deleting"
  - "Pattern 2: Confirmation prompts use task title/name for better context"
  - "Pattern 3: Cancellation acknowledged with user-facing message in both JSON and terminal modes"

# Metrics
duration: 2min
completed: 2026-02-13
---

# Phase 08 Plan 01: CLI Command Expansion - Delete and Show Summary

**Complete task CRUD operations with delete command (confirmation prompts) and show command (formatted detail view)**

## Performance

- **Duration:** 2 minutes
- **Started:** 2026-02-13T23:09:12Z
- **Completed:** 2026-02-13T23:11:56Z
- **Tasks:** 4 (3 auto, 1 checkpoint skipped)
- **Files modified:** 6 (4 created, 2 modified)

## Accomplishments
- Added deleteTask() API client function following existing patterns
- Created delete command with confirmation prompt (respects --force flag)
- Created show command with formatted task detail output
- Both commands support global --json flag
- Added 12 comprehensive tests (7 for delete, 5 for show)
- All 281 tests passing (no regressions)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add deleteTask API client function** - `0bbe6d1` (feat)
2. **Task 2: Create delete and show commands** - `7f09475` (feat)
3. **Task 3: Human verification checkpoint** - *skipped per instructions*
4. **Task 4: Add comprehensive tests** - `4282bd2` (test)

## Files Created/Modified
- `src/cli/api/client.ts` - Added deleteTask() function (DELETE /api/v1/tasks/:id)
- `src/cli/commands/delete.ts` - Delete command with confirmAction() and task pre-fetch
- `src/cli/commands/show.ts` - Show command with formatTaskDetail() output
- `src/cli/bin/tasks.ts` - Registered delete and show commands
- `src/cli/__tests__/delete.test.ts` - 7 tests covering confirmation, --force, --json, errors, validation
- `src/cli/__tests__/show.test.ts` - 5 tests covering terminal mode, --json, errors, all fields, validation

## Decisions Made

**Pre-fetch before delete:**
- Delete command calls getTask() before confirming deletion to show user what they're about to delete
- Improves UX (user sees task title in confirmation prompt)
- Follows "show what you're changing" principle from Phase 7

**Cancellation feedback:**
- Delete command shows "Deletion cancelled" message instead of silent exit
- Provides user confirmation that cancellation was acknowledged
- Works in both JSON mode (envelope) and terminal mode (colored message)

**Global flag access:**
- Both commands use program.optsWithGlobals() to access --json flag
- Follows Phase 7 pattern established in update command
- Ensures consistent behavior across all commands

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. All tasks completed without errors. TypeScript compilation clean. All tests pass.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

**Ready for remaining CLI command expansion:**
- Foundation solid: delete and show commands work correctly
- Patterns established: confirmation prompts, pre-fetch for context, JSON mode support
- Test coverage complete: 12 new tests, no regressions
- Next commands (projects, dependencies, comments, estimates) can follow these patterns

**Commands now complete:**
- ✓ create, list, update, delete, show (5 task commands)
- Remaining: project management, dependency management, comment management, estimate management

## Self-Check: PASSED

All files and commits verified:
- ✓ src/cli/commands/delete.ts (1868 bytes)
- ✓ src/cli/commands/show.ts (1242 bytes)
- ✓ src/cli/__tests__/delete.test.ts (7097 bytes)
- ✓ src/cli/__tests__/show.test.ts (5579 bytes)
- ✓ Commit 0bbe6d1 exists
- ✓ Commit 7f09475 exists
- ✓ Commit 4282bd2 exists

---
*Phase: 08-cli-command-expansion*
*Completed: 2026-02-13*
