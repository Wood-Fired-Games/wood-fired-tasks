---
phase: 14-sse-event-infrastructure
plan: 02
subsystem: services
tags: [event-emission, domain-events, integration, eventbus]
dependency_graph:
  requires:
    - Phase 14 Plan 01 (EventBus implementation)
  provides:
    - Event emissions from TaskService CRUD operations
    - Event emissions from ProjectService CRUD operations
    - Full entity snapshots in event payloads (prevents 404 race conditions)
  affects:
    - SSE consumers will receive events for all task/project CRUD operations
    - Phase 16 workflow triggers can subscribe to domain events
tech_stack:
  added: []
  patterns:
    - Emit AFTER successful database operations (transaction committed)
    - Emit BEFORE deletion (consumers can query related entities)
    - Status change emits both task.updated AND task.status_changed
    - Full entity snapshot in payload (addresses Pitfall #4)
key_files:
  created: []
  modified:
    - src/services/task.service.ts
    - src/services/project.service.ts
    - src/services/__tests__/task.service.test.ts
    - src/services/__tests__/project.service.test.ts
    - src/events/sse-manager.ts (deviation: fixed API bug)
    - src/api/server.ts (deviation: fixed plugin registration)
decisions:
  - decision: Emit events AFTER repository operations return
    rationale: SQLite transactions are synchronous in better-sqlite3. Repository call success means transaction committed. No race condition possible.
  - decision: Emit task.deleted BEFORE repository delete call
    rationale: Allows SSE consumers to query related entities before row removal. Prevents 404s on cascade queries.
  - decision: Emit both task.updated and task.status_changed when status changes
    rationale: Enables filtering - some consumers want all updates, others only status changes.
  - decision: Include full entity snapshot with tags in event payload
    rationale: Addresses Pitfall #4 - prevents race condition where SSE consumer receives event then queries API before commit visible.
metrics:
  duration_seconds: 399
  completed_at: "2026-02-14T15:28:23Z"
  tasks_completed: 2
  commits: 3
  files_modified: 6
  tests_added: 17
  tests_passing: 102
---

# Phase 14 Plan 02: Service Integration Summary

**One-liner:** TaskService and ProjectService emit typed domain events after successful CRUD operations with full entity snapshots to prevent race conditions.

## Objective Achieved

Integrated EventBus into domain services to emit events AFTER successful database operations. Services now broadcast task.created, task.updated, task.deleted, task.status_changed, project.created, project.updated, and project.deleted events. Event payloads include full entity snapshots (with tags for tasks) to prevent 404 race conditions when SSE consumers query API immediately after receiving events (addresses Pitfall #4 from v1.3 research).

## Tasks Completed

### Task 1: Add event emissions to TaskService CRUD operations
- **Status:** Complete
- **Commit:** 8fbc9cf
- **Output:** TaskService emits 4 event types, 9 new tests, 60 total tests passing

Implemented event emissions:
- task.created: Emitted AFTER taskRepo.create() returns
- task.updated: Emitted AFTER taskRepo.update() returns
- task.status_changed: Emitted AFTER taskRepo.update() when status changes (includes from/to metadata)
- task.deleted: Emitted BEFORE taskRepo.delete() so consumers can query related entities

Test coverage:
- Verified eventBus.emit called with correct event type and payload structure
- Verified emit called AFTER successful repository operations
- Verified emit NOT called when validation fails (ValidationError)
- Verified emit NOT called when business logic fails (BusinessError, NotFoundError)
- Verified status_changed only emitted when status actually changes
- Verified from/to metadata included in status_changed events

### Task 2: Add event emissions to ProjectService CRUD operations
- **Status:** Complete
- **Commit:** e32dab4
- **Output:** ProjectService emits 3 event types, 8 new tests, 19 total tests passing

Implemented event emissions:
- project.created: Emitted AFTER projectRepo.create() returns
- project.updated: Emitted AFTER projectRepo.update() returns
- project.deleted: Emitted BEFORE projectRepo.delete() so consumers can query related entities

Test coverage:
- Verified eventBus.emit called with correct ProjectEvent payload
- Verified emit NOT called when validation fails
- Verified emit NOT called when duplicate name exists
- Verified emit NOT called when project not found

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed @fastify/sse API usage for v0.4.0**
- **Found during:** TypeScript compilation verification (plan requirement: Zero TypeScript errors)
- **Issue:** sse-manager.ts from plan 14-03 was using `reply.sse()` but v0.4.0 API is `reply.sse.send()`
- **Fix:**
  - Updated sendEvent() to use reply.sse.send() with promise-based error handling
  - Updated startHeartbeat() to use reply.sse.send() for ping messages
  - Added type assertion for fastifySSE plugin registration (TypeScript overload resolution)
- **Files modified:** src/events/sse-manager.ts, src/api/server.ts
- **Commit:** b984807
- **Rationale:** TypeScript compilation was failing from plan 14-03 code. This was a blocking issue (Rule 3) preventing completion of plan 14-02 verification step which requires "Zero TypeScript errors". Simple API fix, no architectural changes needed.

## Verification Results

**Service tests:**
```
Test Files: 4 passed (4)
Tests: 102 passed (102)
```

Breakdown:
- TaskService: 60 tests (51 existing + 9 new event emission tests)
- ProjectService: 19 tests (11 existing + 8 new event emission tests)
- DependencyService: 13 tests (unchanged)
- CommentService: 10 tests (unchanged)

**TypeScript:**
- Zero compilation errors
- eventBus.emit appears in git diff for both service files
- Full type safety for event emissions

**Coverage:**
- All CRUD operations emit events after successful operations
- All error cases (validation, business logic, not found) verified to NOT emit events
- Status change double-emission (updated + status_changed) verified
- Event timing verified (AFTER operations for create/update, BEFORE for delete)

## Success Criteria Status

- [x] TaskService emits 4 event types (created, updated, deleted, status_changed)
- [x] ProjectService emits 3 event types (created, updated, deleted)
- [x] Events emitted AFTER successful database operations
- [x] Failed operations (validation errors, not found) do NOT emit events
- [x] Event payloads include full entity snapshots (addresses Pitfall #4)
- [x] Tests verify emission timing and payload structure
- [x] All existing tests pass (no regressions)
- [x] Zero TypeScript errors
- [x] task.claimed emission explicitly deferred to Phase 15 (documented but not implemented)

## Key Implementation Details

**Event Emission Pattern:**
```typescript
// Create: emit AFTER
const task = this.taskRepo.create(data);
eventBus.emit('task.created', {
  eventType: 'task.created',
  timestamp: new Date().toISOString(),
  data: task, // Full entity with tags
  metadata: { source: 'user' }
});
return task;

// Update: emit AFTER, conditional status_changed
const updatedTask = this.taskRepo.update(id, data);
eventBus.emit('task.updated', { ... });
if (statusChanged) {
  eventBus.emit('task.status_changed', {
    ...
    metadata: { source: 'user', from: oldStatus, to: newStatus }
  });
}
return updatedTask;

// Delete: emit BEFORE
const existing = this.taskRepo.findById(id);
eventBus.emit('task.deleted', { data: existing, ... });
this.taskRepo.delete(id);
```

**Why emit AFTER works for create/update:**
better-sqlite3 uses synchronous transactions. When repository method returns, transaction is committed. No async gap = no race condition.

**Why emit BEFORE for delete:**
Consumers receiving task.deleted can still query `/api/v1/tasks/:id/dependencies`, `/api/v1/tasks/:id/comments`, etc. before CASCADE delete removes related rows.

**Full entity snapshot:**
Prevents Pitfall #4 race condition:
1. Service creates task (commits to DB)
2. Service emits event with full task object
3. SSE consumer receives event
4. Consumer queries GET /api/v1/tasks/:id
5. If event only had task.id, WAL checkpoint delay could cause 404
6. Full snapshot in payload eliminates need for immediate API query

## Integration Points

**Phase 14:**
- Plan 03 (SSE Routes): EventBus → SSEManager wiring already in place (server.ts lines 78-85)
- SSEManager broadcasts these events to connected clients

**Phase 15:**
- task.claimed type defined but emission deferred
- Will emit from POST /api/v1/tasks/:id/claim endpoint

**Phase 16:**
- Workflow triggers will subscribe to task lifecycle events
- Automation can trigger on status_changed, created, etc.

## Next Steps

1. Phase 14 Plan 03: Create GET /api/v1/events endpoint for SSE streaming
2. Phase 14 Plan 04: Already complete (this plan WAS 14-04, became 14-02)
3. Phase 15: Implement atomic task claiming with task.claimed emission

## Self-Check: PASSED

**Files verified:**
- FOUND: src/services/task.service.ts (modified)
- FOUND: src/services/project.service.ts (modified)
- FOUND: src/services/__tests__/task.service.test.ts (17 new tests)
- FOUND: src/services/__tests__/project.service.test.ts (8 new tests)

**Commits verified:**
- FOUND: 8fbc9cf (feat: TaskService event emissions)
- FOUND: e32dab4 (feat: ProjectService event emissions)
- FOUND: b984807 (fix: SSE API bug from plan 14-03)

**Tests verified:**
- 102 tests passing (94 baseline + 8 EventBus from 14-01 = 102, includes 17 new service event tests)
- Zero TypeScript errors

**Deviations:**
- 1 bug fix (Rule 1): SSE API usage corrected for v0.4.0 compatibility
