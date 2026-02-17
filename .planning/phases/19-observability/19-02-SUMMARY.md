---
phase: 19-observability
plan: 02
subsystem: api
tags: [request-id, tracing, observability, sse, mcp, fastify, crypto]

# Dependency graph
requires:
  - phase: 17-core-reliability-fundamentals
    provides: structured logging via Pino, Fastify server foundation
  - phase: 19-observability-01
    provides: doctor command and diagnostic infrastructure
provides:
  - UUID v4 X-Request-ID header on every REST API response
  - requestIdHeader: false (no caller ID injection)
  - onSend hook stamping X-Request-ID on all Fastify responses
  - traceId logging on 5 key MCP tools (create_task, update_task, list_tasks, claim_task, check_health)
  - SSE event replay buffer capped at 100 events (down from 1000)
  - ApiClientError.requestId property for error debugging
  - getLastRequestId() exported from CLI client
affects:
  - phase-20-testing-depth
  - phase-21-ux-polish
  - future debugging and incident response

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "genReqId with crypto.randomUUID() for Fastify UUID request IDs"
    - "onSend hook pattern for response header injection"
    - "requestIdHeader: false for security — never trust caller-supplied IDs"
    - "traceId pattern: generate at handler entry, log start/success/error to stderr as JSON"
    - "Module-level _lastRequestId variable for CLI request ID surfacing without signature changes"

key-files:
  created: []
  modified:
    - src/api/server.ts
    - src/events/sse-manager.ts
    - src/mcp/tools/task-tools.ts
    - src/mcp/tools/health-tools.ts
    - src/cli/api/client.ts

key-decisions:
  - "requestIdHeader: false — security hardening, prevents attackers injecting arbitrary request IDs via X-Request-ID header"
  - "Module-level _lastRequestId in client.ts — avoids breaking 20+ caller signatures while making request ID accessible"
  - "SSE buffer 100 (not 1000) — right-sized per OBSV-03 requirement; 1000 was never the spec"
  - "traceId only on 5 key MCP tools (create/update/list/claim task + check_health) — blast radius control"

patterns-established:
  - "MCP traceId pattern: randomUUID at handler entry, JSON.stringify to console.error at start/success/error"
  - "Fastify request ID pattern: genReqId + requestIdHeader:false + onSend hook"
  - "CLI request ID pattern: extract from response header, store in module variable, expose via getter"

requirements-completed: [OBSV-02, OBSV-03]

# Metrics
duration: 2min
completed: 2026-02-17
---

# Phase 19 Plan 02: Request ID Propagation and SSE Buffer Reduction Summary

**UUID v4 X-Request-ID on all REST responses, traceId logging on 5 MCP tools, SSE buffer reduced to 100 events, and request ID surfaced in CLI client**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-17T20:28:50Z
- **Completed:** 2026-02-17T20:31:32Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Fastify now generates UUID v4 request IDs via `genReqId: () => randomUUID()` and stamps them as `X-Request-ID` header on every response via `onSend` hook
- `requestIdHeader: false` prevents callers from injecting arbitrary request IDs (security hardening)
- 5 key MCP tools (create_task, update_task, list_tasks, claim_task, check_health) now log JSON traceId records to stderr at start/success/error
- SSE event replay buffer default reduced from 1000 to 100 events per OBSV-03 requirement
- CLI client captures `X-Request-ID` from responses, exposes via `ApiClientError.requestId` and `getLastRequestId()` without breaking any existing callers

## Task Commits

Each task was committed atomically:

1. **Task 1: Add Fastify request ID generation, response header, MCP traceId logging, and SSE buffer reduction** - `dd56e6a` (feat)
2. **Task 2: Surface request IDs in CLI client for error tracing** - `f164ff9` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `src/api/server.ts` - Added crypto import, genReqId with randomUUID, requestIdHeader:false, onSend hook for X-Request-ID header
- `src/events/sse-manager.ts` - Changed default maxBufferSize from 1000 to 100
- `src/mcp/tools/task-tools.ts` - Added randomUUID import, traceId logging on create_task, update_task, list_tasks, claim_task
- `src/mcp/tools/health-tools.ts` - Added randomUUID import, traceId logging on check_health
- `src/cli/api/client.ts` - Added requestId to ApiClientError, _lastRequestId module variable, getLastRequestId() export, x-request-id header extraction

## Decisions Made
- `requestIdHeader: false` — prevents security issue where callers could inject arbitrary request IDs to poison logs
- Module-level `_lastRequestId` in client.ts — cleanest approach to expose request ID from successful responses without changing the return type of 20+ API functions or their callers
- SSE buffer at 100 (down from 1000) — OBSV-03 requirement; the 1000 default was never the intended size
- traceId only on 5 key tools — controlled blast radius; get_task, delete_task, get_subtasks, list_subtasks intentionally excluded

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Request ID propagation complete — all REST responses have traceable X-Request-ID headers
- MCP tool tracing operational — create/update/list/claim task and check_health log traceIds to stderr
- CLI client ready for commands to surface request IDs in error output and --json envelopes
- SSE replay buffer correctly sized at 100 events
- 598 tests still passing, no regressions

---
*Phase: 19-observability*
*Completed: 2026-02-17*
