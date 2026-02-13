# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-13)

**Core value:** Any agent on the local network can reliably create, find, and update work items in real time -- making this the single source of truth for all Wood Fired Games task tracking.
**Current focus:** Phase 4: MCP Server

## Current Position

Phase: 4 of 6 (MCP Server)
Plan: 1 of 2 in current phase
Status: Completed
Last activity: 2026-02-13 -- Completed plan 04-01 (MCP Server Foundation)

Progress: [████████████████░░░░] 40%

## Performance Metrics

**Velocity:**
- Total plans completed: 8
- Average duration: 3 minutes
- Total execution time: 0.49 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-foundation | 3 | 11 min | 4 min |
| 02-rest-api | 2 | 9 min | 5 min |
| 03-cli | 2 | 5 min | 3 min |
| 04-mcp-server | 1 | 4 min | 4 min |

**Recent Trend:**
- Last 5 plans: 02-02 (3 min), 03-01 (2 min), 03-02 (3 min), 04-01 (4 min)
- Trend: Excellent velocity (averaging 3 min per plan)

*Updated after each plan completion*
| Phase 04 P01 | 4 | 2 tasks | 4 files |

## Accumulated Context

### Decisions

**Phase 01-01 (Database Foundation):**
- Used npm instead of pnpm for package management (pnpm not available in environment)
- Set Node16 module resolution for proper ESM/CJS interop with better-sqlite3
- Implemented custom Umzug storage using SQLite for migration tracking (no Sequelize dependency)

**Phase 01-02 (Repository Layer):**
- Used dynamic SET clause building to only update provided fields, avoiding null overwrites
- Wrapped tag create/update/delete in db.transaction() to ensure atomicity
- Used LEFT JOIN with GROUP_CONCAT for efficient tag loading in findAll and findByFilters
- Prepared all static queries in constructor for performance and SQL injection prevention

**Phase 01-03 (Service Layer):**
- Used Zod v4 .issues instead of .errors for error handling compatibility
- Updated CreateProjectDTO to allow null description for Zod nullable() compatibility
- TaskService always forces status to 'open' on create, ignoring any status in input
- All service methods validate unknown input via Zod safeParse before processing
- Custom error classes provide structured error information (ValidationError with fieldErrors, NotFoundError with entity+id)

**Phase 02-01 (REST API Core):**
- Moved auth preHandler hook from separate plugin to inline registration in server scope for proper encapsulation
- Used z.coerce for query/param number types to handle URL string coercion automatically
- Disabled parallel test file execution to prevent environment variable conflicts in tests
- Tags returned in alphabetical order from database GROUP_CONCAT (not insertion order)

**Phase 02-02 (Error Handling & OpenAPI):**
- Error handler checks Phase 1 custom errors BEFORE Fastify-specific properties to ensure proper mapping
- Health endpoint registered outside /api/v1 scope to bypass authentication
- Swagger registered before routes to capture all route schemas for spec generation
- OpenAPI paths include trailing slashes (Fastify convention) - tests adapted to handle both formats

**Phase 03-01 (CLI Foundation):**
- Used chalk v4 instead of v5 (v4 has CJS/ESM compatibility via esModuleInterop, v5 is ESM-only)
- Deferred API_KEY validation to lazy getter (allows --help to work without requiring API_KEY)
- Used fetch AbortController for 10s timeout (Node 18+ native, no library needed)
- Set process.exitCode instead of process.exit in error handler (allows graceful cleanup)
- CLI-side types decoupled from server types (no imports from src/services or src/types)
- [Phase 03-02]: Used importOriginal in vi.mock to preserve ApiClientError class while mocking API functions
- [Phase 03-02]: Update command requires at least one field to be specified (prevents no-op API calls)

**Phase 04-01 (MCP Server Foundation):**
- Used double type assertion (as unknown as) for structuredContent to satisfy TypeScript strict mode without weakening Task type safety
- Made tool handlers async but call synchronous service methods directly (better-sqlite3 is sync, no await needed)
- Used console.error() exclusively in MCP code (stdout reserved for JSON-RPC protocol in stdio transport)
- Shared Zod schemas (CreateTaskSchema, UpdateTaskSchema, TaskFiltersSchema) between REST API and MCP server for consistent validation

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 6: Dependency cycle detection (DFS graph traversal) flagged as high complexity by research. Budget accordingly.

## Session Continuity

Last session: 2026-02-13T20:04:50Z
Stopped at: Completed 04-01-PLAN.md (MCP Server Foundation)
Resume file: .planning/phases/04-mcp-server/04-01-SUMMARY.md
