import type Database from 'better-sqlite3';
import type { User } from '../types/identity.js';
import type { IUserRepository } from './interfaces.js';
import { mapRow, mapRows } from './row-mapper.js';

/**
 * Read-only repository for the `users` table (Phase 27 scope).
 *
 * Write paths are intentionally absent — they land in Phase 28 (PAT mint
 * command) and Phase 29 (JIT OIDC provisioning). The Phase 27 boot-time
 * seeder (Plan 6) writes via a separate code path that does not require
 * any write methods on this repository.
 */
export class UserRepository implements IUserRepository {
  private findByIdStmt: Database.Statement;
  private findByOidcSubStmt: Database.Statement;
  private findBySlackUserIdStmt: Database.Statement;
  private findLegacyByDisplayNameStmt: Database.Statement;
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

  findLegacyByDisplayName(displayName: string): User | null {
    return mapRow<User>(this.findLegacyByDisplayNameStmt, displayName) ?? null;
  }

  listAll(): User[] {
    return mapRows<User>(this.listAllStmt);
  }
}
