---
phase: 24-block-kit-formatters-user-identity
plan: 01
subsystem: slack
tags: [slack, block-kit, formatters, typescript, tdd, vitest]

# Dependency graph
requires:
  - phase: 23-socket-mode-infrastructure
    provides: SlackService with getApp(), @slack/types devDep already installed
  - phase: core
    provides: Task, TaskStatus, TaskPriority domain types from src/types/task.ts
  - phase: events
    provides: TaskEvent type from src/events/types.ts

provides:
  - "formatTaskList(tasks): KnownBlock[] — header + status/priority/assignee per task, truncates at 20 with context footer"
  - "formatTaskDetail(task): KnownBlock[] — header (≤150 chars) + fields SectionBlock + optional description"
  - "formatTaskNotification(event): KnownBlock[] — compact event label + actor + task summary + /tasks show <id>"
  - "STATUS_EMOJI and PRIORITY_INDICATOR maps exported for reuse (project-formatter Plan 02)"

affects:
  - 24-02 (project-formatter will import STATUS_EMOJI, PRIORITY_INDICATOR from task-formatter)
  - 25-slash-commands (Phase 25 handlers call these formatters to compose Block Kit responses)
  - 26-notifications (Phase 26 SlackNotifier calls formatTaskNotification for event-driven messages)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure formatter functions: take domain objects, return KnownBlock[] — no side effects, no async, no service deps"
    - "Type-only @slack/types imports: KnownBlock, SectionBlock, HeaderBlock, DividerBlock, ContextBlock, MrkdwnElement"
    - "HeaderBlock 150-char truncation: title.length > 150 ? title.slice(0, 147) + '...' : title"
    - "SectionBlock fields array for 2-column key/value detail layouts"
    - "ContextBlock footer for truncated lists: Showing 20 of N tasks"
    - "Event label lookup map with unknown-type fallback to raw eventType string"

key-files:
  created:
    - src/slack/task-formatter.ts
    - src/slack/formatters/__tests__/task-formatter.test.ts
  modified: []

key-decisions:
  - "Title truncation boundary is title.length > 150 (not > 147): a title of exactly 150 chars passes through untouched; 151+ truncated to 147 + '...'"
  - "STATUS_EMOJI and PRIORITY_INDICATOR exported as named exports for reuse in project-formatter (Plan 02)"
  - "Formatter file located at src/slack/task-formatter.ts (not src/slack/formatters/task-formatter.ts) — tests import from ../../task-formatter.js"
  - "toEndWith is not a Vitest built-in matcher — use toMatch(/\\.\\.\\.$/)"

patterns-established:
  - "Pure Block Kit formatter pattern: (domain object) => KnownBlock[] with no external dependencies"
  - "TDD RED/GREEN: write failing tests importing non-existent module first, then implement until passing"

requirements-completed:
  - BKIT-01
  - BKIT-02
  - BKIT-04

# Metrics
duration: 5min
completed: 2026-02-18
---

# Phase 24 Plan 01: Block Kit Task Formatter Summary

**Three pure Block Kit formatter functions — formatTaskList, formatTaskDetail, formatTaskNotification — producing typed KnownBlock[] from Task and TaskEvent domain objects via @slack/types**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-18T03:01:20Z
- **Completed:** 2026-02-18T03:06:45Z
- **Tasks:** 2
- **Files modified:** 2 (created)

## Accomplishments
- `formatTaskList`: renders task arrays as Block Kit with status emoji, priority indicator, assignee per task; handles empty arrays, truncates at 20 with Slack-safe context footer
- `formatTaskDetail`: HeaderBlock with 150-char truncation + SectionBlock fields (status, priority, assignee, due date, project, created_by, optional tags) + optional description block
- `formatTaskNotification`: compact SectionBlock joining event label, actor, task summary, and `/tasks show <id>` command reference for all 5 event types
- 43 tests passing; STATUS_EMOJI and PRIORITY_INDICATOR exported for Plan 02 reuse

## Task Commits

Each task was committed atomically:

1. **Task 1: Write failing tests for task formatters (RED)** - `9fe964f` (test)
2. **Task 2: Implement task formatters to pass all tests (GREEN)** - `1fed72e` (feat)

**Plan metadata:** *(docs commit follows)*

_Note: TDD tasks have two commits — test (RED) then feat (GREEN)_

## Files Created/Modified
- `src/slack/task-formatter.ts` — Three exported formatter functions plus STATUS_EMOJI and PRIORITY_INDICATOR maps
- `src/slack/formatters/__tests__/task-formatter.test.ts` — 43 test cases covering formatTaskList, formatTaskDetail, formatTaskNotification with makeTask() and makeTaskEvent() factories

## Decisions Made
- **Title truncation boundary:** `title.length > 150` (not `> 147`) — a 150-char title passes through untouched; only titles exceeding 150 chars are truncated to 147 + `...` to stay within the Slack HeaderBlock 150-char limit
- **Export STATUS_EMOJI and PRIORITY_INDICATOR:** Named exports so Plan 02 (project-formatter) can import and reuse the same emoji mappings without duplication
- **Formatter location:** `src/slack/task-formatter.ts` (flat in `src/slack/`) matches the import path `../../task-formatter.js` used in the test file under `src/slack/formatters/__tests__/`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Replaced `toEndWith` with `toMatch(/\\.\\.\\.$/)`**
- **Found during:** Task 2 (implementing formatters — ran tests)
- **Issue:** `toEndWith` is not a Vitest built-in matcher; the Vitest API uses Jest-compatible `expect` matchers and `toEndWith` does not exist, causing `Invalid Chai property: toEndWith` errors
- **Fix:** Replaced `.toEndWith('...')` with `.toMatch(/\\.\\.\\./)` and `.not.toEndWith('...')` with `.not.toMatch(/\\.\\.\\.$/)` in the title-truncation tests
- **Files modified:** `src/slack/formatters/__tests__/task-formatter.test.ts`
- **Verification:** Both truncation tests pass after fix
- **Committed in:** `1fed72e` (Task 2 commit — test + impl both staged together)

---

**Total deviations:** 1 auto-fixed (1 bug in test assertions)
**Impact on plan:** Minor test assertion API mismatch. No scope change. Implementation unaffected.

## Issues Encountered
- `toEndWith` missing from Vitest matchers — fixed inline during Task 2 GREEN phase per Rule 1 (bug fix)

## User Setup Required
None — no external service configuration required. Formatters are pure functions; no Slack API calls.

## Next Phase Readiness
- Task formatter functions ready to import in Phase 25 (slash commands) and Phase 26 (notifications)
- STATUS_EMOJI and PRIORITY_INDICATOR maps exported for Plan 02 (project-formatter)
- TypeScript compiles cleanly for new files (pre-existing server.ts logger type mismatch is unrelated)
- 734 tests passing, no regressions

---
*Phase: 24-block-kit-formatters-user-identity*
*Completed: 2026-02-18*
