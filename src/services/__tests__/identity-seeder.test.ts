import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from '../../db/driver.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, initTestDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { seedIdentities } from '../identity-seeder.js';
import { createTestApp } from '../../index.js';

/**
 * Tests for the Phase 27 boot-time identity seeder (Plan 6).
 *
 * Goals (IDENT-04, IDENT-05, MIGR-01):
 * - Each API_KEYS entry yields one `users` row with `display_name=label`,
 *   `is_legacy=1`.
 * - Exactly one `slack-bot` row with `is_service_account=1` exists, regardless
 *   of API_KEYS contents.
 * - Idempotent: re-running with the same input produces 0 new rows.
 * - First-run emits one INFO line per seeded row tagged `event: 'identity-seeded'`.
 * - No-op run emits exactly one INFO summary tagged `event: 'identity-seed-noop'`.
 * - All writes wrapped in a SINGLE `db.transaction(() => {})` -- rollback on
 *   error leaves zero rows.
 * - The legacy key string itself is NEVER persisted in any users row.
 */

interface MockLogger {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

function makeMockLogger(): MockLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('seedIdentities', () => {
  let db: Database.Database;
  let logger: MockLogger;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);
    logger = makeMockLogger();
  });

  afterEach(() => {
    if (db.open) {
      db.close();
    }
  });

  describe('first run', () => {
    it('seeds 2 legacy users + 2 service-account users (slack-bot, mcp-bot) for 2 API_KEYS entries', () => {
      const result = seedIdentities(
        db,
        [
          { key: 'k1', label: 'alice' },
          { key: 'k2', label: 'bob' },
        ],
        logger,
      );

      const legacyCount = (
        db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_legacy = 1').get() as { c: number }
      ).c;
      const serviceCount = (
        db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_service_account = 1').get() as {
          c: number;
        }
      ).c;
      expect(legacyCount).toBe(2);
      // Phase 31: BOTH slack-bot AND mcp-bot are seeded unconditionally.
      expect(serviceCount).toBe(2);

      expect(result).toEqual({
        seeded: { legacy: 2, service: 2 },
        alreadyPresent: { legacy: 0, service: 0 },
      });
    });

    it('logs one info line per seeded row tagged event=identity-seeded', () => {
      seedIdentities(
        db,
        [
          { key: 'k1', label: 'alice' },
          { key: 'k2', label: 'bob' },
        ],
        logger,
      );

      // Expect at least 4 info calls (2 legacy + 2 service). No noop summary on a first run.
      expect(logger.info.mock.calls.length).toBeGreaterThanOrEqual(4);

      // Each seeded-row call's first arg is the structured payload with event + kind.
      const seededCalls = logger.info.mock.calls.filter((call) => {
        const obj = call[0];
        return (
          typeof obj === 'object' &&
          obj !== null &&
          (obj as { event?: string }).event === 'identity-seeded'
        );
      });
      expect(seededCalls).toHaveLength(4);

      const kinds = seededCalls.map((call) => (call[0] as { kind: string }).kind).sort();
      expect(kinds).toEqual(['legacy', 'legacy', 'service', 'service']);

      // No noop summary on first run.
      const noopCalls = logger.info.mock.calls.filter((call) => {
        const obj = call[0];
        return (
          typeof obj === 'object' &&
          obj !== null &&
          (obj as { event?: string }).event === 'identity-seed-noop'
        );
      });
      expect(noopCalls).toHaveLength(0);
    });

    it('empty API_KEYS array still seeds both service-account rows (slack-bot, mcp-bot)', () => {
      const result = seedIdentities(db, [], logger);

      const legacyCount = (
        db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_legacy = 1').get() as { c: number }
      ).c;
      const serviceCount = (
        db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_service_account = 1').get() as {
          c: number;
        }
      ).c;
      expect(legacyCount).toBe(0);
      expect(serviceCount).toBe(2);
      expect(result.seeded.service).toBe(2);
      expect(result.seeded.legacy).toBe(0);
    });

    it('both service-account rows have the correct literal display_names', () => {
      seedIdentities(db, [], logger);
      const rows = db
        .prepare(
          'SELECT display_name FROM users WHERE is_service_account = 1 ORDER BY display_name',
        )
        .all() as { display_name: string }[];
      expect(rows.map((r) => r.display_name)).toEqual(['mcp-bot', 'slack-bot']);
    });

    it('mcp-bot row has is_service_account=1 and slack_user_id=NULL', () => {
      seedIdentities(db, [], logger);
      const row = db
        .prepare(
          "SELECT is_service_account, slack_user_id FROM users WHERE display_name = 'mcp-bot'",
        )
        .get() as { is_service_account: number; slack_user_id: string | null };
      expect(row.is_service_account).toBe(1);
      expect(row.slack_user_id).toBeNull();
    });

    it('legacy row display_name equals entry.label verbatim', () => {
      seedIdentities(db, [{ key: 'secret', label: 'custom-label' }], logger);
      const row = db.prepare('SELECT display_name FROM users WHERE is_legacy = 1').get() as {
        display_name: string;
      };
      expect(row.display_name).toBe('custom-label');
    });
  });

  describe('second run / idempotency', () => {
    it('second run with identical API_KEYS inserts 0 new rows', () => {
      const entries = [
        { key: 'k1', label: 'alice' },
        { key: 'k2', label: 'bob' },
      ];
      seedIdentities(db, entries, logger);
      logger.info.mockClear();

      const result = seedIdentities(db, entries, logger);

      const total = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
      // Phase 31: 2 legacy + 2 service-account rows.
      expect(total).toBe(4);
      expect(result).toEqual({
        seeded: { legacy: 0, service: 0 },
        alreadyPresent: { legacy: 2, service: 2 },
      });
    });

    it('second run logs exactly one identity-seed-noop summary line', () => {
      const entries = [
        { key: 'k1', label: 'alice' },
        { key: 'k2', label: 'bob' },
      ];
      seedIdentities(db, entries, logger);
      logger.info.mockClear();

      seedIdentities(db, entries, logger);

      expect(logger.info).toHaveBeenCalledTimes(1);
      const [payload] = logger.info.mock.calls[0];
      expect(payload).toMatchObject({
        event: 'identity-seed-noop',
        counts: { legacy: 2, service: 2 },
      });
    });

    it('mcp-bot row persists across re-runs (coexists with slack-bot)', () => {
      seedIdentities(db, [], logger);
      seedIdentities(db, [], logger);
      const rows = db
        .prepare(
          'SELECT display_name FROM users WHERE is_service_account = 1 ORDER BY display_name',
        )
        .all() as { display_name: string }[];
      expect(rows.map((r) => r.display_name)).toEqual(['mcp-bot', 'slack-bot']);
    });
  });

  describe('atomicity', () => {
    it('leaves db.inTransaction false before and after the call', () => {
      expect(db.inTransaction).toBe(false);
      seedIdentities(db, [{ key: 'k1', label: 'alice' }], logger);
      expect(db.inTransaction).toBe(false);
    });

    it('rolls back ALL inserts if any insert throws (single-transaction guarantee)', () => {
      // Monkey-patch db.prepare so the slack-bot insert throws AFTER the legacy
      // inserts have already run inside the same transaction. The seeder must
      // wrap everything in one transaction, so the rollback must remove the
      // legacy rows too -- proving atomicity.
      const realPrepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const stmt = realPrepare(sql);
        // Target the slack-bot insert (the only insert that mentions is_service_account).
        if (/is_service_account/i.test(sql) && /INSERT/i.test(sql)) {
          return {
            ...stmt,
            run: (..._args: unknown[]) => {
              throw new Error('synthetic slack-bot insert failure');
            },
          } as unknown as Database.Statement;
        }
        return stmt;
      });

      expect(() =>
        seedIdentities(
          db,
          [
            { key: 'k1', label: 'alice' },
            { key: 'k2', label: 'bob' },
          ],
          logger,
        ),
      ).toThrow(/synthetic slack-bot insert failure/);

      prepareSpy.mockRestore();

      // Re-issue prepare on the real db (the spy is gone) to verify zero rows
      // were persisted -- the transaction rolled the legacy inserts back too.
      const total = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
      expect(total).toBe(0);
      expect(db.inTransaction).toBe(false);
    });
  });

  describe('logger parameter is optional', () => {
    it('does not throw when called without a logger', () => {
      // Silence the console-stub default to keep test output clean.
      const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(() => seedIdentities(db, [{ key: 'k1', label: 'alice' }])).not.toThrow();

      infoSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  describe('secret hygiene', () => {
    it('does not persist the legacy key string anywhere in the users table', () => {
      const secret = 'secret-key-value-123';
      seedIdentities(db, [{ key: secret, label: 'alice' }], logger);

      const rows = db.prepare('SELECT * FROM users').all();
      const serialised = JSON.stringify(rows);
      expect(serialised).not.toContain(secret);
    });

    it('does not log the legacy key string in any info call payload', () => {
      const secret = 'secret-key-value-XYZ';
      seedIdentities(db, [{ key: secret, label: 'alice' }], logger);

      const serialised = JSON.stringify(logger.info.mock.calls);
      expect(serialised).not.toContain(secret);
    });
  });

  describe('concurrent-boot race safety (WR-04 / migration 010)', () => {
    // The pre-WR-04 implementation used `INSERT ... WHERE NOT EXISTS (...)`
    // for idempotency. Two concurrent boots could both pass the
    // WHERE-NOT-EXISTS subquery before either committed and both INSERT,
    // producing duplicate rows. The fix is the partial UNIQUE indexes in
    // migration 010 + `INSERT ... ON CONFLICT DO NOTHING` in the seeder.
    //
    // These tests exercise the DB-level guard directly. In a single-process
    // synchronous engine like better-sqlite3 we cannot reproduce a true
    // pre-commit race from JS, but we CAN verify the underlying guarantee:
    // a second INSERT that would have created a duplicate is silently
    // dropped at the DB layer (info.changes === 0) rather than producing
    // a duplicate row or throwing.

    it('raw concurrent-race scenario: second INSERT becomes a DB-level no-op (legacy)', () => {
      // Simulate "process A and process B both pass WHERE-NOT-EXISTS and
      // both INSERT": just issue the same INSERT twice. With the partial
      // UNIQUE index + ON CONFLICT DO NOTHING, the second one no-ops.
      const stmt = db.prepare(
        `INSERT INTO users (display_name, is_legacy)
         VALUES (?, 1)
         ON CONFLICT(display_name) WHERE is_legacy = 1 DO NOTHING`,
      );

      const r1 = stmt.run('alice');
      const r2 = stmt.run('alice');

      expect(r1.changes).toBe(1);
      expect(r2.changes).toBe(0);

      const count = (
        db
          .prepare('SELECT COUNT(*) AS c FROM users WHERE is_legacy = 1 AND display_name = ?')
          .get('alice') as { c: number }
      ).c;
      expect(count).toBe(1);
    });

    it('raw concurrent-race scenario: second INSERT becomes a DB-level no-op (slack-bot)', () => {
      const stmt = db.prepare(
        `INSERT INTO users (display_name, is_service_account)
         VALUES ('slack-bot', 1)
         ON CONFLICT(display_name) WHERE is_service_account = 1 DO NOTHING`,
      );

      const r1 = stmt.run();
      const r2 = stmt.run();

      expect(r1.changes).toBe(1);
      expect(r2.changes).toBe(0);

      const count = (
        db
          .prepare(
            'SELECT COUNT(*) AS c FROM users WHERE is_service_account = 1 AND display_name = ?',
          )
          .get('slack-bot') as { c: number }
      ).c;
      expect(count).toBe(1);
    });

    it('two seedIdentities calls on the SAME db both succeed and leave exactly one row per identity', () => {
      // Two seeders racing past `runMigrations` (which holds BEGIN EXCLUSIVE
      // only during migration application) is what WR-04 worried about.
      // The DB-level guard makes both seeders safe.
      const entries = [
        { key: 'k1', label: 'alice' },
        { key: 'k2', label: 'bob' },
      ];

      const r1 = seedIdentities(db, entries, logger);
      const r2 = seedIdentities(db, entries, logger);

      // Phase 31: 2 service rows (slack-bot, mcp-bot).
      expect(r1.seeded).toEqual({ legacy: 2, service: 2 });
      expect(r2.seeded).toEqual({ legacy: 0, service: 0 });
      expect(r2.alreadyPresent).toEqual({ legacy: 2, service: 2 });

      const total = (
        db.prepare('SELECT COUNT(*) AS c FROM users').get() as {
          c: number;
        }
      ).c;
      expect(total).toBe(4);
    });

    it('two connections to the same on-disk DB each run seedIdentities; result is one row per identity', async () => {
      // The closest in-process approximation of "two createApp() boots
      // against the shared data/tasks.db file": open two distinct
      // better-sqlite3 connections to the same file (WAL mode enabled by
      // initDatabase) and run runMigrations + seedIdentities on each.
      //
      // Each connection serialises its own transactions; the DB-level
      // partial UNIQUE indexes from migration 010 guarantee the second
      // boot's INSERTs no-op rather than produce duplicates.
      const tmp = mkdtempSync(join(tmpdir(), 'wft-seeder-race-'));
      const dbPath = join(tmp, 'race.db');
      let dbA: Database.Database | undefined;
      let dbB: Database.Database | undefined;
      try {
        dbA = initDatabase(dbPath);
        await runMigrations(dbA);

        // Second connection sees the same schema (migrations were committed
        // on dbA; WAL makes them visible to dbB without ceremony).
        dbB = initDatabase(dbPath);

        const entries = [
          { key: 'k1', label: 'alice' },
          { key: 'k2', label: 'bob' },
        ];

        const rA = seedIdentities(dbA, entries, logger);
        const rB = seedIdentities(dbB, entries, logger);

        // Whichever ran first did the inserts; whichever ran second
        // observed `alreadyPresent`. Phase 31: 2 service rows.
        expect(rA.seeded).toEqual({ legacy: 2, service: 2 });
        expect(rB.seeded).toEqual({ legacy: 0, service: 0 });
        expect(rB.alreadyPresent).toEqual({ legacy: 2, service: 2 });

        const total = (dbB.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
        expect(total).toBe(4);
      } finally {
        if (dbA?.open) dbA.close();
        if (dbB?.open) dbB.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});

/**
 * Task 6.4 smoke test: end-to-end verification that `createTestApp` actually
 * runs the seeder during boot and produces the expected user set when
 * API_KEYS is populated. This exercises the wiring done in src/index.ts
 * (Task 6.3) without mocking anything -- it's the closest in-process
 * approximation of "does the server boot clean and seed?".
 */
describe('createTestApp boot integration (Task 6.4 smoke)', () => {
  let prevApiKeys: string | undefined;

  beforeEach(() => {
    prevApiKeys = process.env.API_KEYS;
  });

  afterEach(() => {
    if (prevApiKeys === undefined) {
      delete process.env.API_KEYS;
    } else {
      process.env.API_KEYS = prevApiKeys;
    }
  });

  it('seeds alice + bob legacy users plus slack-bot AND mcp-bot when API_KEYS is set', async () => {
    process.env.API_KEYS = 'k1:alice,k2:bob';

    const app = await createTestApp();
    try {
      const rows = app.db.prepare('SELECT display_name FROM users ORDER BY display_name').all() as {
        display_name: string;
      }[];
      const names = rows.map((r) => r.display_name);
      // Phase 31: both service accounts seeded; sorted alphabetically:
      // alice, bob, mcp-bot, slack-bot.
      expect(names).toEqual(['alice', 'bob', 'mcp-bot', 'slack-bot']);
    } finally {
      app.dispose();
    }
  });
});
