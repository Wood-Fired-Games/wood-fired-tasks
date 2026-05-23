import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from '../database.js';
import { runMigrations } from '../migrate.js';
import type Database from 'better-sqlite3';

/**
 * Integration tests for migration 012: tasks.verification_evidence column.
 *
 * Verifies (Wave 1.4 of the Tasks System Reliability milestone):
 *  - tasks.verification_evidence exists as a nullable TEXT column.
 *  - No CHECK / DEFAULT / UNIQUE constraints — enum validation is enforced
 *    by the Zod schema at the service boundary, not by SQLite.
 *  - Existing rows (inserted with no verification_evidence) load with NULL.
 *  - Rows can round-trip a populated JSON-string value (preserving structure).
 *  - SQLite's json_extract sees the persisted verdict — used by the
 *    `?verified=` repository filter.
 *  - down() drops the column.
 *  - up() after down() restores the schema (round-trip).
 */
describe('migration 012: tasks.verification_evidence', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);
  });

  it('adds tasks.verification_evidence as nullable TEXT', () => {
    const cols = db
      .prepare("PRAGMA table_info('tasks')")
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>;
    const col = cols.find((c) => c.name === 'verification_evidence');
    expect(col).toBeDefined();
    expect(col?.type).toBe('TEXT');
    expect(col?.notnull).toBe(0);
    // No default value — caller must supply explicit NULL or a JSON string.
    expect(col?.dflt_value).toBeNull();
  });

  it('existing rows (inserted without verification_evidence) load with NULL value', () => {
    const projectId = db
      .prepare('INSERT INTO projects (name) VALUES (?)')
      .run('p').lastInsertRowid as number;

    const taskId = db
      .prepare(
        `INSERT INTO tasks (title, project_id, created_by) VALUES (?, ?, ?)`
      )
      .run('legacy task', projectId, 'tester').lastInsertRowid as number;

    const row = db
      .prepare('SELECT verification_evidence FROM tasks WHERE id = ?')
      .get(taskId) as { verification_evidence: string | null };
    expect(row.verification_evidence).toBeNull();
  });

  it('round-trips a populated JSON string verbatim', () => {
    const projectId = db
      .prepare('INSERT INTO projects (name) VALUES (?)')
      .run('p').lastInsertRowid as number;

    const evidence = JSON.stringify({
      verdict: 'PASS',
      checks: [
        { name: 'build', status: 'PASS', evidence_url_or_text: 'green' },
      ],
      verifier_session_id: 'sess-abc',
      verifier_request_id: 'req-123',
      verified_at: '2026-05-23T12:00:00.000Z',
    });

    const taskId = db
      .prepare(
        `INSERT INTO tasks (title, project_id, created_by, verification_evidence)
         VALUES (?, ?, ?, ?)`
      )
      .run('t', projectId, 'tester', evidence).lastInsertRowid as number;

    const row = db
      .prepare('SELECT verification_evidence FROM tasks WHERE id = ?')
      .get(taskId) as { verification_evidence: string | null };
    expect(row.verification_evidence).toBe(evidence);
  });

  it('json_extract reads the persisted verdict (filter contract)', () => {
    const projectId = db
      .prepare('INSERT INTO projects (name) VALUES (?)')
      .run('p').lastInsertRowid as number;

    const ids: number[] = [];
    for (const verdict of ['PASS', 'FAIL', 'PARTIAL', 'NOT_VERIFIED']) {
      const id = db
        .prepare(
          `INSERT INTO tasks (title, project_id, created_by, verification_evidence)
           VALUES (?, ?, ?, ?)`
        )
        .run(`t-${verdict}`, projectId, 'tester', JSON.stringify({ verdict }))
        .lastInsertRowid as number;
      ids.push(id);
    }

    const rows = db
      .prepare(
        `SELECT id, json_extract(verification_evidence, '$.verdict') AS v
         FROM tasks
         WHERE id IN (${ids.map(() => '?').join(',')})
         ORDER BY id`
      )
      .all(...ids) as Array<{ id: number; v: string }>;

    expect(rows.map((r) => r.v)).toEqual(['PASS', 'FAIL', 'PARTIAL', 'NOT_VERIFIED']);
  });

  it('updating verification_evidence from NULL -> value -> NULL works', () => {
    const projectId = db
      .prepare('INSERT INTO projects (name) VALUES (?)')
      .run('p').lastInsertRowid as number;
    const taskId = db
      .prepare(
        `INSERT INTO tasks (title, project_id, created_by) VALUES (?, ?, ?)`
      )
      .run('t', projectId, 'tester').lastInsertRowid as number;

    const evidence = JSON.stringify({ verdict: 'NOT_VERIFIED' });
    db.prepare('UPDATE tasks SET verification_evidence = ? WHERE id = ?').run(
      evidence,
      taskId
    );
    expect(
      (
        db
          .prepare('SELECT verification_evidence FROM tasks WHERE id = ?')
          .get(taskId) as { verification_evidence: string | null }
      ).verification_evidence
    ).toBe(evidence);

    db.prepare('UPDATE tasks SET verification_evidence = NULL WHERE id = ?').run(
      taskId
    );
    expect(
      (
        db
          .prepare('SELECT verification_evidence FROM tasks WHERE id = ?')
          .get(taskId) as { verification_evidence: string | null }
      ).verification_evidence
    ).toBeNull();
  });

  it('down() drops verification_evidence column', async () => {
    const { down } = await import('../migrations/012-verification-evidence.js');
    await down(db);

    const cols = db
      .prepare("PRAGMA table_info('tasks')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).not.toContain('verification_evidence');
    // Sanity: unrelated columns survive (including the sibling 011 column).
    expect(names).toContain('title');
    expect(names).toContain('description');
    expect(names).toContain('project_id');
    expect(names).toContain('acceptance_criteria');
  });

  it('up() after down() restores the schema (round-trip)', async () => {
    const before = db
      .prepare(
        `SELECT name, type, sql FROM sqlite_master
         WHERE type='table' AND name='tasks'`
      )
      .all();

    const { up, down } = await import(
      '../migrations/012-verification-evidence.js'
    );
    await down(db);
    await up(db);

    const after = db
      .prepare(
        `SELECT name, type, sql FROM sqlite_master
         WHERE type='table' AND name='tasks'`
      )
      .all();

    expect(after).toEqual(before);
  });
});
