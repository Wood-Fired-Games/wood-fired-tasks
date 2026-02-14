import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { TaskService } from '../task.service.js';
import { ProjectService } from '../project.service.js';
import { BusinessError, NotFoundError } from '../errors.js';
import { eventBus } from '../../events/event-bus.js';
import type { App } from '../../index.js';

describe('TaskService - claimTask', () => {
  let app: App;
  let taskService: TaskService;
  let projectService: ProjectService;
  let testProjectId: number;

  beforeEach(async () => {
    // Create test app with in-memory database
    app = await createTestApp();
    taskService = app.taskService;
    projectService = app.projectService;

    // Create a test project for tasks
    const project = projectService.createProject({
      name: 'Claim Test Project',
      description: 'For testing claim protocol',
    });
    testProjectId = project.id;
  });

  describe('happy path claim', () => {
    it('claims an unassigned open task and sets assignee, status, and claimed_at', () => {
      const task = taskService.createTask({
        title: 'Unassigned Task',
        project_id: testProjectId,
        created_by: 'creator',
      });

      const claimed = taskService.claimTask(task.id, 'agent-1');

      expect(claimed.assignee).toBe('agent-1');
      expect(claimed.status).toBe('in_progress');
      expect(claimed.claimed_at).toBeTruthy();
      expect(typeof claimed.claimed_at).toBe('string');
    });
  });

  describe('version tracking', () => {
    it('increments version from 1 to 2 after claiming', () => {
      const task = taskService.createTask({
        title: 'Version Track Task',
        project_id: testProjectId,
        created_by: 'creator',
      });

      // New tasks should have version 1
      const freshTask = taskService.getTask(task.id);
      expect(freshTask.version).toBe(1);

      const claimed = taskService.claimTask(task.id, 'agent-1');
      expect(claimed.version).toBe(2);
    });
  });

  describe('claim already-claimed task fails', () => {
    it('throws BusinessError when task is already claimed by another agent', () => {
      const task = taskService.createTask({
        title: 'Already Claimed Task',
        project_id: testProjectId,
        created_by: 'creator',
      });

      // First claim succeeds
      taskService.claimTask(task.id, 'agent-1');

      // Second claim should fail -- task is now in_progress, so status check fires first
      expect(() => taskService.claimTask(task.id, 'agent-2')).toThrow(BusinessError);

      try {
        taskService.claimTask(task.id, 'agent-2');
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessError);
        // After claiming, status becomes 'in_progress', so the status validation fires
        expect((error as BusinessError).message).toContain('cannot be claimed');
      }
    });
  });

  describe('claim non-existent task fails', () => {
    it('throws NotFoundError for non-existent task ID', () => {
      expect(() => taskService.claimTask(99999, 'agent-1')).toThrow(NotFoundError);

      try {
        taskService.claimTask(99999, 'agent-1');
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundError);
        const notFoundError = error as NotFoundError;
        expect(notFoundError.entity).toBe('Task');
        expect(notFoundError.id).toBe(99999);
      }
    });
  });

  describe('claim task not in open status fails', () => {
    it('throws BusinessError when task is in_progress (not open)', () => {
      const task = taskService.createTask({
        title: 'In Progress Task',
        project_id: testProjectId,
        created_by: 'creator',
      });

      // Move task to in_progress via normal update
      taskService.updateTask(task.id, { status: 'in_progress' });

      expect(() => taskService.claimTask(task.id, 'agent-1')).toThrow(BusinessError);

      try {
        taskService.claimTask(task.id, 'agent-1');
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessError);
        expect((error as BusinessError).message).toContain('open');
      }
    });
  });

  describe('event emission on successful claim', () => {
    it('emits task.claimed event with correct payload after successful claim', () => {
      const emitSpy = vi.spyOn(eventBus, 'emit');

      const task = taskService.createTask({
        title: 'Event Emission Task',
        project_id: testProjectId,
        created_by: 'creator',
      });

      // Clear spy from createTask emission
      emitSpy.mockClear();

      const claimed = taskService.claimTask(task.id, 'agent-1');

      expect(emitSpy).toHaveBeenCalledWith('task.claimed', {
        eventType: 'task.claimed',
        timestamp: expect.any(String),
        data: claimed,
        metadata: { source: 'user' },
      });

      emitSpy.mockRestore();
    });
  });

  describe('no event emission on failed claim', () => {
    it('does NOT emit task.claimed when claim fails (already claimed)', () => {
      const task = taskService.createTask({
        title: 'No Event Task',
        project_id: testProjectId,
        created_by: 'creator',
      });

      // First claim succeeds
      taskService.claimTask(task.id, 'agent-1');

      const emitSpy = vi.spyOn(eventBus, 'emit');

      // Second claim should fail - no event emitted
      expect(() => taskService.claimTask(task.id, 'agent-2')).toThrow(BusinessError);

      expect(emitSpy).not.toHaveBeenCalledWith('task.claimed', expect.any(Object));

      emitSpy.mockRestore();
    });

    it('does NOT emit task.claimed when task not found', () => {
      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() => taskService.claimTask(99999, 'agent-1')).toThrow(NotFoundError);

      expect(emitSpy).not.toHaveBeenCalledWith('task.claimed', expect.any(Object));

      emitSpy.mockRestore();
    });

    it('does NOT emit task.claimed when task is in wrong status', () => {
      const task = taskService.createTask({
        title: 'Wrong Status Task',
        project_id: testProjectId,
        created_by: 'creator',
      });

      taskService.updateTask(task.id, { status: 'in_progress' });

      const emitSpy = vi.spyOn(eventBus, 'emit');

      expect(() => taskService.claimTask(task.id, 'agent-1')).toThrow(BusinessError);

      expect(emitSpy).not.toHaveBeenCalledWith('task.claimed', expect.any(Object));

      emitSpy.mockRestore();
    });
  });

  describe('concurrent claims (serial simulation)', () => {
    it('exactly one of two rapid sequential claims succeeds', () => {
      const task = taskService.createTask({
        title: 'Race Condition Task',
        project_id: testProjectId,
        created_by: 'creator',
      });

      let successes = 0;
      let failures = 0;

      // Simulate two agents trying to claim the same task
      for (const agent of ['agent-1', 'agent-2']) {
        try {
          taskService.claimTask(task.id, agent);
          successes++;
        } catch (error) {
          if (error instanceof BusinessError) {
            failures++;
          } else {
            throw error; // Unexpected error type
          }
        }
      }

      expect(successes).toBe(1);
      expect(failures).toBe(1);

      // Verify the task is claimed by exactly one agent
      const claimedTask = taskService.getTask(task.id);
      expect(claimedTask.status).toBe('in_progress');
      expect(claimedTask.assignee).toBeTruthy();
      expect(['agent-1', 'agent-2']).toContain(claimedTask.assignee);
    });
  });
});
