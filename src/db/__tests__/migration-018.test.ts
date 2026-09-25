import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from '../database.js';
import { runMigrations } from '../migrate.js';
import type Database from '../driver.js';

/**
 * Integration tests for migration 018: append-only audit_events table.
 *
 * Verifies (Security Audit finding M5):
 *  - audit_events exists with the full column set (timestamp, actor_type,
 *    actor_id, token_id, action, resource_type, resource_id, request_id,
 *    metadata).
 *  - idx_audit_events_timestamp and idx_audit_events_resource exist after
 *    up() and are gone after down().
 *  - the table itself is gone after down().
 *  - UPDATE against an inserted row throws (append-only enforcement).
 *  - DELETE against an inserted row throws (append-only enforcement).
 *  - down() then up() restores the schema (round-trip).
 */
describe('migration 018: audit_events append-only table', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);
  });

  function insertSampleRow(database: Database.Database): number {
    const res = database
      .prepare(
        `INSERT INTO audit_events
           (actor_type, actor_id, token_id, action, resource_type, resource_id, request_id, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'user',
        'user-123',
        'token-abc',
        'task.create',
        'task',
        'task-456',
        'req-789',
        JSON.stringify({ note: 'created via API' }),
      );
    return res.lastInsertRowid as number;
  }

  it('creates the audit_events table with the full column set', () => {
    const cols = db.prepare("PRAGMA table_info('audit_events')").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const names = cols.map((c) => c.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'timestamp',
        'actor_type',
        'actor_id',
        'token_id',
        'action',
        'resource_type',
        'resource_id',
        'request_id',
        'metadata',
      ]),
    );

    const notNullCols = new Set(cols.filter((c) => c.notnull === 1).map((c) => c.name));
    // Required columns per the M5 spec.
    expect(notNullCols.has('timestamp')).toBe(true);
    expect(notNullCols.has('actor_type')).toBe(true);
    expect(notNullCols.has('actor_id')).toBe(true);
    expect(notNullCols.has('action')).toBe(true);
    expect(notNullCols.has('resource_type')).toBe(true);
    // Nullable columns.
    expect(notNullCols.has('token_id')).toBe(false);
    expect(notNullCols.has('resource_id')).toBe(false);
    expect(notNullCols.has('request_id')).toBe(false);
    expect(notNullCols.has('metadata')).toBe(false);
  });

  it('creates idx_audit_events_timestamp and idx_audit_events_resource', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_events'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);

    expect(names).toContain('idx_audit_events_timestamp');
    expect(names).toContain('idx_audit_events_resource');
  });

  it('down() drops audit_events and its indexes', async () => {
    const { down } = await import('../migrations/018-audit-events.js');
    await down(db);

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events'")
      .all() as Array<{ name: string }>;
    expect(table).toHaveLength(0);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_audit_events_timestamp', 'idx_audit_events_resource')",
      )
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(0);
  });

  it('up() after down() restores the schema (round-trip)', async () => {
    interface ColumnDef {
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }
    const auditColumnDefs = () =>
      (db.prepare("PRAGMA table_info('audit_events')").all() as ColumnDef[]).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    const indexNames = () =>
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_events'")
          .all() as Array<{ name: string }>
      )
        .map((i) => i.name)
        .sort();

    const beforeCols = auditColumnDefs();
    const beforeIndexes = indexNames();
    expect(beforeCols.length).toBeGreaterThan(0);

    // 019 layers the hash-chain columns onto THIS table, so 018 can only be
    // round-tripped underneath it: unwind 019 first, then re-apply it after
    // 018 has rebuilt the table. Round-tripping 018 alone would compare the
    // 018-era column set against the 018+019 one and fail.
    const { up, down } = await import('../migrations/018-audit-events.js');
    const { up: up019, down: down019 } = await import(
      '../migrations/019-audit-events-hash-chain.js'
    );
    await down019(db);
    await down(db);
    await up(db);
    await up019(db);

    expect(auditColumnDefs()).toEqual(beforeCols);
    expect(indexNames()).toEqual(beforeIndexes);
  });

  it('throws on UPDATE against an inserted audit_events row', () => {
    const id = insertSampleRow(db);

    expect(() =>
      db.prepare('UPDATE audit_events SET action = ? WHERE id = ?').run('task.delete', id),
    ).toThrow(/append-only/i);
  });

  it('throws on DELETE against an inserted audit_events row', () => {
    const id = insertSampleRow(db);

    expect(() => db.prepare('DELETE FROM audit_events WHERE id = ?').run(id)).toThrow(
      /append-only/i,
    );
  });
});
