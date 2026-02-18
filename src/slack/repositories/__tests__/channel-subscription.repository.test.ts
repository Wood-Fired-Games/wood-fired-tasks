import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { up } from '../../../db/migrations/006-slack-channel-subscriptions.js';
import { SlackChannelSubscriptionRepository } from '../channel-subscription.repository.js';

describe('SlackChannelSubscriptionRepository', () => {
  let db: Database.Database;
  let repo: SlackChannelSubscriptionRepository;

  beforeEach(async () => {
    db = new Database(':memory:');

    // Create minimal projects table for FK constraint
    db.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Insert test projects
    db.exec("INSERT INTO projects (id, name) VALUES (1, 'Test Project')");
    db.exec("INSERT INTO projects (id, name) VALUES (2, 'Second Project')");

    // Run migration to create slack_channel_subscriptions table
    await up(db);

    repo = new SlackChannelSubscriptionRepository(db);
  });

  // ── subscribe ────────────────────────────────────────────────────────────

  it('subscribe inserts rows for each event type', () => {
    repo.subscribe('C001', 1, ['task.created', 'task.status_changed']);

    const rows = repo.findByChannel('C001');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.event_type)).toEqual(
      expect.arrayContaining(['task.created', 'task.status_changed'])
    );
  });

  it('subscribe with duplicate event type does not throw (INSERT OR IGNORE)', () => {
    repo.subscribe('C001', 1, ['task.created']);
    expect(() => repo.subscribe('C001', 1, ['task.created'])).not.toThrow();

    // Still only one row
    const rows = repo.findByChannel('C001');
    expect(rows).toHaveLength(1);
  });

  // ── unsubscribe ──────────────────────────────────────────────────────────

  it('unsubscribe with projectId deletes only that project rows', () => {
    repo.subscribe('C001', 1, ['task.created']);
    repo.subscribe('C001', 2, ['task.created']);

    const removed = repo.unsubscribe('C001', 1);
    expect(removed).toBe(1);

    const rows = repo.findByChannel('C001');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.project_id).toBe(2);
  });

  it('unsubscribe without projectId deletes all rows for channel', () => {
    repo.subscribe('C001', 1, ['task.created', 'task.status_changed']);
    repo.subscribe('C001', 2, ['task.created']);

    const removed = repo.unsubscribe('C001');
    expect(removed).toBe(3);

    const rows = repo.findByChannel('C001');
    expect(rows).toHaveLength(0);
  });

  it('unsubscribe returns count of deleted rows', () => {
    repo.subscribe('C001', 1, ['task.created', 'task.status_changed']);

    const removed = repo.unsubscribe('C001', 1);
    expect(removed).toBe(2);
  });

  it('unsubscribe returns 0 if no rows matched', () => {
    const removed = repo.unsubscribe('C999', 1);
    expect(removed).toBe(0);
  });

  // ── findSubscribedChannels ───────────────────────────────────────────────

  it('findSubscribedChannels returns correct channel IDs for project+event', () => {
    repo.subscribe('C001', 1, ['task.created']);
    repo.subscribe('C002', 1, ['task.created']);
    repo.subscribe('C003', 1, ['task.status_changed']);

    const channels = repo.findSubscribedChannels(1, 'task.created');
    expect(channels).toEqual(expect.arrayContaining(['C001', 'C002']));
    expect(channels).toHaveLength(2);
  });

  it('findSubscribedChannels returns empty array when no subscriptions match', () => {
    const channels = repo.findSubscribedChannels(999, 'task.created');
    expect(channels).toEqual([]);
  });

  // ── findByChannel ────────────────────────────────────────────────────────

  it('findByChannel returns all subscriptions for a channel ordered by project_id then event_type', () => {
    repo.subscribe('C001', 2, ['task.status_changed']);
    repo.subscribe('C001', 1, ['task.created', 'task.status_changed']);

    const rows = repo.findByChannel('C001');
    expect(rows).toHaveLength(3);

    // Ordered by project_id ASC, then event_type ASC
    expect(rows[0]!.project_id).toBe(1);
    expect(rows[0]!.event_type).toBe('task.created');
    expect(rows[1]!.project_id).toBe(1);
    expect(rows[1]!.event_type).toBe('task.status_changed');
    expect(rows[2]!.project_id).toBe(2);
    expect(rows[2]!.event_type).toBe('task.status_changed');
  });

  it('findByChannel returns empty array for unknown channel', () => {
    const rows = repo.findByChannel('C999');
    expect(rows).toEqual([]);
  });
});
