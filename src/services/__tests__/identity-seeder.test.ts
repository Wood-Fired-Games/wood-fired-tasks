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
 * Tests for the boot-time identity seeder.
 *
 * Legacy API-key seeding was removed in Phase 0 (Task #801): the seeder no
 * longer inserts `is_legacy` credential rows on boot. Only the two service
 * accounts (slack-bot, mcp-bot) are seeded.
 *
 * Goals:
 * - The seeder NEVER inserts an `is_legacy` row, regardless of input.
 * - Exactly one `slack-bot` and one `mcp-bot` row with `is_service_account=1`
 *   exist after boot.
 * - Idempotent: re-running produces 0 new rows.
 * - First-run emits one INFO line per seeded row tagged `event: 'identity-seeded'`.
 * - No-op run emits exactly one INFO summary tagged `event: 'identity-seed-noop'`.
 * - All writes wrapped in a SINGLE `db.transaction(() => {})` -- rollback on
 *   error leaves zero rows.
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
    it('seeds the two service accounts (slack-bot, mcp-bot) and zero legacy rows', () => {
      const result = seedIdentities(db, [], logger);

      const legacyCount = (
        db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_legacy = 1').get() as { c: number }
      ).c;
      const serviceCount = (
        db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_service_account = 1').get() as {
          c: number;
        }
      ).c;
      // Legacy seeding removed (Task #801): no is_legacy rows are ever created.
      expect(legacyCount).toBe(0);
      // BOTH slack-bot AND mcp-bot are seeded unconditionally.
      expect(serviceCount).toBe(2);

      expect(result).toEqual({
        seeded: { service: 2 },
        alreadyPresent: { service: 0 },
      });
    });

    it('inserts no is_legacy rows even when legacy entries are passed', () => {
      // Legacy entries are accepted for call-site compatibility but ignored.
      seedIdentities(
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
      expect(legacyCount).toBe(0);

      // 'alice'/'bob' must NOT have been persisted as users at all.
      const total = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
      expect(total).toBe(2); // only slack-bot + mcp-bot
    });

    it('logs one info line per seeded service row tagged event=identity-seeded', () => {
      seedIdentities(db, [], logger);

      // Expect exactly 2 info calls (2 service). No noop summary on a first run.
      const seededCalls = logger.info.mock.calls.filter((call) => {
        const obj = call[0];
        return (
          typeof obj === 'object' &&
          obj !== null &&
          (obj as { event?: string }).event === 'identity-seeded'
        );
      });
      expect(seededCalls).toHaveLength(2);

      const kinds = seededCalls.map((call) => (call[0] as { kind: string }).kind).sort();
      expect(kinds).toEqual(['service', 'service']);

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

    it('slack-bot row has is_service_account=1 and slack_user_id=NULL', () => {
      seedIdentities(db, [], logger);
      const row = db
        .prepare(
          "SELECT is_service_account, slack_user_id FROM users WHERE display_name = 'slack-bot'",
        )
        .get() as { is_service_account: number; slack_user_id: string | null };
      expect(row.is_service_account).toBe(1);
      expect(row.slack_user_id).toBeNull();
    });
  });

  describe('second run / idempotency', () => {
    it('second run inserts 0 new rows', () => {
      seedIdentities(db, [], logger);
      logger.info.mockClear();

      const result = seedIdentities(db, [], logger);

      const total = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
      // 2 service-account rows only.
      expect(total).toBe(2);
      expect(result).toEqual({
        seeded: { service: 0 },
        alreadyPresent: { service: 2 },
      });
    });

    it('second run logs exactly one identity-seed-noop summary line', () => {
      seedIdentities(db, [], logger);
      logger.info.mockClear();

      seedIdentities(db, [], logger);

      expect(logger.info).toHaveBeenCalledTimes(1);
      const [payload] = logger.info.mock.calls[0];
      expect(payload).toMatchObject({
        event: 'identity-seed-noop',
        counts: { service: 2 },
      });
    });

    it('both service rows persist across re-runs', () => {
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
      seedIdentities(db, [], logger);
      expect(db.inTransaction).toBe(false);
    });

    it('rolls back ALL inserts if any insert throws (single-transaction guarantee)', () => {
      // Monkey-patch db.prepare so the service-account insert throws. The
      // seeder must wrap everything in one transaction, so the rollback must
      // remove every service row it had begun inserting -- proving atomicity.
      const realPrepare = db.prepare.bind(db);
      const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const stmt = realPrepare(sql);
        // Target the service-account insert.
        if (/is_service_account/i.test(sql) && /INSERT/i.test(sql)) {
          return {
            ...stmt,
            run: (..._args: unknown[]) => {
              throw new Error('synthetic service insert failure');
            },
          } as unknown as Database.Statement;
        }
        return stmt;
      });

      expect(() => seedIdentities(db, [], logger)).toThrow(/synthetic service insert failure/);

      prepareSpy.mockRestore();

      // Re-issue prepare on the real db (the spy is gone) to verify zero rows
      // were persisted -- the transaction rolled everything back.
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

      expect(() => seedIdentities(db)).not.toThrow();

      infoSpy.mockRestore();
      warnSpy.mockRestore();
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
      const r1 = seedIdentities(db, [], logger);
      const r2 = seedIdentities(db, [], logger);

      // 2 service rows (slack-bot, mcp-bot).
      expect(r1.seeded).toEqual({ service: 2 });
      expect(r2.seeded).toEqual({ service: 0 });
      expect(r2.alreadyPresent).toEqual({ service: 2 });

      const total = (
        db.prepare('SELECT COUNT(*) AS c FROM users').get() as {
          c: number;
        }
      ).c;
      expect(total).toBe(2);
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

        const rA = seedIdentities(dbA, [], logger);
        const rB = seedIdentities(dbB, [], logger);

        // Whichever ran first did the inserts; whichever ran second
        // observed `alreadyPresent`. 2 service rows.
        expect(rA.seeded).toEqual({ service: 2 });
        expect(rB.seeded).toEqual({ service: 0 });
        expect(rB.alreadyPresent).toEqual({ service: 2 });

        const total = (dbB.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
        expect(total).toBe(2);
      } finally {
        if (dbA?.open) dbA.close();
        if (dbB?.open) dbB.close();
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});

/**
 * Smoke test: end-to-end verification that `createTestApp` actually runs the
 * seeder during boot and produces the expected service-account user set. This
 * exercises the wiring in src/index.ts without mocking anything -- it's the
 * closest in-process approximation of "does the server boot clean and seed?".
 *
 * Legacy seeding removed (Task #801): even when API_KEYS is set, no legacy
 * users are created -- only slack-bot and mcp-bot.
 */
describe('createTestApp boot integration (smoke)', () => {
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

  it('seeds only slack-bot AND mcp-bot (no legacy users) even when API_KEYS is set', async () => {
    process.env.API_KEYS = 'k1:alice,k2:bob';

    const app = await createTestApp();
    try {
      const rows = app.db.prepare('SELECT display_name FROM users ORDER BY display_name').all() as {
        display_name: string;
      }[];
      const names = rows.map((r) => r.display_name);
      // Legacy seeding removed: alice/bob are NOT created. Only the two
      // service accounts, sorted alphabetically: mcp-bot, slack-bot.
      expect(names).toEqual(['mcp-bot', 'slack-bot']);

      const legacyCount = (
        app.db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_legacy = 1').get() as {
          c: number;
        }
      ).c;
      expect(legacyCount).toBe(0);
    } finally {
      app.dispose();
    }
  });
});
