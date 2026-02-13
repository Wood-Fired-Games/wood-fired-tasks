# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-13)

**Core value:** Any agent on the local network can reliably create, find, and update work items in real time -- making this the single source of truth for all Wood Fired Games task tracking.
**Current focus:** v1.1 Interface Parity & CLI Polish

## Current Position

**Phase:** 10 - Testing & Integration
**Plan:** — (validation phase, no plans needed)
**Status:** Complete — Milestone audit PASSED (31/31 requirements)
**Progress:** [██████████] 100%

Last activity: 2026-02-13 — Milestone audit passed, all phases complete

## Performance Metrics

**Velocity:**
- Total plans completed: 13 (v1.0)
- Average duration: 5 minutes
- Total execution time: 63 minutes (1.05 hours)

**By Phase (v1.0):**

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

**v1.1 In Progress:**
- Phases: 3/4 (75%) — Phase 7, 8, 9 complete
- Plans: 10/10 (Phase 7: 3, Phase 8: 5, Phase 9: 2)
- Tests: 357 (all passing)
- Requirements mapped: 31/31 (100%)

*Updated after each plan completion*
| Phase 09 P02 | 4 | 3 tasks | 7 files |
| Phase 08 P01 | 2 | 4 tasks | 6 files |
| Phase 09 P01 | 2 | 3 tasks | 3 files |
| Phase 07 P03 | 5 | 3 tasks | 7 files |
| Phase 07 P01 | 2 | 2 tasks | 3 files |
| Phase 07 P02 | 3 | 2 tasks | 3 files |
| Phase 08 P02 | 4 | 4 tasks | 10 files |
| Phase 08 P03 | 3 | 4 tasks | 8 files |
| Phase 08 P04 | 3 | 4 tasks | 8 files |
| Phase 08 P05 | 3 | 4 tasks | 9 files |

## Accumulated Context

### Decisions

**v1.1 Roadmap (2026-02-13):**
- Phase 7 must precede Phase 8 (infrastructure patterns affect all 16 new CLI commands; retrofitting is expensive)
- Phases 8 and 9 can run parallel (CLI and MCP are independent interfaces with no shared code paths)
- Start phase numbering at 7 (continues from v1.0 which ended at Phase 6)
- 4 phases derived from requirements (7: Infrastructure, 8: CLI Commands, 9: MCP Tools, 10: Testing)

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

**Phase 07-01 (Output Abstraction Layer):**
- Use process.argv.includes('--json') for mode detection to avoid circular dependencies with Commander
- Keep parseAsync() for future async command handler compatibility
- Return plain strings from formatters in JSON mode (no ANSI codes)
- Fixed blocking TypeScript error in interactive.ts validate callback (Rule 3 deviation)

**Phase 07-02 (Interactive Prompt Infrastructure):**
- Use @clack/prompts over inquirer or prompts (modern, lightweight, handles Ctrl+C automatically)
- Check --no-input and --force via process.argv instead of program.opts() (consistent with formatters approach)
- Fail fast with error when prompts disabled and field missing (better for CI/scripts)
- Return true immediately on --force for confirmAction() (allows destructive operations in scripts)
- [Phase 07-03]: Use program.optsWithGlobals() to access global --json flag from subcommands
- [Phase 07-03]: NO_COLOR env var checked via process.env.NO_COLOR !== undefined (any value disables colors)

**Phase 08-01 (Delete and Show Commands):**
- Delete command fetches task first to display what will be deleted (better UX)
- Delete shows cancellation message instead of silent exit (user feedback)
- Both commands follow Phase 7 patterns (optsWithGlobals for --json, error handling)
- Pre-fetch pattern established: fetch entity before destructive operation to show user context
- Confirmation prompts use task title/name for better context
- Cancellation acknowledged with user-facing message in both JSON and terminal modes
- [Phase 07-03]: Combined shouldUseColor() replaces isJsonMode() checks in formatters (NO_COLOR + --json detection)

**Phase 09-02 (Health Monitoring and Subtask Tools):**
- check_health returns unhealthy status instead of throwing errors (ensures tool always responds)
- list_subtasks provides richer output than get_subtasks (bulleted list vs count) for better UX
- Database parameter added to createMcpServer signature for health check access
- All existing tests updated to pass db parameter (breaking change handled immediately)
- [Phase 08]: Project commands follow exact same patterns as task commands (optsWithGlobals, handleError, jsonOutput)
- [Phase 08]: Show task IDs only in dependency list (not titles) for v1.1 simplicity
- [Phase 08]: comment-delete requires both <task-id> and <comment-id> because REST API route is nested under tasks
- [Phase 08]: HealthResponse type matches actual REST API shape (healthy/unhealthy, checks.database) not plan's simplified shape

### Pending Todos

**Phase 7 (Core CLI Infrastructure):**
- [x] Implement output abstraction layer (stdout for data, stderr for messages)
- [x] Add global --json flag with proper inheritance to all commands
- [x] Integrate @clack/prompts for interactive CLI experiences (interactive.ts created)
- [x] Add --no-input flag to disable prompts in scripts (global flag added)
- [x] Add confirmation prompts for destructive actions (confirmAction in interactive.ts)
- [x] Retrofit existing commands (create, list, update) with --json support (Phase 07-03)
- [x] Update table formatters with color-coded statuses and priorities (already done in v1.0)
- [x] Add NO_COLOR environment variable support (Phase 07-03, shouldUseColor())

### Blockers/Concerns

None. v1.0 shipped successfully. v1.1 roadmap complete with 31/31 requirements mapped to phases.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 1 | Address all tech debt — zero TS errors, no test duplication, all 250 tests pass | 2026-02-13 | 5e721c0 | [1-address-all-of-the-tech-debt-and-ensure-](./quick/1-address-all-of-the-tech-debt-and-ensure-/) |

## Session Continuity

**Last session:** 2026-02-13T23:38:35.117Z

**Stopped at:** Completed 08-05-PLAN.md - Phase 8 COMPLETE (all 18 CLI commands)

**Next session should:**
1. Continue Phase 9 or Phase 8 execution (both in progress)
2. MCP interface now at 25 tools (up from 23)
3. Consider completing remaining Phase 8 and Phase 9 plans

**Quick start command:**
```bash
/gsd:execute-phase 9  # Continue with next plan in phase
```

**Context for next agent:**
- v1.0 shipped with 9,020 lines of TypeScript, 117 files, 250 tests passing
- Phase 09-01 complete: Added 5 project CRUD tools to MCP (now 25 tools total)
- CLI currently has 5 commands (create, list, update, delete, show); expanding to 18+
- MCP currently has 25 tools; expanding further in 09-02
- Phase 7 is foundation work that affects all subsequent CLI commands
- Research identified 10 critical pitfalls; top 5 must be addressed in Phase 7
- All 31 v1.1 requirements mapped to phases 7-10 with 100% coverage

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

**V1.1 MILESTONE IN PROGRESS**

Roadmap created with 4 phases (7-10):
- Phase 7: Core CLI Infrastructure (3/3 plans complete)
- Phase 8: CLI Command Expansion (5/5 plans complete, 18 CLI commands)
- Phase 9: MCP Tool Expansion (2/2 plans complete, 27 MCP tools)
- Phase 10: Testing & Integration (validation phase — pending)

Coverage: 31/31 requirements mapped (100%)
Status: Phases 7-9 complete, Phase 10 pending

---
*Last updated: 2026-02-13*
*Roadmap version: v1.1*
