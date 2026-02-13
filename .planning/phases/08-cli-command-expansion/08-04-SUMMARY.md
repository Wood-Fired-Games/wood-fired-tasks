---
phase: 08-cli-command-expansion
plan: 04
subsystem: cli
tags: [commander, comments, interactive-prompts, json-output]

# Dependency graph
requires:
  - phase: 07-core-cli-infrastructure
    provides: "Output abstraction, interactive prompts, --json flag infrastructure"
  - phase: 06-advanced-features
    provides: "Comment REST API endpoints and service layer"
provides:
  - "comment-add CLI command with interactive prompts"
  - "comment-list CLI command with chronological display"
  - "comment-delete CLI command with confirmation"
  - "Comment API client functions (addComment, getComments, deleteComment)"
  - "formatCommentList formatter for terminal output"
affects: [08-05-PLAN, 10-testing]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Comment command pattern: argument-based task ID with option flags for fields"
    - "Nested REST route CLI client: deleteComment requires both taskId and commentId"

key-files:
  created:
    - src/cli/commands/comment-add.ts
    - src/cli/commands/comment-list.ts
    - src/cli/commands/comment-delete.ts
    - src/cli/__tests__/comments.test.ts
  modified:
    - src/cli/api/client.ts
    - src/cli/api/types.ts
    - src/cli/output/formatters.ts
    - src/cli/bin/tasks.ts

key-decisions:
  - "comment-delete requires both <task-id> and <comment-id> because REST API route is nested (/tasks/:id/comments/:commentId)"
  - "promptForMissing used for author and content fields in comment-add (interactive mode)"
  - "formatCommentList shows chronological [timestamp] author: indented-content format"

patterns-established:
  - "Comment command arguments: task ID as positional arg, fields as options"
  - "Nested resource deletion: CLI passes both parent and child IDs to match REST route"

# Metrics
duration: 3min
completed: 2026-02-13
---

# Phase 8 Plan 4: Comment Commands Summary

**3 comment CLI commands (add, list, delete) with interactive prompts, chronological display, and JSON output**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-13T23:28:33Z
- **Completed:** 2026-02-13T23:31:39Z
- **Tasks:** 4
- **Files modified:** 8

## Accomplishments
- Added CommentResponse/CreateCommentInput types and 3 API client functions
- Created formatCommentList with color-coded timestamps and indented content
- Built 3 comment commands following Phase 7 patterns (optsWithGlobals, promptForMissing, confirmAction)
- 20 comprehensive tests covering all commands, JSON mode, prompts, error handling
- All 340 tests passing (20 new + 320 existing)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add comment API client and types** - `6d2cd69` (feat)
2. **Task 2: Add comment formatter** - `1786e0e` (feat)
3. **Task 3: Create comment commands** - `77357c2` (feat)
4. **Task 4: Add comprehensive tests** - `2c859b8` (test)

## Files Created/Modified
- `src/cli/api/types.ts` - CommentResponse and CreateCommentInput interfaces
- `src/cli/api/client.ts` - addComment, getComments, deleteComment API functions
- `src/cli/output/formatters.ts` - formatCommentList with chronological display
- `src/cli/commands/comment-add.ts` - Add comment with interactive prompts for author/content
- `src/cli/commands/comment-list.ts` - List comments with formatted or JSON output
- `src/cli/commands/comment-delete.ts` - Delete comment with confirmation prompt
- `src/cli/bin/tasks.ts` - Registered all 3 comment commands
- `src/cli/__tests__/comments.test.ts` - 20 tests across 3 describe blocks

## Decisions Made
- comment-delete takes both `<task-id>` and `<comment-id>` arguments because the REST API route is nested under tasks (`/api/v1/tasks/:id/comments/:commentId`). The plan assumed a flat `/api/v1/comments/:id` endpoint which does not exist.
- Used promptForMissing for both author and content in comment-add (consistent with project-create pattern)
- Skipped checkpoint:human-verify task per user instruction for fully autonomous execution

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] comment-delete requires both task-id and comment-id arguments**
- **Found during:** Task 1 (API client implementation)
- **Issue:** Plan specified `comment-delete <comment-id>` with a flat `/api/v1/comments/:id` endpoint. The actual REST API route is `DELETE /api/v1/tasks/:id/comments/:commentId` requiring both IDs.
- **Fix:** Changed deleteComment client to accept (taskId, commentId) and comment-delete command to accept `<task-id> <comment-id>` arguments
- **Files modified:** src/cli/api/client.ts, src/cli/commands/comment-delete.ts
- **Verification:** Tests pass, TypeScript compiles, command appears correctly in --help
- **Committed in:** 6d2cd69 (Task 1), 77357c2 (Task 3)

---

**Total deviations:** 1 auto-fixed (1 bug - incorrect API endpoint assumption)
**Impact on plan:** Necessary correction for API compatibility. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- CLI now has 16 commands total (create, list, update, delete, show, 5 project, 3 dep, 3 comment)
- Comment commands follow established Phase 7 patterns consistently
- Ready for 08-05 (remaining CLI commands if any)

## Self-Check: PASSED

All 8 files verified present. All 4 commit hashes verified in git log.

---
*Phase: 08-cli-command-expansion*
*Completed: 2026-02-13*
