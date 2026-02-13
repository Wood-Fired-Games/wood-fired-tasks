---
phase: 04-mcp-server
plan: 01
subsystem: mcp-interface
tags: [mcp, tools, stdio, integration]

dependency-graph:
  requires:
    - phase: 01
      plans: [01, 02, 03]
      reason: "Database, repositories, and services for task operations"
    - phase: 01
      plans: [01]
      reason: "Zod schemas for input validation"
  provides:
    - capability: "MCP tool interface for task CRUD"
      consumers: ["Claude Code", "MCP clients"]
    - capability: "Error conversion from domain errors to MCP protocol"
      consumers: ["All MCP tools"]
  affects:
    - component: "None"
      impact: "New interface, no changes to existing code"

tech-stack:
  added:
    - "@modelcontextprotocol/sdk@1.26.0 - Official MCP TypeScript SDK"
  patterns:
    - "Factory pattern for testable server instantiation"
    - "Shared Zod schema reuse across REST and MCP interfaces"
    - "Error conversion layer for protocol translation"

key-files:
  created:
    - "src/mcp/errors.ts - Error conversion utility"
    - "src/mcp/tools/task-tools.ts - Task CRUD tool registrations"
    - "src/mcp/server.ts - MCP server factory function"
    - "src/mcp/index.ts - Stdio entry point"
  modified:
    - "package.json - Added SDK dependency and mcp:start/mcp:dev scripts"

decisions:
  - what: "Double type assertion for structuredContent"
    why: "TypeScript strict mode requires unknown intermediate cast for Task objects without index signature"
    alternatives: ["Add index signature to Task type (breaks type safety)", "Omit structuredContent (loses rich client data)"]
    impact: "Type-safe at runtime, verbose casting syntax"
  - what: "Async handlers for sync service methods"
    why: "MCP SDK requires async handlers, but better-sqlite3 is synchronous"
    alternatives: ["Wrap in Promise.resolve() (unnecessary overhead)", "Change service layer to async (breaks existing REST API)"]
    impact: "No await needed on service calls, clean code"
  - what: "console.error for all logging"
    why: "Stdio transport uses stdout for JSON-RPC messages - any stdout pollution breaks protocol"
    alternatives: ["Use stderr stream directly (less idiomatic)", "Suppress all logging (harder to debug)"]
    impact: "Must use console.error() exclusively in MCP code"

metrics:
  duration: "3m 52s"
  tasks: 2
  files-created: 4
  files-modified: 2
  commits: 2
  completed: "2026-02-13T20:04:50Z"
---

# Phase 04 Plan 01: MCP Server Foundation Summary

**One-liner:** MCP stdio server with 5 task CRUD tools sharing Zod schemas and error conversion from Phase 1 domain layer.

## Overview

Implemented the MCP server foundation with all task management tools, error conversion, and stdio entry point. The server exposes create_task, get_task, update_task, list_tasks, and delete_task tools that share validation schemas with the REST API and convert domain errors to MCP protocol errors.

## What Was Built

### 1. Error Conversion Layer (`src/mcp/errors.ts`)
- `convertToMcpError(error)` function maps Phase 1 custom errors to McpError:
  - `ValidationError` → `InvalidParams` with `fieldErrors` data
  - `NotFoundError` → `InvalidRequest` with `entity`/`id` context
  - `BusinessError` → `InvalidRequest` with message
  - Unknown errors → `InternalError` (logged to console.error, sanitized message)
- Full logging of unexpected errors for debugging
- Structured error data for client handling

### 2. Task Tools (`src/mcp/tools/task-tools.ts`)
Registered 5 MCP tools for task CRUD operations:

**create_task:**
- Input: CreateTaskSchema (shared from Phase 1)
- Creates task via TaskService
- Returns text summary with ID/status + full task object

**get_task:**
- Input: `{ id: number }`
- Retrieves task by ID
- Returns formatted summary (title, status, priority, description, assignee, due date, tags) + full task

**update_task:**
- Input: `{ id: number, updates: UpdateTaskSchema }`
- Updates task with status transition validation
- Returns confirmation text + updated task object

**list_tasks:**
- Input: TaskFiltersSchema (all fields optional)
- Filters tasks by project_id, status, assignee, tags, due_before, due_after, search
- Returns count + bullet list summary + array of tasks
- Special case: empty results return "No tasks found matching filters."

**delete_task:**
- Input: `{ id: number }`
- Deletes task via TaskService
- Returns confirmation text

All tools:
- Use shared Zod schemas from `src/schemas/task.schema.ts`
- Wrap service calls in try/catch
- Throw `convertToMcpError(error)` on failure
- Return both `content` (text array) and `structuredContent` (full data)

### 3. Server Factory (`src/mcp/server.ts`)
- `createMcpServer(taskService, projectService)` factory function
- Creates McpServer instance with name "wood-fired-bugs" v1.0.0
- Registers all task tools via `registerTaskTools()`
- Returns configured server ready for transport connection
- Factory pattern allows test instantiation without stdio transport

### 4. Stdio Entry Point (`src/mcp/index.ts`)
- Async main() function:
  - Reads DB_PATH from environment (default: `./data/tasks.db`)
  - Calls `createApp(dbPath)` to initialize database and services
  - Creates MCP server via `createMcpServer()`
  - Creates `StdioServerTransport()`
  - Connects server to transport via `server.connect(transport)`
  - Logs "Wood Fired Bugs MCP Server running on stdio" to stderr
- Global error handlers for uncaughtException and unhandledRejection
- Main() catch block logs fatal errors and exits with code 1

### 5. NPM Scripts
- `mcp:start` - Run compiled MCP server: `node dist/mcp/index.js`
- `mcp:dev` - Run MCP server in dev mode: `tsx src/mcp/index.ts`

## Deviations from Plan

None - plan executed exactly as written. All 5 tools registered, shared schemas used, error conversion implemented, stdio entry point created, project compiles cleanly.

## Key Decisions

### 1. TypeScript Type Assertions for structuredContent
**Context:** MCP SDK expects `structuredContent?: { [x: string]: unknown }`, but Task type lacks index signature.

**Decision:** Used double type assertion `task as unknown as { [x: string]: unknown }` for structuredContent fields.

**Rationale:**
- Task objects ARE compatible at runtime (plain objects with string keys)
- Adding index signature to Task type would break type safety elsewhere
- Omitting structuredContent would lose rich data for clients
- Double cast satisfies TypeScript strict mode

**Alternative considered:** Modify Task interface with index signature - rejected because it weakens type checking across codebase.

### 2. Async Handlers with Sync Services
**Context:** MCP SDK requires async tool handlers, but TaskService methods are synchronous (better-sqlite3 is sync).

**Decision:** Made handlers async but called service methods without await.

**Rationale:**
- Service methods return values immediately (no promises)
- Wrapping in Promise.resolve() adds unnecessary overhead
- Changing service layer to async would break existing REST API
- Async handlers allow future async operations (e.g., external APIs)

**Impact:** Clean code, no performance overhead, future-compatible.

### 3. console.error for All Logging
**Context:** Stdio transport uses stdout for JSON-RPC messages.

**Decision:** Used console.error() exclusively in MCP code (errors.ts, index.ts).

**Rationale:**
- Any stdout pollution breaks MCP protocol
- console.error() writes to stderr (safe for logging)
- Standard practice for stdio-based protocols
- Matches SDK examples and MCP documentation

**Enforcement:** Verification step confirmed zero console.log() calls in src/mcp/.

## Testing Strategy

**Manual verification performed:**
1. TypeScript compilation: `npx tsc --noEmit` - zero errors
2. Build output: All 4 dist files exist (index.js, server.js, errors.js, tools/task-tools.js)
3. SDK installation: `npm ls @modelcontextprotocol/sdk` shows v1.26.0
4. Schema reuse: grep confirms CreateTaskSchema/UpdateTaskSchema/TaskFiltersSchema imports from shared schemas
5. No stdout pollution: grep confirms zero console.log() calls in src/mcp/
6. Error conversion usage: grep confirms convertToMcpError used in all 5 tool handlers

**Next phase testing:**
- Phase 04-02 will add integration tests with actual MCP client
- Tests will verify tool execution, error handling, and stdio transport
- Will use in-memory database for test isolation

## Integration Points

**Upstream dependencies:**
- Phase 01-03 (Service Layer): TaskService and ProjectService for all business logic
- Phase 01-02 (Repository Layer): Indirectly via services
- Phase 01-01 (Database Foundation): Database initialization via createApp()
- Phase 01 schemas: CreateTaskSchema, UpdateTaskSchema, TaskFiltersSchema

**Downstream consumers:**
- MCP clients (Claude Code, desktop clients, custom integrations)
- Phase 04-02 will add integration tests
- Phase 05 (Real-time subscriptions) may add MCP notifications

**Shared validation:**
- REST API (Phase 02) and MCP server now share identical Zod schemas
- Validation errors have identical structure across interfaces
- Business logic centralized in service layer (single source of truth)

## Files Created

**src/mcp/errors.ts** (44 lines)
- Error conversion function for MCP protocol
- Maps 4 error types (ValidationError, NotFoundError, BusinessError, unknown)
- Logs unknown errors for debugging

**src/mcp/tools/task-tools.ts** (199 lines)
- 5 tool registrations (create_task, get_task, update_task, list_tasks, delete_task)
- Shared schema usage
- Text summaries + structured content
- Error conversion in all catch blocks

**src/mcp/server.ts** (28 lines)
- Factory function for McpServer creation
- Tool registration orchestration
- Testable design (no transport coupling)

**src/mcp/index.ts** (46 lines)
- Stdio entry point
- Database and service initialization
- Transport connection
- Global error handlers

## Files Modified

**package.json**
- Added @modelcontextprotocol/sdk ^1.26.0 dependency
- Added mcp:start and mcp:dev scripts

**package-lock.json**
- Locked SDK and 71 transitive dependencies

## Commits

**8df790d** - feat(04-01): install MCP SDK and create error conversion utility
- Installed @modelcontextprotocol/sdk ^1.26.0
- Created src/mcp/errors.ts with convertToMcpError function
- Added npm scripts for mcp:start and mcp:dev

**ee17238** - feat(04-01): create MCP server with task CRUD tools
- Created task-tools.ts with 5 tool registrations
- Created server.ts factory function
- Created index.ts stdio entry point
- All tools use shared schemas and error conversion

## Challenges & Solutions

**Challenge 1: TypeScript strict mode rejected structuredContent type**
- Issue: Task type lacks index signature required by MCP SDK
- Solution: Double cast `as unknown as { [x: string]: unknown }`
- Learning: MCP SDK uses loose typing for extensibility - need type assertions at boundaries

**Challenge 2: Determining correct SDK import paths**
- Issue: Plan used hypothetical paths like `@modelcontextprotocol/sdk/server/mcp.js`
- Solution: Inspected node_modules structure to verify actual exports
- Learning: Always verify SDK structure before writing imports (checked package.json exports field)

**Challenge 3: Understanding tool callback return type**
- Issue: SDK types are complex (BaseToolCallback, CallToolResult)
- Solution: Read SDK examples (toolWithSampleServer.js, mcpServerOutputSchema.js)
- Learning: Examples are more valuable than type definitions for understanding SDK usage patterns

## Next Steps

**Immediate (Phase 04-02):**
- Add integration tests with MCP client
- Test all 5 tools with real transport
- Verify error handling and validation
- Test stdio transport connection

**Future phases:**
- Phase 05: Add project CRUD tools (create_project, list_projects, etc.)
- Phase 06: Add MCP notifications for real-time task updates
- Phase 06: Add resource endpoints for task browsing

## Success Criteria Met

- [x] MCP SDK installed as production dependency
- [x] 5 MCP tools defined (create_task, get_task, update_task, list_tasks, delete_task)
- [x] All tools use shared Zod schemas from src/schemas/task.schema.ts
- [x] Error conversion maps ValidationError, NotFoundError, BusinessError to McpError
- [x] Server factory allows test instantiation without stdio
- [x] Stdio entry point compiles and builds to dist/mcp/index.js
- [x] Zero console.log calls in MCP source (stdout reserved for JSON-RPC)
- [x] Project compiles with zero type errors
- [x] All verification checks pass

## Self-Check: PASSED

**Files verified:**
- [x] src/mcp/errors.ts exists
- [x] src/mcp/tools/task-tools.ts exists
- [x] src/mcp/server.ts exists
- [x] src/mcp/index.ts exists
- [x] dist/mcp/errors.js exists
- [x] dist/mcp/tools/task-tools.js exists
- [x] dist/mcp/server.js exists
- [x] dist/mcp/index.js exists

**Commits verified:**
- [x] 8df790d exists (Task 1: SDK + errors)
- [x] ee17238 exists (Task 2: tools + server + entry point)

**Code patterns verified:**
- [x] CreateTaskSchema imported from ../../schemas/task.schema.js
- [x] UpdateTaskSchema imported from ../../schemas/task.schema.js
- [x] TaskFiltersSchema imported from ../../schemas/task.schema.js
- [x] convertToMcpError used in 5 catch blocks
- [x] Zero console.log() calls in src/mcp/

All claims in summary verified against actual codebase.
