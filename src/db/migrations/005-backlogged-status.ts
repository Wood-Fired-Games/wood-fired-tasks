import type Database from 'better-sqlite3';

export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    // SQLite does not support ALTER TABLE ... MODIFY COLUMN, so we must rebuild
    // the table to change the CHECK constraint on the status column.

    // Disable foreign key enforcement during the table rebuild
    db.pragma('foreign_keys = OFF');

    // Create the new tasks table with backlogged added to the CHECK constraint
    db.exec(`
      CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK(status IN ('open', 'in_progress', 'done', 'closed', 'blocked', 'backlogged')),
        priority TEXT NOT NULL DEFAULT 'medium'
          CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_task_id INTEGER REFERENCES tasks_new(id) ON DELETE CASCADE,
        assignee TEXT,
        created_by TEXT NOT NULL,
        due_date TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        estimated_minutes INTEGER,
        version INTEGER NOT NULL DEFAULT 1,
        claimed_at TEXT
      )
    `);

    // Copy all existing data into the new table
    db.exec(`
      INSERT INTO tasks_new
        SELECT id, title, description, status, priority, project_id, parent_task_id,
               assignee, created_by, due_date, created_at, updated_at,
               estimated_minutes, version, claimed_at
        FROM tasks
    `);

    // Drop FTS triggers BEFORE dropping the tasks table (triggers depend on it)
    db.exec('DROP TRIGGER IF EXISTS tasks_fts_insert');
    db.exec('DROP TRIGGER IF EXISTS tasks_fts_update');
    db.exec('DROP TRIGGER IF EXISTS tasks_fts_delete');

    // Drop the old table
    db.exec('DROP TABLE tasks');

    // Rename the new table to tasks
    db.exec('ALTER TABLE tasks_new RENAME TO tasks');

    // Recreate all indexes
    db.exec('CREATE INDEX idx_tasks_project_id ON tasks(project_id)');
    db.exec('CREATE INDEX idx_tasks_project_status_assignee ON tasks(project_id, status, assignee)');
    db.exec('CREATE INDEX idx_tasks_status_due_date ON tasks(status, due_date)');
    db.exec('CREATE INDEX idx_tasks_assignee ON tasks(assignee)');
    db.exec('CREATE INDEX idx_tasks_parent_id ON tasks(parent_task_id)');

    // Recreate all FTS triggers to keep the full-text search index in sync
    db.exec(`
      CREATE TRIGGER tasks_fts_insert AFTER INSERT ON tasks
      BEGIN
        INSERT INTO tasks_fts(rowid, title, description)
        VALUES (new.id, new.title, new.description);
      END
    `);

    db.exec(`
      CREATE TRIGGER tasks_fts_update AFTER UPDATE ON tasks
      BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
        VALUES('delete', old.id, old.title, old.description);
        INSERT INTO tasks_fts(rowid, title, description)
        VALUES (new.id, new.title, new.description);
      END
    `);

    db.exec(`
      CREATE TRIGGER tasks_fts_delete AFTER DELETE ON tasks
      BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
        VALUES('delete', old.id, old.title, old.description);
      END
    `);

    // Re-enable foreign key enforcement
    db.pragma('foreign_keys = ON');
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    // Disable foreign key enforcement during the table rebuild
    db.pragma('foreign_keys = OFF');

    // Update any backlogged tasks to open before removing the status
    db.exec(`UPDATE tasks SET status = 'open' WHERE status = 'backlogged'`);

    // Create the old tasks table schema (without backlogged in CHECK constraint)
    db.exec(`
      CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK(status IN ('open', 'in_progress', 'done', 'closed', 'blocked')),
        priority TEXT NOT NULL DEFAULT 'medium'
          CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        parent_task_id INTEGER REFERENCES tasks_new(id) ON DELETE CASCADE,
        assignee TEXT,
        created_by TEXT NOT NULL,
        due_date TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        estimated_minutes INTEGER,
        version INTEGER NOT NULL DEFAULT 1,
        claimed_at TEXT
      )
    `);

    // Copy all data into the reverted table
    db.exec(`
      INSERT INTO tasks_new
        SELECT id, title, description, status, priority, project_id, parent_task_id,
               assignee, created_by, due_date, created_at, updated_at,
               estimated_minutes, version, claimed_at
        FROM tasks
    `);

    // Drop FTS triggers BEFORE dropping the tasks table
    db.exec('DROP TRIGGER IF EXISTS tasks_fts_insert');
    db.exec('DROP TRIGGER IF EXISTS tasks_fts_update');
    db.exec('DROP TRIGGER IF EXISTS tasks_fts_delete');

    // Drop the current table and rename
    db.exec('DROP TABLE tasks');
    db.exec('ALTER TABLE tasks_new RENAME TO tasks');

    // Recreate all indexes
    db.exec('CREATE INDEX idx_tasks_project_id ON tasks(project_id)');
    db.exec('CREATE INDEX idx_tasks_project_status_assignee ON tasks(project_id, status, assignee)');
    db.exec('CREATE INDEX idx_tasks_status_due_date ON tasks(status, due_date)');
    db.exec('CREATE INDEX idx_tasks_assignee ON tasks(assignee)');
    db.exec('CREATE INDEX idx_tasks_parent_id ON tasks(parent_task_id)');

    // Recreate all FTS triggers
    db.exec(`
      CREATE TRIGGER tasks_fts_insert AFTER INSERT ON tasks
      BEGIN
        INSERT INTO tasks_fts(rowid, title, description)
        VALUES (new.id, new.title, new.description);
      END
    `);

    db.exec(`
      CREATE TRIGGER tasks_fts_update AFTER UPDATE ON tasks
      BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
        VALUES('delete', old.id, old.title, old.description);
        INSERT INTO tasks_fts(rowid, title, description)
        VALUES (new.id, new.title, new.description);
      END
    `);

    db.exec(`
      CREATE TRIGGER tasks_fts_delete AFTER DELETE ON tasks
      BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
        VALUES('delete', old.id, old.title, old.description);
      END
    `);

    // Re-enable foreign key enforcement
    db.pragma('foreign_keys = ON');
  })();
}
