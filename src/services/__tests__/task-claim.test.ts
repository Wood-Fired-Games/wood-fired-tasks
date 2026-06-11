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

  afterEach(() => {
    // task #257: release WorkflowEngine's EventBus subscription between tests.
    app.dispose();
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

  // Task #1003: claim renewal (heartbeat) — a same-assignee re-claim of a
  // task already held in_progress refreshes claimed_at (extending the TTL)
  // instead of throwing the already-claimed conflict.
  describe('claim renewal (same-assignee re-claim, task #1003)', () => {
    /** Backdate the claim window via SQL so a refresh is observable. */
    function backdateClaim(taskId: number, minutes: number): void {
      app.db
        .prepare(
          `UPDATE tasks
           SET claimed_at = datetime('now', ?), updated_at = datetime('now', ?)
           WHERE id = ?`,
        )
        .run(`-${minutes} minutes`, `-${minutes} minutes`, taskId);
    }

    it('same-assignee re-claim succeeds and refreshes claimed_at', () => {
      const task = taskService.createTask({
        title: 'Renewal Task',
        project_id: testProjectId,
        created_by: 'creator',
      });

      const claimed = taskService.claimTask(task.id, 'agent-1');
      backdateClaim(task.id, 10);
      const stale = taskService.getTask(task.id);

      const renewed = taskService.claimTask(task.id, 'agent-1');

      expect(renewed.assignee).toBe('agent-1');
      expect(renewed.status).toBe('in_progress');
      expect(renewed.claimed_at).toBeTruthy();
      // claimed_at moved forward off the backdated value.
      expect(renewed.claimed_at).not.toBe(stale.claimed_at);
      // Renewal is a write like any other: version bumps.
      expect(renewed.version).toBe(claimed.version + 1);
    });

    it('re-claim by a DIFFERENT assignee still throws BusinessError', () => {
      const task = taskService.createTask({
        title: 'Held Task',
        project_id: testProjectId,
        created_by: 'creator',
      });

      taskService.claimTask(task.id, 'agent-1');

      expect(() => taskService.claimTask(task.id, 'agent-2')).toThrow(BusinessError);

      // Holder unchanged.
      const after = taskService.getTask(task.id);
      expect(after.assignee).toBe('agent-1');
      expect(after.status).toBe('in_progress');
    });

    it('renewal emits task.claimed with the refreshed task', () => {
      const task = taskService.createTask({
        title: 'Renewal Event Task',
        project_id: testProjectId,
        created_by: 'creator',
      });
      taskService.claimTask(task.id, 'agent-1');

      const emitSpy = vi.spyOn(eventBus, 'emit');
      const renewed = taskService.claimTask(task.id, 'agent-1');

      expect(emitSpy).toHaveBeenCalledWith('task.claimed', {
        eventType: 'task.claimed',
        timestamp: expect.any(String),
        data: renewed,
        metadata: { source: 'user' },
      });

      emitSpy.mockRestore();
    });
  });

  // Task #1003: claim-TTL visibility — getTask surfaces claim_ttl_minutes +
  // claim_remaining_seconds (read-time computed) while a claim is active.
  describe('getTask claim-TTL visibility (task #1003)', () => {
    it('surfaces claim_ttl_minutes and claim_remaining_seconds on a claimed task', () => {
      const task = taskService.createTask({
        title: 'TTL Visible Task',
        project_id: testProjectId,
        created_by: 'creator',
      });
      taskService.claimTask(task.id, 'agent-1');

      const fetched = taskService.getTask(task.id);
      expect(fetched.claim_ttl_minutes).toBe(30);
      expect(fetched.claim_remaining_seconds).toBeGreaterThan(0);
      expect(fetched.claim_remaining_seconds).toBeLessThanOrEqual(30 * 60);
    });

    it('omits the TTL fields on an unclaimed task', () => {
      const task = taskService.createTask({
        title: 'Unclaimed Task',
        project_id: testProjectId,
        created_by: 'creator',
      });

      const fetched = taskService.getTask(task.id);
      expect(fetched.claim_ttl_minutes).toBeUndefined();
      expect(fetched.claim_remaining_seconds).toBeUndefined();
    });

    it('remaining seconds shrink with claim age and reset on renewal', () => {
      const task = taskService.createTask({
        title: 'TTL Countdown Task',
        project_id: testProjectId,
        created_by: 'creator',
      });
      taskService.claimTask(task.id, 'agent-1');

      // Age the claim window to 29 of the 30 minutes → ~60s remaining.
      app.db
        .prepare(
          `UPDATE tasks
           SET claimed_at = datetime('now', '-29 minutes'),
               updated_at = datetime('now', '-29 minutes')
           WHERE id = ?`,
        )
        .run(task.id);

      const aged = taskService.getTask(task.id);
      expect(aged.claim_remaining_seconds).toBeGreaterThanOrEqual(0);
      expect(aged.claim_remaining_seconds).toBeLessThanOrEqual(120);

      // A same-assignee renewal restarts the window.
      taskService.claimTask(task.id, 'agent-1');
      const renewed = taskService.getTask(task.id);
      expect(renewed.claim_remaining_seconds).toBeGreaterThan(25 * 60);
    });
  });
});
