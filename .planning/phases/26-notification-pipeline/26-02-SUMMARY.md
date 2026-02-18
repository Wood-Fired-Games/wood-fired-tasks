---
phase: 26-notification-pipeline
plan: 02
subsystem: slack
tags: [slack, notifications, eventbus, block-kit, retry, promise-allsettled]

# Dependency graph
requires:
  - phase: 26-notification-pipeline
    provides: SlackChannelSubscriptionRepository.findSubscribedChannels, formatTaskNotification with projectName
  - phase: 14-sse-event-system
    provides: EventBus singleton, TaskEvent types
provides:
  - SlackNotifier class (EventBus subscriber, per-channel posting with retry and error isolation)
  - Full notification pipeline wiring in server.ts (subscription repo + notifier + shutdown hooks)
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [fire-and-forget-async-with-catch, promise-allsettled-error-isolation, exponential-backoff-retry, minimal-logger-interface]

key-files:
  created:
    - src/slack/notifier.ts
    - src/slack/__tests__/notifier.test.ts
  modified:
    - src/api/server.ts

key-decisions:
  - "NotifierLogger minimal interface instead of pino Logger -- avoids FastifyBaseLogger/pino type mismatch, follows dependency inversion"
  - "PERMANENT_ERRORS Set for O(1) lookup -- not_in_channel, channel_not_found, invalid_auth, token_revoked fail fast without retry"
  - "Additive onClose hook for slackNotifier.stop() -- Fastify executes all onClose hooks, notifier stop only unsubscribes from EventBus (no Slack API calls)"

patterns-established:
  - "Fire-and-forget async: synchronous EventBus handler calls async method then chains .catch() to prevent unhandled rejections"
  - "Promise.allSettled for per-channel error isolation: one channel failure cannot block others"
  - "Exponential backoff retry: 500ms * (attempt + 1) for transient errors, up to maxRetries attempts"

requirements-completed: [NTFY-01, NTFY-05]

# Metrics
duration: 5min
completed: 2026-02-18
---

# Phase 26 Plan 02: SlackNotifier EventBus Subscriber and Server Wiring Summary

**SlackNotifier subscribes to 5 task event types, posts Block Kit notifications to subscribed channels with retry and per-channel error isolation via Promise.allSettled**

## Performance

- **Duration:** 5 min
- **Started:** 2026-02-18T04:13:18Z
- **Completed:** 2026-02-18T04:18:19Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- SlackNotifier class subscribes to task.created, task.updated, task.status_changed, task.claimed, task.deleted via EventBus with fire-and-forget .catch() pattern
- Per-channel error isolation via Promise.allSettled: one channel's API failure does not block others
- Transient error retry with exponential backoff (500ms, 1000ms) up to 2 retries; permanent errors (not_in_channel, channel_not_found, invalid_auth, token_revoked) fail fast
- server.ts fully wired: SlackChannelSubscriptionRepository created and passed to registerTasksCommand, SlackNotifier instantiated with start()/stop() lifecycle hooks
- 14 new tests covering lifecycle, event handling, error isolation, retry behavior, and fire-and-forget pattern verification
- 839 total tests passing (825 + 14)

## Task Commits

Each task was committed atomically:

1. **Task 1: SlackNotifier class with EventBus subscription, retry, and error isolation** - `e6f4c2f` (feat)
2. **Task 2: Wire SlackNotifier and SlackChannelSubscriptionRepository into server.ts** - `d762235` (feat)

## Files Created/Modified
- `src/slack/notifier.ts` - SlackNotifier class: EventBus subscription, channel querying, project name resolution, Block Kit formatting, chat.postMessage with retry and error isolation
- `src/slack/__tests__/notifier.test.ts` - 14 unit tests: lifecycle (3), event handling (5), error isolation (2), retry behavior (3), fire-and-forget verification (1)
- `src/api/server.ts` - Added imports, created subscriptionRepo, passed to registerTasksCommand as 4th param, instantiated SlackNotifier with start/stop lifecycle

## Decisions Made
- Used minimal NotifierLogger interface (`{ error(obj, msg) }`) instead of importing pino Logger directly: avoids pre-existing FastifyBaseLogger/pino type mismatch while maintaining dependency inversion
- PERMANENT_ERRORS as a Set for O(1) lookup of non-retryable Slack API error codes
- Additive onClose hook for notifier.stop(): Fastify supports multiple onClose hooks, notifier stop is synchronous (only unsubscribes from EventBus, no Slack API calls needed)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Logger type incompatibility between pino and Fastify**
- **Found during:** Task 2 (server.ts wiring)
- **Issue:** `server.log` (FastifyBaseLogger) is not assignable to `pino.Logger` due to missing `msgPrefix` property -- this was a pre-existing type mismatch in the codebase also affecting SlackService
- **Fix:** Replaced `import type { Logger } from 'pino'` with a minimal `NotifierLogger` interface that accepts both FastifyBaseLogger and pino Logger
- **Files modified:** src/slack/notifier.ts, src/slack/__tests__/notifier.test.ts
- **Verification:** `npx tsc --noEmit` passes for all new code (pre-existing SlackService error unchanged)
- **Committed in:** d762235 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix)
**Impact on plan:** Logger interface change is a clean dependency inversion improvement. No scope creep.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Full notification pipeline complete: task event -> EventBus -> SlackNotifier -> subscription query -> project name resolution -> Block Kit format -> chat.postMessage per channel
- This is the final plan of Phase 26 (Notification Pipeline) and the v1.5 Slack Integration milestone
- Pre-existing FastifyBaseLogger/pino type mismatch in SlackService remains as a tech-debt item (does not affect runtime behavior)

## Self-Check: PASSED

All 3 files verified present. Both task commits (e6f4c2f, d762235) confirmed in git log. Line counts: notifier.ts 141 (min 60), tests 383 (min 100).

---
*Phase: 26-notification-pipeline*
*Completed: 2026-02-18*
