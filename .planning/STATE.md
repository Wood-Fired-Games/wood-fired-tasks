# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-13)

**Core value:** Any agent on the local network can reliably create, find, and update work items in real time -- making this the single source of truth for all Wood Fired Games task tracking.
**Current focus:** Phase 6: Advanced Features

## Current Position

Phase: 6 of 6 (Advanced Features)
Plan: 2 of 2 in current phase
Status: Completed
Last activity: 2026-02-13 -- Completed plan 06-01 (Task Hierarchy and Dependency Tracking)

Progress: [█████████████████████████] 65%

## Performance Metrics

**Velocity:**
- Total plans completed: 12
- Average duration: 4 minutes
- Total execution time: 0.87 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-foundation | 3 | 11 min | 4 min |
| 02-rest-api | 2 | 9 min | 5 min |
| 03-cli | 2 | 5 min | 3 min |
| 04-mcp-server | 2 | 9 min | 5 min |
| 05-production-deployment | 2 | 11 min | 6 min |
| 06-advanced-features | 1 | 7 min | 7 min |

**Recent Trend:**
- Last 5 plans: 04-02 (5 min), 05-02 (5 min), 05-01 (6 min), 06-01 (7 min)
- Trend: Consistent velocity (averaging 5-6 min per plan)

*Updated after each plan completion*
| Phase 06 P01 | 7 | 2 tasks | 14 files |

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

**Phase 04-02 (MCP Testing):**
- Used Client + InMemoryTransport pattern for MCP integration tests (SDK doesn't expose direct tool invocation)
- Check isError flag instead of exception-based error handling (MCP SDK returns errors as successful responses with isError=true)
- Fixed list_tasks structuredContent by wrapping tasks array in object with tasks key (SDK validates record type, not array)

**Phase 05-01 (systemd Service Infrastructure):**
- StartLimitBurst/IntervalSec placed in [Unit] section (not [Service]) to avoid silent ignore
- Restart=on-failure (not always) to allow manual stop without restart loop
- ProtectHome=read-only (not yes) so service can read ~/.npmrc or node paths
- Migration glob auto-detects *.ts vs *.js based on __dirname (supports dev and prod)
- Signal handlers in start.ts call server.close() then db.close() for graceful shutdown

**Phase 05-02 (Logging & Backup Automation):**
- Use Pino name field (not custom field) for journald service identification
- No pino-journald transport needed (stdout with StandardOutput=journal is correct pattern)
- sqlite3 .backup command instead of file copy (WAL mode safety)
- 30-day backup retention with automatic cleanup
- Service must be stopped before restore (integrity protection)
- Parameterized script paths for testability outside /opt

**Phase 06-01 (Task Hierarchy and Dependency Tracking):**
- Used SQLite DROP COLUMN in migration down() (safe in better-sqlite3 12.x with SQLite 3.46+)
- Self-dependency rejection enforced at both DB (CHECK constraint) and validation (Zod refine)
- CASCADE delete from tasks to task_dependencies (automatic cleanup)
- CASCADE delete from parent task to child tasks (hierarchy cleanup)
- CycleDetector rebuilds full graph on each check (acceptable for current scale)
- Parent task must exist in same project (cross-project hierarchies not allowed)

### Pending Todos

None yet.

### Blockers/Concerns

- Pre-existing: 67 TypeScript compilation errors in src/mcp/__tests__/task-tools.test.ts (tests pass at runtime, should be fixed in dedicated plan)

## Session Continuity

Last session: 2026-02-13T20:52:29Z
Stopped at: Completed 06-01-PLAN.md (Task Hierarchy and Dependency Tracking)
Resume file: .planning/phases/06-advanced-features/06-01-SUMMARY.md
