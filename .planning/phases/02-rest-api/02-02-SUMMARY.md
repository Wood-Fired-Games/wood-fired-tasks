---
phase: 02-rest-api
plan: 02
subsystem: api
tags: [error-handling, openapi, swagger, health-check, structured-errors]

# Dependency graph
requires:
  - phase: 02-rest-api
    plan: 01
    provides: Fastify server, routes, auth middleware
  - phase: 01-foundation
    provides: Custom error classes (ValidationError, NotFoundError, BusinessError)
provides:
  - Custom error handler mapping service errors to structured HTTP responses
  - OpenAPI 3.0 specification auto-generated from Zod route schemas
  - Swagger UI at /docs for interactive API documentation
  - Health check endpoint at /health (public, no auth required)
  - Machine-readable error codes for LLM parsing
affects: [03-cli, 04-mcp, 05-network]

# Tech tracking
tech-stack:
  added: []
  patterns: [Fastify error handler, OpenAPI generation from Zod, health check pattern]

key-files:
  created:
    - src/api/hooks/error-handler.ts
    - src/api/routes/health.ts
    - src/api/plugins/swagger.ts
    - src/api/__tests__/errors.test.ts
    - src/api/__tests__/health.test.ts
    - src/api/__tests__/openapi.test.ts
  modified:
    - src/api/server.ts

key-decisions:
  - "Error handler checks Phase 1 custom errors BEFORE Fastify-specific properties to ensure proper mapping"
  - "Health endpoint registered outside /api/v1 scope to bypass authentication"
  - "Swagger registered before routes to capture all route schemas for spec generation"
  - "OpenAPI paths include trailing slashes (Fastify convention) - tests adapted to handle both formats"

patterns-established:
  - "Custom error handler maps ValidationError->400, NotFoundError->404, BusinessError->422, unknown->500"
  - "All error responses are structured JSON with 'error' (machine-readable code) and 'message' fields"
  - "Health checks test database connectivity with SELECT 1, return 503 on failure"
  - "OpenAPI spec generated via jsonSchemaTransform from Zod route schemas"

# Metrics
duration: 3min
completed: 2026-02-13
---

# Phase 02 Plan 02: Error Handling & OpenAPI Summary

**Structured error responses with machine-readable codes and auto-generated OpenAPI documentation for LLM-friendly API consumption**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-13T19:16:30Z
- **Completed:** 2026-02-13T19:20:09Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Custom error handler mapping Phase 1 errors to structured HTTP responses (ValidationError->400, NotFoundError->404, BusinessError->422, unknown->500)
- All error responses are structured JSON with machine-readable error codes (no stack traces)
- Health check endpoint at GET /health with database connectivity check, publicly accessible
- OpenAPI 3.0 specification auto-generated from Zod route schemas
- Swagger UI served at /docs for interactive API documentation
- 23 comprehensive tests (8 error + 5 health + 10 openapi) verifying all new functionality

## Task Commits

Each task was committed atomically:

1. **Task 1: Custom error handler and health check endpoint** - `9990511` (feat)
2. **Task 2: OpenAPI generation and comprehensive error/health tests** - `bac9be7` (feat)

## Files Created/Modified
- `src/api/hooks/error-handler.ts` - Maps Phase 1 errors to HTTP responses with machine-readable codes
- `src/api/routes/health.ts` - Public health check with database connectivity test
- `src/api/plugins/swagger.ts` - OpenAPI spec generation from Zod schemas
- `src/api/server.ts` - Registered error handler, swagger plugin, and health routes
- `src/api/__tests__/errors.test.ts` - 8 tests for error response structure and codes
- `src/api/__tests__/health.test.ts` - 5 tests for public health check accessibility
- `src/api/__tests__/openapi.test.ts` - 10 tests for OpenAPI spec completeness

## Decisions Made

**Error handler ordering:**
- Check Phase 1 custom errors (ValidationError, NotFoundError, BusinessError) FIRST via instanceof
- Check Fastify errors (with statusCode property) SECOND
- Fallback to generic 500 INTERNAL_ERROR for unexpected errors
- This prevents Fastify from wrapping Phase 1 errors incorrectly

**Health endpoint registration:**
- Registered at server root level OUTSIDE /api/v1 scope
- This bypasses the auth preHandler hook, making health check publicly accessible
- Required for infrastructure monitoring without authentication

**Swagger plugin timing:**
- Registered AFTER error handler but BEFORE routes
- Swagger must see route schemas during registration to include them in spec
- Uses jsonSchemaTransform to convert Zod schemas to OpenAPI format

**OpenAPI path format:**
- Fastify/Swagger generates paths with trailing slashes (/api/v1/tasks/ instead of /api/v1/tasks)
- Tests adapted to check both formats for flexibility
- No functional impact - routes work with or without trailing slash

## Deviations from Plan

None - plan executed exactly as written.

**Auth gates:** None encountered.

**Rule 1-3 auto-fixes:** None required. All code worked as expected on first implementation.

---

**Total deviations:** 0

## Issues Encountered

None. Implementation was straightforward:
- Fastify error handler API is simple and well-documented
- Zod + OpenAPI integration via fastify-type-provider-zod worked seamlessly
- Health check pattern is standard across REST APIs

## User Setup Required

None - no external service configuration required.

## Verification Summary

All verification criteria met:

1. ✅ `npm test` - ALL 132 tests pass (109 existing + 23 new)
2. ✅ `npx tsc --noEmit` - TypeScript compilation succeeds
3. ✅ Error mapping: ValidationError->400, NotFoundError->404, BusinessError->422, unknown->500
4. ✅ Health: GET /health returns 200 without API key, includes database check
5. ✅ OpenAPI: GET /docs/json returns valid OpenAPI spec documenting all endpoints
6. ✅ No stack traces in any error response (verified by test assertions)
7. ✅ All responses are structured JSON suitable for LLM parsing

## Next Phase Readiness

Ready for Phase 3 (CLI):
- REST API is production-ready with structured errors
- OpenAPI spec provides machine-readable API documentation
- Health check enables infrastructure monitoring
- All endpoints tested and verified

Phase 2 SUCCESS CRITERIA COMPLETE:
1. ✅ All task CRUD operations work via REST endpoints with structured JSON
2. ✅ Every request without valid API key rejected with 401
3. ✅ Invalid requests return structured error responses with machine-readable codes (VALIDATION_ERROR, NOT_FOUND, BUSINESS_RULE_VIOLATION, INTERNAL_ERROR)
4. ✅ OpenAPI specification generated from route definitions (available at /docs/json)
5. ✅ Health check returns service status without authentication (GET /health)

## Self-Check: PASSED

All files verified to exist:
- ✅ src/api/hooks/error-handler.ts
- ✅ src/api/routes/health.ts
- ✅ src/api/plugins/swagger.ts
- ✅ src/api/__tests__/errors.test.ts
- ✅ src/api/__tests__/health.test.ts
- ✅ src/api/__tests__/openapi.test.ts

All commits verified:
- ✅ 9990511 (Task 1)
- ✅ bac9be7 (Task 2)

---
*Phase: 02-rest-api*
*Completed: 2026-02-13*
