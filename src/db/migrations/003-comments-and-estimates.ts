import type Database from '../driver.js';

export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    // Create task_comments table
    db.exec(`
      CREATE TABLE task_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT
      )
    `);

    // Create composite index for chronological retrieval
    db.exec(`
      CREATE INDEX idx_comments_task_created ON task_comments(task_id, created_at)
    `);

    // Add estimated_minutes column to tasks table
    db.exec(`
      ALTER TABLE tasks ADD COLUMN estimated_minutes INTEGER
    `);
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    // Drop estimated_minutes column
    db.exec(`
      ALTER TABLE tasks DROP COLUMN estimated_minutes
    `);

    // Drop task_comments table (CASCADE will remove indexes)
    db.exec(`
      DROP TABLE task_comments
    `);
  })();
}
