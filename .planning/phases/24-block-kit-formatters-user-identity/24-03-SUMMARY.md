---
phase: 24-block-kit-formatters-user-identity
plan: 03
subsystem: slack
tags: [slack, web-api, user-identity, caching, ttl, vitest, tdd]

# Dependency graph
requires:
  - phase: 23-socket-mode-infrastructure
    provides: SlackService with getApp() returning Bolt App instance with client WebClient

provides:
  - UserIdentityCache class in src/slack/user-identity.ts
  - resolve(userId) calls users.info and returns display name with fallback chain
  - TTL in-memory Map cache (default 5 min) prevents duplicate API calls
  - Error fallback: caches userId for 30s (ERROR_TTL_MS) on API failure
  - clear() empties cache for testing and reset scenarios

affects:
  - 25-slash-commands
  - 26-slack-notifications

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dependency inversion: UserIdentityCache takes WebClient not SlackService — allows unit testing without Bolt App"
    - "Error TTL pattern: short TTL (30s) for error fallbacks vs full TTL (5 min) for successful lookups"
    - "Fallback chain: trim + non-empty check for display_name and real_name before falling back"

key-files:
  created:
    - src/slack/user-identity.ts
    - src/slack/__tests__/user-identity.test.ts
  modified: []

key-decisions:
  - "UserIdentityCache takes WebClient not SlackService — dependency inversion enables unit testing with plain mock object, no vi.mock() needed"
  - "Error TTL (ERROR_TTL_MS = 30_000ms) is a hardcoded constant — 30s brief cache on failure prevents API hammering without blocking retry"
  - "No logger parameter in UserIdentityCache — keeps class self-contained; Phase 25 handlers log context before calling resolve()"

patterns-established:
  - "Mock WebClient as plain object cast to WebClient — no vi.mock('@slack/web-api') needed; pass mock directly to constructor"
  - "vi.useFakeTimers() in beforeEach + vi.useRealTimers() in afterEach for TTL expiry tests without real waits"

requirements-completed:
  - UIDENT-01
  - UIDENT-02

# Metrics
duration: 2min
completed: 2026-02-18
---

# Phase 24 Plan 03: User Identity Cache Summary

**TTL-based in-memory UserIdentityCache class that resolves Slack user IDs to display names via users.info with fallback chain (display_name -> real_name -> name -> userId) and graceful error handling**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-18T03:01:30Z
- **Completed:** 2026-02-18T03:03:44Z
- **Tasks:** 2 (RED + GREEN)
- **Files modified:** 2

## Accomplishments
- Implemented UserIdentityCache class with resolve() and clear() methods
- Fallback chain correctly handles empty/missing display_name and real_name
- TTL cache prevents duplicate users.info API calls for same userId within 5 minutes
- Error handling returns userId gracefully and caches briefly at 30s (not full TTL) to avoid API hammering
- 12 comprehensive tests covering all specified scenarios — all pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Write failing tests for UserIdentityCache (RED)** - `6044ba9` (test)
2. **Task 2: Implement UserIdentityCache to pass all tests (GREEN)** - `ff4c915` (feat)

## Files Created/Modified
- `src/slack/user-identity.ts` - UserIdentityCache class: resolve(), clear(), TTL Map cache, ERROR_TTL_MS constant
- `src/slack/__tests__/user-identity.test.ts` - 12 unit tests covering resolve, fallback chain, caching, TTL, error handling, clear()

## Decisions Made
- **UserIdentityCache takes WebClient, not SlackService:** Dependency inversion — allows testing with a plain mock object. No vi.mock() of bolt needed. Phase 25/26 callers construct via `new UserIdentityCache(app.client)`.
- **ERROR_TTL_MS = 30_000 hardcoded constant:** 30s error cache prevents hammering the API on repeated failures while allowing recovery. Not configurable — it's an implementation detail.
- **No logger parameter:** Keeps the class self-contained. The plan explicitly states "Phase 25 handler can log if needed before calling resolve()." Following plan specification.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Pre-existing failing tests from Plans 24-01 and 24-02 (RED-phase tests for formatters not yet implemented). These are out-of-scope per scope boundary rule — logged in deferred-items context only. All 677 tests in scope pass; 12 new tests added.

## User Setup Required
**External services require manual configuration before runtime testing of UIDENT-01:**
- Add `users:read` to bot OAuth scopes in Slack App Dashboard (OAuth & Permissions -> Bot Token Scopes -> Add users:read)
- Reinstall the app to workspace after adding the scope

This is documented in the plan's `user_setup` section. No code changes needed — the scope gate is an API permission, not implementation.

## Next Phase Readiness
- UserIdentityCache is ready for Phase 25 slash command handlers
- Usage pattern: `const cache = new UserIdentityCache(slackService.getApp()!.client)` — construct once at handler registration time
- Phase 25 calls `await cache.resolve(command.user_id)` to get display name before writing to DB (satisfies UIDENT-03)
- Phase 24 still has Plans 24-01 (task formatters) and 24-02 (project formatters) to complete before Phase 25 can proceed

---
*Phase: 24-block-kit-formatters-user-identity*
*Completed: 2026-02-18*
