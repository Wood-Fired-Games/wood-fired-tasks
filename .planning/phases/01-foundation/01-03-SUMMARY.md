---
phase: 01-foundation
plan: 03
subsystem: service-layer
tags: [services, zod, validation, business-logic, status-lifecycle]
dependency_graph:
  requires:
    - database-initialization
    - schema-migrations
    - type-definitions
    - project-repository
    - task-repository
    - data-access-layer
  provides:
    - service-layer
    - validation-layer
    - business-logic-layer
    - application-entry-point
  affects:
    - rest-api
    - cli
    - mcp-interface
tech_stack:
  added: []
  patterns:
    - Zod schema validation with custom error formatting
    - Service layer with dependency injection
    - Status lifecycle enforcement via transition map
    - Custom error classes (ValidationError, BusinessError, NotFoundError)
    - Application factory pattern (createApp, createTestApp)
key_files:
  created:
    - src/schemas/task.schema.ts
    - src/services/errors.ts
    - src/services/project.service.ts
    - src/services/task.service.ts
    - src/services/__tests__/project.service.test.ts
    - src/services/__tests__/task.service.test.ts
  modified:
    - src/index.ts
    - src/types/task.ts
    - src/repositories/project.repository.ts
decisions:
  - zod_v4_compatibility: "Used .issues instead of .errors for Zod v4 error handling"
  - nullable_description: "Updated CreateProjectDTO to allow null description for Zod nullable() compatibility"
  - status_forced_open: "TaskService always sets status to 'open' on create, ignoring any status in input"
  - validation_layer_pattern: "All service methods validate unknown input via Zod safeParse before processing"
  - error_structure: "ValidationError contains fieldErrors map, NotFoundError includes entity+id, BusinessError has descriptive message"
metrics:
  tasks_completed: 2
  tests_added: 55
  files_created: 6
  duration_minutes: 5
  completed_at: "2026-02-13T18:50:16Z"
---

# Phase 01 Plan 03: Service Layer with Validation and Business Logic Summary

Complete service layer with Zod validation, custom error handling, status lifecycle enforcement, and application entry point with comprehensive integration tests proving the full stack works end-to-end.

## Tasks Completed

### Task 1: Zod schemas, custom errors, and ProjectService
**Commit:** ca08428

Created validation schemas, custom error classes, and ProjectService with full CRUD operations and business logic.

**Files created:**
- `src/schemas/task.schema.ts` - Zod validation schemas for all operations
- `src/services/errors.ts` - Custom error classes with structured error information
- `src/services/project.service.ts` - Project business logic and validation
- `src/services/__tests__/project.service.test.ts` - ProjectService integration tests (11 tests)

**Files modified:**
- `src/types/task.ts` - Updated CreateProjectDTO to allow null description
- `src/repositories/project.repository.ts` - Fixed to handle optional description field

**Zod schemas:**
- `CreateTaskSchema` - Validates task creation (no status field - always forced to 'open')
- `UpdateTaskSchema` - Validates partial task updates (all fields optional)
- `CreateProjectSchema` - Validates project creation
- `TaskFiltersSchema` - Validates all 7 filter types (partial, all optional)

**Custom errors:**
- `ValidationError` - Contains fieldErrors map from Zod validation
- `BusinessError` - For business logic violations (duplicate names, invalid transitions)
- `NotFoundError` - For missing entities (includes entity type and id)

**ProjectService operations:**
- `createProject(input)` - Validates input, checks duplicate names, creates project
- `getProject(id)` - Returns project or throws NotFoundError
- `listProjects()` - Returns all projects
- `updateProject(id, input)` - Validates, checks uniqueness on name change, updates
- `deleteProject(id)` - Verifies existence, deletes project

**Tests verify:**
- Create with valid input returns project with all fields
- Empty name throws ValidationError with field errors
- Duplicate name throws BusinessError
- getProject throws NotFoundError for non-existent ID
- listProjects returns all projects
- updateProject changes fields and validates uniqueness
- deleteProject removes project

**Key fix applied (Rule 3 - Blocking):**
- Zod v4 uses `.issues` instead of `.errors` - updated all error handling code
- ProjectRepository normalizes description to null when undefined for better-sqlite3 compatibility

### Task 2: TaskService with status lifecycle and createApp entry point
**Commit:** 5155ef4

Implemented TaskService (the core of Phase 1) with status lifecycle enforcement and created the application factory.

**Files created:**
- `src/services/task.service.ts` - Task business logic with status lifecycle validation
- `src/services/__tests__/task.service.test.ts` - Comprehensive TaskService tests (44 tests)

**Files modified:**
- `src/index.ts` - Application entry point with createApp() and createTestApp()

**TaskService operations:**
- `createTask(input)` - Validates, verifies project exists, forces status to 'open', creates with tags
- `getTask(id)` - Returns task with tags or throws NotFoundError
- `listTasks(filters?)` - Validates filters, returns filtered tasks with tags
- `updateTask(id, input)` - Validates, enforces status transitions, updates task
- `deleteTask(id)` - Verifies existence, deletes task
- `countTasks(filters?)` - Validates filters, returns count
- `searchTasks(query)` - Convenience method for FTS5 search

**Status lifecycle enforcement:**
Uses VALID_STATUS_TRANSITIONS map from types. Invalid transitions throw BusinessError with clear message listing valid targets.

Valid transitions verified by tests:
- open → in_progress, blocked, closed (NOT done)
- in_progress → done, blocked, open
- done → closed, open (NOT in_progress)
- closed → open (NOT in_progress)
- blocked → open, in_progress (NOT done)

**Application factory (createApp):**
1. Initialize database with provided path (or './data/tasks.db')
2. Run migrations (async)
3. Create ProjectRepository and TaskRepository
4. Create ProjectService and TaskService
5. Return App interface with db, projectService, taskService

**createTestApp():** Calls createApp(':memory:') for test usage.

**Tests verify:**
- **Create:** Valid input with all fields, tags array, forced 'open' status
- **Validation:** Missing title/created_by throws ValidationError, invalid due_date format rejected
- **Business logic:** Non-existent project throws BusinessError
- **Read:** getTask returns task with tags, non-existent throws NotFoundError
- **Update:** Change title, priority, assignee, due_date, tags
- **Status lifecycle:** 14 tests covering every valid and invalid transition
- **Delete:** Removes task, non-existent throws NotFoundError
- **Filters:** All 7 filter types work individually and combined
- **Search:** FTS5 search finds by title and description keywords
- **Count:** Returns correct counts with and without filters
- **createApp:** Returns db, services; initializes properly

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed async migrations in test setup**
- **Found during:** Task 1 test execution
- **Issue:** runMigrations is async but test beforeEach wasn't awaiting it, causing "no such table" errors
- **Fix:** Changed beforeEach to async and added await for runMigrations
- **Files modified:** `src/services/__tests__/project.service.test.ts`
- **Commit:** ca08428

**2. [Rule 3 - Blocking] Fixed Zod v4 error structure**
- **Found during:** Task 1 test execution
- **Issue:** Zod v4 uses `.issues` instead of `.errors` for error array
- **Fix:** Updated all error handling to use result.error.issues.forEach
- **Files modified:** `src/services/project.service.ts`
- **Commit:** ca08428

**3. [Rule 3 - Blocking] Fixed ProjectRepository optional field handling**
- **Found during:** Task 1 test execution
- **Issue:** better-sqlite3 requires all named parameters, but description is optional
- **Fix:** Normalize description to null when undefined: `description: dto.description ?? null`
- **Files modified:** `src/repositories/project.repository.ts`
- **Commit:** ca08428

**4. [Rule 2 - Missing Critical] Updated CreateProjectDTO type**
- **Found during:** Task 1 TypeScript compilation
- **Issue:** Zod schema uses nullable() which infers `string | null | undefined`, but DTO only had `string | undefined`
- **Fix:** Updated CreateProjectDTO description to `string | null | undefined`
- **Files modified:** `src/types/task.ts`
- **Commit:** ca08428

**5. [Rule 1 - Bug] Fixed test tag order dependency**
- **Found during:** Task 2 test execution
- **Issue:** Test expected exact tag order, but GROUP_CONCAT doesn't guarantee order
- **Fix:** Changed test to verify tag presence (toContain) instead of exact order (toEqual)
- **Files modified:** `src/services/__tests__/task.service.test.ts`
- **Commit:** 5155ef4

## Verification Results

All verification criteria met:

1. **TypeScript compilation:** `npx tsc --noEmit` passes without errors
2. **All tests pass:** 91 tests total across 5 test files
   - Database tests: 9 tests
   - ProjectRepository tests: 7 tests
   - TaskRepository tests: 20 tests
   - ProjectService tests: 11 tests
   - TaskService tests: 44 tests
3. **Status lifecycle:** 14 transition tests covering every valid and invalid transition
4. **Zod validation:** All schemas reject invalid input with descriptive field errors
5. **Error types:** ValidationError, BusinessError, NotFoundError all work correctly
6. **createApp:** Initializes database, runs migrations, returns working services
7. **Full stack integration:** createTask → getTask → updateTask → listTasks → deleteTask all work
8. **FTS5 search:** Finds tasks by title and description keywords through service layer
9. **All 7 filter types:** status, project_id, assignee, tags, due_before, due_after, search

## Impact

This plan completes the foundation phase by providing the service layer that all future interfaces will use:

- **Provides:** Service layer, validation layer, business logic layer, application entry point
- **Enables:** Phase 2 (REST API), Phase 3 (CLI), Phase 4 (MCP) to build on this service layer
- **Guarantees:** All business logic and validation is centralized, consistent across all interfaces

**Requirements satisfied:**
- TASK-01 (Create): ✅ createTask validates and creates with all fields
- TASK-02 (Read): ✅ getTask, listTasks with 7 filter types
- TASK-03 (Update): ✅ updateTask with validation
- TASK-04 (Delete): ✅ deleteTask with existence check
- TASK-05 (Status): ✅ Status lifecycle enforced via VALID_STATUS_TRANSITIONS
- TASK-06 (Tags): ✅ Tags managed atomically in create and update
- ORG-01 (Create): ✅ createProject validates and creates
- ORG-02 (Read): ✅ getProject, listProjects
- ORG-03 (Update): ✅ updateProject with uniqueness check
- ORG-04 (Delete): ✅ deleteProject with verification
- ASGN-01 (Assign): ✅ Assignee field validated and stored
- ASGN-02 (Filter): ✅ Filter by assignee works
- INFRA-01 (Search): ✅ FTS5 search through service layer
- INFRA-02 (Filter): ✅ All 7 filter types validated and working

## Next Steps

Phase 01 (Foundation) is now complete. Phase 02 will build the REST API on top of this service layer, exposing all operations via HTTP endpoints with Express.

## Self-Check: PASSED

All files created and commits verified:

**Files verified:**
- src/schemas/task.schema.ts ✅
- src/services/errors.ts ✅
- src/services/project.service.ts ✅
- src/services/task.service.ts ✅
- src/services/__tests__/project.service.test.ts ✅
- src/services/__tests__/task.service.test.ts ✅
- src/index.ts (modified) ✅
- src/types/task.ts (modified) ✅
- src/repositories/project.repository.ts (modified) ✅

**Commits verified:**
- ca08428 (Task 1: Zod schemas, custom errors, and ProjectService) ✅
- 5155ef4 (Task 2: TaskService with status lifecycle and createApp) ✅
