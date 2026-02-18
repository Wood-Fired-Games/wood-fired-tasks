---
phase: 25-slash-command-handlers
plan: 01
subsystem: slack
tags: [slack, bolt, slash-command, block-kit, routing]

requires:
  - phase: 24-block-kit-formatters-user-identity
    provides: UserIdentityCache (user-identity.ts) and Block Kit formatters consumed by future Plans 02/03
  - phase: 23-slack-bolt-integration
    provides: SlackService with getApp() returning the Bolt App instance wired in server.ts

provides:
  - registerTasksCommand function in src/slack/commands/tasks-command.ts
  - Subcommand router skeleton with all 26 subcommands (stubs for Plans 02/03 to fill)
  - parseArgs utility for --flag value splitting from positional args
  - respondBlocks / respondError helpers for consistent ephemeral Block Kit responses
  - formatServiceError for NotFoundError / ValidationError / BusinessError formatting
  - HELP_BLOCKS constant for /tasks help and bare /tasks responses
  - server.ts wiring: UserIdentityCache constructed once, registerTasksCommand called if Slack enabled
  - 18 unit tests covering ack-first, routing, help, errors, parseArgs, helper fns

affects:
  - 25-slash-command-handlers plans 02 and 03 — they fill the stub cases in the switch router

tech-stack:
  added: []
  patterns:
    - "Single /tasks Bolt command with subcommand switch router — Plans 02/03 add case implementations"
    - "ack() always first statement in Bolt slash command handler — no exceptions"
    - "respond() with response_type ephemeral for all slash command output — never say()"
    - "UserIdentityCache constructed once in server.ts, passed as dependency — preserves TTL cache across invocations"
    - "formatServiceError centralises NotFoundError/ValidationError/BusinessError formatting for all handlers"
    - "void services / void identityCache markers for stub phase — removed as Plans 02/03 implement handlers"

key-files:
  created:
    - src/slack/commands/tasks-command.ts
    - src/slack/commands/__tests__/tasks-command.test.ts
  modified:
    - src/api/server.ts

key-decisions:
  - "Subcommand switch with void services/identityCache markers for Plans 02/03 stubs — compiles cleanly, easy to fill in"
  - "Use 'as unknown as UserIdentityCache' in test mock — avoids needing private fields (cache, client, ttlMs) in plain mock objects"
  - "SlashCommand type annotation on handler args — satisfies TypeScript without needing to vi.mock @slack/bolt"

patterns-established:
  - "Pattern: Mock App as plain object with .command() vi.fn() — captures handler for direct invocation in unit tests"
  - "Pattern: Call order tracking with callOrder array to prove ack-first without race conditions"
  - "Pattern: Type assertion (as unknown as ConcreteClass) for test mocks of classes with private fields"

requirements-completed:
  - SCMD-01
  - SCMD-02
  - SCMD-03
  - SCMD-10

duration: 4min
completed: 2026-02-18
---

# Phase 25 Plan 01: Slash Command Handlers Summary

**Single /tasks Bolt command router with subcommand dispatch, help, parseArgs, respondBlocks/respondError helpers, formatServiceError, and server.ts wiring — foundation for Plans 02 and 03**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-18T03:27:48Z
- **Completed:** 2026-02-18T03:31:18Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Created `src/slack/commands/tasks-command.ts` with all exported utilities and the main `registerTasksCommand` function containing the full 26-subcommand switch router skeleton
- Wired `registerTasksCommand` into `server.ts` after `slackService.start()` with a `slackApp` null guard — safe when Slack tokens are absent
- Added 18 unit tests proving ack-first behavior, help rendering for bare `/tasks` and `/tasks help`, unknown subcommand error formatting with hint, parseArgs flag/positional splitting, formatServiceError error type handling, and helper function behavior

## Task Commits

1. **Task 1: Create tasks-command.ts** - `48c59bf` (feat)
2. **Task 2: Wire server.ts and add unit tests** - `e4101c6` (feat)
3. **Auto-fix: Type assertion for mock UserIdentityCache** - `f5def2c` (fix)

**Plan metadata:** (docs commit below)

## Files Created/Modified

- `src/slack/commands/tasks-command.ts` - registerTasksCommand, parseArgs, respondBlocks, respondError, formatServiceError, HELP_BLOCKS, Services interface
- `src/slack/commands/__tests__/tasks-command.test.ts` - 18 unit tests for routing, help, errors, parseArgs, helpers
- `src/api/server.ts` - Added registerTasksCommand and UserIdentityCache imports; conditional registration block after slackService.start()

## Decisions Made

- Subcommand stubs use `await respondError(respond, 'Not yet implemented: `subcommand`')` so bare invocations give useful feedback while Plans 02/03 fill them in — avoids silent no-ops
- `void services; void identityCache;` markers at top of handler suppress TypeScript unused-variable warnings without suppression comments — removed as Plans 02/03 implement the actual calls
- Test mock for `UserIdentityCache` uses `as unknown as UserIdentityCache` type assertion because the concrete class has private fields (`cache`, `client`, `ttlMs`) that a plain object cannot satisfy structurally

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Type assertion for mock UserIdentityCache in test file**
- **Found during:** Overall verification (`npx tsc --noEmit`)
- **Issue:** `makeMockIdentityCache()` returned a plain object with `resolve` and `clear` vi.fn() properties but TypeScript requires all fields of the concrete `UserIdentityCache` class including private `cache`, `client`, and `ttlMs`
- **Fix:** Applied `as unknown as InstanceType<typeof import('...').UserIdentityCache>` type assertion to the mock return value
- **Files modified:** `src/slack/commands/__tests__/tasks-command.test.ts`
- **Verification:** `npx tsc --noEmit` shows zero new errors (only pre-existing server.ts logger error remains)
- **Committed in:** `f5def2c`

---

**Total deviations:** 1 auto-fixed (Rule 1 - type bug in test mock)
**Impact on plan:** Essential for clean TypeScript compile. No scope creep.

## Issues Encountered

- Pre-existing TypeScript error in `src/api/server.ts` line 138: `FastifyBaseLogger` not assignable to pino `Logger` (missing `msgPrefix` property). This error predates this plan and is out of scope. Verified it existed before our changes by confirming it persists without our files.

## User Setup Required

None — no external service configuration required for the router skeleton. Slack App dashboard setup (slash command `/tasks` registration) was documented as a prerequisite in 23-02-SUMMARY.md and remains unchanged.

## Next Phase Readiness

- Plans 02 and 03 have the full router skeleton ready — just fill in the stub cases
- `parseArgs`, `respondBlocks`, `respondError`, `formatServiceError` are all exported and unit-tested — Plans 02/03 import them directly
- `UserIdentityCache` is now wired in production code (server.ts) — the UIDENT-03 gap identified in Phase 24 VERIFICATION.md is closed at the infrastructure level
- 752 tests passing (63 test files) — no regressions

## Self-Check: PASSED

- FOUND: src/slack/commands/tasks-command.ts
- FOUND: src/slack/commands/__tests__/tasks-command.test.ts
- FOUND: .planning/phases/25-slash-command-handlers/25-01-SUMMARY.md
- FOUND: commit 48c59bf (Task 1: tasks-command.ts)
- FOUND: commit e4101c6 (Task 2: server.ts wiring + tests)
- FOUND: commit f5def2c (type fix: UserIdentityCache mock assertion)

---
*Phase: 25-slash-command-handlers*
*Completed: 2026-02-18*
