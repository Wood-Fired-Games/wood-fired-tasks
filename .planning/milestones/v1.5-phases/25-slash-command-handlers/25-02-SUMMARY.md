---
phase: 25-slash-command-handlers
plan: 02
subsystem: slack
tags: [slack, bolt, slash-command, block-kit, task-handlers, uident-03]

requires:
  - phase: 25-slash-command-handlers
    plan: 01
    provides: registerTasksCommand router skeleton, parseArgs, respondBlocks, respondError, formatServiceError, Services interface
  - phase: 24-block-kit-formatters-user-identity
    provides: formatTaskList, formatTaskDetail (task-formatter.ts), UserIdentityCache (user-identity.ts)

provides:
  - handleList subcommand handler with --status/--project/--assignee/--search/--tags flag support
  - handleShow subcommand handler with last-5 comments and dependency sections
  - handleCreate subcommand handler with UIDENT-03 display name resolution for created_by
  - handleUpdate subcommand handler with selective field updates from --flags
  - handleDelete subcommand handler with immediate execution and :white_check_mark: confirmation
  - handleClaim subcommand handler with UIDENT-03 display name resolution for assignee
  - 21 unit tests covering all 6 handlers across happy path and error scenarios

affects:
  - 25-slash-command-handlers plan 03 — project/dep/comment/subtask handlers, same switch router

tech-stack:
  added: []
  patterns:
    - "handleList passes only present flags to listTasks — absent flags omitted from filters object"
    - "handleShow chains getTask + getComments + getBlockedBy + getBlockers — all service calls async-safe"
    - "handleCreate/handleClaim: await identityCache.resolve(command.user_id) before service call — UIDENT-03"
    - "handleUpdate: Object.keys(updates).length === 0 guard — rejects invocation with no update fields"
    - "handleDelete: no confirmation modal in this phase — immediate deleteTask then :white_check_mark: block"
    - "handleShow: comments.slice(-5) for last-5 pattern; ContextBlock footer if comments.length > 5"

key-files:
  created: []
  modified:
    - src/slack/commands/tasks-command.ts
    - src/slack/commands/__tests__/tasks-command.test.ts

key-decisions:
  - "handleShow uses comments.slice(-5) not comments.slice(0,5) — last 5 most recent comments, not first 5"
  - "handleUpdate uses Object.keys(updates) guard after building updates object from present flags — clean undefined removal without explicit Object.entries filter loop"
  - "handleList passes filters as Record<string, unknown> to listTasks — avoids TaskFilters type cast; TaskService.listTasks accepts unknown and validates internally via Zod"
  - "void services/identityCache markers removed — all 6 task cases now wire real handlers"
  - "commentService.getComments typed as returning Promise to match async service signature — test mocks use mockResolvedValue"

requirements-completed:
  - SCMD-04
  - SCMD-05
  - SCMD-06
  - SCMD-07
  - SCMD-08

duration: 4min
completed: 2026-02-18
---

# Phase 25 Plan 02: Task Subcommand Handlers Summary

**6 task subcommand handlers (list/show/create/update/delete/claim) wired into the /tasks router switch, with UIDENT-03 display name resolution for create/claim, Block Kit formatting via formatTaskList/formatTaskDetail, and 21 unit tests**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-18T03:34:47Z
- **Completed:** 2026-02-18T03:38:18Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Implemented all 6 task subcommand handlers as private functions in `src/slack/commands/tasks-command.ts`:
  - `handleList`: parses --status/--project/--assignee/--search/--tags flags, passes present-only filters to `listTasks`, formats result with `formatTaskList`
  - `handleShow`: fetches task detail, appends last-5 comments with divider+header (with "X more comments" ContextBlock), appends dependency section if blockedBy or blockers present
  - `handleCreate`: validates non-empty title positionals and required `--project` flag, resolves Slack user ID to display name via `identityCache.resolve()` for `created_by` (UIDENT-03)
  - `handleUpdate`: parses up to 6 update flags, builds partial updates object (undefined keys omitted), rejects invocation with no fields
  - `handleDelete`: calls `deleteTask(id)` immediately, responds with `:white_check_mark: Task #<id> deleted.` block
  - `handleClaim`: resolves Slack user ID to display name via `identityCache.resolve()` (UIDENT-03), calls `claimTask(id, displayName)`
- Removed `void services; void identityCache;` stub markers — all task cases now call real handlers
- Wired all 6 handlers into the existing switch statement, replacing the `respondError('Not yet implemented')` stubs
- Added `import { formatTaskList, formatTaskDetail } from '../task-formatter.js'` to the implementation file
- Added 21 unit tests covering: list (3), show (5), create (3), update (4), delete (2), claim (2)

## Task Commits

1. **Task 1: Implement 6 task subcommand handlers** - `8eee79e` (feat)
2. **Task 2: Add unit tests for all 6 handlers** - `2675851` (test)

**Plan metadata:** (docs commit below)

## Files Created/Modified

- `src/slack/commands/tasks-command.ts` — Added `formatTaskList`/`formatTaskDetail` import; added 6 handler functions; wired switch cases; removed void markers
- `src/slack/commands/__tests__/tasks-command.test.ts` — Added 21 tests (list/show/create/update/delete/claim); added mock task, comment, dependency factories; expanded makeMockServices with vi.fn() implementations

## Decisions Made

- `handleShow` uses `comments.slice(-5)` not `comments.slice(0, 5)` — returns the last 5 most recent comments, which is more useful for active task discussions
- `handleUpdate` builds an `updates` object then checks `Object.keys(updates).length === 0` — cleaner than checking each flag individually; relies on only adding defined flags
- `handleList` passes `Record<string, unknown>` to `listTasks` — avoids TaskFilters type cast; `TaskService.listTasks` accepts `unknown` and validates internally via Zod so only valid filter keys propagate
- `commentService.getComments` typed as returning `Promise<Comment[]>` in the handler (with `await`) — production CommentService is synchronous but test mock uses `mockResolvedValue`; both work with `await`

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

- Pre-existing TypeScript error in `src/api/server.ts` line 140: `FastifyBaseLogger` not assignable to pino `Logger` (missing `msgPrefix` property). This error predates this plan — no change from Plan 01 baseline.

## User Setup Required

None — unit tests only. Runtime Slack testing requires the Slack App dashboard setup documented in 23-02-SUMMARY.md.

## Next Phase Readiness

- Plan 25-03 has all 6 task stubs replaced — it can now implement the project/dep/comment/subtask stubs in the same switch router
- All task-related `respondError('Not yet implemented')` stubs are eliminated — only project, dep, comment, subtask, and operational stubs remain
- 773 tests passing (63 test files) — no regressions

## Self-Check: PASSED

- FOUND: src/slack/commands/tasks-command.ts (handleList, handleShow, handleCreate, handleUpdate, handleDelete, handleClaim all present)
- FOUND: src/slack/commands/__tests__/tasks-command.test.ts (39 total tests)
- FOUND: commit 8eee79e (Task 1: implement 6 handlers)
- FOUND: commit 2675851 (Task 2: unit tests)

---
*Phase: 25-slash-command-handlers*
*Completed: 2026-02-18*
