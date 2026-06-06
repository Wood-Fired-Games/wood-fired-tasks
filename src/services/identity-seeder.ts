import type Database from '../db/driver.js';
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
  seeded: { service: number };
  alreadyPresent: { service: number };
}

/**
 * Idempotent boot-time seeder for service-account users.
 *
 * Legacy API-key seeding was removed in Phase 0 (Task #801): the seeder no
 * longer creates `is_legacy` credential rows on boot. Any pre-existing
 * `is_legacy` rows are left inert (no migration). Only the service-account
 * rows are seeded going forward.
 *
 * The `entries` parameter is retained (and ignored) so the existing call site
 * in `src/index.ts` keeps compiling during integration; sibling task #800 is
 * removing `API_KEYS`/`parseApiKeyEntries` from `src/config/env.js`, after
 * which the caller will stop passing entries entirely.
 *
 * Behaviour:
 * - Unconditionally ensures `users` rows with
 *   `display_name = 'slack-bot', is_service_account = 1` AND
 *   `display_name = 'mcp-bot',   is_service_account = 1` exist.
 *   Both rows are seeded on every boot; `slack_user_id` stays NULL for both
 *   (Slack-side identity is resolved at message time, not boot time).
 * - All writes occur inside ONE `db.transaction(() => {})()` -- crashing
 *   mid-seed leaves the table untouched.
 * - First-run: emits one INFO line per seeded row, tagged `event: 'identity-seeded'`.
 * - Idempotent run (nothing new): emits one INFO summary tagged
 *   `event: 'identity-seed-noop'`.
 *
 * @param db - better-sqlite3 handle (caller owns lifecycle).
 * @param _entries - legacy API_KEYS entries; ignored (legacy seeding removed).
 * @param logger - optional structured logger; defaults to console-stub.
 * @returns counts of `seeded` (new) and `alreadyPresent` (skipped) rows.
 */
export function seedIdentities(
  db: Database.Database,
  _entries: ApiKeyEntry[] = [],
  logger: MinimalLogger = consoleStubLogger,
): IdentitySeedResult {
  // Idempotent INSERT ... ON CONFLICT DO NOTHING. info.changes is 1 when a
  // row was actually inserted, 0 when the partial UNIQUE index from
  // migration 010 (WR-04 of 27-REVIEW.md) suppressed the duplicate. The
  // backing partial UNIQUE index is:
  //   idx_users_slack_bot            UNIQUE(display_name) WHERE is_service_account = 1
  // Two concurrent boots will both attempt their INSERTs; the second one
  // becomes a DB-level no-op rather than producing a duplicate row.
  //
  // The conflict target is specified as `(display_name) WHERE ...` because
  // SQLite matches partial unique indexes by their predicate — the WHERE
  // clause is required for the index to be selected as the conflict target.
  //
  // Phase 31 (Plan 31-01): parameterised so the same prepared statement
  // seeds both 'slack-bot' AND 'mcp-bot'. The partial UNIQUE index
  // idx_users_slack_bot covers ANY service-account display_name, so the
  // conflict target works identically for both names.
  const insertServiceStmt = db.prepare(
    `INSERT INTO users (display_name, is_service_account)
     VALUES (?, 1)
     ON CONFLICT(display_name) WHERE is_service_account = 1 DO NOTHING`,
  );

  // The list of service-account display_names seeded on every boot. Order
  // matters for log determinism (slack-bot first, mcp-bot second) and matches
  // the historical 27-Phase ordering — slack-bot was seeded first, mcp-bot
  // is the Phase-31 addition.
  const SERVICE_ACCOUNT_NAMES = ['slack-bot', 'mcp-bot'] as const;

  // Buffer log events; emit AFTER the transaction commits so a rollback
  // doesn't leave misleading 'identity-seeded' lines in the log for rows
  // that were never persisted.
  interface PendingLog {
    kind: 'service';
    userId: number | bigint;
    displayName: string;
  }
  const pending: PendingLog[] = [];

  const result: IdentitySeedResult = {
    seeded: { service: 0 },
    alreadyPresent: { service: 0 },
  };

  db.transaction(() => {
    // Phase 31 (Plan 31-01): seed each service account by name. Each
    // `info.changes` is reported independently so the per-row event log
    // and seeded/alreadyPresent counters remain accurate.
    for (const name of SERVICE_ACCOUNT_NAMES) {
      const serviceInfo = insertServiceStmt.run(name);
      if (serviceInfo.changes > 0) {
        result.seeded.service += 1;
        pending.push({
          kind: 'service',
          userId: serviceInfo.lastInsertRowid,
          displayName: name,
        });
      } else {
        result.alreadyPresent.service += 1;
      }
    }
  })();

  const totalSeeded = result.seeded.service;
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
          service: result.alreadyPresent.service,
        },
      },
      'identity-seed-noop',
    );
  }

  return result;
}
