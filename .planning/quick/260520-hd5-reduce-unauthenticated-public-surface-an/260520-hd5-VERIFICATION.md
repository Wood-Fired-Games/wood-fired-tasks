---
quick_id: 260520-hd5
status: passed
date: 2026-05-20
verifier: gsd-quick (full mode self-verification)
commit: 86c2d7d
---

# Quick Task 260520-hd5: Verification

## Must-Haves Check

### Truth 1: In NODE_ENV=production with default config, GET /docs and GET /docs/json are NOT registered (404) unless ENABLE_SWAGGER_IN_PRODUCTION=true and a valid X-API-Key is supplied.

**Status:** PASSED

**Evidence:**
- `src/api/server.ts:188` — `exposeSwaggerUI = config.NODE_ENV !== 'production' || config.ENABLE_SWAGGER_IN_PRODUCTION === true`
- `src/api/server.ts:190-198` — `if (exposeSwaggerUI)` gate; production branch registers `authPlugin` inside the scope before `registerSwaggerUI`
- Tests in `src/api/__tests__/swagger-production.test.ts`:
  - "production + default config: GET /docs returns 404" → PASSED
  - "production + default config: GET /docs/json returns 404" → PASSED
  - "production + ENABLE_SWAGGER_IN_PRODUCTION=true: GET /docs without key returns 401" → PASSED
  - "production + ENABLE_SWAGGER_IN_PRODUCTION=true: GET /docs/json with valid key returns the spec" → PASSED

### Truth 2: In non-production (development/test), /docs and /docs/json remain reachable without auth so the existing developer workflow keeps working.

**Status:** PASSED

**Evidence:**
- `src/api/server.ts:195-197` — non-production branch calls `registerSwaggerUI(server)` directly (no auth scope wrap)
- Test: "non-production (test mode): GET /docs/json is reachable without auth (no regression)" → PASSED
- Existing `src/api/__tests__/openapi.test.ts` — 10/10 tests still pass, including:
  - "GET /docs returns 200 (Swagger UI is served)"
  - "GET /docs/json returns 200 with valid JSON containing openapi field"

### Truth 3: GET /health returns ONLY { status, timestamp, version } with no checks or stats field.

**Status:** PASSED

**Evidence:**
- `src/api/routes/health.ts:28-43` — minimal Zod schema returns `z.object({ status, timestamp, version })` (no `checks`, no `stats`)
- `src/api/routes/health.ts:60-68` — handler returns the 3-field literal object
- Tests in `src/api/__tests__/health.test.ts`:
  - "GET /health response has exactly status + timestamp + version (no checks/stats)" → PASSED
  - "GET /health response does NOT include a `checks` field" → PASSED
  - "GET /health response does NOT include a `stats` field" → PASSED
  - "GET /health response does NOT leak SSE client count" → PASSED (regex check on `clientCount|uptime|listenerCount`)

### Truth 4: GET /health/detailed returns the full diagnostic payload and is gated by the canonical auth plugin.

**Status:** PASSED

**Evidence:**
- `src/api/server.ts:243-251` — `/health/detailed` scope first registers `authPlugin`, then `detailedHealthRoutes`
- `src/api/routes/health.ts:76-170` — exported `detailedHealthRoutes` with full schema (checks + stats)
- Tests in `src/api/__tests__/health-detailed.test.ts`:
  - "returns 401 without X-API-Key header" → PASSED (asserts `body.error === 'UNAUTHORIZED'`)
  - "returns 401 with an invalid X-API-Key" → PASSED
  - "returns 200 with full diagnostic payload when authenticated" → PASSED (asserts checks.database, checks.eventBus, checks.sseManager, stats.eventBus.listenerCount, stats.sseManager.clientCount, stats.sseManager.uptime)

### Truth 5: New SSE connection is rejected with HTTP 429 + Retry-After header when ANY of SSE_MAX_CONNECTIONS_PER_KEY (4), SSE_MAX_CONNECTIONS_PER_IP (8), SSE_MAX_CONNECTIONS (200) is exceeded.

**Status:** PASSED

**Evidence:**
- `src/events/sse-manager.ts:60-90` — `canAccept(apiKey, ip)` returns `SSECapDecision` with reason
- `src/api/routes/events.ts:28-52` — `preHandler` returns 429 + `Retry-After: 30` + `{ error: 'TOO_MANY_CONNECTIONS', ... }`
- `src/config/env.ts:75-77` — env defaults 4 / 8 / 200
- Tests in `src/api/__tests__/sse-caps.test.ts`:
  - "per-key cap: rejects the (N+1)th connection from the same key" → PASSED
  - "per-IP cap: rejects the (N+1)th connection from the same IP (different keys)" → PASSED
  - "global cap: rejects the (N+1)th connection regardless of key/IP" → PASSED
  - "returns 429 + Retry-After header when the per-key cap is exceeded" → PASSED (asserts `r.headers['retry-after'] === '30'`)
  - "returns 429 with per-IP reason when per-IP cap exceeded" → PASSED

### Truth 6: Normal authenticated SSE subscription still works under the caps.

**Status:** PASSED

**Evidence:**
- `src/api/routes/events.ts:55-78` — fall-through path when `canAccept` returns `{ ok: true }` registers the connection via `addConnection`
- Test: "normal authenticated subscription passes auth + cap (no 401 / no 429)" → PASSED
- Existing `src/api/__tests__/events.test.ts` — 5/5 tests still pass:
  - "should require authentication" → PASSED
  - "should accept valid API key" → PASSED
  - "should accept project_id filter query parameter" → PASSED
  - "should accept event_types filter query parameter" → PASSED
  - "should accept Last-Event-ID header" → PASSED

### Truth 7: All pre-task tests continue to pass (baseline 944/944).

**Status:** PASSED

**Evidence:**
- Pre-task baseline: 944 tests passing across 73 test files
- Post-task: 958 tests passing across 76 test files (+14 new tests, +3 new test files; no removed tests beyond the minimal-shape replacements in `health.test.ts`)
- `npm run build` exit code 0 (tsc strict mode, no new TypeScript errors)

## Artifacts Check

All planned artifacts present and modified:

| Artifact | Status |
|----------|--------|
| `src/api/server.ts` | Modified (conditional Swagger registration, `/health/detailed` scope, SSEManager config wiring) |
| `src/api/plugins/swagger.ts` | Modified (split into `registerSwaggerSpec` + `registerSwaggerUI`) |
| `src/api/routes/health.ts` | Modified (split into minimal default + `detailedHealthRoutes`) |
| `src/api/routes/events.ts` | Modified (cap check in preHandler) |
| `src/events/sse-manager.ts` | Modified (per-key/per-IP/global caps + `canAccept`) |
| `src/config/env.ts` | Modified (`ENABLE_SWAGGER_IN_PRODUCTION`, three SSE_MAX_* env vars) |
| `src/api/__tests__/swagger-production.test.ts` | New (6 tests) |
| `src/api/__tests__/health.test.ts` | Updated (10 tests, including new minimal-shape assertions) |
| `src/api/__tests__/health-detailed.test.ts` | New (4 tests) |
| `src/api/__tests__/sse-caps.test.ts` | New (8 tests) |

## Verification Result

**Status:** passed

All 7 must-have truths are satisfied with named test evidence. Build is clean. Existing tests continue to pass.
