import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from '../database.js';
import type Database from '../driver.js';

/**
 * Integration tests for migration 004: claim protocol.
 *
 * Data-semantic surface:
 * - Adds `version INTEGER NOT NULL DEFAULT 1` to tasks — existing rows MUST
 *   be backfilled to version=1 so the CAS claim protocol has a starting value.
 * - Adds `claimed_at TEXT` (nullable) — existing rows MUST be NULL, not the
 *   default `datetime('now')`, otherwise the auto-release sweep would
 *   immediately consider every pre-existing row as freshly claimed.
 * - Adds `idempotency_keys` table — purely additive, covered by round-trip.
 *
 * The generic round-trip snapshot covers schema shape; this file covers the
 * data backfill semantics of the column DEFAULTs against legacy rows.
 */
describe('Migration 004: Claim Protocol — data semantics', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initTestDatabase();
  });

  it('backfills version=1 and claimed_at=NULL for rows that existed before migration 004', async () => {
    const { up: up001 } = await import('../migrations/001-initial-schema.js');
    const { up: up002 } = await import('../migrations/002-task-hierarchy-and-dependencies.js');
    const { up: up003 } = await import('../migrations/003-comments-and-estimates.js');

    up001(db);
    await up002(db);
    await up003(db);

    const projectId = (db
      .prepare('INSERT INTO projects (name) VALUES (?)')
      .run('Pre-004 Project').lastInsertRowid) as number;

    db.prepare(
      `INSERT INTO tasks (title, project_id, created_by, status)
       VALUES (?, ?, ?, ?)`
    ).run('Legacy open task', projectId, 'tester', 'open');

    db.prepare(
      `INSERT INTO tasks (title, project_id, created_by, status)
       VALUES (?, ?, ?, ?)`
    ).run('Legacy in_progress task', projectId, 'tester', 'in_progress');

    const { up: up004 } = await import('../migrations/004-claim-protocol.js');
    await up004(db);

    const rows = db
      .prepare('SELECT title, version, claimed_at FROM tasks ORDER BY id')
      .all() as Array<{ title: string; version: number; claimed_at: string | null }>;

    expect(rows).toHaveLength(2);
    // Every pre-existing row must seed version=1 so a subsequent claim's CAS
    // (UPDATE ... WHERE version=?) has a known starting value.
    expect(rows[0].version).toBe(1);
    expect(rows[1].version).toBe(1);
    // claimed_at must be NULL on legacy rows — anything else would make the
    // auto-release sweep think every legacy task is already claimed.
    expect(rows[0].claimed_at).toBeNull();
    expect(rows[1].claimed_at).toBeNull();
  });
});
