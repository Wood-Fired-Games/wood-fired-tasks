---
phase: 15-atomic-claim-protocol
plan: 02
subsystem: api, services
tags: [fastify, idempotency, auto-release, REST, claim-protocol, stale-detection]

# Dependency graph
requires:
  - phase: 15-atomic-claim-protocol
    plan: 01
    provides: TaskRepository.claimTask with CAS, TaskService.claimTask with validation, idempotency_keys table
provides:
  - "POST /api/v1/tasks/:id/claim REST endpoint with 200/409/404 responses"
  - "IdempotencyService for X-Idempotency-Key deduplication (24h TTL)"
  - "ClaimReleaseService for auto-releasing stale claims (configurable timeout)"
  - "X-Claim-Source header for user vs workflow claim distinction"
  - "Server lifecycle management for cleanup intervals"
affects: [15-03-PLAN, 16-workflow-automation]

# Tech tracking
tech-stack:
  added: []
  patterns: [idempotency key caching, stale claim auto-release sweep, server lifecycle cleanup hooks]

key-files:
  created:
    - src/services/idempotency.service.ts
    - src/services/claim-release.service.ts
    - src/services/__tests__/idempotency.test.ts
    - src/services/__tests__/claim-release.test.ts
    - src/api/__tests__/tasks-claim.test.ts
  modified:
    - src/api/routes/tasks/index.ts
    - src/api/routes/tasks/schemas.ts
    - src/api/server.ts

key-decisions:
  - "Idempotency key cached in SQLite idempotency_keys table with 24h TTL - simple, no external cache needed"
  - "Stale claim detection uses both claimed_at AND updated_at - activity resets the staleness clock"
  - "ClaimReleaseService emits task.updated (not task.claimed) events - released tasks go back to open state"
  - "BusinessError returns 409 Conflict (not 422) for claim conflicts - clearer HTTP semantics for concurrent operations"

patterns-established:
  - "Idempotency pattern: check X-Idempotency-Key header -> return cached or process -> cache response"
  - "Stale detection: claimed_at AND updated_at both past threshold = stale, activity on either resets clock"
  - "Server lifecycle: onClose hook stops all intervals and managers cleanly"

# Metrics
duration: 5min
completed: 2026-02-14
---

# Phase 15 Plan 02: REST Claim Endpoint & Auto-Release Summary

**POST /claim endpoint with idempotency key deduplication, 409 conflict handling, and automatic stale claim release via periodic sweep**

## Performance

- **Duration:** 4 min 37s
- **Started:** 2026-02-14T15:59:16Z
- **Completed:** 2026-02-14T16:03:53Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- POST /api/v1/tasks/:id/claim endpoint returns 200 (claimed), 409 (conflict), 404 (not found), 400 (validation)
- IdempotencyService caches responses by X-Idempotency-Key header with 24-hour TTL, preventing duplicate claims on network retry
- ClaimReleaseService periodically sweeps stale claims (default 30-min timeout) and auto-releases them back to open status
- X-Claim-Source header distinguishes user vs workflow claims for event metadata
- 26 new tests across 3 test files (8 API + 8 idempotency + 10 release), 479 total passing

## Task Commits

Each task was committed atomically:

1. **Task 1: REST claim endpoint with idempotency service** - `4849638` (feat)
2. **Task 2: Auto-release service for stale claims** - `ae66bd2` (feat)

## Files Created/Modified
- `src/services/idempotency.service.ts` - Idempotency key check/set/cleanup with SQLite backend
- `src/services/claim-release.service.ts` - Auto-release sweep for stale claims with EventBus integration
- `src/services/__tests__/idempotency.test.ts` - 8 tests for get/set/cleanup/expiry
- `src/services/__tests__/claim-release.test.ts` - 10 tests for find stale/release/sweep/events/timer
- `src/api/__tests__/tasks-claim.test.ts` - 8 API integration tests for claim endpoint
- `src/api/routes/tasks/index.ts` - Added POST /:id/claim route with idempotency and conflict handling
- `src/api/routes/tasks/schemas.ts` - Added ClaimRequestSchema, ClaimResponseSchema, ConflictResponseSchema
- `src/api/server.ts` - Wired IdempotencyService, ClaimReleaseService, cleanup intervals, onClose hooks

## Decisions Made
- Idempotency key cached in SQLite idempotency_keys table with 24h TTL - simple approach, no external cache dependency
- Stale claim detection uses both claimed_at AND updated_at - any activity resets the staleness clock
- ClaimReleaseService emits task.updated events (not task.claimed) for released tasks - they return to open state
- BusinessError mapped to 409 Conflict (not default 422) in the claim handler - clearer HTTP semantics for concurrent claim conflicts

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript error on cached idempotency response send**
- **Found during:** Task 1 (TypeScript compilation check)
- **Issue:** `idempotencyService.get()` returns `object | null`, but Fastify's typed reply.send() expects the full task response type
- **Fix:** Cast cached response as `z.infer<typeof ClaimResponseSchema>` before sending
- **Files modified:** src/api/routes/tasks/index.ts
- **Verification:** Zero TypeScript errors with `npx tsc --noEmit`
- **Committed in:** 4849638 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix)
**Impact on plan:** Type safety fix for TypeScript strict mode. No scope creep.

## Issues Encountered
None - implementation followed plan specification closely.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- REST claim endpoint fully operational with idempotency and auto-release
- Ready for Plan 03 (MCP tool and CLI command for claiming)
- ClaimReleaseService can be configured with different timeout values per environment
- All 479 tests pass, zero TypeScript errors

---
*Phase: 15-atomic-claim-protocol*
*Completed: 2026-02-14*
