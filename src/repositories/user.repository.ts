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

  findByOidcSub(provider: string, sub: string): User | null {
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
