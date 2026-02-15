---
phase: 4-investigate-and-fix-tasks-losing-state
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/services/claim-release.service.ts
  - src/services/__tests__/claim-release.test.ts
  - src/services/__tests__/workflow-engine.test.ts
autonomous: true

must_haves:
  truths:
    - "A task marked as done never reverts to open due to stale claim sweep"
    - "A task marked as closed never reverts to open due to stale claim sweep"
    - "Only in_progress tasks with stale claims are released back to open"
    - "All 513+ existing tests continue to pass"
  artifacts:
    - path: "src/services/claim-release.service.ts"
      provides: "Status-aware stale claim release"
      contains: "status.*in_progress"
    - path: "src/services/__tests__/claim-release.test.ts"
      provides: "Regression tests for done/closed tasks not being swept"
  key_links:
    - from: "src/services/claim-release.service.ts"
      to: "tasks table"
      via: "SQL WHERE clause"
      pattern: "status.*=.*'in_progress'"
---

<objective>
Fix tasks losing state -- completed tasks reverting to open after stale claim sweep.

Purpose: The ClaimReleaseService sweeps stale claims every 5 minutes, but its SQL queries have no
status filter. When a claimed task (in_progress) is completed (done), the assignee and claimed_at
fields persist. After the timeout (30 min), the sweep resets done/closed tasks back to open,
destroying user work.

Root cause: Two bugs in claim-release.service.ts:
1. findStaleClaims() selects ANY task with non-null assignee/claimed_at past timeout, regardless of status
2. releaseClaim() unconditionally sets status='open' without checking current status

Fix: Add `AND status = 'in_progress'` guard to both queries so only actually-stale in-progress
tasks are released. Tasks in done/closed/blocked states are never touched by the sweep.

Output: Fixed service + regression tests proving done/closed tasks are immune to sweep.
</objective>

<execution_context>
@/home/stuart/.claude/get-shit-done/workflows/execute-plan.md
@/home/stuart/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/services/claim-release.service.ts
@src/services/__tests__/claim-release.test.ts
@src/types/task.ts
@src/repositories/task.repository.ts (claimTask method -- sets in_progress + assignee + claimed_at)
@src/services/task.service.ts (updateTask -- does NOT clear assignee/claimed_at on status change)
</context>

<tasks>

<task type="auto">
  <name>Task 1: Fix ClaimReleaseService to only sweep in_progress tasks</name>
  <files>src/services/claim-release.service.ts</files>
  <action>
Two SQL changes in claim-release.service.ts:

1. In findStaleClaims() (line 28), add status filter to the WHERE clause:
   Change the query to:
   ```sql
   SELECT id, assignee, claimed_at FROM tasks
   WHERE assignee IS NOT NULL
     AND claimed_at IS NOT NULL
     AND status = 'in_progress'
     AND claimed_at <= datetime('now', ?)
     AND updated_at <= datetime('now', ?)
   ```
   This ensures only in_progress tasks are candidates for stale claim release.
   Tasks that have been completed (done), closed, blocked, or reopened (open) are never swept.

2. In releaseClaim() (line 41), add a status guard to the UPDATE WHERE clause:
   Change the query to:
   ```sql
   UPDATE tasks
   SET assignee = NULL, status = 'open', claimed_at = NULL,
       version = version + 1, updated_at = datetime('now')
   WHERE id = ? AND assignee IS NOT NULL AND status = 'in_progress'
   ```
   This is a defense-in-depth guard. Even if findStaleClaims somehow returns a non-in_progress
   task, releaseClaim will refuse to modify it. The return value (info.changes > 0) naturally
   reflects whether the release actually happened.

Do NOT change: the sweep() method, start/stop lifecycle, timeout logic, event emission.
These are all correct as-is.
  </action>
  <verify>
Run: `npx vitest run src/services/__tests__/claim-release.test.ts`
All existing tests pass. The existing test for releaseClaim creates tasks with status 'in_progress'
(see createClaimedTask helper), so they will match the new status filter.
  </verify>
  <done>
findStaleClaims() only returns in_progress tasks. releaseClaim() only modifies in_progress tasks.
All existing claim-release tests pass without modification.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add regression tests proving done/closed tasks are immune to sweep</name>
  <files>src/services/__tests__/claim-release.test.ts, src/services/__tests__/workflow-engine.test.ts</files>
  <action>
Add regression tests to claim-release.test.ts:

1. In the `findStaleClaims` describe block, add:
   ```
   it('does NOT return done tasks even if claimed_at is stale', () => {
     // Create a task that was claimed 40 min ago, then completed (done)
     // but assignee/claimed_at were NOT cleared (the real-world scenario)
     db.prepare(
       `INSERT INTO tasks (
         title, status, priority, project_id, assignee, created_by,
         claimed_at, created_at, updated_at, version
       ) VALUES (
         'Completed Task', 'done', 'medium', ?, 'agent-1', 'creator',
         datetime('now', '-40 minutes'), datetime('now', '-60 minutes'),
         datetime('now', '-35 minutes'), 3
       )`
     ).run(projectId);

     const stale = service.findStaleClaims();
     expect(stale).toEqual([]);
   });
   ```

2. Add similar test for 'closed' status:
   ```
   it('does NOT return closed tasks even if claimed_at is stale', () => {
     db.prepare(
       `INSERT INTO tasks (
         title, status, priority, project_id, assignee, created_by,
         claimed_at, created_at, updated_at, version
       ) VALUES (
         'Closed Task', 'closed', 'medium', ?, 'agent-1', 'creator',
         datetime('now', '-40 minutes'), datetime('now', '-60 minutes'),
         datetime('now', '-35 minutes'), 4
       )`
     ).run(projectId);

     const stale = service.findStaleClaims();
     expect(stale).toEqual([]);
   });
   ```

3. In the `releaseClaim` describe block, add:
   ```
   it('returns false for done tasks (defense-in-depth status guard)', () => {
     db.prepare(
       `INSERT INTO tasks (
         title, status, priority, project_id, assignee, created_by,
         claimed_at, created_at, updated_at, version
       ) VALUES (
         'Done Task', 'done', 'medium', ?, 'agent-1', 'creator',
         datetime('now', '-40 minutes'), datetime('now', '-60 minutes'),
         datetime('now', '-35 minutes'), 3
       )`
     ).run(projectId);

     const released = service.releaseClaim(1);
     expect(released).toBe(false);

     // Verify status was NOT changed
     const task = db.prepare('SELECT status FROM tasks WHERE id = 1').get() as any;
     expect(task.status).toBe('done');
   });
   ```

4. In the `sweep` describe block, add an integration-style test:
   ```
   it('does NOT release done tasks during sweep (end-to-end regression)', () => {
     // Mix of stale in_progress (should release) and stale done (should NOT release)
     createClaimedTask({ title: 'Stale In Progress', claimedMinutesAgo: 35, assignee: 'agent-1' });

     // Manually create a done task with stale claim data
     db.prepare(
       `INSERT INTO tasks (
         title, status, priority, project_id, assignee, created_by,
         claimed_at, created_at, updated_at, version
       ) VALUES (
         'Stale But Done', 'done', 'medium', ?, 'agent-2', 'creator',
         datetime('now', '-40 minutes'), datetime('now', '-60 minutes'),
         datetime('now', '-35 minutes'), 3
       )`
     ).run(projectId);

     const released = service.sweep();
     expect(released).toBe(1); // Only the in_progress task

     // Verify done task was NOT touched
     const doneTask = db.prepare('SELECT * FROM tasks WHERE title = ?').get('Stale But Done') as any;
     expect(doneTask.status).toBe('done');
     expect(doneTask.assignee).toBe('agent-2');
   });
   ```

5. Add one regression test in workflow-engine.test.ts to confirm the full lifecycle:
   In the existing describe block, add a new test at the end:
   ```
   describe('regression: completed tasks immune to stale claim sweep', () => {
     it('task completed via workflow auto-complete is not reverted by claim release', () => {
       // This tests the full lifecycle:
       // 1. Agent claims task (in_progress + assignee + claimed_at)
       // 2. Agent completes task (done, but assignee/claimed_at persist)
       // 3. Stale claim sweep runs but should NOT touch done task

       const { ClaimReleaseService } = require('../claim-release.service.js');

       const parent = createTask('Parent Task');
       const child = createTask('Child Task', parent.id);

       engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
       engine.start();

       // Simulate agent claiming child task
       taskService.claimTask(child.id, 'test-agent');

       // Agent marks child done (triggers parent auto-complete)
       taskService.updateTask(child.id, { status: 'done' });

       expect(taskService.getTask(child.id).status).toBe('done');
       expect(taskService.getTask(parent.id).status).toBe('done');

       // Now simulate stale claim sweep (with 0 minute timeout so everything is "stale")
       const claimService = new ClaimReleaseService(db, 0);
       const released = claimService.sweep();

       // Nothing should be released -- both tasks are done
       expect(released).toBe(0);
       expect(taskService.getTask(child.id).status).toBe('done');
       expect(taskService.getTask(parent.id).status).toBe('done');
     });
   });
   ```
   Note: Use dynamic import if the test file uses ESM. Check the existing import style.
   The test file already imports from relative paths with .js extensions (ESM style).
   Add the import at the top with the other imports:
   `import { ClaimReleaseService } from '../claim-release.service.js';`
  </action>
  <verify>
Run: `npx vitest run src/services/__tests__/claim-release.test.ts src/services/__tests__/workflow-engine.test.ts`
All new regression tests pass. All existing tests still pass.

Then run full test suite: `npx vitest run`
All 513+ tests pass with no regressions.
  </verify>
  <done>
6 new regression tests prove:
- findStaleClaims skips done and closed tasks
- releaseClaim refuses to modify done tasks
- sweep only releases in_progress tasks, leaving done tasks untouched
- Full lifecycle: claimed -> completed -> sweep = no state loss
Full test suite passes with zero regressions.
  </done>
</task>

</tasks>

<verification>
1. `npx vitest run` -- all tests pass (513+ existing + 6 new)
2. Manual spot check: read the SQL in claim-release.service.ts and confirm both queries include `status = 'in_progress'`
3. Verify no other code path resets done/closed tasks to open by searching for `status = 'open'` or `status.*open` in the codebase
</verification>

<success_criteria>
- ClaimReleaseService.findStaleClaims() SQL includes AND status = 'in_progress'
- ClaimReleaseService.releaseClaim() SQL includes AND status = 'in_progress'
- 6 new regression tests cover done, closed, and mixed-status sweep scenarios
- Full test suite passes with zero regressions
- No other code paths identified that could revert done tasks to open
</success_criteria>

<output>
After completion, create `.planning/quick/4-investigate-and-fix-tasks-losing-state-c/4-SUMMARY.md`
</output>
