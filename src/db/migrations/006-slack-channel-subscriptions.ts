import type Database from 'better-sqlite3';

export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE slack_channel_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(channel_id, project_id, event_type)
      )
    `);

    db.exec(`CREATE INDEX idx_slack_subs_channel_id ON slack_channel_subscriptions(channel_id)`);
    db.exec(`CREATE INDEX idx_slack_subs_project_id ON slack_channel_subscriptions(project_id)`);
    db.exec(`CREATE INDEX idx_slack_subs_event_type ON slack_channel_subscriptions(event_type)`);
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS slack_channel_subscriptions');
  })();
}
