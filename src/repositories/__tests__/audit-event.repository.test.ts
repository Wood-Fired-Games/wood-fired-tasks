import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { AuditEventRepository } from '../audit-event.repository.js';
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
});
