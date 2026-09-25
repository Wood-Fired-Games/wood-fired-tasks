import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { AUDIT_CHAIN_GENESIS_HASH, AuditEventRepository } from '../audit-event.repository.js';
import type Database from '../../db/driver.js';
import type { AuditEventRecord } from '../interfaces.js';

describe('AuditEventRepository', () => {
  let db: Database.Database;
  let repo: AuditEventRepository;

  beforeEach(async () => {
    db = initDatabase(':memory:');
    await runMigrations(db);
    repo = new AuditEventRepository(db);
  });

  const baseRecord = (overrides: Partial<AuditEventRecord> = {}): AuditEventRecord => ({
    actorType: 'user',
    actorId: 'alice',
    action: 'task.create',
    resourceType: 'task',
    ...overrides,
  });

  it('round-trips an appended event with every field intact, including metadata', () => {
    const metadata = { before: null, after: { title: 'New Task' }, nested: { a: [1, 2, 3] } };
    const id = repo.append(
      baseRecord({
        actorId: 'alice',
        tokenId: 'tok_123',
        action: 'task.create',
        resourceType: 'task',
        resourceId: '42',
        requestId: 'req_abc',
        metadata,
      }),
    );

    expect(id).toBeGreaterThan(0);

    const [row] = repo.findByActor('alice', 10);
    expect(row).toBeDefined();
    expect(row.id).toBe(id);
    expect(row.actor_type).toBe('user');
    expect(row.actor_id).toBe('alice');
    expect(row.token_id).toBe('tok_123');
    expect(row.action).toBe('task.create');
    expect(row.resource_type).toBe('task');
    expect(row.resource_id).toBe('42');
    expect(row.request_id).toBe('req_abc');
    expect(row.timestamp).toBeTruthy();
    // The JSON metadata blob must round-trip as a parsed object, not a string.
    expect(row.metadata).toEqual(metadata);
  });

  it('leaves nullable fields null when omitted', () => {
    const id = repo.append(baseRecord());
    const [row] = repo.findByActor('alice', 10);

    expect(row.id).toBe(id);
    expect(row.token_id).toBeNull();
    expect(row.resource_id).toBeNull();
    expect(row.request_id).toBeNull();
    expect(row.metadata).toBeNull();
  });

  it('findByActor honours limit and returns rows newest-first', () => {
    const ids = [1, 2, 3, 4, 5].map((n) =>
      repo.append(baseRecord({ actorId: 'bob', action: `action.${n}` })),
    );

    const limited = repo.findByActor('bob', 2);
    expect(limited).toHaveLength(2);
    // Newest first: the last-appended id should come first.
    expect(limited[0].id).toBe(ids[4]);
    expect(limited[1].id).toBe(ids[3]);

    const all = repo.findByActor('bob', 100);
    expect(all).toHaveLength(5);
    expect(all.map((r) => r.id)).toEqual([...ids].reverse());
  });

  it('findByResource honours limit and returns rows newest-first', () => {
    const ids = [1, 2, 3].map((n) =>
      repo.append(
        baseRecord({
          actorId: `actor-${n}`,
          resourceType: 'project',
          resourceId: 'proj-1',
        }),
      ),
    );
    // Unrelated resource row that must not leak into the results.
    repo.append(baseRecord({ resourceType: 'project', resourceId: 'proj-2' }));

    const limited = repo.findByResource('project', 'proj-1', 2);
    expect(limited).toHaveLength(2);
    expect(limited[0].id).toBe(ids[2]);
    expect(limited[1].id).toBe(ids[1]);

    const all = repo.findByResource('project', 'proj-1', 100);
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.id)).toEqual([...ids].reverse());
  });

  it('findByTimeRange honours limit and returns rows newest-first within the inclusive bounds', () => {
    const ids = [1, 2, 3, 4].map((n) => repo.append(baseRecord({ actorId: `range-${n}` })));

    const [row] = repo.findByActor(`range-1`, 1);
    const start = row.timestamp;
    const end = row.timestamp;

    // All four rows share the same `datetime('now')`-resolution timestamp in
    // an in-memory test run, so the inclusive range covers every row.
    const inRange = repo.findByTimeRange(start, end, 2);
    expect(inRange).toHaveLength(2);
    expect(inRange[0].id).toBe(ids[3]);
    expect(inRange[1].id).toBe(ids[2]);

    const allInRange = repo.findByTimeRange(start, end, 100);
    expect(allInRange.map((r) => r.id)).toEqual([...ids].reverse());

    // A range strictly before any row excludes everything.
    expect(repo.findByTimeRange('2000-01-01', '2000-01-02', 100)).toHaveLength(0);
  });

  it('has no update or delete member on the exported interface', () => {
    expect((repo as unknown as { update?: unknown }).update).toBeUndefined();
    expect((repo as unknown as { delete?: unknown }).delete).toBeUndefined();
  });

  /**
   * Hash chain (Security Audit finding M5, task #1636).
   *
   * The tamper scenarios below have to reach the rows the way a real attacker
   * with write access to the SQLite file would — around migration 018's
   * append-only triggers, not through them. `tamperAroundTriggers` drops both
   * triggers, runs the raw SQL, then recreates them with the EXACT statements
   * from migration 018, which is precisely the capability the chain exists to
   * make evident.
   */
  describe('hash chain', () => {
    function tamperAroundTriggers(sql: string, ...params: unknown[]): void {
      db.exec('DROP TRIGGER audit_events_no_update');
      db.exec('DROP TRIGGER audit_events_no_delete');
      try {
        db.prepare(sql).run(...(params as never[]));
      } finally {
        db.exec(`
          CREATE TRIGGER audit_events_no_update
          BEFORE UPDATE ON audit_events
          BEGIN
            SELECT RAISE(ABORT, 'audit_events is append-only: UPDATE is not permitted');
          END
        `);
        db.exec(`
          CREATE TRIGGER audit_events_no_delete
          BEFORE DELETE ON audit_events
          BEGIN
            SELECT RAISE(ABORT, 'audit_events is append-only: DELETE is not permitted');
          END
        `);
      }
    }

    function appendSequence(): number[] {
      return [1, 2, 3, 4, 5].map((n) =>
        repo.append(
          baseRecord({
            actorId: `chain-actor-${n}`,
            action: `chain.action.${n}`,
            resourceId: `res-${n}`,
            metadata: { seq: n },
          }),
        ),
      );
    }

    it('reports an empty table as intact', () => {
      expect(repo.verifyChain()).toBeNull();
    });

    it('links the first row to the genesis value and each later row to its predecessor', () => {
      const ids = appendSequence();
      const rows = db
        .prepare('SELECT id, prev_hash, row_hash FROM audit_events ORDER BY id ASC')
        .all() as Array<{ id: number; prev_hash: string; row_hash: string }>;

      expect(rows.map((r) => r.id)).toEqual(ids);
      expect(rows[0].prev_hash).toBe(AUDIT_CHAIN_GENESIS_HASH);
      for (const row of rows) {
        expect(row.row_hash).toMatch(/^[0-9a-f]{64}$/);
      }
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].prev_hash, `row ${rows[i].id} must link to row ${rows[i - 1].id}`).toBe(
          rows[i - 1].row_hash,
        );
      }
    });

    it('verifies a freshly appended sequence as intact', () => {
      appendSequence();
      expect(repo.verifyChain()).toBeNull();
    });

    it('reports the mutated row as the first break when content is edited via raw SQL', () => {
      const ids = appendSequence();
      const target = ids[2];

      tamperAroundTriggers(
        'UPDATE audit_events SET action = ? WHERE id = ?',
        'tampered.action',
        target,
      );

      // The row's stored row_hash no longer matches its (edited) content.
      expect(repo.verifyChain()).toBe(target);
    });

    it('reports the mutated row as the first break when metadata is edited via raw SQL', () => {
      const ids = appendSequence();
      const target = ids[1];

      tamperAroundTriggers(
        'UPDATE audit_events SET metadata = ? WHERE id = ?',
        JSON.stringify({ seq: 999 }),
        target,
      );

      expect(repo.verifyChain()).toBe(target);
    });

    it('detects deletion of a middle row via raw SQL', () => {
      const ids = appendSequence();
      const deleted = ids[2];
      const successor = ids[3];

      tamperAroundTriggers('DELETE FROM audit_events WHERE id = ?', deleted);

      expect(db.prepare('SELECT COUNT(*) AS c FROM audit_events').get() as { c: number }).toEqual({
        c: 4,
      });
      // The survivor still commits to a predecessor that is no longer there,
      // so it is the first row whose link fails.
      expect(repo.verifyChain()).toBe(successor);
    });

    it('detects deletion of the first row via raw SQL', () => {
      const ids = appendSequence();

      tamperAroundTriggers('DELETE FROM audit_events WHERE id = ?', ids[0]);

      // The new head no longer links to the genesis value.
      expect(repo.verifyChain()).toBe(ids[1]);
    });

    it('reports a row inserted around the repository (NULL chain columns) as a break', () => {
      const ids = appendSequence();

      db.prepare(
        `INSERT INTO audit_events (actor_type, actor_id, action, resource_type)
         VALUES (?, ?, ?, ?)`,
      ).run('user', 'sneaky', 'task.delete', 'task');

      const breakAt = repo.verifyChain();
      expect(breakAt).not.toBeNull();
      expect(breakAt).toBeGreaterThan(ids[4]);
    });

    it('returns the FIRST break when several rows are tampered with', () => {
      const ids = appendSequence();

      tamperAroundTriggers('UPDATE audit_events SET actor_id = ? WHERE id = ?', 'mallory', ids[3]);
      tamperAroundTriggers('UPDATE audit_events SET actor_id = ? WHERE id = ?', 'mallory', ids[1]);

      expect(repo.verifyChain()).toBe(ids[1]);
    });
  });
});
