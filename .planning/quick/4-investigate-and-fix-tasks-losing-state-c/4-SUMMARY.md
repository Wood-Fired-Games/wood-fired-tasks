---
phase: quick
plan: 4
type: execute
subsystem: workflow-automation
tags: [bugfix, claim-release, regression-tests, data-integrity]
completed: 2026-02-15T00:26:51Z
duration: 150s

dependency_graph:
  requires: []
  provides:
    - Status-aware stale claim release
    - Regression test coverage for done/closed task immunity
  affects:
    - ClaimReleaseService
    - Stale claim sweep behavior

tech_stack:
  added: []
  patterns:
    - Defense-in-depth status guards in SQL WHERE clauses
    - Regression testing for data integrity bugs

key_files:
  created: []
  modified:
    - src/services/claim-release.service.ts
    - src/services/__tests__/claim-release.test.ts
    - src/services/__tests__/workflow-engine.test.ts

decisions: []

metrics:
  tasks_completed: 2
  tests_added: 5
  tests_total: 518
  commits: 2
---

# Quick Task 4: Fix Tasks Losing State

**One-liner:** Fixed stale claim sweep to only release in_progress tasks, preventing completed tasks from reverting to open status.

## Problem

The ClaimReleaseService was reverting completed (done) and closed tasks back to open status during stale claim sweeps. When a task was claimed (setting assignee + claimed_at), then completed, the sweep would eventually reset it to open if the claim data exceeded the timeout threshold.

Root cause: Both `findStaleClaims()` and `releaseClaim()` SQL queries lacked status filters, allowing any task with non-null assignee/claimed_at to be swept, regardless of current status.

## Solution

Added `AND status = 'in_progress'` guards to both SQL queries:

1. **findStaleClaims()**: Only returns tasks actually in `in_progress` status with stale claims
2. **releaseClaim()**: Defense-in-depth guard refusing to modify non-in_progress tasks

This ensures only legitimately stale work-in-progress tasks are released. Tasks that have moved to done, closed, blocked, or back to open are immune to the sweep mechanism.

## Implementation Details

### Task 1: Fix ClaimReleaseService SQL queries

**Changes:**
- Line 31: Added `AND status = 'in_progress'` to findStaleClaims WHERE clause
- Line 46: Added `AND status = 'in_progress'` to releaseClaim WHERE clause

**Verification:** All 10 existing claim-release tests pass without modification (createClaimedTask helper already creates in_progress tasks).

**Commit:** e1ac843

### Task 2: Add regression tests

Added 5 new regression tests proving the fix:

**claim-release.test.ts (4 tests):**
1. findStaleClaims does NOT return done tasks with stale claims
2. findStaleClaims does NOT return closed tasks with stale claims
3. releaseClaim returns false for done tasks (defense-in-depth guard)
4. sweep does NOT release done tasks in mixed-status scenario

**workflow-engine.test.ts (1 test):**
5. Full lifecycle: claimed -> completed via workflow -> sweep runs -> task stays done

**Verification:** All 518 tests pass (513 existing + 5 new).

**Commit:** dd9dde0

## Deviations from Plan

None - plan executed exactly as written.

## Verification Results

1. Full test suite: 518/518 passing (513 existing + 5 new regression tests)
2. Manual SQL inspection: Both queries include `status = 'in_progress'` guard
3. Grep for status-changing code: Only ClaimReleaseService sets status='open', now with proper guard
4. No other code paths identified that could revert done tasks to open

## Self-Check: PASSED

**Created files:** None (tests added to existing files)

**Modified files:**
- /home/stuart/wood-fired-bugs/src/services/claim-release.service.ts - FOUND
- /home/stuart/wood-fired-bugs/src/services/__tests__/claim-release.test.ts - FOUND
- /home/stuart/wood-fired-bugs/src/services/__tests__/workflow-engine.test.ts - FOUND

**Commits:**
- e1ac843 - FOUND
- dd9dde0 - FOUND

## Impact

**Before:** Completed tasks could be reverted to open status 30 minutes after completion, destroying user work and creating data integrity issues.

**After:** Only in_progress tasks with genuine stale claims are released. Completed work is protected by status-aware filtering.

**Risk:** Low - change is purely additive (adds filters), all existing tests pass, 5 new regression tests prevent future regressions.

## Success Criteria: MET

- [x] ClaimReleaseService.findStaleClaims() SQL includes AND status = 'in_progress'
- [x] ClaimReleaseService.releaseClaim() SQL includes AND status = 'in_progress'
- [x] 5 new regression tests cover done, closed, and mixed-status sweep scenarios
- [x] Full test suite passes with zero regressions (518/518)
- [x] No other code paths identified that could revert done tasks to open
