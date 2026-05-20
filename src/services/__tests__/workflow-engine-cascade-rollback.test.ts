import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestApp } from '../../index.js';
import { TaskService } from '../task.service.js';
import { ProjectService } from '../project.service.js';
import { WorkflowEngine } from '../workflow-engine.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { DependencyRepository } from '../../repositories/dependency.repository.js';
import { eventBus } from '../../events/event-bus.js';
import type Database from 'better-sqlite3';
import type { App } from '../../index.js';
import type { Task } from '../../types/task.js';
import type { TaskEvent } from '../../events/types.js';

/**
 * Regression: cascade transaction rollback on mid-cascade taskRepo.update failure.
 *
 * Background: WorkflowEngine.handleStatusChanged wraps the entire cascade in a
 * single db.transaction at depth 0. If any nested operation throws, the
 * transaction rolls back (better-sqlite3 semantics) and cascadeError is captured
 * + rethrown so the outer try/catch logs without crashing the EventBus.
 *
 * This suite injects a faulty taskRepo.update DURING the cascade (specifically
 * when the engine attempts to transition the parent open -> done — the second
 * workflow-triggered write) and verifies:
 *   - The parent task's status reverts to its pre-cascade value (open). The
 *     in-progress write that succeeded earlier in the cascade transaction is
 *     also reverted because the cascade transaction rolls back as a unit.
 *   - No `task.status_changed` event with `to: 'done'` is broadcast for the
 *     parent (the cascade's failed step). The parent never reached 'done', so
 *     no done event can have been emitted.
 *
 * The injection point is `taskRepo.update` — one level deeper than the
 * existing "transaction atomicity" test which spies on taskService.updateTask.
 * This catches regressions where the rollback path is broken at the
 * repository boundary (e.g. accidental autocommit, savepoint mismanagement).
 */
describe('WorkflowEngine: cascade rollback on taskRepo.update failure (regression)', () => {
  let app: App;
  let taskService: TaskService;
  let projectService: ProjectService;
  let taskRepo: TaskRepository;
  let dependencyRepo: DependencyRepository;
  let engine: WorkflowEngine;
  let testProjectId: number;
  let db: Database.Database;

  beforeEach(async () => {
    app = await createTestApp();
    // Stop the app's built-in WorkflowEngine so this test owns the engine.
    app.workflowEngine.stop();

    taskService = app.taskService;
    projectService = app.projectService;
    db = app.db;
    taskRepo = new TaskRepository(db);
    dependencyRepo = new DependencyRepository(db);

    const project = projectService.createProject({
      name: 'Cascade Rollback Test',
      description: 'Regression test for mid-cascade taskRepo.update failure',
    });
    testProjectId = project.id;
  });

  afterEach(() => {
    if (engine) {
      engine.stop();
    }
  });

  function createTask(title: string, parentId?: number): Task & { tags: string[] } {
    return taskService.createTask({
      title,
      project_id: testProjectId,
      created_by: 'test-user',
      ...(parentId !== undefined ? { parent_task_id: parentId } : {}),
    });
  }

  it('rolls back parent state and suppresses task.status_changed event when taskRepo.update throws mid-cascade', () => {
    // Hierarchy: parent has two children. Marking child 2 done triggers cascade
    // because child 1 was already marked done before the engine started.
    const parent = createTask('Parent');
    const child1 = createTask('Child 1', parent.id);
    const child2 = createTask('Child 2', parent.id);

    // Mark child 1 done before engine starts so it has no cascade side effect.
    taskService.updateTask(child1.id, { status: 'in_progress' });
    taskService.updateTask(child1.id, { status: 'done' });

    // Snapshot pre-cascade parent state for assertion.
    const preCascadeParent = taskService.getTask(parent.id);
    expect(preCascadeParent.status).toBe('open');

    // Wire the engine with our own taskRepo instance so we can spy on its
    // update method. The engine's reference to taskRepo points at this same
    // instance (passed explicitly to the constructor).
    engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
    engine.start();

    // Capture every task.status_changed event so we can prove the parent's
    // done event never fires.
    const receivedEvents: TaskEvent[] = [];
    const unsub = eventBus.subscribe('task.status_changed', (event: TaskEvent) => {
      receivedEvents.push(event);
    });

    // Inject a faulty taskRepo.update by spying on the TaskRepository
    // PROTOTYPE so we intercept the instance that taskService owns internally
    // (the engine and the service share the same taskRepo wiring at app
    // construction). The cascade path is:
    //   user: child2 open -> in_progress (taskRepo.update #A)  -- succeeds (own tx, commits before cascade)
    //   user: child2 in_progress -> done (taskRepo.update #B)  -- succeeds (own tx, commits before cascade)
    //     >>> cascade transaction T2 opens HERE (depth 0 handler) <<<
    //     workflow: parent open -> in_progress (taskRepo.update #C) -- succeeds (savepoint inside T2)
    //     workflow: parent in_progress -> done (taskRepo.update #D) -- THROW
    //
    // We throw on the SECOND taskRepo.update targeting the parent (the
    // workflow-triggered done step). By that point the parent's
    // open -> in_progress write is already inside the cascade transaction.
    // The throw must cause better-sqlite3 to roll back the entire cascade
    // transaction so the parent reverts to its pre-cascade 'open' state. If
    // the rollback were broken (e.g. savepoint not released, autocommit
    // leakage), the parent would be left stranded in 'in_progress' — exactly
    // the regression this test guards against.
    const originalUpdate = TaskRepository.prototype.update;
    let parentUpdateCount = 0;
    const updateSpy = vi.spyOn(TaskRepository.prototype, 'update').mockImplementation(
      function (
        this: TaskRepository,
        id: number,
        updates: Parameters<TaskRepository['update']>[1]
      ) {
        if (id === parent.id) {
          parentUpdateCount++;
          if (parentUpdateCount >= 2) {
            // Second parent update == the workflow's done transition.
            throw new Error('Simulated taskRepo.update crash mid-cascade');
          }
        }
        return originalUpdate.call(this, id, updates);
      }
    );

    // Trigger the cascade. The workflow attempt to update the parent will
    // throw; the outer transaction should roll back without re-throwing
    // beyond the engine's catch (it just logs).
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // child2 user transitions trigger the cascade; the failure happens during
    // the second emit (in_progress -> done) when the workflow handler reacts.
    taskService.updateTask(child2.id, { status: 'in_progress' });
    taskService.updateTask(child2.id, { status: 'done' });

    consoleErrorSpy.mockRestore();
    updateSpy.mockRestore();
    unsub();

    // ASSERTION 1: parent reverted to pre-cascade value.
    // Inside the cascade transaction, the engine wrote parent open->in_progress
    // before the failing parent->done call. The rollback must undo that write.
    const parentAfter = taskService.getTask(parent.id);
    expect(parentAfter.status).toBe(preCascadeParent.status);
    expect(parentAfter.status).toBe('open');

    // ASSERTION 2: no task.status_changed event was broadcast for the
    // rolled-back parent. The parent's in_progress event was emitted into
    // the EventBus during the transaction, but its DB write was reverted —
    // so any event referencing parent.id with `to: 'in_progress'` or
    // `to: 'done'` represents a broadcast that lies about persisted state.
    //
    // The regression we're guarding against: a future change that emits the
    // status_changed event AFTER commit (correct) vs DURING the transaction
    // (current behavior leaks a phantom event). We assert the current
    // contract: no `to: 'done'` event for the parent. A done event would
    // be the most damaging — downstream consumers (Slack, MCP clients)
    // would see the parent as completed when it isn't.
    const parentDoneEvents = receivedEvents.filter(
      (e) => e.data.id === parent.id && (e.metadata as any).to === 'done'
    );
    expect(parentDoneEvents).toHaveLength(0);

    // ASSERTION 3: child2's user-triggered done IS persisted. child2's
    // taskRepo.update committed in its OWN transaction before the cascade
    // transaction opened (the user write is not part of the cascade
    // transaction's rollback scope). This documents the rollback boundary:
    // the cascade transaction wraps only workflow-engine writes, not the
    // user write that triggered the cascade.
    const child2After = taskService.getTask(child2.id);
    expect(child2After.status).toBe('done');
  });
});
