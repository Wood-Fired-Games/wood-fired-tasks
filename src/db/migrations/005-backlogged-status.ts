import type Database from '../driver.js';

/**
 * Child tables that hold an `ON DELETE CASCADE` foreign key to `tasks(id)` at
 * the point migration 005 runs (created by migrations 001–003):
 *   - task_tags (001), task_dependencies (002), task_comments (003).
 * They are snapshotted before the tasks-table rebuild and restored after — see
 * the data-loss note in up().
 */
const TASK_CHILD_TABLES = ['task_tags', 'task_dependencies', 'task_comments'] as const;

export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    // SQLite does not support ALTER TABLE ... MODIFY COLUMN, so we must rebuild
    // the table to change the CHECK constraint on the status column.

    // DATA-LOSS FIX (v2.0 release blocker M2): `PRAGMA foreign_keys = OFF` is a
    // NO-OP inside a transaction (SQLite ignores it until the outer transaction
    // commits), and this migration's `up()` runs inside `db.transaction()`.
    // With FK enforcement therefore still ON, the `DROP TABLE tasks` below
    // CASCADE-deletes every child row that references tasks(id) ON DELETE
    // CASCADE — task_comments, task_dependencies, task_tags — silently
    // destroying comments/dependencies/tags on a 1.x → 2.0 upgrade. The pragma
    // call is retained for documentation but cannot be relied on; instead we
    // snapshot those child rows here and restore any that get cascade-deleted
    // after the rebuild. The new tasks table preserves task ids verbatim
    // (INSERT copies id), so the restored child rows' FKs remain valid.
    db.pragma('foreign_keys = OFF');

    const savedChildren = snapshotChildTables(db);

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
    db.exec(
      'CREATE INDEX idx_tasks_project_status_assignee ON tasks(project_id, status, assignee)',
    );
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

    // Restore any child rows that were cascade-deleted by the `DROP TABLE tasks`
    // above (see the FK-pragma data-loss note in up()).
    restoreChildTables(db, savedChildren);

    // Re-enable foreign key enforcement
    db.pragma('foreign_keys = ON');
  })();
}

/** Snapshot of every tasks-child table's rows, keyed by table name. */
type ChildSnapshot = Record<string, Array<Record<string, unknown>>>;

/**
 * Capture all rows from each tasks-child table (task_tags / task_dependencies /
 * task_comments) before a tasks-table rebuild. Tables absent at this migration
 * point are skipped defensively.
 */
function snapshotChildTables(db: Database.Database): ChildSnapshot {
  const snapshot: ChildSnapshot = {};
  for (const table of TASK_CHILD_TABLES) {
    const exists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table);
    if (!exists) continue;
    snapshot[table] = db.prepare(`SELECT * FROM "${table}"`).all() as Array<
      Record<string, unknown>
    >;
  }
  return snapshot;
}

/**
 * Re-insert child rows captured by `snapshotChildTables`, skipping any that
 * already survived the rebuild (idempotent). Every child table here has an
 * `id INTEGER PRIMARY KEY AUTOINCREMENT` column captured by `SELECT *`, so we
 * re-insert with the original `id` preserved and skip ids that still exist.
 * Column names are read from each saved row object so this stays correct
 * regardless of the table's exact column set. Identifiers are quoted; values
 * bound. None of these child tables reference each other, so one pass suffices.
 */
function restoreChildTables(db: Database.Database, snapshot: ChildSnapshot): void {
  for (const table of TASK_CHILD_TABLES) {
    const saved = snapshot[table];
    if (!saved || saved.length === 0) continue;

    const surviving = new Set(
      (db.prepare(`SELECT id FROM "${table}"`).all() as Array<{ id: number }>).map((r) => r.id),
    );

    const columns = Object.keys(saved[0]!);
    const colList = columns.map((c) => `"${c}"`).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const insert = db.prepare(`INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`);

    for (const row of saved) {
      if (surviving.has(row['id'] as number)) continue;
      insert.run(columns.map((c) => row[c]));
    }
  }
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    // Disable foreign key enforcement during the table rebuild. NOTE: this is a
    // no-op inside a transaction (see up()'s data-loss note) — task_comments is
    // snapshotted and restored around the rebuild to survive the FK cascade.
    db.pragma('foreign_keys = OFF');

    const savedChildren = snapshotChildTables(db);

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
    db.exec(
      'CREATE INDEX idx_tasks_project_status_assignee ON tasks(project_id, status, assignee)',
    );
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

    // Restore any child rows cascade-deleted by the rebuild (see up()).
    restoreChildTables(db, savedChildren);

    // Re-enable foreign key enforcement
    db.pragma('foreign_keys = ON');
  })();
}
