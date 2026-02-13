---
phase: 04-mcp-server
plan: 02
subsystem: mcp-interface
tags: [mcp, testing, integration, vitest]

dependency-graph:
  requires:
    - phase: 04
      plans: [01]
      reason: "MCP server, tools, and error conversion to test"
    - phase: 01
      plans: [01, 02, 03]
      reason: "Service layer and schemas for test data setup"
  provides:
    - capability: "Comprehensive test coverage for MCP tools"
      consumers: ["CI/CD", "Development workflow"]
    - capability: "Integration test pattern for MCP servers"
      consumers: ["Future MCP test suites"]
  affects:
    - component: "src/mcp/tools/task-tools.ts"
      impact: "Bug fix: wrapped list_tasks structuredContent array in object to satisfy SDK validation"

tech-stack:
  added: []
  patterns:
    - "Client + InMemoryTransport pattern for MCP integration testing"
    - "isError flag inspection instead of exception-based error handling"
    - "Direct service layer access for test data setup"

key-files:
  created:
    - "src/mcp/__tests__/errors.test.ts - Error conversion utility tests"
    - "src/mcp/__tests__/task-tools.test.ts - All 5 MCP task tool tests"
  modified:
    - "src/mcp/tools/task-tools.ts - Fixed structuredContent for list_tasks (array → object wrapper)"

decisions:
  - what: "Test MCP tools via Client + InMemoryTransport"
    why: "MCP SDK doesn't expose direct tool invocation API - need client-server pair"
    alternatives: ["Mock tool handlers directly (bypasses SDK validation)", "Use stdio transport (requires process management)"]
    impact: "Tests verify full request/response cycle through SDK validation"
  - what: "Check isError flag instead of expect().rejects.toThrow()"
    why: "MCP SDK returns errors as successful responses with isError=true, doesn't throw"
    alternatives: ["Wrap client.callTool to throw on isError (hides SDK behavior)"]
    impact: "Tests match actual SDK client behavior"
  - what: "Fix list_tasks structuredContent by wrapping array in object"
    why: "SDK validates structuredContent must be record type, not array - runtime error on list operations"
    alternatives: ["Omit structuredContent for lists (loses structured data)", "Change SDK types (not our code)"]
    impact: "list_tasks now returns { tasks: [...] } in structuredContent field"

metrics:
  duration: "4m 55s"
  tasks: 2
  files-created: 2
  files-modified: 1
  commits: 2
  tests-added: 19
  completed: "2026-02-13T20:12:40Z"
---

# Phase 04 Plan 02: MCP Testing Summary

**One-liner:** Comprehensive integration tests for MCP error conversion and all 5 task tools using Client + InMemoryTransport pattern, with bug fix for list_tasks structuredContent validation.

## Overview

Implemented full test coverage for the MCP server built in Plan 01. Tests verify error conversion mappings, tool request/response handling, shared schema validation, and error scenarios. Discovered and fixed a bug where list_tasks violated SDK validation by returning an array as structuredContent.

## What Was Built

### 1. Error Conversion Tests (`src/mcp/__tests__/errors.test.ts`)

5 test cases covering all error conversion paths:

**Test 1: ValidationError → InvalidParams**
- Creates ValidationError with field errors (title, priority)
- Verifies McpError with ErrorCode.InvalidParams
- Confirms fieldErrors in data field

**Test 2: NotFoundError → InvalidRequest**
- Creates NotFoundError("Task", 42)
- Verifies McpError with ErrorCode.InvalidRequest
- Confirms entity and id in data field

**Test 3: BusinessError → InvalidRequest**
- Creates BusinessError with status transition message
- Verifies McpError with ErrorCode.InvalidRequest
- Confirms error message preserved

**Test 4: Unknown Error → InternalError**
- Creates generic Error("something unexpected")
- Mocks console.error to verify logging
- Confirms McpError with sanitized message (no info leak)
- Confirms ErrorCode.InternalError

**Test 5: Non-Error unknown → InternalError**
- Passes string instead of Error object
- Confirms same sanitized error handling

All error tests verify that McpError.message contains expected text (not exact match due to "MCP error {code}: " prefix).

### 2. Task Tools Integration Tests (`src/mcp/__tests__/task-tools.test.ts`)

14 test cases covering all 5 MCP tools:

**Test setup:**
- Uses `createTestApp()` for in-memory SQLite database
- Creates `McpServer` via `createMcpServer()`
- Uses `InMemoryTransport.createLinkedPair()` for client-server communication
- Creates test project in beforeEach for valid project_id
- Cleans up transports and database in afterEach

**create_task tool (4 tests):**
1. Creates task with required fields (title, project_id, created_by)
   - Verifies text response contains title, ID, status
   - Verifies structuredContent has task object
2. Creates task with all optional fields
   - Tests description, priority, assignee, due_date (ISO8601 datetime), tags
   - Verifies all fields persisted via service layer query
3. Rejects task with missing required fields
   - Passes empty arguments object
   - Verifies isError=true and validation error message
4. Rejects task with non-existent project_id
   - Uses project_id: 9999
   - Verifies isError=true and business error message

**get_task tool (2 tests):**
5. Returns task by ID
   - Creates task via service, fetches via MCP tool
   - Verifies text summary includes title, status, priority
   - Verifies structuredContent matches created task
6. Returns error for non-existent task ID
   - Uses id: 9999
   - Verifies isError=true and not-found error message

**update_task tool (3 tests):**
7. Updates task fields
   - Changes title and priority
   - Verifies text confirms update
   - Verifies structuredContent has new values
8. Rejects invalid status transition
   - Attempts open → done (skips in_progress)
   - Verifies isError=true and transition error message
9. Returns error for non-existent task
   - Uses id: 9999
   - Verifies isError=true

**list_tasks tool (3 tests):**
10. Lists all tasks when no filters
    - Creates 3 tasks, calls list_tasks with {}
    - Verifies text contains "Found 3 task(s)" and all titles
11. Filters tasks by status
    - Creates open task and in_progress task
    - Filters by status: "open"
    - Verifies only matching task in results
12. Returns empty message when no tasks match
    - Filters by assignee: "nobody"
    - Verifies "No tasks found" message

**delete_task tool (2 tests):**
13. Deletes an existing task
    - Creates task, calls delete_task
    - Verifies deletion confirmation text
    - Confirms task gone by trying to get_task (isError=true)
14. Returns error for non-existent task
    - Uses id: 9999
    - Verifies isError=true

### 3. Bug Fix: list_tasks structuredContent

**Issue discovered during testing:**
- list_tasks returned tasks array directly as structuredContent
- MCP SDK validates structuredContent must be `{ [x: string]: unknown }` (record type)
- SDK threw McpError -32602: "Invalid input: expected record, received array"
- Tests failed with validation error before reaching assertions

**Root cause:**
- Phase 01 implementation used `tasks as unknown as { [x: string]: unknown }`
- Type cast bypassed TypeScript checks but failed SDK runtime validation
- Double cast worked for single objects but not for arrays

**Fix applied (Deviation Rule 1 - Bug):**
- Changed empty case: `structuredContent: { tasks: [] }`
- Changed non-empty case: `structuredContent: { tasks }`
- Wrapped array in object with `tasks` key
- Now returns record type satisfying SDK validation

**Files modified:**
- `src/mcp/tools/task-tools.ts` lines 142, 160

**Impact:**
- list_tasks now provides structured data in `result.structuredContent.tasks` array
- Matches common API pattern (wrapping arrays in named fields)
- All 14 tests pass after fix

## Deviations from Plan

### Auto-fixed Issues (Deviation Rule 1)

**1. [Rule 1 - Bug] Fixed list_tasks structuredContent validation error**
- **Found during:** Task 2, test execution
- **Issue:** SDK runtime validation rejected array as structuredContent, expecting record type
- **Fix:** Wrapped tasks array in object with `tasks` key: `{ tasks: [] }` and `{ tasks }`
- **Files modified:** src/mcp/tools/task-tools.ts (lines 142, 160)
- **Commit:** b3a9f6c (included with Task 2 tests)

**2. [Rule 1 - Bug] Corrected test data to use ISO8601 datetime format**
- **Found during:** Task 2, test execution
- **Issue:** due_date test value '2026-03-01' failed validation (schema requires full datetime with timezone)
- **Fix:** Changed to '2026-03-01T12:00:00Z' in test
- **Files modified:** src/mcp/__tests__/task-tools.test.ts
- **Commit:** b3a9f6c

**3. [Rule 1 - Bug] Fixed status value to use underscore not hyphen**
- **Found during:** Task 2, test execution
- **Issue:** Test used 'in-progress' but enum defines 'in_progress'
- **Fix:** Changed status value to 'in_progress' in test
- **Files modified:** src/mcp/__tests__/task-tools.test.ts
- **Commit:** b3a9f6c

## Key Decisions

### 1. Client + InMemoryTransport Testing Pattern
**Context:** Need to test MCP tool handlers but SDK doesn't expose direct invocation API.

**Decision:** Use full client-server setup with InMemoryTransport for tests.

**Rationale:**
- McpServer.registerTool() doesn't return callable function
- Direct handler invocation bypasses SDK validation (what we need to test)
- InMemoryTransport creates paired transports without stdio complexity
- Pattern matches SDK's own test suite

**Implementation:**
```typescript
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'test-client', version: '1.0.0' });
await client.connect(clientTransport);
const result = await client.callTool({ name: 'create_task', arguments: {...} });
```

**Alternative considered:** Mock tool handlers directly - rejected because it skips SDK validation layer.

### 2. isError Flag Inspection for Error Assertions
**Context:** MCP tool errors don't throw exceptions - SDK returns them as successful responses.

**Decision:** Check `result.isError === true` instead of `expect().rejects.toThrow()`.

**Rationale:**
- MCP protocol treats tool errors as structured responses, not exceptions
- SDK client.callTool() always resolves (never rejects) for tool execution errors
- Error details in `result.content[0].text` and `result.isError` flag
- Tests need to match actual client behavior

**Example:**
```typescript
const result = await client.callTool({ name: 'get_task', arguments: { id: 9999 } });
expect(result.isError).toBe(true);
expect(result.content[0].text).toContain('not found');
```

**Alternative considered:** Wrap client.callTool() to throw on isError - rejected because it hides SDK semantics from tests.

### 3. Direct Service Access for Test Setup
**Context:** Need to create tasks with specific properties for test scenarios.

**Decision:** Use `app.taskService.createTask()` and `app.taskService.updateTask()` directly in tests.

**Rationale:**
- Test setup simpler than multiple MCP tool calls
- Isolates test data creation from tool behavior being tested
- Allows testing edge cases (e.g., specific status for transition tests)
- Faster test execution (no transport round-trips for setup)

**Example:**
```typescript
const task = app.taskService.createTask({ title: 'Test', project_id: testProjectId, created_by: 'test' });
app.taskService.updateTask(task.id, { status: 'in_progress' });
// Now test list_tasks filtering
```

**Alternative considered:** Use create_task/update_task tools for setup - rejected as unnecessarily complex for test data.

## Testing Strategy

**Unit tests (errors.test.ts):**
- Pure function testing of `convertToMcpError()`
- Mocks console.error to verify logging without pollution
- Covers all 4 error types plus unknown values

**Integration tests (task-tools.test.ts):**
- Full request/response cycle through MCP SDK
- Real database operations (in-memory SQLite)
- Verifies schema validation, business logic, error conversion in concert
- Tests SDK's own validation of tool responses

**Verification performed:**
1. `npx vitest run src/mcp/__tests__/errors.test.ts` - 5/5 pass
2. `npx vitest run src/mcp/__tests__/task-tools.test.ts` - 14/14 pass
3. `npx vitest run src/` - 172/172 pass (includes 19 new + 153 existing)
4. Zero regressions in existing test suite

## Integration Points

**Upstream dependencies:**
- Phase 04-01: MCP server, tool registrations, error conversion
- Phase 01-03: TaskService and ProjectService for business logic
- Phase 01-01: Schemas (CreateTaskSchema, UpdateTaskSchema, TaskFiltersSchema)
- Phase 01-01: In-memory database via createTestApp()

**Downstream consumers:**
- CI/CD pipeline (test verification before deployment)
- Future MCP tool additions (pattern reference)
- Documentation (integration test examples)

**Validation coverage:**
- MCP-01 (CRUD operations): All 5 tools tested with happy paths
- MCP-02 (Shared schemas): Tests verify create_task rejects invalid input
- MCP-03 (Structured errors): Tests verify isError flag and error codes

## Files Created

**src/mcp/__tests__/errors.test.ts** (78 lines)
- 5 test cases for error conversion
- Covers ValidationError, NotFoundError, BusinessError, unknown Error, non-Error
- Verifies ErrorCode mapping and data structure

**src/mcp/__tests__/task-tools.test.ts** (341 lines)
- 14 test cases across 5 MCP tools
- beforeEach/afterEach for test app and transport management
- Covers happy paths, validation errors, not-found errors, business rule violations

## Files Modified

**src/mcp/tools/task-tools.ts** (2 lines changed)
- Line 142: Empty list structuredContent changed from `[]` to `{ tasks: [] }`
- Line 160: Non-empty list structuredContent changed from `tasks` to `{ tasks }`
- Fix: Wrapped array in object to satisfy SDK record type validation

## Commits

**ff09e39** - test(04-02): add error conversion utility tests
- 5 tests covering all error conversion paths
- ValidationError → InvalidParams with fieldErrors
- NotFoundError → InvalidRequest with entity/id
- BusinessError → InvalidRequest with message
- Unknown errors → InternalError with sanitized messages

**b3a9f6c** - test(04-02): add comprehensive MCP task tools tests
- 14 tests for all 5 MCP tools
- Client + InMemoryTransport integration pattern
- Bug fix: list_tasks structuredContent array wrapping
- Test data fixes: ISO8601 datetime, status enum values

## Challenges & Solutions

**Challenge 1: Understanding MCP SDK error handling**
- Issue: Expected errors to throw, but SDK returns isError flag
- Solution: Read SDK source code to understand protocol semantics
- Learning: MCP treats tool errors as structured responses, not exceptions

**Challenge 2: structuredContent validation failure**
- Issue: list_tasks tests threw SDK validation error before reaching test assertions
- Root cause: SDK runtime validates structuredContent type (record not array)
- Solution: Wrapped tasks array in object with `tasks` key
- Learning: TypeScript casts don't prevent runtime validation - SDK checks actual structure

**Challenge 3: Setting up MCP client-server pair for tests**
- Issue: No obvious API for direct tool invocation in tests
- Solution: Found InMemoryTransport.createLinkedPair() in SDK examples
- Learning: Integration tests for protocol implementations need full client-server setup

**Challenge 4: ISO8601 datetime vs date format**
- Issue: Test used '2026-03-01' but schema requires full datetime
- Root cause: Schema defines `datetime` format, not just `date`
- Solution: Changed test value to '2026-03-01T12:00:00Z'
- Learning: Zod datetime format requires time and timezone components

## Success Criteria Met

- [x] Error conversion tests: 5 tests covering all error types
- [x] Task tool tests: 14 tests covering all 5 tools (create, get, update, list, delete)
- [x] All tests pass independently: errors.test.ts (5/5), task-tools.test.ts (14/14)
- [x] Full suite passes: 172/172 tests (19 new + 153 existing)
- [x] Tests prove MCP-01: All CRUD operations work correctly
- [x] Tests prove MCP-02: Shared validation rejects bad input (create_task empty args)
- [x] Tests prove MCP-03: Structured error codes (InvalidParams, InvalidRequest, InternalError)
- [x] Zero regressions in existing 153 tests
- [x] Bug fix applied and verified: list_tasks structuredContent now valid

## Self-Check: PASSED

**Files verified:**
```bash
[ -f "src/mcp/__tests__/errors.test.ts" ] && echo "FOUND: src/mcp/__tests__/errors.test.ts"
[ -f "src/mcp/__tests__/task-tools.test.ts" ] && echo "FOUND: src/mcp/__tests__/task-tools.test.ts"
```
- [x] src/mcp/__tests__/errors.test.ts exists
- [x] src/mcp/__tests__/task-tools.test.ts exists

**Commits verified:**
```bash
git log --oneline --all | grep -q "ff09e39" && echo "FOUND: ff09e39"
git log --oneline --all | grep -q "b3a9f6c" && echo "FOUND: b3a9f6c"
```
- [x] ff09e39 exists (Task 1: error tests)
- [x] b3a9f6c exists (Task 2: tool tests + bug fix)

**Test execution verified:**
```bash
npx vitest run src/mcp/__tests__/errors.test.ts
npx vitest run src/mcp/__tests__/task-tools.test.ts
npx vitest run src/
```
- [x] errors.test.ts: 5/5 tests pass
- [x] task-tools.test.ts: 14/14 tests pass
- [x] Full suite: 172/172 tests pass
- [x] No regressions

All claims in summary verified against actual codebase.
