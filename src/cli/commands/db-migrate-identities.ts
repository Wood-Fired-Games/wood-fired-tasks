/**
 * `tasks db migrate-identities` — offline backfill of identity FK columns.
 *
 * Phase 31 Plan 31-05 (MIGR-03/04). Scans the three TEXT identity columns
 * shipped by Phase 27 (`tasks.created_by`, `tasks.assignee`,
 * `task_comments.author`) and populates their parallel FK columns from
 * Migration 009 (`*_user_id`). Dry-run by default; `--commit` applies;
 * `--alias-map <file>` overrides per-string resolution; idempotent on re-run.
 *
 * Direct DB access via `initDatabase` — NO HTTP. Mirrors the pattern from
 * `db-mint-token.ts` (Phase 28).
 *
 * Resolution priority per TEXT value:
 *   1. alias-map[value] (operator override, validated as positive integer +
 *      pre-flight checked against `users.id`).
 *   2. users.email LIKE LOWER(value) — guarded by `value.includes('@')` to
 *      avoid `findByEmail` throwing on empty/null (Pitfall 6).
 *   3. users.display_name = value (exact, case-sensitive).
 *   4. --user-fallback strategy:
 *        - 'legacy' (default): pin to lowest-id `is_legacy=1` user. If none
 *          seeded (PAT-only deployment), exit 1 with a clear error before
 *          any DB write (RESEARCH §6 edge case).
 *        - 'skip': leave the FK NULL; row is reported as "skipped".
 *
 * Per-table transactions (CONTEXT decision) — a failure in one table doesn't
 * roll back mappings from earlier tables.
 *
 * Idempotency: every UPDATE carries `AND <fk_col> IS NULL AND <text_col> = ?`
 * so re-running with the same alias-map is a no-op (Pitfall 3).
 *
 * Security (T-31-13): table and column names come from a const allowlist;
 * all values are bound via `?` placeholders; alias-map values are validated
 * as `Number.isInteger` BEFORE binding. No interpolation of user input.
 */
import { Command } from 'commander';
import { readFileSync } from 'fs';
import type Database from '../../db/driver.js';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { resolveDbPath } from '../../config/db-path.js';
import { UserRepository } from '../../repositories/user.repository.js';
import '../config/env.js';

/** Per-table backfill descriptor — names come from this const allowlist
 * (NOT from user input) so the dynamic SQL build is safe from injection. */
const TABLES: ReadonlyArray<{
  table: 'tasks' | 'task_comments';
  textCol: 'created_by' | 'assignee' | 'author';
  fkCol: 'created_by_user_id' | 'assignee_user_id' | 'author_user_id';
}> = [
  { table: 'tasks', textCol: 'created_by', fkCol: 'created_by_user_id' },
  { table: 'tasks', textCol: 'assignee', fkCol: 'assignee_user_id' },
  {
    table: 'task_comments',
    textCol: 'author',
    fkCol: 'author_user_id',
  },
];

type FallbackStrategy = 'legacy' | 'skip';

interface ResolvedMapping {
  /** The legacy TEXT value (key in the WHERE clause). */
  value: string;
  /** Resolved user.id, or null when --user-fallback skip and unmatched. */
  userId: number | null;
  /** Count of rows that would be updated for this mapping. */
  rowCount: number;
  /** How the resolution happened — surfaced in plan output. */
  source: 'alias-map' | 'email' | 'display_name' | 'fallback-legacy' | 'skipped';
}

/** Load + validate the alias-map JSON. Returns a flat
 * `Record<string, number>` after enforcing every value is a positive integer.
 * Throws Error with a clear message on any malformedness (missing file,
 * non-JSON, non-integer value). */
function loadAliasMap(path: string): Record<string, number> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`--alias-map: cannot read file '${path}': ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--alias-map: file '${path}' is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `--alias-map: file '${path}' must contain a flat JSON object mapping legacy values to user IDs`,
    );
  }
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Number.isInteger(value) || (value as number) <= 0) {
      throw new Error(
        `--alias-map: value for '${key}' is not a positive integer (got ${JSON.stringify(value)})`,
      );
    }
    result[key] = value as number;
  }
  return result;
}

/** Pre-flight check: every alias-map user_id must exist in `users`. Avoids
 * a partial-commit where the first few mappings land then a later one
 * raises a FK constraint mid-transaction. */
function validateAliasMapUserIdsExist(
  db: Database.Database,
  aliasMap: Record<string, number>,
): void {
  const distinctIds = [...new Set(Object.values(aliasMap))];
  if (distinctIds.length === 0) return;
  const placeholders = distinctIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id FROM users WHERE id IN (${placeholders})`)
    .all(...distinctIds) as Array<{ id: number }>;
  const foundIds = new Set(rows.map((r) => r.id));
  const missing = distinctIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      `--alias-map: user_id(s) ${missing.join(', ')} not found in users table (FK pre-flight)`,
    );
  }
}

/** Look up the lowest-id `is_legacy=1` user, or null if none seeded. */
function findFirstLegacyUserId(db: Database.Database): number | null {
  const row = db
    .prepare(`SELECT id FROM users WHERE is_legacy = 1 ORDER BY id ASC LIMIT 1`)
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

/** Resolve a single TEXT value to a `user.id` according to the priority
 * order documented at the top of this file. Returns null when --user-fallback
 * skip and resolution falls through. */
function resolveValue(
  db: Database.Database,
  userRepo: UserRepository,
  value: string,
  aliasMap: Record<string, number> | null,
  fallbackUserId: number | null,
  strategy: FallbackStrategy,
): { userId: number | null; source: ResolvedMapping['source'] } {
  // 1. alias-map (highest priority).
  if (aliasMap && Object.prototype.hasOwnProperty.call(aliasMap, value)) {
    const aliasId = aliasMap[value];
    if (aliasId !== undefined) {
      return { userId: aliasId, source: 'alias-map' };
    }
  }

  // 2. Email match — guarded so findByEmail's null/empty throw is never hit.
  if (value.length > 0 && value.includes('@')) {
    try {
      const u = userRepo.findByEmail(value);
      if (u !== null) return { userId: u.id, source: 'email' };
    } catch {
      // Defensive: findByEmail throws on empty/null; the length+includes
      // guards above mean we should never get here, but if the repo's
      // contract tightens we fail soft.
    }
  }

  // 3. display_name exact match.
  if (value.length > 0) {
    const row = db.prepare(`SELECT id FROM users WHERE display_name = ? LIMIT 1`).get(value) as
      | { id: number }
      | undefined;
    if (row) return { userId: row.id, source: 'display_name' };
  }

  // 4. Fallback.
  if (strategy === 'skip') {
    return { userId: null, source: 'skipped' };
  }
  // strategy === 'legacy'
  if (fallbackUserId === null) {
    throw new Error(
      'No legacy users seeded; cannot use --user-fallback legacy. Provide --alias-map or --user-fallback skip.',
    );
  }
  return { userId: fallbackUserId, source: 'fallback-legacy' };
}

/** Scan distinct TEXT values WHERE the FK column IS NULL, count rows per
 * value, and resolve each. Sorted by rowCount DESC so operators see
 * highest-impact mappings first. */
function buildPlanForTable(
  db: Database.Database,
  userRepo: UserRepository,
  spec: (typeof TABLES)[number],
  aliasMap: Record<string, number> | null,
  fallbackUserId: number | null,
  strategy: FallbackStrategy,
): ResolvedMapping[] {
  // table + column come from the TABLES allowlist (NOT user input) so the
  // dynamic SQL build is safe.
  const rows = db
    .prepare(
      `SELECT ${spec.textCol} AS value, COUNT(*) AS row_count
         FROM ${spec.table}
        WHERE ${spec.fkCol} IS NULL
          AND ${spec.textCol} IS NOT NULL
        GROUP BY ${spec.textCol}`,
    )
    .all() as Array<{ value: string; row_count: number }>;

  const mappings: ResolvedMapping[] = rows.map((r) => {
    const resolution = resolveValue(db, userRepo, r.value, aliasMap, fallbackUserId, strategy);
    return {
      value: r.value,
      userId: resolution.userId,
      rowCount: r.row_count,
      source: resolution.source,
    };
  });

  mappings.sort((a, b) => b.rowCount - a.rowCount);
  return mappings;
}

/** Render a single mapping into a human-readable plan line. */
function renderMappingLine(m: ResolvedMapping, userLabelMap: Map<number, string>): string {
  const value = JSON.stringify(m.value);
  if (m.userId === null) {
    return `    ${value.padEnd(25)} → SKIPPED (no match)               ${m.rowCount} rows`;
  }
  const label = userLabelMap.get(m.userId) ?? `user-${m.userId}`;
  const sourceTag = m.source === 'fallback-legacy' ? ` [legacy fallback]` : '';
  return `    ${value.padEnd(25)} → user ${m.userId} (${label})${sourceTag}    ${m.rowCount} rows`;
}

/** Build a `users.id → display_name` lookup for plan rendering. */
function buildUserLabelMap(db: Database.Database): Map<number, string> {
  const rows = db.prepare(`SELECT id, display_name FROM users`).all() as Array<{
    id: number;
    display_name: string;
  }>;
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

/** Apply mappings via per-table transactions. Returns total rows updated.
 * Idempotent: WHERE clauses include `<fk_col> IS NULL` so re-runs are no-ops.
 *
 * `limit` (WR-03 clarification): the cap is PER TABLE, not per mapping —
 * `remaining` is a single counter shared across the loop over `toApply`.
 * The SQL's per-mapping `LIMIT ?` binding receives the table-level
 * remainder so a mapping that has more matching rows than `remaining`
 * still terminates at the table budget. Documented this way in --help.
 */
function applyMappings(
  db: Database.Database,
  spec: (typeof TABLES)[number],
  mappings: ResolvedMapping[],
  limit: number | undefined,
): { rowsUpdated: number } {
  // Filter mappings that have a resolved user_id (skip skipped).
  const toApply = mappings.filter((m) => m.userId !== null);
  if (toApply.length === 0) return { rowsUpdated: 0 };

  let totalUpdated = 0;
  let remaining = limit;

  const txn = db.transaction(() => {
    for (const m of toApply) {
      if (remaining !== undefined && remaining <= 0) break;
      let sql: string;
      let params: unknown[];
      if (remaining !== undefined) {
        // Apply a deterministic per-mapping cap using a subselect so
        // the LIMIT is applied to row id ordering, not to the UPDATE
        // (SQLite does not support `UPDATE ... LIMIT N` without a
        // compile-time flag).
        sql = `UPDATE ${spec.table}
                  SET ${spec.fkCol} = ?
                WHERE id IN (
                  SELECT id FROM ${spec.table}
                   WHERE ${spec.fkCol} IS NULL
                     AND ${spec.textCol} = ?
                   ORDER BY id ASC
                   LIMIT ?
                )`;
        params = [m.userId, m.value, remaining];
      } else {
        sql = `UPDATE ${spec.table}
                  SET ${spec.fkCol} = ?
                WHERE ${spec.fkCol} IS NULL
                  AND ${spec.textCol} = ?`;
        params = [m.userId, m.value];
      }
      const info = db.prepare(sql).run(...params);
      const changed = info.changes;
      totalUpdated += changed;
      if (remaining !== undefined) {
        remaining -= changed;
      }
    }
  });

  txn();
  return { rowsUpdated: totalUpdated };
}

export const dbMigrateIdentitiesCommand = new Command('migrate-identities')
  .description(
    'Backfill identity FK columns from legacy TEXT columns. Dry-run by default; --commit applies. Unmatched values default to the first-seeded legacy user (--user-fallback legacy). Override via --alias-map or --user-fallback skip.',
  )
  .option('--alias-map <path>', 'JSON file mapping legacy TEXT values to user IDs')
  .option('--commit', 'Apply changes; default is dry-run')
  .option(
    '--user-fallback <strategy>',
    'How to handle unmatched values: "legacy" or "skip"',
    'legacy',
  )
  .option(
    '--limit <n>',
    // WR-03: align help with implementation. The SQL has a per-mapping
    // LIMIT binding but `applyMappings` shares a single `remaining`
    // counter across the loop over mappings, so the budget is per-table
    // (whichever mappings iterate first consume the same N). Documented
    // as such here. See applyMappings() for the counter logic.
    'Cap rows processed per table, NOT per mapping (testing only)',
    (v) => parseInt(v, 10),
  )
  .action(
    async (opts: {
      aliasMap?: string;
      commit?: boolean;
      userFallback?: string;
      limit?: number;
    }) => {
      const dbPath = resolveDbPath();
      const db = initDatabase(dbPath);
      try {
        // WR-05: dry-run is supposed to be side-effect-free. Previously
        // `runMigrations(db)` ran unconditionally — meaning a "preview"
        // on a backup or production replica could silently advance the
        // schema. Gate the migration on --commit so dry-run is truly
        // read-only. Operators running --commit get the auto-migrate
        // they need; operators running --dry-run get a clean preview
        // (and a clear error from the planning SQL if the schema is
        // behind — migration 009's identity FK columns are required to
        // build the plan at all).
        if (opts.commit) {
          await runMigrations(db);
        }

        // Validate --user-fallback enum.
        const strategy: FallbackStrategy = opts.userFallback === 'skip' ? 'skip' : 'legacy';
        if (
          opts.userFallback !== undefined &&
          opts.userFallback !== 'skip' &&
          opts.userFallback !== 'legacy'
        ) {
          console.error(
            `--user-fallback: invalid value '${opts.userFallback}' (expected "legacy" or "skip")`,
          );
          process.exitCode = 1;
          return;
        }

        // Load + validate alias-map (if provided).
        let aliasMap: Record<string, number> | null = null;
        if (opts.aliasMap !== undefined) {
          try {
            aliasMap = loadAliasMap(opts.aliasMap);
            validateAliasMapUserIdsExist(db, aliasMap);
          } catch (err) {
            console.error((err as Error).message);
            process.exitCode = 1;
            return;
          }
        }

        // Resolve legacy fallback user (lowest-id is_legacy=1).
        const fallbackUserId = findFirstLegacyUserId(db);

        const userRepo = new UserRepository(db);
        const userLabelMap = buildUserLabelMap(db);

        // Build the per-table plan. Resolution can throw the empty-API_KEYS
        // edge case error; surface it BEFORE any write.
        const tablePlans: Array<{
          spec: (typeof TABLES)[number];
          mappings: ResolvedMapping[];
        }> = [];
        try {
          for (const spec of TABLES) {
            const mappings = buildPlanForTable(
              db,
              userRepo,
              spec,
              aliasMap,
              fallbackUserId,
              strategy,
            );
            tablePlans.push({ spec, mappings });
          }
        } catch (err) {
          console.error((err as Error).message);
          process.exitCode = 1;
          return;
        }

        // Render the plan (always — dry-run AND commit both show it first).
        const mode = opts.commit ? 'commit' : 'dry-run';
        console.log(
          mode === 'dry-run'
            ? 'Identity migration plan (dry-run):'
            : 'Applying identity migration (commit mode):',
        );
        console.log('');
        let planTotal = 0;
        for (const { spec, mappings } of tablePlans) {
          if (mappings.length === 0) continue;
          console.log(`  ${spec.table}.${spec.textCol}:`);
          for (const m of mappings) {
            console.log(renderMappingLine(m, userLabelMap));
            if (m.userId !== null) planTotal += m.rowCount;
          }
        }
        console.log('');

        if (mode === 'dry-run') {
          console.log(`Total rows that would be updated: ${planTotal}`);
          console.log('Run with --commit to apply.');
          return;
        }

        // --commit: per-table transactions.
        let appliedTotal = 0;
        for (const { spec, mappings } of tablePlans) {
          const { rowsUpdated } = applyMappings(db, spec, mappings, opts.limit);
          if (rowsUpdated > 0) {
            console.log(
              `  Updated ${rowsUpdated} rows in ${spec.table} (${spec.textCol} → ${spec.fkCol})`,
            );
          }
          appliedTotal += rowsUpdated;
        }
        console.log(`Done. Total rows updated: ${appliedTotal}.`);
      } finally {
        db.close();
      }
    },
  );
