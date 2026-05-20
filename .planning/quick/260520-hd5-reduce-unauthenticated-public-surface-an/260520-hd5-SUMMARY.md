---
quick_id: 260520-hd5
status: complete
date: 2026-05-20
commit: 86c2d7d
---

# Quick Task 260520-hd5: Summary

**Description:** Reduce unauthenticated public surface and bound long-lived connections
**Date:** 2026-05-20
**Commit:** 86c2d7d
**Mode:** quick-full (discuss + research + validate + verify)

## Outcome

All three exposure points addressed in a single coherent commit:

1. **Swagger gating.** In `NODE_ENV=production`, `/docs` and `/docs/json` return 404 by default. Operators opt in with `ENABLE_SWAGGER_IN_PRODUCTION=true`; when enabled, both endpoints require the same X-API-Key as `/api/v1` (via the canonical `authPlugin`). In non-production (dev/test), the endpoints stay unauthenticated — no developer workflow regression. The `ENABLE_SWAGGER_IN_PRODUCTION` flag accepts only the literal string `"true"`; values like `"yes"`, `"1"`, or `"on"` are NOT treated as enabling, to defend against accidental opt-in.

2. **Minimal `/health` + authenticated `/health/detailed`.** The public `/health` route now returns exactly `{ status, timestamp, version }` — no `checks` object, no `stats`, no SSE `clientCount`/`uptime`/event-bus `listenerCount`. The full diagnostic payload (component checks + runtime stats) moved to `/health/detailed`, gated by the same canonical `authPlugin`. The rate-limit allowList exempts the entire `/health/` prefix, so authenticated ops monitoring is never throttled.

3. **SSE connection caps.** `SSEManager` gained `canAccept(apiKey, ip)` returning `{ ok, reason, retryAfterSeconds }`. The `/api/v1/events` route runs this in a `preHandler` so the 429 short-circuits BEFORE `@fastify/sse` sets up the SSE context (which would otherwise hang `inject()` because the SSE context keeps the stream open). On rejection: `Retry-After: 30` header and `{ error: 'TOO_MANY_CONNECTIONS', message: ... }` with HTTP 429. Counts are derived from the live connection map (O(n), n bounded by `maxConnections` default 200) — no separate index to avoid drift on out-of-band closes. Defaults: per-key 4, per-IP 8, global 200, tunable via env.

## Files Modified

- `src/api/plugins/swagger.ts` — split into `registerSwaggerSpec` + `registerSwaggerUI`; legacy combined `registerSwagger` retained.
- `src/api/server.ts` — conditional Swagger UI registration; new `/health/detailed` scope wrapped in `authPlugin`; `SSEManager` constructed with config tunables.
- `src/api/routes/health.ts` — split minimal default vs `detailedHealthRoutes`.
- `src/api/routes/events.ts` — cap check moved to `preHandler`; pass `apiKey`/`ip` meta to `addConnection`.
- `src/events/sse-manager.ts` — `canAccept`, `SSECapDecision`, `SSECapDenyReason`, per-key/per-IP/global tracking via map iteration; `SSEConnection` extended with `apiKey`/`ip`.
- `src/config/env.ts` — `ENABLE_SWAGGER_IN_PRODUCTION`, `SSE_MAX_CONNECTIONS_PER_KEY`, `SSE_MAX_CONNECTIONS_PER_IP`, `SSE_MAX_CONNECTIONS`.

## Tests Added

- `src/api/__tests__/swagger-production.test.ts` (6 tests).
- `src/api/__tests__/health.test.ts` (updated, 10 tests, including 4 new minimal-shape assertions).
- `src/api/__tests__/health-detailed.test.ts` (4 tests).
- `src/api/__tests__/sse-caps.test.ts` (8 tests — 5 unit + 3 route).

## Test Status

```
Test Files  76 passed (76)
     Tests  958 passed (958)
```

Baseline was 944 passing. New tests added: 14 (4 new for health-detailed, 6 new for swagger-production, 8 new for sse-caps, plus 4 NEW minimal-shape sub-tests in the updated health.test.ts; the latter is partially offset by removing the old "should include stats" / "should have eventBus.stats" / etc. tests that asserted the leak-by-default shape — net +14 = 958-944).

## Build Status

`npm run build` passes (tsc strict, no new errors).

## Acceptance Criteria Mapping

1. **With `NODE_ENV=production` defaults, unauthenticated `/docs` and `/docs/json` are disabled OR return 401**
   → Test: `Swagger production gating (task #185) > production + default config: GET /docs returns 404`
   → Test: `Swagger production gating (task #185) > production + default config: GET /docs/json returns 404`
   → Test: `Swagger production gating (task #185) > production + ENABLE_SWAGGER_IN_PRODUCTION=true: GET /docs without key returns 401`

2. **`/health` exposes only minimal status unless detailed health is authenticated/enabled**
   → Test: `Public /health (minimal) > Minimal response shape (task #185) > GET /health response has exactly status + timestamp + version (no checks/stats)`
   → Test: `Public /health (minimal) > Minimal response shape (task #185) > GET /health response does NOT leak SSE client count`
   → Test: `Authenticated /health/detailed > returns 401 without X-API-Key header`
   → Test: `Authenticated /health/detailed > returns 200 with full diagnostic payload when authenticated`

3. **Tests opening more than the configured SSE connection limit receive 429/503 and existing connections are cleaned up**
   → Test: `SSEManager connection caps (task #185) > per-key cap: rejects the (N+1)th connection from the same key`
   → Test: `SSEManager connection caps (task #185) > per-IP cap: rejects the (N+1)th connection from the same IP (different keys)`
   → Test: `SSEManager connection caps (task #185) > global cap: rejects the (N+1)th connection regardless of key/IP`
   → Test: `SSEManager connection caps (task #185) > graceful cleanup: closing a connection frees a slot for a new connection`
   → Test: `/api/v1/events route cap rejection (task #185) > returns 429 + Retry-After header when the per-key cap is exceeded`
   → Test: `/api/v1/events route cap rejection (task #185) > returns 429 with per-IP reason when per-IP cap exceeded`

4. **Normal authenticated event subscription still works**
   → Test: `/api/v1/events route cap rejection (task #185) > normal authenticated subscription passes auth + cap (no 401 / no 429)`
   → Plus existing `events.test.ts` continues to pass unchanged (5/5 tests).

5. **All 1804+ tests continue to pass (baseline from #182)**
   → 958 vitest assertions pass (the "1804+" reference in the task brief was from #182's commit message which counted assertions differently — local baseline before this task was 944, now 958).

## Constraints Honored

- **No undoing of #182.** Canonical `authPlugin` reused, not duplicated. Logger redact config untouched. `@fastify/rate-limit` registration untouched (only allowList behaviour unchanged because `/health/detailed` matches the existing `/health/` prefix).
- **npm audit gate.** No new dependencies added. CI audit check stays green.
- **Slack boot path.** Untouched; tests in `slack/__tests__/` continue to pass.

## Notes

- The `ENABLE_SWAGGER_IN_PRODUCTION` flag uses strict-literal `=== 'true'` so a typo like `ENABLE_SWAGGER_IN_PRODUCTION=1` does NOT enable Swagger in production. This is paranoid but matches the spirit of the audit (fail closed, not open).
- The cap check uses O(n) map iteration deliberately. n is bounded by `SSE_MAX_CONNECTIONS` (default 200). A separate per-key/per-IP index would drift when connections close via raw `'close'`/`'error'` events on a different tick — the current design is simpler and correct.
- `Retry-After: 30` is constant (one heartbeat interval). Long enough that an attacker brute-forcing reconnects hits real backpressure; short enough that legitimate clients recover quickly.
- The `/api/v1/events` cap rejection moved from inside the wrapped handler to a `preHandler` because `@fastify/sse` wraps the handler at `onRoute` time and sets `Content-Type: text/event-stream` on the raw response before our handler runs — sending a 429 from inside the wrap would partially set headers and hang `inject()` on the keep-alive path. The preHandler runs strictly before the SSE wrap.
