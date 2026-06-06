import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClaimReleaseService } from '../claim-release.service.js';
import { initTestDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { eventBus } from '../../events/event-bus.js';
import type Database from '../../db/driver.js';

describe('ClaimReleaseService', () => {
  let db: Database.Database;
  let service: ClaimReleaseService;
  let projectId: number;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);

    // Create a test project
    db.prepare(
      `INSERT INTO projects (name, created_at, updated_at)
       VALUES ('Test Project', datetime('now'), datetime('now'))`,
    ).run();
    projectId = 1;

    // Default timeout of 30 minutes
    service = new ClaimReleaseService(db, 30);
  });

  afterEach(() => {
    service.stop();
    db.close();
  });

  /**
   * Helper to create a task with specific claimed state
   */
  function createClaimedTask(options: {
    title: string;
    claimedMinutesAgo: number;
    updatedMinutesAgo?: number;
    assignee?: string;
  }): number {
    const { title, claimedMinutesAgo, updatedMinutesAgo, assignee = 'agent-1' } = options;
    const updatedAgo = updatedMinutesAgo ?? claimedMinutesAgo;

    db.prepare(
      `INSERT INTO tasks (
        title, status, priority, project_id, assignee, created_by,
        claimed_at, created_at, updated_at, version
      ) VALUES (
        ?, 'in_progress', 'medium', ?, ?, 'creator',
        datetime('now', ?), datetime('now', '-60 minutes'),
        datetime('now', ?), 2
      )`,
    ).run(title, projectId, assignee, `-${claimedMinutesAgo} minutes`, `-${updatedAgo} minutes`);

    return db.prepare('SELECT last_insert_rowid() as id').get() as any as number;
  }

  describe('findStaleClaims', () => {
    it('returns empty array when no claimed tasks exist', () => {
      // Create an unclaimed task
      db.prepare(
        `INSERT INTO tasks (title, status, priority, project_id, created_by, created_at, updated_at)
         VALUES ('Unclaimed Task', 'open', 'medium', ?, 'creator', datetime('now'), datetime('now'))`,
      ).run(projectId);

      const stale = service.findStaleClaims();
      expect(stale).toEqual([]);
    });

    it('returns empty array for recently claimed tasks (within timeout)', () => {
      createClaimedTask({ title: 'Recent Claim', claimedMinutesAgo: 10 });

      const stale = service.findStaleClaims();
      expect(stale).toEqual([]);
    });

    it('returns tasks claimed longer than timeout ago with no recent activity', () => {
      createClaimedTask({ title: 'Stale Claim', claimedMinutesAgo: 31 });

      const stale = service.findStaleClaims();
      expect(stale).toHaveLength(1);
      expect(stale[0].assignee).toBe('agent-1');
      expect(stale[0].claimed_at).toBeTruthy();
    });

    it('does NOT return tasks with recent updated_at (activity resets clock)', () => {
      // Claimed 40 minutes ago but updated 5 minutes ago (activity resets clock)
      createClaimedTask({
        title: 'Active Claim',
        claimedMinutesAgo: 40,
        updatedMinutesAgo: 5,
      });

      const stale = service.findStaleClaims();
      expect(stale).toEqual([]);
    });

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
        )`,
      ).run(projectId);

      const stale = service.findStaleClaims();
      expect(stale).toEqual([]);
    });

    it('does NOT return closed tasks even if claimed_at is stale', () => {
      db.prepare(
        `INSERT INTO tasks (
          title, status, priority, project_id, assignee, created_by,
          claimed_at, created_at, updated_at, version
        ) VALUES (
          'Closed Task', 'closed', 'medium', ?, 'agent-1', 'creator',
          datetime('now', '-40 minutes'), datetime('now', '-60 minutes'),
          datetime('now', '-35 minutes'), 4
        )`,
      ).run(projectId);

      const stale = service.findStaleClaims();
      expect(stale).toEqual([]);
    });
  });

  describe('releaseClaim', () => {
    it('sets assignee to null, status to open, clears claimed_at, increments version', () => {
      createClaimedTask({ title: 'To Release', claimedMinutesAgo: 31 });
      const taskId = 1;

      const released = service.releaseClaim(taskId);
      expect(released).toBe(true);

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
      expect(task.assignee).toBeNull();
      expect(task.status).toBe('open');
      expect(task.claimed_at).toBeNull();
      expect(task.version).toBe(3); // Was 2, incremented to 3
    });

    it('returns false when task has no assignee', () => {
      db.prepare(
        `INSERT INTO tasks (title, status, priority, project_id, created_by, created_at, updated_at)
         VALUES ('Open Task', 'open', 'medium', ?, 'creator', datetime('now'), datetime('now'))`,
      ).run(projectId);

      const released = service.releaseClaim(1);
      expect(released).toBe(false);
    });

    it('returns false for done tasks (defense-in-depth status guard)', () => {
      db.prepare(
        `INSERT INTO tasks (
          title, status, priority, project_id, assignee, created_by,
          claimed_at, created_at, updated_at, version
        ) VALUES (
          'Done Task', 'done', 'medium', ?, 'agent-1', 'creator',
          datetime('now', '-40 minutes'), datetime('now', '-60 minutes'),
          datetime('now', '-35 minutes'), 3
        )`,
      ).run(projectId);

      const released = service.releaseClaim(1);
      expect(released).toBe(false);

      // Verify status was NOT changed
      const task = db.prepare('SELECT status FROM tasks WHERE id = 1').get() as any;
      expect(task.status).toBe('done');
    });
  });

  describe('sweep', () => {
    it('releases all stale claims and returns count', () => {
      createClaimedTask({ title: 'Stale 1', claimedMinutesAgo: 35, assignee: 'agent-1' });
      createClaimedTask({ title: 'Stale 2', claimedMinutesAgo: 45, assignee: 'agent-2' });
      createClaimedTask({ title: 'Recent', claimedMinutesAgo: 10, assignee: 'agent-3' });

      const released = service.sweep();
      expect(released).toBe(2);

      // Verify stale tasks were released
      const task1 = db.prepare('SELECT * FROM tasks WHERE id = 1').get() as any;
      expect(task1.status).toBe('open');
      expect(task1.assignee).toBeNull();

      const task2 = db.prepare('SELECT * FROM tasks WHERE id = 2').get() as any;
      expect(task2.status).toBe('open');
      expect(task2.assignee).toBeNull();

      // Recent task should still be claimed
      const task3 = db.prepare('SELECT * FROM tasks WHERE id = 3').get() as any;
      expect(task3.status).toBe('in_progress');
      expect(task3.assignee).toBe('agent-3');
    });

    it('emits task.updated event with source: workflow for each released task', () => {
      createClaimedTask({ title: 'Event Task', claimedMinutesAgo: 31 });

      const events: any[] = [];
      const unsubscribe = eventBus.subscribe('task.updated', (event) => {
        events.push(event);
      });

      service.sweep();

      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('task.updated');
      expect(events[0].metadata.source).toBe('workflow');
      expect(events[0].data.status).toBe('open');
      expect(events[0].data.assignee).toBeNull();

      unsubscribe();
    });

    it('returns 0 when no stale claims exist', () => {
      createClaimedTask({ title: 'Fresh', claimedMinutesAgo: 5 });

      const released = service.sweep();
      expect(released).toBe(0);
    });

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
        )`,
      ).run(projectId);

      const released = service.sweep();
      expect(released).toBe(1); // Only the in_progress task

      // Verify done task was NOT touched
      const doneTask = db
        .prepare('SELECT * FROM tasks WHERE title = ?')
        .get('Stale But Done') as any;
      expect(doneTask.status).toBe('done');
      expect(doneTask.assignee).toBe('agent-2');
    });
  });

  describe('start/stop', () => {
    it('starts periodic sweep and can be stopped', () => {
      vi.useFakeTimers();

      createClaimedTask({ title: 'Timer Test', claimedMinutesAgo: 31 });

      // Start with short interval for testing
      service.start(1000);

      // Verify task is still claimed initially
      const before = db.prepare('SELECT * FROM tasks WHERE id = 1').get() as any;
      expect(before.assignee).toBe('agent-1');

      // Advance timer
      vi.advanceTimersByTime(1000);

      // Verify task was released by sweep
      const after = db.prepare('SELECT * FROM tasks WHERE id = 1').get() as any;
      expect(after.assignee).toBeNull();

      service.stop();
      vi.useRealTimers();
    });
  });
});
