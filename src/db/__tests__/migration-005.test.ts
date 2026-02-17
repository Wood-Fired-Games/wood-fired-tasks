import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from '../database.js';
import { runMigrations } from '../migrate.js';
import type Database from 'better-sqlite3';

/**
 * Integration tests for migration 005: backlogged status
 *
 * These tests verify that:
 * - The CHECK constraint is updated to include 'backlogged'
 * - Existing data is preserved through the table rebuild
 * - FTS triggers are recreated and work correctly after migration
 * - All indexes exist after migration
 */
describe('Migration 005: Backlogged Status', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);
  });

  describe('CHECK constraint update', () => {
    it('allows inserting a task with status backlogged after migration', () => {
      // Create a project first (tasks require project_id)
      const projectResult = db
        .prepare('INSERT INTO projects (name) VALUES (?)')
        .run('Test Project');
      const projectId = projectResult.lastInsertRowid;

      // Insert a task with status = 'backlogged' (was rejected before migration 005)
      expect(() => {
        db.prepare(`
          INSERT INTO tasks (title, project_id, created_by, status)
          VALUES (?, ?, ?, ?)
        `).run('Backlogged Task', projectId, 'tester', 'backlogged');
      }).not.toThrow();

      const task = db
        .prepare('SELECT status FROM tasks WHERE title = ?')
        .get('Backlogged Task') as { status: string };

      expect(task.status).toBe('backlogged');
    });

    it('rejects inserting a task with an invalid status', () => {
      const projectResult = db
        .prepare('INSERT INTO projects (name) VALUES (?)')
        .run('Test Project');
      const projectId = projectResult.lastInsertRowid;

      expect(() => {
        db.prepare(`
          INSERT INTO tasks (title, project_id, created_by, status)
          VALUES (?, ?, ?, ?)
        `).run('Invalid Task', projectId, 'tester', 'invalid_status');
      }).toThrow();
    });

    it('still allows all previous valid statuses', () => {
      const projectResult = db
        .prepare('INSERT INTO projects (name) VALUES (?)')
        .run('Status Test Project');
      const projectId = projectResult.lastInsertRowid;

      const validStatuses = ['open', 'in_progress', 'done', 'closed', 'blocked', 'backlogged'];

      for (const status of validStatuses) {
        expect(() => {
          db.prepare(`
            INSERT INTO tasks (title, project_id, created_by, status)
            VALUES (?, ?, ?, ?)
          `).run(`Task with ${status}`, projectId, 'tester', status);
        }).not.toThrow();
      }
    });
  });

  describe('data preservation', () => {
    it('preserves all existing tasks through the migration', async () => {
      // This test works by running migrations on a fresh DB — the migration
      // already ran in beforeEach, so we verify data inserted matches expectations
      // by seeding a fresh DB before migration 005 and running it manually.

      // Create fresh DB and run only migrations 001-004
      const freshDb = initTestDatabase();

      // Manually import and run migrations 001-004
      const { up: up001 } = await import('../migrations/001-initial-schema.js');
      const { up: up002 } = await import('../migrations/002-task-hierarchy-and-dependencies.js');
      const { up: up003 } = await import('../migrations/003-comments-and-estimates.js');
      const { up: up004 } = await import('../migrations/004-claim-protocol.js');

      up001(freshDb);
      await up002(freshDb);
      await up003(freshDb);
      await up004(freshDb);

      // Insert test data before migration 005
      const projectResult = freshDb
        .prepare('INSERT INTO projects (name) VALUES (?)')
        .run('Pre-Migration Project');
      const projectId = projectResult.lastInsertRowid;

      freshDb.prepare(`
        INSERT INTO tasks (title, description, project_id, created_by, status, priority)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('Pre-migration task 1', 'Keep this', projectId, 'dev1', 'open', 'high');

      freshDb.prepare(`
        INSERT INTO tasks (title, description, project_id, created_by, status)
        VALUES (?, ?, ?, ?, ?)
      `).run('Pre-migration task 2', 'Also keep this', projectId, 'dev2', 'in_progress');

      const beforeCount = (freshDb
        .prepare('SELECT COUNT(*) as count FROM tasks')
        .get() as { count: number }).count;

      expect(beforeCount).toBe(2);

      // Run migration 005
      const { up: up005 } = await import('../migrations/005-backlogged-status.js');
      await up005(freshDb);

      // Verify all tasks still exist
      const afterCount = (freshDb
        .prepare('SELECT COUNT(*) as count FROM tasks')
        .get() as { count: number }).count;

      expect(afterCount).toBe(2);

      // Verify task data is intact
      const tasks = freshDb
        .prepare('SELECT title, description, status, priority, created_by FROM tasks ORDER BY id')
        .all() as Array<{ title: string; description: string; status: string; priority: string; created_by: string }>;

      expect(tasks[0]).toMatchObject({
        title: 'Pre-migration task 1',
        description: 'Keep this',
        status: 'open',
        priority: 'high',
        created_by: 'dev1',
      });

      expect(tasks[1]).toMatchObject({
        title: 'Pre-migration task 2',
        description: 'Also keep this',
        status: 'in_progress',
        created_by: 'dev2',
      });

      freshDb.close();
    });
  });

  describe('FTS triggers after migration', () => {
    it('insert trigger works: new tasks are findable via FTS search', () => {
      const projectResult = db
        .prepare('INSERT INTO projects (name) VALUES (?)')
        .run('FTS Test Project');
      const projectId = projectResult.lastInsertRowid;

      db.prepare(`
        INSERT INTO tasks (title, description, project_id, created_by)
        VALUES (?, ?, ?, ?)
      `).run('Searchable xylophone task', 'Contains xylophone keyword', projectId, 'tester');

      const results = db.prepare(`
        SELECT tasks.id, tasks.title
        FROM tasks
        JOIN tasks_fts ON tasks.id = tasks_fts.rowid
        WHERE tasks_fts MATCH ?
      `).all('xylophone') as Array<{ id: number; title: string }>;

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe('Searchable xylophone task');
    });

    it('update trigger works: updated task title is findable via FTS search', () => {
      const projectResult = db
        .prepare('INSERT INTO projects (name) VALUES (?)')
        .run('FTS Update Test Project');
      const projectId = projectResult.lastInsertRowid;

      const taskResult = db.prepare(`
        INSERT INTO tasks (title, description, project_id, created_by)
        VALUES (?, ?, ?, ?)
      `).run('Original velociraptor title', null, projectId, 'tester');

      const taskId = taskResult.lastInsertRowid;

      // Update the title
      db.prepare('UPDATE tasks SET title = ? WHERE id = ?')
        .run('Updated pterodactyl title', taskId);

      // Old title no longer matches
      const oldResults = db.prepare(`
        SELECT tasks.id FROM tasks
        JOIN tasks_fts ON tasks.id = tasks_fts.rowid
        WHERE tasks_fts MATCH ?
      `).all('velociraptor') as Array<{ id: number }>;

      expect(oldResults).toHaveLength(0);

      // New title matches
      const newResults = db.prepare(`
        SELECT tasks.id FROM tasks
        JOIN tasks_fts ON tasks.id = tasks_fts.rowid
        WHERE tasks_fts MATCH ?
      `).all('pterodactyl') as Array<{ id: number }>;

      expect(newResults).toHaveLength(1);
      expect(newResults[0].id).toBe(taskId);
    });

    it('delete trigger works: deleted task is removed from FTS', () => {
      const projectResult = db
        .prepare('INSERT INTO projects (name) VALUES (?)')
        .run('FTS Delete Test Project');
      const projectId = projectResult.lastInsertRowid;

      const taskResult = db.prepare(`
        INSERT INTO tasks (title, project_id, created_by)
        VALUES (?, ?, ?)
      `).run('Ephemeral stegosaurus task', projectId, 'tester');

      const taskId = taskResult.lastInsertRowid;

      // Verify it is in FTS
      let ftsRows = db
        .prepare('SELECT rowid FROM tasks_fts WHERE rowid = ?')
        .all(taskId);
      expect(ftsRows).toHaveLength(1);

      // Delete the task
      db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);

      // Verify it is gone from FTS
      ftsRows = db
        .prepare('SELECT rowid FROM tasks_fts WHERE rowid = ?')
        .all(taskId);
      expect(ftsRows).toHaveLength(0);
    });
  });

  describe('indexes after migration', () => {
    it('recreates all required task indexes', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_tasks%'")
        .all() as { name: string }[];

      const indexNames = indexes.map((i) => i.name);

      expect(indexNames).toContain('idx_tasks_project_id');
      expect(indexNames).toContain('idx_tasks_project_status_assignee');
      expect(indexNames).toContain('idx_tasks_status_due_date');
      expect(indexNames).toContain('idx_tasks_assignee');
      expect(indexNames).toContain('idx_tasks_parent_id');
    });
  });
});
