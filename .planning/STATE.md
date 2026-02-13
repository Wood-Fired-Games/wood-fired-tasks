# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-13)

**Core value:** Any agent on the local network can reliably create, find, and update work items in real time -- making this the single source of truth for all Wood Fired Games task tracking.
**Current focus:** Planning next milestone

## Current Position

Phase: 6 of 6 (Advanced Features)
Plan: 2 of 2 in current phase
Status: MILESTONE COMPLETE
Last activity: 2026-02-13 - Completed quick task 1: address all of the tech debt and ensure there are no warnings, errors, and that all tests pass

Progress: [█████████████████████████] 100%

## Performance Metrics

**Velocity:**
- Total plans completed: 13
- Average duration: 5 minutes
- Total execution time: 63 minutes (1.05 hours)

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-foundation | 3 | 11 min | 4 min |
| 02-rest-api | 2 | 9 min | 5 min |
| 03-cli | 2 | 5 min | 3 min |
| 04-mcp-server | 2 | 9 min | 5 min |
| 05-production-deployment | 2 | 11 min | 6 min |
| 06-advanced-features | 2 | 18 min | 9 min |

**Recent Trend:**
- Last 5 plans: 05-02 (5 min), 05-01 (6 min), 06-01 (7 min), 06-02 (11 min)
- Trend: Increasing complexity in final phase

*Updated after each plan completion*
| Phase 06 P02 | 11 | 2 tasks | 25 files |

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

**Phase 06-02 (Comments, Estimates, and Full API/MCP Exposure):**
- Chronological comment order enforced at repository level via ORDER BY created_at ASC
- Composite index (task_id, created_at) optimizes chronological retrieval by task
- Time estimates capped at 10080 minutes (1 week) for sanity
- Comment author max 100 chars, content max 5000 chars (prevents abuse)
- REST routes return blocks/blocked_by structure for dependencies (mirrors graph semantics)
- MCP tools use registerTool pattern with Zod schemas (consistent with task-tools)
- Skipped MCP tool tests for subtasks due to pre-existing SDK type issues (verified via API tests)

### Pending Todos

None yet.

### Blockers/Concerns

None. All tech debt resolved in quick task 1.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 1 | Address all tech debt — zero TS errors, no test duplication, all 250 tests pass | 2026-02-13 | 5e721c0 | [1-address-all-of-the-tech-debt-and-ensure-](./quick/1-address-all-of-the-tech-debt-and-ensure-/) |

## Session Continuity

Last session: 2026-02-13T21:12:56Z
Stopped at: Completed 06-02-PLAN.md (Comments, Estimates, and Full API/MCP Exposure) - FINAL PLAN
Resume file: .planning/phases/06-advanced-features/06-02-SUMMARY.md

## Milestone Status

**V1.0 MILESTONE COMPLETE**

All 6 phases executed successfully:
1. Foundation - Database, repositories, services
2. REST API - Core endpoints, error handling, OpenAPI
3. CLI - Task management commands
4. MCP Server - Tool registration, validation
5. Production Deployment - systemd, logging, backups
6. Advanced Features - Relationships, comments, estimates

Total execution time: 63 minutes
Total tests: 250 (all passing)
Total files: 100+ created/modified
Total commits: 13 plans
