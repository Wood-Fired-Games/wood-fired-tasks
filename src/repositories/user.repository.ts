import type Database from 'better-sqlite3';
import type { User } from '../types/identity.js';
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
  private listAllStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.findByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');

    this.findByOidcSubStmt = db.prepare(
      'SELECT * FROM users WHERE oidc_provider = ? AND oidc_sub = ?'
    );

    this.findBySlackUserIdStmt = db.prepare(
      'SELECT * FROM users WHERE slack_user_id = ?'
    );

    this.findLegacyByDisplayNameStmt = db.prepare(
      'SELECT * FROM users WHERE is_legacy = 1 AND display_name = ? LIMIT 1'
    );

    // ORDER BY id ASC LIMIT 1 makes "first match wins" deterministic in
    // v1.6 where `email` has no UNIQUE constraint. Phase 29's OIDC JIT
    // provisioning is expected to enforce uniqueness as it populates the
    // column; until then, the lowest-id row is the canonical resolution.
    this.findByEmailStmt = db.prepare(
      'SELECT * FROM users WHERE LOWER(email) = LOWER(?) ORDER BY id ASC LIMIT 1'
    );

    this.listAllStmt = db.prepare('SELECT * FROM users ORDER BY id ASC');
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
      throw new TypeError(
        'UserRepository.findByOidcSub: provider must be a non-empty string',
      );
    }
    if (sub == null || sub === '') {
      throw new TypeError(
        'UserRepository.findByOidcSub: sub must be a non-empty string',
      );
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
      throw new TypeError(
        'UserRepository.findByEmail: email must be a non-empty string',
      );
    }
    return mapRow<User>(this.findByEmailStmt, email) ?? null;
  }

  findLegacyByDisplayName(displayName: string): User | null {
    return mapRow<User>(this.findLegacyByDisplayNameStmt, displayName) ?? null;
  }

  listAll(): User[] {
    return mapRows<User>(this.listAllStmt);
  }
}
