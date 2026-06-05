import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from '../database.js';
import { runMigrations } from '../migrate.js';
import type Database from '../driver.js';

/**
 * Integration tests for migration 007: completed_at column
 *
 * Verifies that:
 * - The column exists after migration
 * - Backfill populates completed_at for existing done tasks
 * - The completion-range index exists
 * - Migration is reversible (down drops column and index)
 */
describe('Migration 007: Completed At', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = initTestDatabase();
  });

  it('adds the completed_at column after running migrations', async () => {
    await runMigrations(db);

    const cols = db
      .prepare("PRAGMA table_info('tasks')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('completed_at');
  });

  it('creates the completed_at index', async () => {
    await runMigrations(db);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_completed_at'"
      )
      .all() as { name: string }[];
    expect(indexes).toHaveLength(1);
  });

  it('backfills completed_at from updated_at for existing done tasks', async () => {
    // Run migrations 001-006 first by manual import (stops short of 007)
    const { up: up001 } = await import('../migrations/001-initial-schema.js');
    const { up: up002 } = await import('../migrations/002-task-hierarchy-and-dependencies.js');
    const { up: up003 } = await import('../migrations/003-comments-and-estimates.js');
    const { up: up004 } = await import('../migrations/004-claim-protocol.js');
    const { up: up005 } = await import('../migrations/005-backlogged-status.js');
    const { up: up006 } = await import('../migrations/006-slack-channel-subscriptions.js');

    up001(db);
    await up002(db);
    await up003(db);
    await up004(db);
    await up005(db);
    await up006(db);

    // Seed: one done task, one open task
    const projectResult = db.prepare('INSERT INTO projects (name) VALUES (?)').run('P');
    const projectId = projectResult.lastInsertRowid;

    db.prepare(`
      INSERT INTO tasks (title, project_id, created_by, status, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('Done task', projectId, 'tester', 'done', '2026-01-15T12:00:00Z');

    db.prepare(`
      INSERT INTO tasks (title, project_id, created_by, status, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('Open task', projectId, 'tester', 'open', '2026-01-15T12:00:00Z');

    // Apply migration 007
    const { up: up007 } = await import('../migrations/007-completed-at.js');
    await up007(db);

    const doneRow = db
      .prepare('SELECT completed_at FROM tasks WHERE title = ?')
      .get('Done task') as { completed_at: string | null };
    const openRow = db
      .prepare('SELECT completed_at FROM tasks WHERE title = ?')
      .get('Open task') as { completed_at: string | null };

    expect(doneRow.completed_at).toBe('2026-01-15T12:00:00Z');
    expect(openRow.completed_at).toBeNull();
  });

  it('down migration drops the column and index', async () => {
    await runMigrations(db);

    const { down } = await import('../migrations/007-completed-at.js');
    await down(db);

    const cols = db
      .prepare("PRAGMA table_info('tasks')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).not.toContain('completed_at');

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_completed_at'"
      )
      .all() as { name: string }[];
    expect(indexes).toHaveLength(0);
  });
});
