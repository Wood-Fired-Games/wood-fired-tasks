import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { TaskService } from '../task.service.js';
import { ProjectService } from '../project.service.js';
import { WorkflowEngine } from '../workflow-engine.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { eventBus } from '../../events/event-bus.js';
import type { App } from '../../index.js';
import type { Task } from '../../types/task.js';
import type { TaskEvent } from '../../events/types.js';

describe('WorkflowEngine', () => {
  let app: App;
  let taskService: TaskService;
  let projectService: ProjectService;
  let taskRepo: TaskRepository;
  let engine: WorkflowEngine;
  let testProjectId: number;

  beforeEach(async () => {
    app = await createTestApp();
    taskService = app.taskService;
    projectService = app.projectService;
    taskRepo = new TaskRepository(app.db);

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

      engine = new WorkflowEngine(taskService, taskRepo, eventBus);
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

      engine = new WorkflowEngine(taskService, taskRepo, eventBus);
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

      engine = new WorkflowEngine(taskService, taskRepo, eventBus);
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

      engine = new WorkflowEngine(taskService, taskRepo, eventBus);
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

      engine = new WorkflowEngine(taskService, taskRepo, eventBus);
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

      engine = new WorkflowEngine(taskService, taskRepo, eventBus);
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

      engine = new WorkflowEngine(taskService, taskRepo, eventBus);
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
});
