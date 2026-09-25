import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from '../database.js';
import { runMigrations } from '../migrate.js';
import type Database from '../driver.js';

/**
 * Integration tests for migration 019: hash-chain columns on audit_events.
 *
 * Verifies (Security Audit finding M5, task #1636):
 *  - `prev_hash` and `row_hash` exist on audit_events after up(), and are
 *    nullable (see the migration's fail-closed rationale).
 *  - down() drops both columns while leaving the 018 table/indexes intact.
 *  - down() then up() restores the columns (round-trip).
 *  - the 018 append-only triggers survive up() AND down() byte-for-byte and
 *    still fire — this migration must not weaken them.
 */
describe('migration 019: audit_events hash chain', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);
  });

  function auditColumns(): Array<{ name: string; notnull: number; dflt_value: unknown }> {
    return db.prepare("PRAGMA table_info('audit_events')").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
  }

  function triggerSql(): Array<{ name: string; sql: string }> {
    return db
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type='trigger' AND tbl_name='audit_events' ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>;
  }

  it('adds prev_hash and row_hash to audit_events', () => {
    const names = auditColumns().map((c) => c.name);
    expect(names).toContain('prev_hash');
    expect(names).toContain('row_hash');
  });

  it('leaves the chain columns nullable with no default (fail-closed for out-of-band inserts)', () => {
    for (const column of ['prev_hash', 'row_hash']) {
      const def = auditColumns().find((c) => c.name === column);
      expect(def, `${column} must exist`).toBeDefined();
      expect(def?.notnull, `${column} must be nullable`).toBe(0);
      expect(def?.dflt_value, `${column} must have no default`).toBeNull();
    }
  });

  it('down() drops both chain columns but keeps the 018 table and indexes', async () => {
    const { down } = await import('../migrations/019-audit-events-hash-chain.js');
    await down(db);

    const names = auditColumns().map((c) => c.name);
    expect(names).not.toContain('prev_hash');
    expect(names).not.toContain('row_hash');
    // Migration 018's own surface is untouched.
    expect(names).toEqual(
      expect.arrayContaining(['id', 'timestamp', 'actor_type', 'actor_id', 'action']),
    );

    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_events'")
        .all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain('idx_audit_events_timestamp');
    expect(indexes).toContain('idx_audit_events_resource');
  });

  it('up() after down() restores the chain columns (round-trip)', async () => {
    const before = auditColumns();
    const { up, down } = await import('../migrations/019-audit-events-hash-chain.js');

    await down(db);
    await up(db);

    expect(auditColumns()).toEqual(before);
  });

  it('leaves the 018 append-only triggers defined byte-for-byte across down()/up()', async () => {
    const before = triggerSql();
    expect(before.map((t) => t.name)).toEqual(['audit_events_no_delete', 'audit_events_no_update']);

    const { up, down } = await import('../migrations/019-audit-events-hash-chain.js');
    await down(db);
    expect(triggerSql(), 'down() must not touch the append-only triggers').toEqual(before);
    await up(db);
    expect(triggerSql(), 'up() must not touch the append-only triggers').toEqual(before);
  });

  it('keeps the append-only triggers firing after the chain columns are added', () => {
    const id = db
      .prepare(
        `INSERT INTO audit_events
           (actor_type, actor_id, action, resource_type, prev_hash, row_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('user', 'user-1', 'task.create', 'task', 'a'.repeat(64), 'b'.repeat(64))
      .lastInsertRowid as number;

    expect(() =>
      db.prepare('UPDATE audit_events SET row_hash = ? WHERE id = ?').run('c'.repeat(64), id),
    ).toThrow(/append-only/i);
    expect(() => db.prepare('DELETE FROM audit_events WHERE id = ?').run(id)).toThrow(
      /append-only/i,
    );
  });
});
