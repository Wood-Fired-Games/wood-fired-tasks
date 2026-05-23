import type Database from 'better-sqlite3';
import type { ApiKeyEntry } from '../config/env.js';

/**
 * Minimal pino-compatible logger interface for the boot-time seeder.
 *
 * Unlike `slack.service.ts`'s MinimalLogger (which is `(msg: string, ...args)`),
 * this interface uses pino's object-first form: `info(obj, msg?)`. This matches
 * the structured-logging style documented in 27-RESEARCH.md section 5 / 27-PLAN-CHECK.md
 * warning W3 -- pino, FastifyBaseLogger, and the in-test `vi.fn()` mocks all
 * satisfy this shape.
 *
 * The seeder runs inside `createApp`, BEFORE Fastify is constructed, so there
 * is no `server.log` available yet. Callers may omit the logger entirely; a
 * console-stub default is used (matches the Umzug pattern in src/db/migrate.ts:
 * 101-106).
 */
export interface MinimalLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

/**
 * Default console-stub logger used when no logger is supplied. Matches the
 * Umzug pattern in src/db/migrate.ts:101-106 -- writes to stderr so that
 * structured-log output is interleavable with the migration logger.
 */
const consoleStubLogger: MinimalLogger = {
  info: (obj: object, msg?: string): void => {
    // MUST write to stderr -- the MCP server speaks JSON-RPC over stdout
    // and createApp() is invoked during MCP boot. Any stdout output here
    // corrupts the protocol stream (caught by stdio-compliance.test.ts).
    console.error('[identity-seeder]', msg ?? '', obj);
  },
  warn: (obj: object, msg?: string): void => {
    console.error('[identity-seeder]', msg ?? '', obj);
  },
};

export interface IdentitySeedResult {
  seeded: { legacy: number; service: number };
  alreadyPresent: { legacy: number; service: number };
}

/**
 * Idempotent boot-time seeder for legacy + service-account users.
 *
 * Behaviour (locked in 27-CONTEXT.md / 27-PLAN-CHECK.md):
 * - For each `API_KEYS` entry, ensures one `users` row with
 *   `display_name = entry.label, is_legacy = 1` exists.
 * - Unconditionally ensures one `users` row with
 *   `display_name = 'slack-bot', is_service_account = 1` exists.
 * - All writes occur inside ONE `db.transaction(() => {})()` -- crashing
 *   mid-seed leaves the table untouched.
 * - First-run: emits one INFO line per seeded row, tagged `event: 'identity-seeded'`.
 * - Idempotent run (nothing new): emits one INFO summary tagged
 *   `event: 'identity-seed-noop'`.
 * - The raw legacy key string is NEVER persisted or logged --
 *   only the label field is used.
 *
 * @param db - better-sqlite3 handle (caller owns lifecycle).
 * @param entries - parsed API_KEYS entries from `parseApiKeyEntries`.
 * @param logger - optional structured logger; defaults to console-stub.
 * @returns counts of `seeded` (new) and `alreadyPresent` (skipped) rows.
 */
export function seedIdentities(
  db: Database.Database,
  entries: ApiKeyEntry[],
  logger: MinimalLogger = consoleStubLogger,
): IdentitySeedResult {
  // Idempotent INSERT ... ON CONFLICT DO NOTHING. info.changes is 1 when a
  // row was actually inserted, 0 when the partial UNIQUE index from
  // migration 010 (WR-04 of 27-REVIEW.md) suppressed the duplicate. The
  // backing partial UNIQUE indexes are:
  //   idx_users_legacy_display_name  UNIQUE(display_name) WHERE is_legacy = 1
  //   idx_users_slack_bot            UNIQUE(display_name) WHERE is_service_account = 1
  // Two concurrent boots will both attempt their INSERTs; the second one
  // becomes a DB-level no-op rather than producing a duplicate row.
  //
  // The conflict target is specified as `(display_name) WHERE ...` because
  // SQLite matches partial unique indexes by their predicate — the WHERE
  // clause is required for the index to be selected as the conflict target.
  const insertLegacyStmt = db.prepare(
    `INSERT INTO users (display_name, is_legacy)
     VALUES (?, 1)
     ON CONFLICT(display_name) WHERE is_legacy = 1 DO NOTHING`,
  );

  const insertServiceStmt = db.prepare(
    `INSERT INTO users (display_name, is_service_account)
     VALUES ('slack-bot', 1)
     ON CONFLICT(display_name) WHERE is_service_account = 1 DO NOTHING`,
  );

  // Buffer log events; emit AFTER the transaction commits so a rollback
  // doesn't leave misleading 'identity-seeded' lines in the log for rows
  // that were never persisted.
  interface PendingLog {
    kind: 'legacy' | 'service';
    userId: number | bigint;
    displayName: string;
  }
  const pending: PendingLog[] = [];

  const result: IdentitySeedResult = {
    seeded: { legacy: 0, service: 0 },
    alreadyPresent: { legacy: 0, service: 0 },
  };

  db.transaction(() => {
    for (const entry of entries) {
      // Only `entry.label` is read -- the raw key string is never touched.
      const info = insertLegacyStmt.run(entry.label);
      if (info.changes > 0) {
        result.seeded.legacy += 1;
        pending.push({
          kind: 'legacy',
          userId: info.lastInsertRowid,
          displayName: entry.label,
        });
      } else {
        result.alreadyPresent.legacy += 1;
      }
    }

    const serviceInfo = insertServiceStmt.run();
    if (serviceInfo.changes > 0) {
      result.seeded.service += 1;
      pending.push({
        kind: 'service',
        userId: serviceInfo.lastInsertRowid,
        displayName: 'slack-bot',
      });
    } else {
      result.alreadyPresent.service += 1;
    }
  })();

  const totalSeeded = result.seeded.legacy + result.seeded.service;
  if (totalSeeded > 0) {
    for (const ev of pending) {
      logger.info(
        {
          event: 'identity-seeded',
          kind: ev.kind,
          userId: typeof ev.userId === 'bigint' ? Number(ev.userId) : ev.userId,
          displayName: ev.displayName,
        },
        'identity-seeded',
      );
    }
  } else {
    logger.info(
      {
        event: 'identity-seed-noop',
        counts: {
          legacy: result.alreadyPresent.legacy,
          service: result.alreadyPresent.service,
        },
      },
      'identity-seed-noop',
    );
  }

  return result;
}
