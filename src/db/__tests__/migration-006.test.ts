import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from '../database.js';
import { runMigrations } from '../migrate.js';
import type Database from '../driver.js';

/**
 * Integration tests for migration 006: slack_channel_subscriptions
 *
 * These tests verify that:
 * - The slack_channel_subscriptions table is created with correct columns
 * - The UNIQUE(channel_id, project_id, event_type) constraint is enforced
 * - Cascade delete works when a referenced project is deleted
 * - All three indexes exist after migration
 */
describe('Migration 006: slack_channel_subscriptions', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);
  });

  describe('table creation', () => {
    it('should create slack_channel_subscriptions table', () => {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='slack_channel_subscriptions'")
        .get() as { name: string } | undefined;

      expect(table).toBeDefined();
      expect(table?.name).toBe('slack_channel_subscriptions');
    });

    it('should allow inserting a subscription row', () => {
      const projectResult = db
        .prepare('INSERT INTO projects (name) VALUES (?)')
        .run('Test Project');
      const projectId = projectResult.lastInsertRowid;

      db.prepare(`
        INSERT INTO slack_channel_subscriptions (channel_id, project_id, event_type)
        VALUES (?, ?, ?)
      `).run('C123', projectId, 'task.created');

      const row = db
        .prepare('SELECT channel_id, project_id, event_type FROM slack_channel_subscriptions WHERE channel_id = ?')
        .get('C123') as { channel_id: string; project_id: number; event_type: string } | undefined;

      expect(row).toBeDefined();
      expect(row?.channel_id).toBe('C123');
      expect(row?.project_id).toBe(projectId);
      expect(row?.event_type).toBe('task.created');
    });

    it('should set created_at automatically', () => {
      const projectResult = db
        .prepare('INSERT INTO projects (name) VALUES (?)')
        .run('Timestamp Test Project');
      const projectId = projectResult.lastInsertRowid;

      db.prepare(`
        INSERT INTO slack_channel_subscriptions (channel_id, project_id, event_type)
        VALUES (?, ?, ?)
      `).run('C456', projectId, 'task.updated');

      const row = db
        .prepare('SELECT created_at FROM slack_channel_subscriptions WHERE channel_id = ?')
        .get('C456') as { created_at: string } | undefined;

      expect(row).toBeDefined();
      expect(row?.created_at).toBeTruthy();
      // Verify it looks like a datetime string
      expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });
  });

  describe('constraints', () => {
    it('should enforce UNIQUE(channel_id, project_id, event_type)', () => {
      const projectResult = db
        .prepare('INSERT INTO projects (name) VALUES (?)')
        .run('Unique Constraint Project');
      const projectId = projectResult.lastInsertRowid;

      db.prepare(`
        INSERT INTO slack_channel_subscriptions (channel_id, project_id, event_type)
        VALUES (?, ?, ?)
      `).run('C789', projectId, 'task.created');

      expect(() => {
        db.prepare(`
          INSERT INTO slack_channel_subscriptions (channel_id, project_id, event_type)
          VALUES (?, ?, ?)
        `).run('C789', projectId, 'task.created');
      }).toThrow();
    });

    it('should allow same channel+project with different event_type', () => {
      const projectResult = db
        .prepare('INSERT INTO projects (name) VALUES (?)')
        .run('Different Event Type Project');
      const projectId = projectResult.lastInsertRowid;

      expect(() => {
        db.prepare(`
          INSERT INTO slack_channel_subscriptions (channel_id, project_id, event_type)
          VALUES (?, ?, ?)
        `).run('CABC', projectId, 'task.created');
      }).not.toThrow();

      expect(() => {
        db.prepare(`
          INSERT INTO slack_channel_subscriptions (channel_id, project_id, event_type)
          VALUES (?, ?, ?)
        `).run('CABC', projectId, 'task.updated');
      }).not.toThrow();

      const rows = db
        .prepare('SELECT COUNT(*) as count FROM slack_channel_subscriptions WHERE channel_id = ?')
        .get('CABC') as { count: number };

      expect(rows.count).toBe(2);
    });

    it('should allow same channel+event_type for different projects', () => {
      const project1Result = db
        .prepare('INSERT INTO projects (name) VALUES (?)')
        .run('Project Alpha');
      const project1Id = project1Result.lastInsertRowid;

      const project2Result = db
        .prepare('INSERT INTO projects (name) VALUES (?)')
        .run('Project Beta');
      const project2Id = project2Result.lastInsertRowid;

      expect(() => {
        db.prepare(`
          INSERT INTO slack_channel_subscriptions (channel_id, project_id, event_type)
          VALUES (?, ?, ?)
        `).run('CDEF', project1Id, 'task.created');
      }).not.toThrow();

      expect(() => {
        db.prepare(`
          INSERT INTO slack_channel_subscriptions (channel_id, project_id, event_type)
          VALUES (?, ?, ?)
        `).run('CDEF', project2Id, 'task.created');
      }).not.toThrow();

      const rows = db
        .prepare('SELECT COUNT(*) as count FROM slack_channel_subscriptions WHERE channel_id = ?')
        .get('CDEF') as { count: number };

      expect(rows.count).toBe(2);
    });

    it('should cascade delete when project is deleted', () => {
      const projectResult = db
        .prepare('INSERT INTO projects (name) VALUES (?)')
        .run('Cascade Test Project');
      const projectId = projectResult.lastInsertRowid;

      db.prepare(`
        INSERT INTO slack_channel_subscriptions (channel_id, project_id, event_type)
        VALUES (?, ?, ?)
      `).run('CGHI', projectId, 'task.created');

      // Verify the subscription exists before deletion
      const before = db
        .prepare('SELECT COUNT(*) as count FROM slack_channel_subscriptions WHERE project_id = ?')
        .get(projectId) as { count: number };
      expect(before.count).toBe(1);

      // Delete the project — should cascade to subscriptions
      db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

      // Verify the subscription was cascade deleted
      const after = db
        .prepare('SELECT COUNT(*) as count FROM slack_channel_subscriptions WHERE project_id = ?')
        .get(projectId) as { count: number };
      expect(after.count).toBe(0);
    });
  });

  describe('indexes', () => {
    it('should create index on channel_id', () => {
      const index = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_slack_subs_channel_id'")
        .get() as { name: string } | undefined;

      expect(index).toBeDefined();
      expect(index?.name).toBe('idx_slack_subs_channel_id');
    });

    it('should create index on project_id', () => {
      const index = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_slack_subs_project_id'")
        .get() as { name: string } | undefined;

      expect(index).toBeDefined();
      expect(index?.name).toBe('idx_slack_subs_project_id');
    });

    it('should create index on event_type', () => {
      const index = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_slack_subs_event_type'")
        .get() as { name: string } | undefined;

      expect(index).toBeDefined();
      expect(index?.name).toBe('idx_slack_subs_event_type');
    });
  });
});
