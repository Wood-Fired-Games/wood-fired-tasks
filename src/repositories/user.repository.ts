import type Database from '../db/driver.js';
import type { User, UserUpsertInput } from '../types/identity.js';
import type { IUserRepository } from './interfaces.js';
import { mapRow, mapRows } from './row-mapper.js';

/**
 * Repository for the `users` table.
 *
 * Phase 27 shipped the original read methods (findById, findByOidcSub,
 * findBySlackUserId, findLegacyByDisplayName, listAll). Phase 28
 * (Plan 28-02) added `findByEmail` for the `tasks db mint-token` CLI's
 * `--user <id|email|displayName>` resolution. Write paths remain deferred
 * to Phase 29 (JIT OIDC provisioning) and Phase 30 (CLI device-code flow);
 * the Phase 27 boot-time seeder writes via a separate code path.
 */
export class UserRepository implements IUserRepository {
  private findByIdStmt: Database.Statement;
  private findByOidcSubStmt: Database.Statement;
  private findBySlackUserIdStmt: Database.Statement;
  private findLegacyByDisplayNameStmt: Database.Statement;
  private findByEmailStmt: Database.Statement;
  private findServiceAccountByNameStmt: Database.Statement;
  private listAllStmt: Database.Statement;
  private insertStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.findByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');

    this.findByOidcSubStmt = db.prepare(
      'SELECT * FROM users WHERE oidc_provider = ? AND oidc_sub = ?',
    );

    this.findBySlackUserIdStmt = db.prepare('SELECT * FROM users WHERE slack_user_id = ?');

    this.findLegacyByDisplayNameStmt = db.prepare(
      'SELECT * FROM users WHERE is_legacy = 1 AND display_name = ? LIMIT 1',
    );

    // ORDER BY id ASC LIMIT 1 makes "first match wins" deterministic in
    // v1.6 where `email` has no UNIQUE constraint. Phase 29's OIDC JIT
    // provisioning is expected to enforce uniqueness as it populates the
    // column; until then, the lowest-id row is the canonical resolution.
    this.findByEmailStmt = db.prepare(
      'SELECT * FROM users WHERE LOWER(email) = LOWER(?) ORDER BY id ASC LIMIT 1',
    );

    // Phase 31 (Plan 31-01): used by mcp-bot boot and slack-bot fallback to
    // resolve their service-account `users.id` once at startup. Case-sensitive
    // by design — display_name is a literal identifier ('mcp-bot',
    // 'slack-bot'), not a user-typed handle.
    this.findServiceAccountByNameStmt = db.prepare(
      'SELECT * FROM users WHERE is_service_account = 1 AND display_name = ? LIMIT 1',
    );

    this.listAllStmt = db.prepare('SELECT * FROM users ORDER BY id ASC');

    // Phase 29 (Plan 29-02): write methods for OIDC JIT provisioning.
    // `is_legacy` + `is_service_account` rely on the column DEFAULT 0;
    // `created_at` relies on DEFAULT (datetime('now')). RETURNING * gives
    // the caller the fully-populated row in one round trip.
    this.insertStmt = db.prepare(
      `INSERT INTO users (oidc_provider, oidc_sub, email, display_name)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
    );
  }

  findById(id: number): User | null {
    return mapRow<User>(this.findByIdStmt, id) ?? null;
  }

  /**
   * Looks up a user by their OIDC (provider, sub) pair.
   *
   * Both columns are nullable in the schema (legacy users with no OIDC binding
   * keep them NULL). The TypeScript signature already requires non-null
   * `string` params, but `oidc_provider = ? AND oidc_sub = ?` would silently
   * return zero rows if a caller bypassed the types and passed `null`
   * (because `NULL = NULL` is `NULL`, not true, in SQL). That silent
   * zero-row match is the classic "find legacy user with no OIDC mapping"
   * footgun called out in WR-03 of 27-REVIEW.md.
   *
   * Throw loudly on null/undefined/empty inputs so a type-bypass at the
   * callsite (`as any`, dynamic JSON input, etc.) fails fast instead of
   * leaking a meaningless "user not found".
   *
   * @throws TypeError when `provider` or `sub` is null, undefined, or empty.
   */
  findByOidcSub(provider: string, sub: string): User | null {
    if (provider == null || provider === '') {
      throw new TypeError('UserRepository.findByOidcSub: provider must be a non-empty string');
    }
    if (sub == null || sub === '') {
      throw new TypeError('UserRepository.findByOidcSub: sub must be a non-empty string');
    }
    return mapRow<User>(this.findByOidcSubStmt, provider, sub) ?? null;
  }

  findBySlackUserId(slackUserId: string): User | null {
    return mapRow<User>(this.findBySlackUserIdStmt, slackUserId) ?? null;
  }

  /**
   * Case-insensitive email lookup.
   *
   * v1.6 has no UNIQUE on `email` (deferred to Phase 29 when OIDC JIT
   * provisioning populates the column). `ORDER BY id ASC LIMIT 1` makes
   * the result deterministic when callers happen to seed two rows with
   * the same email: the lowest-id row wins.
   *
   * Null/empty input throws `TypeError` for the same reason
   * `findByOidcSub` does (WR-03 defense-in-depth): `LOWER(NULL) = LOWER('')`
   * would silently match no rows even if the caller meant "look up the
   * empty email", which is meaningless. Fail loud instead.
   *
   * @throws TypeError when `email` is null, undefined, or empty.
   */
  findByEmail(email: string): User | null {
    if (email == null || email === '') {
      throw new TypeError('UserRepository.findByEmail: email must be a non-empty string');
    }
    return mapRow<User>(this.findByEmailStmt, email) ?? null;
  }

  findLegacyByDisplayName(displayName: string): User | null {
    return mapRow<User>(this.findLegacyByDisplayNameStmt, displayName) ?? null;
  }

  /**
   * Lookup an `is_service_account=1` user by display_name. Returns null
   * silently for null/undefined/empty input — service-account names are
   * literal identifiers passed in by trusted callers (MCP boot, Slack
   * fallback) and an empty name simply means "no such service account".
   * Throwing here would force boot-time wrappers to add try/catch for a
   * condition that legitimately means "not seeded yet".
   *
   * Backed by the partial UNIQUE index `idx_users_slack_bot`
   * (UNIQUE(display_name) WHERE is_service_account = 1, migration 010),
   * so at most one row can match.
   */
  findServiceAccountByName(name: string): User | null {
    if (name == null || name === '') {
      return null;
    }
    return mapRow<User>(this.findServiceAccountByNameStmt, name) ?? null;
  }

  listAll(): User[] {
    return mapRows<User>(this.listAllStmt);
  }

  /**
   * Insert a new OIDC-provisioned user row.
   *
   * Defense-in-depth guards mirror `findByOidcSub` (WR-03): even though the
   * TypeScript signature requires non-empty strings, a caller bypass
   * (`as any`, dynamic JSON input) must NOT be able to write a row with an
   * empty provider/sub that would later look like a legacy NULL-NULL row.
   * Empty `display_name` would violate the column-NOT-NULL only if SQLite
   * rejected `''` (it does not), so the guard is application-level.
   *
   * UNIQUE(oidc_provider, oidc_sub) is partial-indexed in migration 008; a
   * duplicate insert raises `SqliteError` with `code === 'SQLITE_CONSTRAINT_UNIQUE'`.
   * The caller in Plan 29-05 (`user-upsert.ts`) catches that and resolves
   * the race via `findByOidcSub`.
   *
   * @throws TypeError when `provider`, `sub`, or `displayName` is null,
   *         undefined, or empty.
   */
  insert(input: UserUpsertInput): User {
    if (input.provider == null || input.provider === '') {
      throw new TypeError('UserRepository.insert: provider must be a non-empty string');
    }
    if (input.sub == null || input.sub === '') {
      throw new TypeError('UserRepository.insert: sub must be a non-empty string');
    }
    if (input.displayName == null || input.displayName === '') {
      throw new TypeError('UserRepository.insert: displayName must be a non-empty string');
    }
    const row = this.insertStmt.get(input.provider, input.sub, input.email, input.displayName) as
      | User
      | undefined;
    if (!row) {
      // Defensive: better-sqlite3's RETURNING * always populates on success.
      // If we somehow get here, surface it loudly rather than returning a
      // half-constructed object.
      throw new Error('UserRepository.insert: INSERT produced no row');
    }
    return row;
  }

  /**
   * Apply email + displayName drift to an existing row.
   *
   * The SET clause is built from a static allowlist (`email`, `display_name`)
   * so a malicious `patch` shape can never pivot into an unrelated column
   * (T-29-02-04). All values are bound as parameters; `id` is type-checked
   * before being interpolated.
   *
   * Patch semantics:
   * - `email` present → sets the column (including explicit `null` to clear).
   * - `displayName` present → sets the column (non-empty required because
   *   the column is NOT NULL).
   * - Neither present → returns the existing row unchanged (no SQL emitted).
   * - `id` does not exist → returns `null`.
   *
   * Never mutates oidc_provider/oidc_sub/created_at/is_legacy/
   * is_service_account/disabled_at — those columns are not in the SET
   * allowlist.
   *
   * @throws TypeError when `id` is not a positive integer, or when
   *         `patch.displayName` is supplied but null/empty.
   */
  updateProfile(id: number, patch: { email?: string | null; displayName?: string }): User | null {
    if (!Number.isInteger(id) || id <= 0) {
      throw new TypeError('UserRepository.updateProfile: id must be a positive integer');
    }
    const sets: string[] = [];
    const params: Array<string | null> = [];
    if (Object.prototype.hasOwnProperty.call(patch, 'email')) {
      sets.push('email = ?');
      params.push(patch.email ?? null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'displayName')) {
      if (patch.displayName == null || patch.displayName === '') {
        throw new TypeError(
          'UserRepository.updateProfile: displayName must be non-empty when supplied',
        );
      }
      sets.push('display_name = ?');
      params.push(patch.displayName);
    }
    if (sets.length === 0) {
      // No-op patch — return current row unchanged.
      return this.findById(id);
    }
    const sql = `UPDATE users SET ${sets.join(', ')} WHERE id = ? RETURNING *`;
    const row = this.db.prepare(sql).get(...params, id) as User | undefined;
    return row ?? null;
  }
}
