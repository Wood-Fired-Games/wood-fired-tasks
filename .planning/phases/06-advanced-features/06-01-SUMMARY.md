---
phase: 06-advanced-features
plan: 01
subsystem: core-domain
tags: [database, relationships, graph-algorithms, validation]
dependency-graph:
  requires:
    - 01-foundation (database, migrations, types)
    - 02-rest-api (services, repositories)
  provides:
    - task-hierarchy (parent_task_id, subtasks)
    - dependency-tracking (task_dependencies table, cycle detection)
    - graph-validation (CycleDetector with DFS)
  affects:
    - Task creation (parent_task_id validation)
    - Task deletion (CASCADE to children and dependencies)
    - App initialization (DependencyService export)
tech-stack:
  added:
    - CycleDetector utility (DFS-based cycle detection)
    - DependencyRepository (CRUD for task_dependencies)
    - DependencyService (business logic with cycle validation)
  patterns:
    - Graph algorithms (DFS with recursion stack for back-edge detection)
    - Adjacency list representation for directed graphs
    - Transaction-based schema migrations
    - Cross-project validation (parent task must be in same project)
key-files:
  created:
    - src/db/migrations/002-task-hierarchy-and-dependencies.ts
    - src/utils/cycle-detector.ts
    - src/repositories/dependency.repository.ts
    - src/services/dependency.service.ts
    - src/schemas/dependency.schema.ts
    - src/utils/__tests__/cycle-detector.test.ts
    - src/repositories/__tests__/dependency.repository.test.ts
    - src/services/__tests__/dependency.service.test.ts
  modified:
    - src/types/task.ts (added parent_task_id, Dependency, CreateDependencyDTO)
    - src/repositories/task.repository.ts (parent_task_id support, findChildren)
    - src/repositories/interfaces.ts (IDependencyRepository, findChildren)
    - src/services/task.service.ts (getSubtasks, parent validation)
    - src/schemas/task.schema.ts (parent_task_id in schemas)
    - src/index.ts (DependencyService export)
    - src/services/__tests__/task.service.test.ts (6 new tests)
decisions:
  - Used SQLite DROP COLUMN in migration down() (safe in better-sqlite3 12.x with SQLite 3.46+)
  - Self-dependency rejection enforced at both DB (CHECK constraint) and validation (Zod refine)
  - CASCADE delete from tasks to task_dependencies (automatic cleanup)
  - CASCADE delete from parent task to child tasks (hierarchy cleanup)
  - CycleDetector rebuilds full graph on each check (acceptable for current scale, can optimize later)
  - Parent task must exist in same project (cross-project hierarchies not allowed)
metrics:
  duration: 7 minutes
  tasks-completed: 2
  files-created: 8
  files-modified: 6
  tests-added: 35 (10 CycleDetector + 15 DependencyRepository + 13 DependencyService + 6 TaskService)
  total-tests: 389 (all passing)
  commits: 2
completed: 2026-02-13
---

# Phase 06 Plan 01: Task Hierarchy and Dependency Tracking Summary

**One-liner:** Parent/child task relationships and dependency graphs with DFS-based cycle detection preventing circular chains.

## What Was Built

### Database Schema
- Added `parent_task_id` column to tasks table (self-referencing FK with CASCADE delete)
- Created `task_dependencies` junction table with UNIQUE and CHECK constraints
- Added indexes for efficient parent/child and dependency lookups

### Core Utilities
- **CycleDetector**: DFS-based cycle detection for directed graphs
  - Adjacency list representation using Map<number, Set<number>>
  - Temporary edge insertion for "would create cycle" checks
  - Recursion stack tracking for back-edge detection
  - Handles disconnected components correctly

### Repositories
- **DependencyRepository**: CRUD operations for task_dependencies table
  - create, findAll, findByTaskId, findBlockingTask
  - delete (specific dependency), deleteByTaskId (cleanup helper)
  - Prepared statements for all queries
- **TaskRepository extensions**:
  - parent_task_id support in create/update
  - findChildren method for subtask queries

### Services
- **DependencyService**: Business logic for dependency management
  - addDependency with full cycle detection (prevents A->B->C->A chains)
  - removeDependency with NotFoundError on missing dependency
  - getBlockedBy / getBlockers for dependency queries
  - Task existence validation before dependency creation
- **TaskService extensions**:
  - getSubtasks returns children of a parent task
  - parent_task_id validation (must exist, must be in same project)

### Validation
- **CreateDependencySchema**: Zod validation with self-dependency refine
- **Task schemas updated**: parent_task_id added to create/update schemas

## Test Coverage

### CycleDetector (10 tests)
- Empty graph, linear chains, diamond graphs
- Self-references, immediate two-node cycles
- Transitive cycles (A->B->C->A)
- Disconnected components
- Multiple edges from same node (fan-out)

### DependencyRepository (15 tests)
- Create, UNIQUE constraint, CHECK constraint (self-dependency)
- findByTaskId, findBlockingTask
- Delete specific dependency, CASCADE delete behavior
- deleteByTaskId cleanup

### DependencyService (13 tests)
- Successful dependency creation
- NotFoundError for missing tasks
- ValidationError for invalid input and self-dependencies
- BusinessError for circular dependencies (direct and transitive)
- getBlockedBy, getBlockers, removeDependency

### TaskService (6 new tests)
- Create with valid parent_task_id
- Reject nonexistent parent, reject cross-project parent
- getSubtasks returns children, empty array for no children
- NotFoundError for missing task

**Total: 35 new tests, 389 total tests (all passing)**

## Deviations from Plan

None - plan executed exactly as written.

## Decisions Made

1. **SQLite DROP COLUMN**: Used in migration down() since better-sqlite3 12.x bundles SQLite 3.46+ (supports DROP COLUMN natively)
2. **Double self-dependency enforcement**: CHECK constraint at DB level + Zod refine at validation level (belt-and-suspenders)
3. **CASCADE deletes**: Both parent->children and task->dependencies CASCADE automatically
4. **CycleDetector rebuilds graph**: Loads all dependencies on each check (acceptable for current scale, can optimize with incremental updates if needed)
5. **Same-project constraint**: Parent task must be in same project as child (prevents cross-project hierarchies)

## Traceability

### Requirements Addressed
- **REL-01**: Task hierarchy via parent_task_id (self-referencing FK)
- **REL-02**: Dependency tracking via task_dependencies table
- **REL-03**: Cycle detection prevents circular dependency chains

### Must-Have Truths (All Satisfied)
- Task can have parent_task_id, querying parent returns children ✓
- Task can be marked as blocking another task ✓
- Circular dependencies detected and rejected with BusinessError ✓
- Self-dependencies rejected at DB and application level ✓
- Deleting parent cascades to children ✓
- Deleting task cascades to dependency records ✓

### Artifacts (All Present)
- Migration 002 with parent_task_id and task_dependencies ✓
- CycleDetector exported from src/utils/cycle-detector.ts ✓
- DependencyRepository exported from src/repositories/dependency.repository.ts ✓
- DependencyService exported from src/services/dependency.service.ts ✓
- CreateDependencySchema exported from src/schemas/dependency.schema.ts ✓

### Key Links (All Verified)
- DependencyService -> CycleDetector (new CycleDetector) ✓
- DependencyService -> DependencyRepository (findAll + create) ✓
- TaskRepository -> tasks.parent_task_id (SELECT/INSERT) ✓

## Performance Notes

- CycleDetector O(V + E) complexity where V = tasks, E = dependencies
- Current implementation rebuilds graph on each check (O(E) load time)
- For large graphs (>10k dependencies), consider incremental graph updates
- All queries use indexed columns (parent_task_id, task_id, blocks_task_id)

## Self-Check: PASSED

### Files Created (all present)
- src/db/migrations/002-task-hierarchy-and-dependencies.ts ✓
- src/utils/cycle-detector.ts ✓
- src/repositories/dependency.repository.ts ✓
- src/services/dependency.service.ts ✓
- src/schemas/dependency.schema.ts ✓
- src/utils/__tests__/cycle-detector.test.ts ✓
- src/repositories/__tests__/dependency.repository.test.ts ✓
- src/services/__tests__/dependency.service.test.ts ✓

### Commits (all present)
- 87ada20: feat(06-01): add task hierarchy and dependency infrastructure ✓
- e7c06cd: feat(06-01): add dependency service and task hierarchy support ✓

### Tests
- npx vitest run: 389 tests passing ✓
- Migration runs successfully on fresh DB ✓
