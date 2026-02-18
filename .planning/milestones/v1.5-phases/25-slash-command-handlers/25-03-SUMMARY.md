---
phase: 25-slash-command-handlers
plan: 03
subsystem: slack
tags: [slack, bolt, slash-command, block-kit, project-handlers, dep-handlers, comment-handlers, subtask-handlers, uident-03]

requires:
  - phase: 25-slash-command-handlers
    plan: 02
    provides: 6 task subcommand handlers (list/show/create/update/delete/claim), parseArgs, respondBlocks, respondError, formatServiceError, Services interface
  - phase: 24-block-kit-formatters-user-identity
    provides: formatProjectList, formatProjectDetail (project-formatter.ts), formatTaskList, formatTaskDetail (task-formatter.ts), UserIdentityCache

provides:
  - handleProjectList — responds with formatProjectList Block Kit blocks
  - handleProjectShow — responds with formatProjectDetail for a single project
  - handleProjectCreate — creates project with name+description, responds with formatProjectDetail
  - handleProjectUpdate — updates project fields from --name/--description flags
  - handleProjectDelete — deletes project, responds with :white_check_mark: confirmation
  - handleDepAdd — adds dependency with cycle detection, validates both IDs
  - handleDepList — shows both directions (blocks + blocked-by) in one SectionBlock
  - handleDepRemove — removes dependency, responds with confirmation
  - handleCommentAdd — UIDENT-03: resolves display name for author before addComment
  - handleCommentList — shows all comments per task as HeaderBlock + per-comment SectionBlocks
  - handleCommentDelete — deletes comment by ID, responds with confirmation
  - handleSubtaskCreate — UIDENT-03: resolves display name for created_by, requires --project
  - handleSubtaskList — shows subtasks via formatTaskList
  - handleHealth — countTasks with try/catch, reports healthy or failed
  - handleCliOnly — informational stubs for backup/doctor/stats/db-check/completions
  - 28 unit tests (project 6, dep 4, comment 4, subtask 3, health 2, CLI-only 5, + claim 2 from plan 02)

affects:
  - Phase 26 — Slack notifications; uses full /tasks handler surface area as reference
  - Any future extension of /tasks subcommands — adds to this switch router

tech-stack:
  added: []
  patterns:
    - "handleCliOnly shared function for all 5 CLI-only stubs — fall-through case grouping in switch"
    - "handleHealth uses try/catch around countTasks — health approximation without dedicated health endpoint"
    - "handleCommentList shows all comments without slicing — unlike handleShow which limits to last 5"
    - "handleDepList shows both directions (blocks + blocked-by) in single SectionBlock with mrkdwn"
    - "handleCommentAdd/handleSubtaskCreate follow UIDENT-03: identityCache.resolve before service call"
    - "Flag values are single whitespace-split tokens — no shell quoting; test inputs must reflect this"

key-files:
  created: []
  modified:
    - src/slack/commands/tasks-command.ts
    - src/slack/commands/__tests__/tasks-command.test.ts

key-decisions:
  - "handleCliOnly uses fall-through switch cases (backup/doctor/stats/db-check/completions) — one handler, no duplication"
  - "handleHealth wraps countTasks in try/catch only — any exception = health check failed; no per-service health probes"
  - "handleCommentList shows ALL comments (no slice) — comment-list is a dedicated command, not a task detail appendage"
  - "CLI-only stubs respond with :information_source: block, not :x: error — informational, not an error condition"
  - "Flag values in command.text are single whitespace-split tokens (no shell quoting) — test assertions must use unquoted single-token values"

requirements-completed:
  - SCMD-09
  - SCMD-10

duration: 4min
completed: 2026-02-18
---

# Phase 25 Plan 03: Remaining Subcommand Handlers Summary

**All 20 remaining /tasks subcommand handlers implemented: 5 project, 3 dependency, 3 comment, 2 subtask, 1 health, and 5 CLI-only informational stubs — completing full slash command surface area with 801 tests passing**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-18T03:40:35Z
- **Completed:** 2026-02-18T03:44:30Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Implemented all 20 remaining subcommand handlers in `src/slack/commands/tasks-command.ts`:
  - `handleProjectList/Show/Create/Update/Delete`: full CRUD for projects with `formatProjectList`/`formatProjectDetail` Block Kit responses
  - `handleDepAdd/List/Remove`: dependency management with both-directions dep-list, dual-ID validation for add/remove
  - `handleCommentAdd/List/Delete`: comment management with UIDENT-03 author resolution for add; ALL comments shown (not sliced like handleShow)
  - `handleSubtaskCreate/List`: subtask management with UIDENT-03 created_by resolution, required --project flag
  - `handleHealth`: try/catch around `countTasks()` — healthy message with count or failure message
  - `handleCliOnly`: single shared function for all 5 CLI-only stubs (backup/doctor/stats/db-check/completions) using fall-through switch cases
- Added import for `formatProjectList`, `formatProjectDetail` from `../formatters/project-formatter.js`
- Wired all 20 handlers into switch statement, removing all "Not yet implemented" stubs
- Zero remaining "not yet implemented" strings in tasks-command.ts (verified)
- Added 28 unit tests across all new subcommand groups; 801 total tests, 63 test files, all passing

## Task Commits

1. **Task 1: Implement project, dep, comment, subtask, health, CLI-only handlers** - `2836367` (feat)
2. **Task 2: Add unit tests for all remaining handlers** - `f05ea8c` (test)

**Plan metadata:** (docs commit below)

## Files Created/Modified

- `src/slack/commands/tasks-command.ts` — Added `formatProjectList`/`formatProjectDetail` import; implemented 15 new handler functions (5 project + 3 dep + 3 comment + 2 subtask + 1 health + 1 CLI-only shared); wired all 20 switch cases; zero stubs remain
- `src/slack/commands/__tests__/tasks-command.test.ts` — Added `makeMockProject` factory; expanded `makeMockServices` with full projectService mock and corrected countTasks return value to 42; added 28 tests covering all new handlers

## Decisions Made

- `handleCliOnly` uses fall-through switch cases (`case 'backup': case 'doctor': ... await handleCliOnly(respond, subcommand)`) — one function handles all 5 CLI-only commands without duplication; `subcommand` is naturally in scope
- `handleHealth` wraps only `countTasks` — no per-service health probes; any thrown exception marks health as failed
- `handleCommentList` shows all comments without slicing — unlike `handleShow` which shows last-5; comment-list is a dedicated full view
- CLI-only stubs respond with `:information_source:` block, not `:x:` error — these are informational (commands exist but require CLI), not error conditions
- Flag values in command.text are single whitespace-split tokens (no shell quoting supported by parseArgs) — test inputs use single-token flag values (e.g., `--name NewName` not `--name "New Name"`)

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

- Two test assertions initially failed for `project-create` and `project-update` because test inputs used shell-quoted strings (e.g., `--description "A desc"` and `--name "New Name"`). The parseArgs function splits on whitespace without shell-quoting awareness, so `"A desc"` becomes `'"A'` + `'desc"'`. Fixed by using single-token values in test inputs (`--description ADesc`, `--name NewName`). This is expected behavior documented in the plan's Pitfall 7 note about multi-word args.
- Pre-existing TypeScript error in `src/api/server.ts` line 140: `FastifyBaseLogger` not assignable to pino `Logger` (missing `msgPrefix` property). Predates this plan — no change from Plan 02 baseline.

## User Setup Required

None — unit tests only. Runtime Slack testing requires the Slack App dashboard setup documented in 23-02-SUMMARY.md.

## Next Phase Readiness

- All 26 /tasks subcommands now have real implementations — zero stubs remain
- Full CLI parity achieved: every service-backed operation (task, project, dep, comment, subtask) has a corresponding /tasks subcommand
- 801 tests passing (63 test files) — no regressions from Plan 02 baseline of 773
- Phase 25 complete — Phase 26 (Slack notifications / SlackNotifier) can proceed

## Self-Check: PASSED

- FOUND: src/slack/commands/tasks-command.ts (handleProjectList, handleProjectShow, handleProjectCreate, handleProjectUpdate, handleProjectDelete, handleDepAdd, handleDepList, handleDepRemove, handleCommentAdd, handleCommentList, handleCommentDelete, handleSubtaskCreate, handleSubtaskList, handleHealth, handleCliOnly all present)
- FOUND: src/slack/commands/__tests__/tasks-command.test.ts (67 total tests in file)
- FOUND: commit 2836367 (Task 1: implement handlers)
- FOUND: commit f05ea8c (Task 2: unit tests)
- VERIFIED: `npx tsc --noEmit` — only pre-existing server.ts error, no new errors
- VERIFIED: `npx vitest run` — 801/801 tests passing

---
*Phase: 25-slash-command-handlers*
*Completed: 2026-02-18*
