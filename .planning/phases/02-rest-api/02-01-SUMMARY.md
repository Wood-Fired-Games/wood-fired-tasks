---
phase: 02-rest-api
plan: 01
subsystem: api
tags: [fastify, zod, rest-api, authentication, api-key]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: TaskService, ProjectService, database layer, type definitions
provides:
  - Fastify server with Zod type provider and Phase 1 service decoration
  - API key authentication middleware protecting /api/v1 routes
  - Complete task CRUD endpoints (POST, GET, GET/:id, PUT/:id, DELETE/:id)
  - Complete project CRUD endpoints with same pattern
  - Zod response schemas for structured API responses
  - Integration tests for auth and CRUD operations
affects: [02-02-error-handling, 03-cli, 04-mcp, 05-network]

# Tech tracking
tech-stack:
  added: [fastify, @fastify/swagger, @fastify/swagger-ui, fastify-type-provider-zod, @fastify/cors, pino-pretty]
  patterns: [Fastify plugin architecture, Zod schema validation, preHandler hooks for auth, service decoration pattern]

key-files:
  created:
    - src/api/server.ts
    - src/api/routes/tasks/index.ts
    - src/api/routes/tasks/schemas.ts
    - src/api/routes/projects/index.ts
    - src/api/routes/projects/schemas.ts
    - src/api/plugins/auth.ts (created then refactored to inline)
    - src/api/__tests__/auth.test.ts
    - src/api/__tests__/tasks.test.ts
    - src/api/__tests__/projects.test.ts
  modified:
    - vitest.config.ts

key-decisions:
  - "Moved auth preHandler hook from separate plugin to inline registration in server scope for proper encapsulation"
  - "Used z.coerce for query/param number types to handle URL string coercion automatically"
  - "Disabled parallel test file execution to prevent environment variable conflicts in tests"
  - "Tags returned in alphabetical order from database GROUP_CONCAT (not insertion order)"

patterns-established:
  - "Fastify routes use FastifyPluginAsyncZod type for Zod schema integration"
  - "All routes define schema with tags, description, body/params/querystring, and response codes"
  - "Service methods called directly from route handlers, errors bubble to default handler"
  - "API key auth reads from process.env.API_KEYS (comma-separated) and validates via preHandler hook"
  - "Tests use server.inject() for HTTP simulation without network sockets"

# Metrics
duration: 6min
completed: 2026-02-13
---

# Phase 02 Plan 01: REST API Core Summary

**Fastify server with Zod validation serving authenticated task/project CRUD endpoints via API key middleware**

## Performance

- **Duration:** 6 min
- **Started:** 2026-02-13T19:07:21Z
- **Completed:** 2026-02-13T19:13:44Z
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments
- Fastify server factory with Phase 1 service decoration and Zod type provider integration
- API key authentication protecting all /api/v1 routes with structured 401 responses
- All 5 task CRUD endpoints (create 201, list 200, get 200, update 200, delete 204)
- All 5 project CRUD endpoints with matching patterns
- 18 integration tests covering auth rejection, valid auth, and full CRUD workflows

## Task Commits

Each task was committed atomically:

1. **Task 1: Fastify server factory, auth plugin, and response schemas** - `92a893d` (feat)
2. **Task 2: Task and project CRUD routes with integration tests** - `6bd668c` (feat)

## Files Created/Modified
- `src/api/server.ts` - Fastify server factory with Zod provider, service decoration, inline auth hook
- `src/api/routes/tasks/index.ts` - 5 task CRUD route handlers using TaskService
- `src/api/routes/tasks/schemas.ts` - Zod response schemas (Task, TaskList, Error)
- `src/api/routes/projects/index.ts` - 5 project CRUD route handlers using ProjectService
- `src/api/routes/projects/schemas.ts` - Zod response schemas (Project, ProjectList)
- `src/api/plugins/auth.ts` - Initial auth plugin (refactored to inline)
- `src/api/__tests__/auth.test.ts` - Auth middleware tests (401 without key, 200 with valid key)
- `src/api/__tests__/tasks.test.ts` - Task CRUD integration tests (9 tests)
- `src/api/__tests__/projects.test.ts` - Project CRUD integration tests (5 tests)
- `vitest.config.ts` - Added fileParallelism: false for test isolation
- `package.json` - Added fastify, swagger, type-provider-zod, cors, pino-pretty

## Decisions Made

**Auth plugin refactoring:**
- Initially created separate auth plugin file following plan structure
- Auth tests failed (200 instead of 401) due to Fastify encapsulation scope issues
- Refactored auth preHandler hook to inline registration in same async scope as routes
- This ensures hook applies correctly to child route registrations

**Query parameter coercion:**
- Used `z.coerce.number()` for querystring/param schemas since URL params arrive as strings
- Fastify type provider handles coercion automatically via Zod transform

**Test isolation:**
- Disabled parallel test file execution (`fileParallelism: false`) to prevent race conditions on `process.env.API_KEYS`
- Each test file sets API_KEYS at module level; parallel execution caused env var conflicts

**Tag ordering:**
- Task tags returned in alphabetical order from `GROUP_CONCAT` in repository layer
- Updated test expectations to match database ordering (not insertion order)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed DELETE route handler return type**
- **Found during:** Task 1 (TypeScript compilation)
- **Issue:** `reply.send()` requires an argument; calling without argument caused TS2554 error
- **Fix:** Changed `reply.code(204).send()` to `reply.code(204).send(null)` in both task and project DELETE handlers
- **Files modified:** src/api/routes/tasks/index.ts, src/api/routes/projects/index.ts
- **Verification:** TypeScript compilation succeeds
- **Committed in:** 6bd668c (Task 2 commit)

**2. [Rule 3 - Blocking] Moved auth hook from plugin to inline registration**
- **Found during:** Task 2 (Auth test execution)
- **Issue:** Auth plugin registered in scoped async function wasn't applying preHandler hook to child routes (Fastify encapsulation issue)
- **Fix:** Moved preHandler hook registration from separate auth plugin to inline in same scope as route registration
- **Files modified:** src/api/server.ts (removed authPlugin import, added inline hook)
- **Verification:** All auth tests pass (401 without key, 200 with valid key)
- **Committed in:** 6bd668c (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both fixes necessary for correctness. Auth refactoring improves clarity by colocating auth logic with route registration.

## Issues Encountered

**Fastify plugin encapsulation:**
- Separate auth plugin wasn't applying hooks to routes in same scope
- Solution: Inline hook registration in same async function as routes
- Learning: Fastify encapsulation requires hooks and routes to be in same plugin scope for proper application

**Test environment variable isolation:**
- Vitest parallel test execution caused race conditions on shared env vars
- Solution: Disabled file parallelism for test files
- Alternative considered: Pass API keys as createServer parameter (deferred to keep env var pattern)

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for plan 02-02 (error handling and health checks):
- Server infrastructure complete
- Routes operational and tested
- Error bubbling works (services throw, routes propagate to default handler)
- Plan 02-02 will add custom error handler to map service errors to proper HTTP codes

## Self-Check: PASSED

All files verified to exist:
- ✓ src/api/server.ts
- ✓ src/api/routes/tasks/index.ts
- ✓ src/api/routes/tasks/schemas.ts
- ✓ src/api/routes/projects/index.ts
- ✓ src/api/routes/projects/schemas.ts
- ✓ src/api/__tests__/auth.test.ts
- ✓ src/api/__tests__/tasks.test.ts
- ✓ src/api/__tests__/projects.test.ts

All commits verified:
- ✓ 92a893d (Task 1)
- ✓ 6bd668c (Task 2)

---
*Phase: 02-rest-api*
*Completed: 2026-02-13*
