import Database from '../driver.js';

export function up(db: Database.Database): void {
  // Run all schema creation in a transaction
  const transaction = db.transaction(() => {
    // Create projects table
    db.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Create tasks table
    db.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK(status IN ('open', 'in_progress', 'done', 'closed', 'blocked')),
        priority TEXT NOT NULL DEFAULT 'medium'
          CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        assignee TEXT,
        created_by TEXT NOT NULL,
        due_date TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Create task_tags table
    db.exec(`
      CREATE TABLE task_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        UNIQUE(task_id, tag)
      )
    `);

    // Create indexes for common queries
    db.exec(`CREATE INDEX idx_tasks_project_id ON tasks(project_id)`);
    db.exec(`CREATE INDEX idx_tasks_project_status_assignee ON tasks(project_id, status, assignee)`);
    db.exec(`CREATE INDEX idx_tasks_status_due_date ON tasks(status, due_date)`);
    db.exec(`CREATE INDEX idx_tasks_assignee ON tasks(assignee)`);
    db.exec(`CREATE INDEX idx_task_tags_task_id ON task_tags(task_id)`);
    db.exec(`CREATE INDEX idx_task_tags_tag ON task_tags(tag)`);

    // Create FTS5 virtual table for full-text search
    db.exec(`
      CREATE VIRTUAL TABLE tasks_fts USING fts5(
        title,
        description,
        content='tasks',
        content_rowid='id'
      )
    `);

    // Create triggers to keep FTS5 table in sync with tasks table

    // Trigger: Insert into FTS when a new task is created
    db.exec(`
      CREATE TRIGGER tasks_fts_insert AFTER INSERT ON tasks
      BEGIN
        INSERT INTO tasks_fts(rowid, title, description)
        VALUES (new.id, new.title, new.description);
      END
    `);

    // Trigger: Update FTS when a task is updated (delete old, insert new)
    db.exec(`
      CREATE TRIGGER tasks_fts_update AFTER UPDATE ON tasks
      BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
        VALUES('delete', old.id, old.title, old.description);
        INSERT INTO tasks_fts(rowid, title, description)
        VALUES (new.id, new.title, new.description);
      END
    `);

    // Trigger: Delete from FTS when a task is deleted
    db.exec(`
      CREATE TRIGGER tasks_fts_delete AFTER DELETE ON tasks
      BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
        VALUES('delete', old.id, old.title, old.description);
      END
    `);
  });

  transaction();
}

export function down(db: Database.Database): void {
  // Drop everything in reverse order
  const transaction = db.transaction(() => {
    db.exec('DROP TRIGGER IF EXISTS tasks_fts_delete');
    db.exec('DROP TRIGGER IF EXISTS tasks_fts_update');
    db.exec('DROP TRIGGER IF EXISTS tasks_fts_insert');
    db.exec('DROP TABLE IF EXISTS tasks_fts');
    db.exec('DROP TABLE IF EXISTS task_tags');
    db.exec('DROP TABLE IF EXISTS tasks');
    db.exec('DROP TABLE IF EXISTS projects');
  });

  transaction();
}
