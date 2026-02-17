import { describe, it, expect, beforeEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { TaskService } from '../task.service.js';
import { ProjectService } from '../project.service.js';
import { BusinessError } from '../errors.js';
import type { App } from '../../index.js';

/**
 * Service-level integration tests for the backlogged status.
 *
 * These tests verify the complete backlogged status lifecycle:
 * - open -> backlogged transition
 * - backlogged -> open transition
 * - Invalid transitions from backlogged are rejected
 * - Backlogged tasks cannot be claimed
 * - createTask always produces open tasks regardless of input
 * - Status filtering includes backlogged
 */
describe('TaskService - Backlogged Status', () => {
  let app: App;
  let taskService: TaskService;
  let projectService: ProjectService;
  let testProjectId: number;

  beforeEach(async () => {
    app = await createTestApp();
    taskService = app.taskService;
    projectService = app.projectService;

    const project = projectService.createProject({
      name: 'Backlog Test Project',
      description: 'For testing backlogged status lifecycle',
    });
    testProjectId = project.id;
  });

  describe('open -> backlogged transition', () => {
    it('can transition a task from open to backlogged via updateTask', () => {
      const task = taskService.createTask({
        title: 'Task to backlog',
        project_id: testProjectId,
        created_by: 'user1',
      });

      expect(task.status).toBe('open');

      const updated = taskService.updateTask(task.id, { status: 'backlogged' });

      expect(updated.status).toBe('backlogged');
    });
  });

  describe('backlogged -> open transition', () => {
    it('can transition a task from backlogged back to open via updateTask', () => {
      const task = taskService.createTask({
        title: 'Task to backlog then promote',
        project_id: testProjectId,
        created_by: 'user1',
      });

      // Move to backlogged
      taskService.updateTask(task.id, { status: 'backlogged' });

      // Promote back to open
      const promoted = taskService.updateTask(task.id, { status: 'open' });

      expect(promoted.status).toBe('open');
    });
  });

  describe('invalid transitions from backlogged', () => {
    it('cannot transition from backlogged directly to in_progress', () => {
      const task = taskService.createTask({
        title: 'Backlogged task',
        project_id: testProjectId,
        created_by: 'user1',
      });

      taskService.updateTask(task.id, { status: 'backlogged' });

      expect(() => {
        taskService.updateTask(task.id, { status: 'in_progress' });
      }).toThrow(BusinessError);

      try {
        taskService.updateTask(task.id, { status: 'in_progress' });
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessError);
        expect((error as BusinessError).message).toContain('backlogged');
        expect((error as BusinessError).message).toContain('in_progress');
      }
    });

    it('cannot transition from backlogged directly to done', () => {
      const task = taskService.createTask({
        title: 'Backlogged to done attempt',
        project_id: testProjectId,
        created_by: 'user1',
      });

      taskService.updateTask(task.id, { status: 'backlogged' });

      expect(() => {
        taskService.updateTask(task.id, { status: 'done' });
      }).toThrow(BusinessError);

      try {
        taskService.updateTask(task.id, { status: 'done' });
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessError);
        expect((error as BusinessError).message).toContain('backlogged');
      }
    });

    it('cannot transition from backlogged directly to closed', () => {
      const task = taskService.createTask({
        title: 'Backlogged to closed attempt',
        project_id: testProjectId,
        created_by: 'user1',
      });

      taskService.updateTask(task.id, { status: 'backlogged' });

      expect(() => {
        taskService.updateTask(task.id, { status: 'closed' });
      }).toThrow(BusinessError);
    });

    it('cannot transition from backlogged to blocked', () => {
      const task = taskService.createTask({
        title: 'Backlogged to blocked attempt',
        project_id: testProjectId,
        created_by: 'user1',
      });

      taskService.updateTask(task.id, { status: 'backlogged' });

      expect(() => {
        taskService.updateTask(task.id, { status: 'blocked' });
      }).toThrow(BusinessError);
    });
  });

  describe('claim exclusion', () => {
    it('cannot claim a backlogged task', () => {
      const task = taskService.createTask({
        title: 'Task to backlog then try to claim',
        project_id: testProjectId,
        created_by: 'user1',
      });

      // Move to backlogged
      taskService.updateTask(task.id, { status: 'backlogged' });

      // Attempt to claim — should be rejected
      expect(() => {
        taskService.claimTask(task.id, 'agent-1');
      }).toThrow(BusinessError);

      try {
        taskService.claimTask(task.id, 'agent-1');
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessError);
        const message = (error as BusinessError).message;
        // The existing guard checks status !== 'open', so the error message
        // will contain the current status 'backlogged' and the required 'open'
        expect(message).toContain('backlogged');
        expect(message).toContain('open');
      }
    });
  });

  describe('createTask always starts as open', () => {
    it('newly created tasks always have status open regardless of any input', () => {
      const task = taskService.createTask({
        title: 'New task',
        project_id: testProjectId,
        created_by: 'user1',
      });

      expect(task.status).toBe('open');
    });

    it('creating multiple tasks all start as open', () => {
      const titles = ['Task A', 'Task B', 'Task C'];

      for (const title of titles) {
        const task = taskService.createTask({
          title,
          project_id: testProjectId,
          created_by: 'user1',
        });

        expect(task.status).toBe('open');
      }
    });
  });

  describe('status filtering', () => {
    it('can filter tasks by backlogged status', () => {
      // Create tasks with various statuses
      const openTask = taskService.createTask({
        title: 'Open task',
        project_id: testProjectId,
        created_by: 'user1',
      });

      const backlogTask1 = taskService.createTask({
        title: 'Backlog task 1',
        project_id: testProjectId,
        created_by: 'user1',
      });
      taskService.updateTask(backlogTask1.id, { status: 'backlogged' });

      const backlogTask2 = taskService.createTask({
        title: 'Backlog task 2',
        project_id: testProjectId,
        created_by: 'user1',
      });
      taskService.updateTask(backlogTask2.id, { status: 'backlogged' });

      // Filter for backlogged tasks only
      const backloggedTasks = taskService.listTasks({
        project_id: testProjectId,
        status: 'backlogged',
      });

      expect(backloggedTasks).toHaveLength(2);
      expect(backloggedTasks.every((t) => t.status === 'backlogged')).toBe(true);
      expect(backloggedTasks.map((t) => t.id)).toContain(backlogTask1.id);
      expect(backloggedTasks.map((t) => t.id)).toContain(backlogTask2.id);

      // The open task should NOT be in backlog results
      expect(backloggedTasks.map((t) => t.id)).not.toContain(openTask.id);
    });

    it('can filter tasks by open status (backlogged tasks excluded)', () => {
      const openTask = taskService.createTask({
        title: 'Should be found',
        project_id: testProjectId,
        created_by: 'user1',
      });

      const backlogTask = taskService.createTask({
        title: 'Should be hidden',
        project_id: testProjectId,
        created_by: 'user1',
      });
      taskService.updateTask(backlogTask.id, { status: 'backlogged' });

      const openTasks = taskService.listTasks({
        project_id: testProjectId,
        status: 'open',
      });

      expect(openTasks.some((t) => t.id === openTask.id)).toBe(true);
      expect(openTasks.some((t) => t.id === backlogTask.id)).toBe(false);
    });
  });

  describe('complete triage lifecycle', () => {
    it('supports full triage workflow: open -> backlogged -> open -> in_progress', () => {
      // Create task
      const task = taskService.createTask({
        title: 'Triageable task',
        project_id: testProjectId,
        created_by: 'user1',
      });
      expect(task.status).toBe('open');

      // Defer to backlog
      const backlogged = taskService.updateTask(task.id, { status: 'backlogged' });
      expect(backlogged.status).toBe('backlogged');

      // Promote from backlog to open
      const promoted = taskService.updateTask(task.id, { status: 'open' });
      expect(promoted.status).toBe('open');

      // Now claim it (goes to in_progress)
      const claimed = taskService.claimTask(task.id, 'agent-1');
      expect(claimed.status).toBe('in_progress');
      expect(claimed.assignee).toBe('agent-1');
    });
  });
});
