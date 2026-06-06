import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from '../database.js';
import { runMigrations } from '../migrate.js';
import type Database from '../driver.js';

describe('Database Initialization', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);
  });

  it('should enable foreign keys', () => {
    const result = db.pragma('foreign_keys', { simple: true });
    expect(result).toBe(1);
  });

  it('should create all required tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);

    // Should include our core tables
    expect(tableNames).toContain('projects');
    expect(tableNames).toContain('tasks');
    expect(tableNames).toContain('task_tags');
    expect(tableNames).toContain('tasks_fts');
    expect(tableNames).toContain('_migrations');
  });

  it('should create all required indexes', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as { name: string }[];

    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain('idx_tasks_project_id');
    expect(indexNames).toContain('idx_tasks_project_status_assignee');
    expect(indexNames).toContain('idx_tasks_status_due_date');
    expect(indexNames).toContain('idx_tasks_assignee');
    expect(indexNames).toContain('idx_task_tags_task_id');
    expect(indexNames).toContain('idx_task_tags_tag');
  });

  it('should enforce foreign key constraints', () => {
    // Try to insert a task without a project - should fail
    expect(() => {
      db.prepare(`
        INSERT INTO tasks (title, project_id, created_by)
        VALUES ('Test Task', 999, 'tester')
      `).run();
    }).toThrow();
  });

  it('should sync FTS5 table via triggers on insert', () => {
    // Insert a project first
    const projectResult = db.prepare('INSERT INTO projects (name) VALUES (?)').run('Test Project');
    const projectId = projectResult.lastInsertRowid;

    // Insert a task
    const taskResult = db
      .prepare(`
      INSERT INTO tasks (title, description, project_id, created_by)
      VALUES (?, ?, ?, ?)
    `)
      .run('Test Task', 'Test Description', projectId, 'tester');

    const taskId = taskResult.lastInsertRowid;

    // Verify FTS5 table has the data
    const ftsRows = db
      .prepare('SELECT rowid, title, description FROM tasks_fts WHERE rowid = ?')
      .all(taskId);
    expect(ftsRows).toHaveLength(1);
    expect(ftsRows[0]).toMatchObject({
      rowid: taskId,
      title: 'Test Task',
      description: 'Test Description',
    });
  });

  it('should sync FTS5 table via triggers on update', () => {
    // Setup: Insert project and task
    const projectResult = db.prepare('INSERT INTO projects (name) VALUES (?)').run('Test Project');
    const projectId = projectResult.lastInsertRowid;

    const taskResult = db
      .prepare(`
      INSERT INTO tasks (title, description, project_id, created_by)
      VALUES (?, ?, ?, ?)
    `)
      .run('Original Title', 'Original Description', projectId, 'tester');

    const taskId = taskResult.lastInsertRowid;

    // Update the task
    db.prepare('UPDATE tasks SET title = ?, description = ? WHERE id = ?').run(
      'Updated Title',
      'Updated Description',
      taskId,
    );

    // Verify FTS5 table has the updated data
    const ftsRows = db
      .prepare('SELECT rowid, title, description FROM tasks_fts WHERE rowid = ?')
      .all(taskId);
    expect(ftsRows).toHaveLength(1);
    expect(ftsRows[0]).toMatchObject({
      rowid: taskId,
      title: 'Updated Title',
      description: 'Updated Description',
    });
  });

  it('should sync FTS5 table via triggers on delete', () => {
    // Setup: Insert project and task
    const projectResult = db.prepare('INSERT INTO projects (name) VALUES (?)').run('Test Project');
    const projectId = projectResult.lastInsertRowid;

    const taskResult = db
      .prepare(`
      INSERT INTO tasks (title, description, project_id, created_by)
      VALUES (?, ?, ?, ?)
    `)
      .run('Test Task', 'Test Description', projectId, 'tester');

    const taskId = taskResult.lastInsertRowid;

    // Verify it's in FTS5
    let ftsRows = db.prepare('SELECT rowid FROM tasks_fts WHERE rowid = ?').all(taskId);
    expect(ftsRows).toHaveLength(1);

    // Delete the task
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);

    // Verify it's removed from FTS5
    ftsRows = db.prepare('SELECT rowid FROM tasks_fts WHERE rowid = ?').all(taskId);
    expect(ftsRows).toHaveLength(0);
  });

  it('should perform full-text search on tasks', () => {
    // Setup: Insert project and multiple tasks
    const projectResult = db.prepare('INSERT INTO projects (name) VALUES (?)').run('Test Project');
    const projectId = projectResult.lastInsertRowid;

    db.prepare(`
      INSERT INTO tasks (title, description, project_id, created_by)
      VALUES (?, ?, ?, ?)
    `).run('Implement authentication', 'Add JWT-based auth', projectId, 'dev1');

    db.prepare(`
      INSERT INTO tasks (title, description, project_id, created_by)
      VALUES (?, ?, ?, ?)
    `).run('Fix bug in login', 'User login fails', projectId, 'dev2');

    db.prepare(`
      INSERT INTO tasks (title, description, project_id, created_by)
      VALUES (?, ?, ?, ?)
    `).run('Update database schema', 'Add new fields', projectId, 'dev3');

    // Search for tasks containing "authentication" or "auth"
    const searchResults = db
      .prepare(`
      SELECT tasks.id, tasks.title
      FROM tasks
      JOIN tasks_fts ON tasks.id = tasks_fts.rowid
      WHERE tasks_fts MATCH ?
    `)
      .all('auth*') as { id: number; title: string }[];

    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults.some((r) => r.title.includes('authentication'))).toBe(true);
  });

  it('should cascade delete tasks when project is deleted', () => {
    // Setup: Insert project and task
    const projectResult = db.prepare('INSERT INTO projects (name) VALUES (?)').run('Test Project');
    const projectId = projectResult.lastInsertRowid;

    db.prepare(`
      INSERT INTO tasks (title, project_id, created_by)
      VALUES (?, ?, ?)
    `).run('Test Task', projectId, 'tester');

    // Verify task exists
    let tasks = db
      .prepare('SELECT COUNT(*) as count FROM tasks WHERE project_id = ?')
      .get(projectId) as { count: number };
    expect(tasks.count).toBe(1);

    // Delete the project
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);

    // Verify task was cascade deleted
    tasks = db
      .prepare('SELECT COUNT(*) as count FROM tasks WHERE project_id = ?')
      .get(projectId) as { count: number };
    expect(tasks.count).toBe(0);
  });
});
