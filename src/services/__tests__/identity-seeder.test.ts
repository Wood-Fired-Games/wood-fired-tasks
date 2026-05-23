import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { initTestDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { seedIdentities } from '../identity-seeder.js';

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
    it('seeds 2 legacy users + 1 slack-bot user for 2 API_KEYS entries', () => {
      const result = seedIdentities(
        db,
        [
          { key: 'k1', label: 'alice' },
          { key: 'k2', label: 'bob' },
        ],
        logger,
      );

      const legacyCount = (db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_legacy = 1').get() as { c: number }).c;
      const serviceCount = (db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_service_account = 1').get() as { c: number }).c;
      expect(legacyCount).toBe(2);
      expect(serviceCount).toBe(1);

      expect(result).toEqual({
        seeded: { legacy: 2, service: 1 },
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

      // Expect at least 3 info calls (2 legacy + 1 service). No noop summary on a first run.
      expect(logger.info.mock.calls.length).toBeGreaterThanOrEqual(3);

      // Each seeded-row call's first arg is the structured payload with event + kind.
      const seededCalls = logger.info.mock.calls.filter((call) => {
        const obj = call[0];
        return typeof obj === 'object' && obj !== null && (obj as { event?: string }).event === 'identity-seeded';
      });
      expect(seededCalls).toHaveLength(3);

      const kinds = seededCalls.map((call) => (call[0] as { kind: string }).kind).sort();
      expect(kinds).toEqual(['legacy', 'legacy', 'service']);

      // No noop summary on first run.
      const noopCalls = logger.info.mock.calls.filter((call) => {
        const obj = call[0];
        return typeof obj === 'object' && obj !== null && (obj as { event?: string }).event === 'identity-seed-noop';
      });
      expect(noopCalls).toHaveLength(0);
    });

    it('empty API_KEYS array still seeds the slack-bot row', () => {
      const result = seedIdentities(db, [], logger);

      const legacyCount = (db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_legacy = 1').get() as { c: number }).c;
      const serviceCount = (db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_service_account = 1').get() as { c: number }).c;
      expect(legacyCount).toBe(0);
      expect(serviceCount).toBe(1);
      expect(result.seeded.service).toBe(1);
      expect(result.seeded.legacy).toBe(0);
    });

    it('slack-bot row has display_name=slack-bot (literal lowercase)', () => {
      seedIdentities(db, [], logger);
      const row = db
        .prepare('SELECT display_name FROM users WHERE is_service_account = 1')
        .get() as { display_name: string };
      expect(row.display_name).toBe('slack-bot');
    });

    it('legacy row display_name equals entry.label verbatim', () => {
      seedIdentities(db, [{ key: 'secret', label: 'custom-label' }], logger);
      const row = db
        .prepare('SELECT display_name FROM users WHERE is_legacy = 1')
        .get() as { display_name: string };
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
      expect(total).toBe(3);
      expect(result).toEqual({
        seeded: { legacy: 0, service: 0 },
        alreadyPresent: { legacy: 2, service: 1 },
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
        counts: { legacy: 2, service: 1 },
      });
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

      expect(() =>
        seedIdentities(db, [{ key: 'k1', label: 'alice' }]),
      ).not.toThrow();

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
});
