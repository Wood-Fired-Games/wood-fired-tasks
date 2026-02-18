import type Database from 'better-sqlite3';

export class SlackChannelSubscriptionRepository {
  private insertStmt: Database.Statement;
  private deleteByChannelAndProjectStmt: Database.Statement;
  private deleteByChannelStmt: Database.Statement;
  private findChannelsStmt: Database.Statement;
  private findByChannelStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(
      'INSERT OR IGNORE INTO slack_channel_subscriptions (channel_id, project_id, event_type) VALUES (?, ?, ?)'
    );

    this.deleteByChannelAndProjectStmt = db.prepare(
      'DELETE FROM slack_channel_subscriptions WHERE channel_id = ? AND project_id = ?'
    );

    this.deleteByChannelStmt = db.prepare(
      'DELETE FROM slack_channel_subscriptions WHERE channel_id = ?'
    );

    this.findChannelsStmt = db.prepare(
      'SELECT DISTINCT channel_id FROM slack_channel_subscriptions WHERE project_id = ? AND event_type = ?'
    );

    this.findByChannelStmt = db.prepare(
      'SELECT project_id, event_type, created_at FROM slack_channel_subscriptions WHERE channel_id = ? ORDER BY project_id, event_type'
    );
  }

  subscribe(channelId: string, projectId: number, eventTypes: string[]): void {
    const insertMany = this.db.transaction((types: string[]) => {
      for (const eventType of types) {
        this.insertStmt.run(channelId, projectId, eventType);
      }
    });
    insertMany(eventTypes);
  }

  unsubscribe(channelId: string, projectId?: number): number {
    if (projectId !== undefined) {
      const info = this.deleteByChannelAndProjectStmt.run(channelId, projectId);
      return info.changes;
    }
    const info = this.deleteByChannelStmt.run(channelId);
    return info.changes;
  }

  findSubscribedChannels(projectId: number, eventType: string): string[] {
    const rows = this.findChannelsStmt.all(projectId, eventType) as Array<{ channel_id: string }>;
    return rows.map((r) => r.channel_id);
  }

  findByChannel(channelId: string): Array<{ project_id: number; event_type: string; created_at: string }> {
    return this.findByChannelStmt.all(channelId) as Array<{
      project_id: number;
      event_type: string;
      created_at: string;
    }>;
  }
}
