import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestApp } from '../../index.js';
import { TaskService } from '../task.service.js';
import { DependencyService } from '../dependency.service.js';
import { ProjectService } from '../project.service.js';
import { WorkflowEngine } from '../workflow-engine.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { DependencyRepository } from '../../repositories/dependency.repository.js';
import { eventBus } from '../../events/event-bus.js';
import type Database from 'better-sqlite3';
import type { App } from '../../index.js';
import type { Task } from '../../types/task.js';
import type { TaskEvent } from '../../events/types.js';

describe('WorkflowEngine', () => {
  let app: App;
  let taskService: TaskService;
  let dependencyService: DependencyService;
  let projectService: ProjectService;
  let taskRepo: TaskRepository;
  let dependencyRepo: DependencyRepository;
  let engine: WorkflowEngine;
  let testProjectId: number;
  let db: Database.Database;

  beforeEach(async () => {
    app = await createTestApp();
    // Stop the app's built-in WorkflowEngine so tests can control their own
    app.workflowEngine.stop();

    taskService = app.taskService;
    dependencyService = app.dependencyService;
    projectService = app.projectService;
    db = app.db;
    taskRepo = new TaskRepository(db);
    dependencyRepo = new DependencyRepository(db);

    const project = projectService.createProject({
      name: 'Workflow Test Project',
      description: 'For testing workflow engine',
    });
    testProjectId = project.id;
  });

  afterEach(() => {
    if (engine) {
      engine.stop();
    }
  });

  /**
   * Helper: create a task with given title and optional parent
   */
  function createTask(title: string, parentId?: number): Task & { tags: string[] } {
    return taskService.createTask({
      title,
      project_id: testProjectId,
      created_by: 'test-user',
      ...(parentId !== undefined ? { parent_task_id: parentId } : {}),
    });
  }

  /**
   * Helper: move task to in_progress first (required before transitioning to done)
   * then mark as done
   */
  function markDone(taskId: number): void {
    const task = taskService.getTask(taskId);
    if (task.status === 'open') {
      taskService.updateTask(taskId, { status: 'in_progress' });
    }
    taskService.updateTask(taskId, { status: 'done' });
  }

  describe('parent auto-complete: all children done triggers parent done', () => {
    it('auto-completes parent when all 3 children reach done status', () => {
      const parent = createTask('Parent Task');
      const child1 = createTask('Child 1', parent.id);
      const child2 = createTask('Child 2', parent.id);
      const child3 = createTask('Child 3', parent.id);

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Mark child 1 done -- parent should NOT auto-complete yet
      markDone(child1.id);
      expect(taskService.getTask(parent.id).status).not.toBe('done');

      // Mark child 2 done -- parent should NOT auto-complete yet
      markDone(child2.id);
      expect(taskService.getTask(parent.id).status).not.toBe('done');

      // Mark child 3 done -- NOW parent should auto-complete
      markDone(child3.id);
      expect(taskService.getTask(parent.id).status).toBe('done');
    });
  });

  describe('parent auto-complete: mixed statuses do NOT trigger', () => {
    it('does not auto-complete parent when children have mixed statuses', () => {
      const parent = createTask('Parent Task');
      const child1 = createTask('Child 1', parent.id);
      const child2 = createTask('Child 2', parent.id);
      const child3 = createTask('Child 3', parent.id);

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Mark 2 children done
      markDone(child1.id);
      markDone(child2.id);

      // Leave child 3 as in_progress (not done)
      taskService.updateTask(child3.id, { status: 'in_progress' });

      // Parent should NOT be done
      expect(taskService.getTask(parent.id).status).not.toBe('done');
    });
  });

  describe('source attribution: workflow-triggered update has source: workflow', () => {
    it('emits task.status_changed with source workflow for auto-completed parent', () => {
      const receivedEvents: TaskEvent[] = [];
      const unsub = eventBus.subscribe('task.status_changed', (event: TaskEvent) => {
        receivedEvents.push(event);
      });

      const parent = createTask('Parent Task');
      const child1 = createTask('Child 1', parent.id);
      const child2 = createTask('Child 2', parent.id);

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Mark both children done to trigger parent auto-complete
      markDone(child1.id);
      markDone(child2.id);

      // Find the status_changed event for the parent task
      const parentEvent = receivedEvents.find(
        (e) => e.data.id === parent.id && (e.metadata as any).to === 'done'
      );

      expect(parentEvent).toBeDefined();
      expect(parentEvent!.metadata.source).toBe('workflow');

      unsub();
    });
  });

  describe('cascade depth tracking: nested parent auto-complete cascades', () => {
    it('cascades auto-complete through grandparent -> parent -> child hierarchy', () => {
      const grandparent = createTask('Grandparent');
      const parent = createTask('Parent', grandparent.id);
      const child = createTask('Child', parent.id);

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Mark leaf child done
      markDone(child.id);

      // Parent should auto-complete (depth 1)
      expect(taskService.getTask(parent.id).status).toBe('done');

      // Grandparent should auto-complete (depth 2)
      expect(taskService.getTask(grandparent.id).status).toBe('done');
    });
  });

  describe('cascade depth limit: stops at depth 5', () => {
    it('does not auto-complete beyond 5 levels of cascade depth', () => {
      // Create a 7-level hierarchy: level0 -> level1 -> ... -> level6
      const levels: Array<Task & { tags: string[] }> = [];

      levels[0] = createTask('Level 0 (root)');
      for (let i = 1; i <= 6; i++) {
        levels[i] = createTask(`Level ${i}`, levels[i - 1].id);
      }

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Mark the leaf (level 6) as done
      markDone(levels[6].id);

      // Level 5 should auto-complete (depth 1)
      expect(taskService.getTask(levels[5].id).status).toBe('done');

      // Level 4 should auto-complete (depth 2)
      expect(taskService.getTask(levels[4].id).status).toBe('done');

      // Level 3 should auto-complete (depth 3)
      expect(taskService.getTask(levels[3].id).status).toBe('done');

      // Level 2 should auto-complete (depth 4)
      expect(taskService.getTask(levels[2].id).status).toBe('done');

      // Level 1 should auto-complete (depth 5 -- max)
      expect(taskService.getTask(levels[1].id).status).toBe('done');

      // Level 0 (root) should NOT auto-complete (depth would be 6, exceeds limit)
      expect(taskService.getTask(levels[0].id).status).not.toBe('done');
    });
  });

  describe('task without parent: no crash, no action', () => {
    it('handles status change for parentless task without errors', () => {
      const task = createTask('Orphan Task');

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Should not throw
      expect(() => markDone(task.id)).not.toThrow();

      // Task is done (user action), no workflow side effects
      expect(taskService.getTask(task.id).status).toBe('done');
    });
  });

  describe('stop/cleanup: unsubscribes from EventBus', () => {
    it('does not auto-complete parents after engine is stopped', () => {
      const parent = createTask('Parent Task');
      const child1 = createTask('Child 1', parent.id);
      const child2 = createTask('Child 2', parent.id);

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Stop the engine
      engine.stop();

      // Mark both children done
      markDone(child1.id);
      markDone(child2.id);

      // Parent should NOT be auto-completed (engine stopped)
      expect(taskService.getTask(parent.id).status).not.toBe('done');
    });
  });

  describe('dependency auto-unblock', () => {
    it('completing blocker unblocks blocked task', () => {
      const taskA = createTask('Task A');
      const taskB = createTask('Task B');

      // A blocks B
      dependencyService.addDependency({ task_id: taskA.id, blocks_task_id: taskB.id });

      // Set B to blocked
      taskService.updateTask(taskB.id, { status: 'blocked' });

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Mark A as done
      markDone(taskA.id);

      // B should be auto-unblocked to 'open'
      expect(taskService.getTask(taskB.id).status).toBe('open');
    });

    it('multiple blockers: only unblocks when ALL done', () => {
      const taskA = createTask('Task A');
      const taskB = createTask('Task B');
      const taskC = createTask('Task C');

      // A blocks C, B blocks C
      dependencyService.addDependency({ task_id: taskA.id, blocks_task_id: taskC.id });
      dependencyService.addDependency({ task_id: taskB.id, blocks_task_id: taskC.id });

      // Set C to blocked
      taskService.updateTask(taskC.id, { status: 'blocked' });

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Mark A as done -- C should still be blocked (B not done)
      markDone(taskA.id);
      expect(taskService.getTask(taskC.id).status).toBe('blocked');

      // Mark B as done -- NOW C should be unblocked
      markDone(taskB.id);
      expect(taskService.getTask(taskC.id).status).toBe('open');
    });

    it('source attribution: auto-unblock carries source workflow', () => {
      const receivedEvents: TaskEvent[] = [];
      const unsub = eventBus.subscribe('task.status_changed', (event: TaskEvent) => {
        receivedEvents.push(event);
      });

      const taskA = createTask('Task A');
      const taskB = createTask('Task B');

      // A blocks B
      dependencyService.addDependency({ task_id: taskA.id, blocks_task_id: taskB.id });

      // Set B to blocked
      taskService.updateTask(taskB.id, { status: 'blocked' });

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Mark A as done to trigger auto-unblock of B
      markDone(taskA.id);

      // Find the status_changed event for B transitioning to 'open'
      const unblockEvent = receivedEvents.find(
        (e) => e.data.id === taskB.id && (e.metadata as any).to === 'open'
      );

      expect(unblockEvent).toBeDefined();
      expect(unblockEvent!.metadata.source).toBe('workflow');

      unsub();
    });

    it('combined cascade: unblock does NOT falsely trigger parent completion', () => {
      // Parent P with children C1 (done) and C2 (blocked)
      const parentP = createTask('Parent P');
      const childC1 = createTask('Child C1', parentP.id);
      const childC2 = createTask('Child C2', parentP.id);

      // External task X blocks C2
      const taskX = createTask('Task X');
      dependencyService.addDependency({ task_id: taskX.id, blocks_task_id: childC2.id });

      // Set C2 to blocked
      taskService.updateTask(childC2.id, { status: 'blocked' });

      // Mark C1 as done (before engine starts)
      markDone(childC1.id);

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Mark X as done -- should auto-unblock C2 (blocked -> open)
      markDone(taskX.id);

      // C2 should be 'open' (auto-unblocked), not 'done'
      expect(taskService.getTask(childC2.id).status).toBe('open');

      // P should NOT be auto-completed (C2 is 'open', not 'done')
      expect(taskService.getTask(parentP.id).status).not.toBe('done');
    });

    it('no-op for non-blocked tasks: dependency resolves but task not blocked', () => {
      const taskA = createTask('Task A');
      const taskB = createTask('Task B');

      // A blocks B
      dependencyService.addDependency({ task_id: taskA.id, blocks_task_id: taskB.id });

      // B stays in 'open' status (NOT blocked)

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Mark A as done
      markDone(taskA.id);

      // B should still be 'open' -- no change, no error
      expect(taskService.getTask(taskB.id).status).toBe('open');
    });
  });

  describe('integration: workflow events visible with source attribution', () => {
    it('parent auto-complete events carry source workflow, child events carry source user', () => {
      const receivedEvents: TaskEvent[] = [];
      const unsub = eventBus.subscribe('task.status_changed', (event: TaskEvent) => {
        receivedEvents.push(event);
      });

      const parent = createTask('Parent Task');
      const child1 = createTask('Child 1', parent.id);
      const child2 = createTask('Child 2', parent.id);

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Mark both children done to trigger parent auto-complete
      markDone(child1.id);
      markDone(child2.id);

      // Find events for the parent task (auto-completed by workflow)
      const parentDoneEvent = receivedEvents.find(
        (e) => e.data.id === parent.id && (e.metadata as any).to === 'done'
      );
      expect(parentDoneEvent).toBeDefined();
      expect(parentDoneEvent!.metadata.source).toBe('workflow');

      // Find events for child tasks (done by user)
      const child1DoneEvent = receivedEvents.find(
        (e) => e.data.id === child1.id && (e.metadata as any).to === 'done'
      );
      expect(child1DoneEvent).toBeDefined();
      expect(child1DoneEvent!.metadata.source).toBe('user');

      const child2DoneEvent = receivedEvents.find(
        (e) => e.data.id === child2.id && (e.metadata as any).to === 'done'
      );
      expect(child2DoneEvent).toBeDefined();
      expect(child2DoneEvent!.metadata.source).toBe('user');

      unsub();
    });
  });

  describe('integration: WorkflowEngine starts via createTestApp', () => {
    it('app.workflowEngine exists and auto-completes when running', async () => {
      // Create a fresh app that has its WorkflowEngine running
      const freshApp = await createTestApp();

      expect(freshApp.workflowEngine).toBeDefined();
      expect(freshApp.workflowEngine).toBeInstanceOf(WorkflowEngine);

      // Create parent + 1 child in the fresh app
      const freshProject = freshApp.projectService.createProject({
        name: 'Integration Project',
        description: 'For integration test',
      });

      const parent = freshApp.taskService.createTask({
        title: 'Parent',
        project_id: freshProject.id,
        created_by: 'test-user',
      });

      const child = freshApp.taskService.createTask({
        title: 'Child',
        project_id: freshProject.id,
        created_by: 'test-user',
        parent_task_id: parent.id,
      });

      // Mark child done -- parent should auto-complete (proves engine is running)
      freshApp.taskService.updateTask(child.id, { status: 'in_progress' });
      freshApp.taskService.updateTask(child.id, { status: 'done' });

      expect(freshApp.taskService.getTask(parent.id).status).toBe('done');

      // Clean up
      freshApp.workflowEngine.stop();
    });
  });

  describe('transaction atomicity: cascade rolls back on error', () => {
    it('rolls back entire cascade when an error occurs mid-cascade', () => {
      const parent = createTask('Parent Task');
      const child1 = createTask('Child 1', parent.id);
      const child2 = createTask('Child 2', parent.id);

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Mark child 1 done (no cascade yet, parent has 2 children)
      markDone(child1.id);

      // Spy on taskService.updateTask and make it throw when called
      // for the parent's done transition (the workflow cascade step)
      const originalUpdate = taskService.updateTask.bind(taskService);
      let callCount = 0;
      const spy = vi.spyOn(taskService, 'updateTask').mockImplementation(
        (id: number, input: unknown, source?: 'user' | 'workflow') => {
          callCount++;
          // The cascade triggers:
          //   1. open -> in_progress for parent (workflow)
          //   2. in_progress -> done for parent (workflow)
          // We throw on the done transition for the parent to simulate crash
          if (source === 'workflow' && id === parent.id) {
            const updates = input as { status?: string };
            if (updates.status === 'done') {
              throw new Error('Simulated crash during cascade');
            }
          }
          return originalUpdate(id, input, source);
        }
      );

      // Mark child 2 done -- should trigger cascade that fails
      markDone(child2.id);

      // Restore spy
      spy.mockRestore();

      // Parent should NOT be done (cascade rolled back)
      // The in_progress transition should also have been rolled back
      const parentStatus = taskService.getTask(parent.id).status;
      expect(parentStatus).not.toBe('done');
      // Parent should still be open (transaction rolled back the in_progress transition too)
      expect(parentStatus).toBe('open');
    });
  });

  describe('edge case: parent already in done status', () => {
    it('does not error when parent is already done', () => {
      const parent = createTask('Parent Task');
      const child1 = createTask('Child 1', parent.id);

      // Manually set parent to done
      taskService.updateTask(parent.id, { status: 'in_progress' });
      taskService.updateTask(parent.id, { status: 'done' });

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Mark child done -- should not error (parent already done, workflow skips)
      expect(() => markDone(child1.id)).not.toThrow();

      // Parent is still done
      expect(taskService.getTask(parent.id).status).toBe('done');
    });
  });

  describe('edge case: parent in closed status (invalid transition target)', () => {
    it('leaves parent in closed status when child completes', () => {
      const parent = createTask('Parent Task');
      const child1 = createTask('Child 1', parent.id);

      // Transition parent to done, then to closed
      taskService.updateTask(parent.id, { status: 'in_progress' });
      taskService.updateTask(parent.id, { status: 'done' });
      taskService.updateTask(parent.id, { status: 'closed' });

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Mark child done -- parent should stay closed (workflow skips invalid transition)
      expect(() => markDone(child1.id)).not.toThrow();

      // Parent stays closed
      expect(taskService.getTask(parent.id).status).toBe('closed');
    });
  });

  describe('edge case: child task with no parent (parent_task_id is null)', () => {
    it('handles standalone task completion without errors', () => {
      // Create standalone task (no parent)
      const standalone = createTask('Standalone Task');

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Mark task done -- should not crash
      expect(() => markDone(standalone.id)).not.toThrow();

      // Task is done
      expect(taskService.getTask(standalone.id).status).toBe('done');
    });
  });

  describe('edge case: task with dependencies resolved and no further deps', () => {
    it('handles dependency chain completing cleanly', () => {
      const taskA = createTask('Task A');
      const taskB = createTask('Task B');

      // B depends on A (A blocks B), B is blocked
      dependencyService.addDependency({ task_id: taskA.id, blocks_task_id: taskB.id });
      taskService.updateTask(taskB.id, { status: 'blocked' });

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Mark A done -- B should be unblocked
      markDone(taskA.id);
      expect(taskService.getTask(taskB.id).status).toBe('open');

      // Mark B done (B has no parent or other deps) -- should complete cleanly
      expect(() => markDone(taskB.id)).not.toThrow();
      expect(taskService.getTask(taskB.id).status).toBe('done');
    });
  });

  describe('edge case: parent with zero children (empty children list)', () => {
    it('does not crash when findChildren returns empty array', () => {
      // Create a task that will act as "parent" but has no children
      const pseudoParent = createTask('Pseudo Parent');
      // Create a child that references pseudoParent, then we'll test with a different task
      const actualChild = createTask('Actual Child', pseudoParent.id);

      engine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
      engine.start();

      // Create a scenario where we have a task with no children
      // and another task referencing a non-existent parent
      // Simplest: test that marking actualChild done auto-completes pseudoParent
      // (single child), then marking pseudoParent done (which has 0 children
      // of its own at the "grandparent" level) does not crash

      // First, mark the child done -- this triggers parent auto-complete
      markDone(actualChild.id);

      // pseudoParent should be done now (auto-completed)
      expect(taskService.getTask(pseudoParent.id).status).toBe('done');

      // Now create a standalone parent with no children and manually test
      const emptyParent = createTask('Empty Parent');

      // Manually transition to done -- workflow processes this event
      // and looks for children of emptyParent (finds none), should not crash
      expect(() => {
        taskService.updateTask(emptyParent.id, { status: 'in_progress' });
        taskService.updateTask(emptyParent.id, { status: 'done' });
      }).not.toThrow();

      expect(taskService.getTask(emptyParent.id).status).toBe('done');
    });
  });
});
