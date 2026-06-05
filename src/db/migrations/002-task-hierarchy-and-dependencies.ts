import Database from '../driver.js';

export function up(db: Database.Database): void {
  // Run all schema changes in a transaction
  const transaction = db.transaction(() => {
    // Add parent_task_id column for task hierarchy (subtasks)
    db.exec(`
      ALTER TABLE tasks
      ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE
    `);

    // Create index for efficient child task lookups
    db.exec(`CREATE INDEX idx_tasks_parent_id ON tasks(parent_task_id)`);

    // Create task_dependencies table for dependency tracking
    db.exec(`
      CREATE TABLE task_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        blocks_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(task_id, blocks_task_id),
        CHECK(task_id != blocks_task_id)
      )
    `);

    // Create indexes for efficient dependency lookups
    db.exec(`CREATE INDEX idx_dependencies_task ON task_dependencies(task_id)`);
    db.exec(`CREATE INDEX idx_dependencies_blocked ON task_dependencies(blocks_task_id)`);
  });

  transaction();
}

export function down(db: Database.Database): void {
  // Drop everything in reverse order
  const transaction = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS task_dependencies');

    // Drop the index that references parent_task_id BEFORE dropping the column.
    // SQLite refuses DROP COLUMN while an index still references it.
    // Discovered via the migrations-roundtrip schema-drift test (task 201).
    db.exec('DROP INDEX IF EXISTS idx_tasks_parent_id');

    // SQLite 3.35.0+ supports DROP COLUMN
    // better-sqlite3 12.x bundles SQLite 3.46+, so this is safe
    db.exec('ALTER TABLE tasks DROP COLUMN parent_task_id');
  });

  transaction();
}
