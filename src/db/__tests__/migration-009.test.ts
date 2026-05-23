import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from '../database.js';
import { runMigrations } from '../migrate.js';
import type Database from 'better-sqlite3';

/**
 * Integration tests for migration 009: parallel FK columns.
 *
 * Verifies (per 27-02-PLAN.md + RESEARCH section 1, Option A):
 * - Exactly THREE new nullable INTEGER columns are added:
 *     tasks.created_by_user_id, tasks.assignee_user_id, task_comments.author_user_id
 * - NO tasks.claimer_user_id column (Option A — claim ownership is tasks.assignee).
 * - All three columns are nullable (notnull=0) — Phase 27 contract says they stay
 *   NULL until Phase 31 backfill.
 * - FK constraints reference users(id) for all three columns.
 * - Three new indexes exist for join performance: idx_tasks_created_by_user_id,
 *   idx_tasks_assignee_user_id, idx_task_comments_author_user_id.
 * - Existing TEXT columns (tasks.created_by, tasks.assignee, task_comments.author)
 *   are untouched (still present, same types/nullability).
 * - Inserting a row with NULL user_id columns succeeds (Phase 27 contract).
 * - Inserting a row referencing a non-existent users.id fails FK check.
 * - down() drops indexes BEFORE columns (SQLite DROP COLUMN constraint, see
 *   RESEARCH section 7 Pitfall 1 / migration 002).
 * - up() after down() restores schema (round-trip).
 */
describe('migration 009: parallel FK columns', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);
  });

  it('adds tasks.created_by_user_id as nullable INTEGER', () => {
    const cols = db
      .prepare("PRAGMA table_info('tasks')")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const col = cols.find((c) => c.name === 'created_by_user_id');
    expect(col).toBeDefined();
    expect(col?.type).toBe('INTEGER');
    expect(col?.notnull).toBe(0);
  });

  it('adds tasks.assignee_user_id as nullable INTEGER', () => {
    const cols = db
      .prepare("PRAGMA table_info('tasks')")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const col = cols.find((c) => c.name === 'assignee_user_id');
    expect(col).toBeDefined();
    expect(col?.type).toBe('INTEGER');
    expect(col?.notnull).toBe(0);
  });

  it('adds task_comments.author_user_id as nullable INTEGER', () => {
    const cols = db
      .prepare("PRAGMA table_info('task_comments')")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const col = cols.find((c) => c.name === 'author_user_id');
    expect(col).toBeDefined();
    expect(col?.type).toBe('INTEGER');
    expect(col?.notnull).toBe(0);
  });

  it('does NOT add tasks.claimer_user_id (Option A per RESEARCH section 1)', () => {
    const cols = db
      .prepare("PRAGMA table_info('tasks')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).not.toContain('claimer_user_id');
  });

  it('FK constraints on tasks reference users(id) for created_by_user_id and assignee_user_id', () => {
    const fks = db
      .prepare("PRAGMA foreign_key_list('tasks')")
      .all() as Array<{ table: string; from: string; to: string }>;

    const createdByFk = fks.find(
      (fk) => fk.from === 'created_by_user_id'
    );
    expect(createdByFk).toBeDefined();
    expect(createdByFk?.table).toBe('users');
    expect(createdByFk?.to).toBe('id');

    const assigneeFk = fks.find((fk) => fk.from === 'assignee_user_id');
    expect(assigneeFk).toBeDefined();
    expect(assigneeFk?.table).toBe('users');
    expect(assigneeFk?.to).toBe('id');
  });

  it('FK constraint on task_comments references users(id) for author_user_id', () => {
    const fks = db
      .prepare("PRAGMA foreign_key_list('task_comments')")
      .all() as Array<{ table: string; from: string; to: string }>;

    const authorFk = fks.find((fk) => fk.from === 'author_user_id');
    expect(authorFk).toBeDefined();
    expect(authorFk?.table).toBe('users');
    expect(authorFk?.to).toBe('id');
  });

  it('creates idx_tasks_created_by_user_id', () => {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_created_by_user_id'"
      )
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
  });

  it('creates idx_tasks_assignee_user_id', () => {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_assignee_user_id'"
      )
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
  });

  it('creates idx_task_comments_author_user_id', () => {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_task_comments_author_user_id'"
      )
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
  });

  it('existing TEXT columns are untouched', () => {
    const taskCols = db
      .prepare("PRAGMA table_info('tasks')")
      .all() as Array<{ name: string; type: string; notnull: number }>;

    const createdBy = taskCols.find((c) => c.name === 'created_by');
    expect(createdBy).toBeDefined();
    expect(createdBy?.type).toBe('TEXT');
    expect(createdBy?.notnull).toBe(1); // NOT NULL per migration 005

    const assignee = taskCols.find((c) => c.name === 'assignee');
    expect(assignee).toBeDefined();
    expect(assignee?.type).toBe('TEXT');
    expect(assignee?.notnull).toBe(0); // nullable per migration 005

    const commentCols = db
      .prepare("PRAGMA table_info('task_comments')")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const author = commentCols.find((c) => c.name === 'author');
    expect(author).toBeDefined();
    expect(author?.type).toBe('TEXT');
    expect(author?.notnull).toBe(1); // NOT NULL per migration 003
  });

  it('inserting a row with NULL user_id columns succeeds (Phase 27 contract: columns stay NULL)', () => {
    const projectId = db
      .prepare('INSERT INTO projects (name) VALUES (?)')
      .run('p').lastInsertRowid as number;

    // Insert task with both *_user_id columns omitted (NULL).
    const taskId = db
      .prepare(
        `INSERT INTO tasks (title, project_id, created_by) VALUES (?, ?, ?)`
      )
      .run('t', projectId, 'tester').lastInsertRowid as number;

    const row = db
      .prepare(
        'SELECT created_by_user_id, assignee_user_id FROM tasks WHERE id = ?'
      )
      .get(taskId) as {
      created_by_user_id: number | null;
      assignee_user_id: number | null;
    };
    expect(row.created_by_user_id).toBeNull();
    expect(row.assignee_user_id).toBeNull();

    // Same for task_comments.author_user_id.
    const commentRes = db
      .prepare(
        `INSERT INTO task_comments (task_id, author, content) VALUES (?, ?, ?)`
      )
      .run(taskId, 'tester', 'hi');
    const commentRow = db
      .prepare('SELECT author_user_id FROM task_comments WHERE id = ?')
      .get(commentRes.lastInsertRowid) as { author_user_id: number | null };
    expect(commentRow.author_user_id).toBeNull();
  });

  it('inserting a tasks row referencing a non-existent users.id fails FK check', () => {
    const projectId = db
      .prepare('INSERT INTO projects (name) VALUES (?)')
      .run('p').lastInsertRowid as number;

    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (title, project_id, created_by, assignee_user_id)
           VALUES (?, ?, ?, ?)`
        )
        .run('t', projectId, 'tester', 999)
    ).toThrow(/FOREIGN KEY/i);
  });

  it('inserting a task_comments row referencing a non-existent users.id fails FK check', () => {
    const projectId = db
      .prepare('INSERT INTO projects (name) VALUES (?)')
      .run('p').lastInsertRowid as number;
    const taskId = db
      .prepare(
        `INSERT INTO tasks (title, project_id, created_by) VALUES (?, ?, ?)`
      )
      .run('t', projectId, 'tester').lastInsertRowid as number;

    expect(() =>
      db
        .prepare(
          `INSERT INTO task_comments (task_id, author, content, author_user_id)
           VALUES (?, ?, ?, ?)`
        )
        .run(taskId, 'tester', 'hi', 999)
    ).toThrow(/FOREIGN KEY/i);
  });

  it('down() drops indexes BEFORE columns and removes all 3 columns + 3 indexes', async () => {
    const { down } = await import('../migrations/009-parallel-fk-columns.js');
    await down(db);

    // Columns removed.
    const taskCols = db
      .prepare("PRAGMA table_info('tasks')")
      .all() as Array<{ name: string }>;
    const taskColNames = taskCols.map((c) => c.name);
    expect(taskColNames).not.toContain('created_by_user_id');
    expect(taskColNames).not.toContain('assignee_user_id');

    const commentCols = db
      .prepare("PRAGMA table_info('task_comments')")
      .all() as Array<{ name: string }>;
    expect(commentCols.map((c) => c.name)).not.toContain('author_user_id');

    // Indexes removed.
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_tasks_created_by_user_id', 'idx_tasks_assignee_user_id', 'idx_task_comments_author_user_id')"
      )
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(0);

    // Legacy TEXT columns survive.
    expect(taskColNames).toContain('created_by');
    expect(taskColNames).toContain('assignee');
    expect(commentCols.map((c) => c.name)).toContain('author');
  });

  it('up() after down() restores schema (round-trip)', async () => {
    const before = db
      .prepare(
        `SELECT name, type, sql FROM sqlite_master
         WHERE name IN ('idx_tasks_created_by_user_id','idx_tasks_assignee_user_id','idx_task_comments_author_user_id')
            OR (type='table' AND name IN ('tasks','task_comments'))
         ORDER BY type, name`
      )
      .all();

    const { up, down } = await import(
      '../migrations/009-parallel-fk-columns.js'
    );
    await down(db);
    await up(db);

    const after = db
      .prepare(
        `SELECT name, type, sql FROM sqlite_master
         WHERE name IN ('idx_tasks_created_by_user_id','idx_tasks_assignee_user_id','idx_task_comments_author_user_id')
            OR (type='table' AND name IN ('tasks','task_comments'))
         ORDER BY type, name`
      )
      .all();

    expect(after).toEqual(before);
  });
});
