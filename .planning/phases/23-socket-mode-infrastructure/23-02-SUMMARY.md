---
phase: 23-socket-mode-infrastructure
plan: 02
subsystem: api
tags: [slack, bolt, socket-mode, fastify, lifecycle, vitest]

# Dependency graph
requires:
  - phase: 23-01
    provides: "config.SLACK_BOT_TOKEN and config.SLACK_APP_TOKEN as string | undefined with both-or-neither refine()"
provides:
  - "SlackService class wrapping @slack/bolt App with start/stop/isEnabled/getApp lifecycle"
  - "@slack/bolt@^4.6.0 runtime dependency installed"
  - "@slack/types@^2.20.0 dev dependency installed for Block Kit type safety"
  - "SlackService integrated into createServer() with onClose hook for graceful Bolt WebSocket cleanup"
  - "14 unit tests confirming token-absent no-op, Socket Mode connection, idempotent stop"
affects:
  - 25-slash-commands (imports SlackService.getApp() to register slash command handlers)
  - 26-notification-pipeline (imports SlackService.getApp() to post messages)
  - 24-formatters-identity (no direct dependency, builds on v1.5 foundation)

# Tech tracking
tech-stack:
  added:
    - "@slack/bolt@^4.6.0 (runtime — Socket Mode WebSocket client)"
    - "@slack/types@^2.20.0 (devDependency — Block Kit TypeScript types)"
  patterns:
    - "Feature flag via token absence: start() checks both tokens; if either absent, returns early with info log"
    - "started boolean guard prevents app.stop() on uninitialized Bolt App (idempotent stop)"
    - "SlackService lifecycle ordered: instantiate before onClose, start() after onClose registration"
    - "Bolt mock as named function (not arrow fn) — required for vi.mock + new App() constructor pattern in Vitest ESM"

key-files:
  created:
    - src/services/slack.service.ts
    - src/services/__tests__/slack.service.test.ts
  modified:
    - src/api/server.ts
    - package.json
    - package-lock.json

key-decisions:
  - "SlackService not decorated onto Fastify instance — passed by closure in server.ts; Phase 25/26 will decide decoration vs injection"
  - "started flag separate from app null-check — prevents stop() crash when start() threw partway through"
  - "getApp() returns App | null — downstream phases guard with isEnabled() before calling getApp()"
  - "Vitest ESM mock requires vi.fn(function() {...}) not arrow function for constructor mocking"

patterns-established:
  - "Optional Bolt integration: SlackService is inert until both tokens present — same pattern as config refine()"
  - "Service lifecycle in server.ts: instantiate → register onClose → start (ensures cleanup guaranteed before start)"

requirements-completed:
  - SLCK-01
  - SLCK-02

# Metrics
duration: 2min
completed: 2026-02-18
---

# Phase 23 Plan 02: SlackService with @slack/bolt and Fastify Integration Summary

**@slack/bolt installed and SlackService wrapping Bolt App wired into Fastify server with token-absent no-op feature flag and graceful onClose WebSocket cleanup**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-18T02:38:42Z
- **Completed:** 2026-02-18T02:40:44Z
- **Tasks:** 2
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments

- Installed @slack/bolt@^4.6.0 (runtime) and @slack/types@^2.20.0 (dev) — 53 new packages
- Created SlackService with start/stop/isEnabled/getApp lifecycle; token-absent path is safe no-op with info log
- Added 14 unit tests covering token-absent, token-present, graceful shutdown, and idempotent stop edge cases
- Integrated SlackService into createServer(): instantiation before onClose, start() after hook registration, stop() in onClose hook

## Task Commits

Each task was committed atomically:

1. **Task 1: Install @slack/bolt and create SlackService with unit tests** - `922f1a6` (feat)
2. **Task 2: Integrate SlackService into Fastify server with onClose hook** - `22947da` (feat)

**Plan metadata:** [pending final commit]

## Files Created/Modified

- `src/services/slack.service.ts` - SlackService class with start/stop/isEnabled/getApp, token-absent guard
- `src/services/__tests__/slack.service.test.ts` - 14 unit tests with mocked @slack/bolt App constructor
- `src/api/server.ts` - SlackService import, instantiation with config tokens, onClose stop(), post-hook start()
- `package.json` - @slack/bolt in dependencies, @slack/types in devDependencies
- `package-lock.json` - 53 packages added

## Decisions Made

- SlackService is not decorated onto the Fastify instance at this stage — it lives as a local const in createServer(). Phase 25/26 plans will decide whether to decorate or inject it when registering handlers.
- `started` boolean separate from `app !== null` null-check — if Bolt App constructor succeeded but `app.start()` threw, `started` remains false and `stop()` won't attempt to call stop on a not-started app.
- `getApp()` returns `App | null` — callers in Phase 25/26 must guard with `isEnabled()` before using the App instance.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Vitest ESM constructor mock for @slack/bolt App**
- **Found during:** Task 1 (running SlackService unit tests)
- **Issue:** Initial `vi.mock('@slack/bolt', () => ({ App: vi.fn().mockImplementation(() => ({...})) }))` used an arrow function factory — Vitest ESM module mocking requires the constructor to be a proper function (not arrow) so `new App()` works. 9 of 14 tests failed with "is not a constructor".
- **Fix:** Changed mock to `vi.fn(function() { return mockAppInstance; })` with shared `mockAppInstance` object. This makes the mock callable as a constructor while still allowing call verification.
- **Files modified:** src/services/__tests__/slack.service.test.ts
- **Verification:** All 14 tests pass after fix
- **Committed in:** 922f1a6 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug in test mock approach)
**Impact on plan:** Fix was necessary for tests to function. No scope creep — production code unchanged.

## Issues Encountered

None in production code. Test mock required one iteration to find the correct Vitest ESM constructor mocking pattern (arrow vs named function).

## User Setup Required

**Slack App dashboard configuration is required before runtime Slack connectivity.** The code is complete and token-absent mode is fully tested. When the user is ready to connect:

1. Create Slack App at https://api.slack.com/apps
2. Enable Socket Mode under App Settings
3. Add bot scopes: `chat:write`, `chat:write.public`, `commands`, `channels:read`
4. Generate app-level token with `connections:write` scope
5. Install app to workspace
6. Set `SLACK_BOT_TOKEN` (xoxb-...) and `SLACK_APP_TOKEN` (xapp-...) in environment

See plan frontmatter `user_setup` section for full details.

## Next Phase Readiness

- SlackService ready: Phase 24 (formatters+identity) and Phase 25 (slash commands) can import SlackService and call getApp() to register handlers
- Token-absent behavior verified: existing 651 tests all pass without Slack tokens, confirming SLCK-04 optional feature flag
- Total tests: 665 passing (59 test files)
- Phase 23 is now complete (both plans done): proceed to Phase 24

## Self-Check: PASSED

- src/services/slack.service.ts: FOUND
- src/services/__tests__/slack.service.test.ts: FOUND
- src/api/server.ts: FOUND (contains slackService at lines 135, 147, 218)
- .planning/phases/23-socket-mode-infrastructure/23-02-SUMMARY.md: FOUND
- Commit 922f1a6: FOUND (Task 1)
- Commit 22947da: FOUND (Task 2)
- All 665 tests passing

---
*Phase: 23-socket-mode-infrastructure*
*Completed: 2026-02-18*
