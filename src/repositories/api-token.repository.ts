import type Database from 'better-sqlite3';
import type { ApiToken } from '../types/identity.js';
import type { IApiTokenRepository } from './interfaces.js';
import { mapRow, mapRows } from './row-mapper.js';

/**
 * Read-only repository for the `api_tokens` table (Phase 27 scope).
 *
 * Write paths (`mint`, `revoke`) intentionally absent — they land in Phase 28.
 *
 * `findByHash` deliberately does NOT pre-filter `revoked_at IS NULL`. The
 * Phase 28 auth chain applies that check at the strategy layer so the
 * failed-auth audit log can record a distinct `reasonCode: 'revoked'`
 * separate from `'unknown_token'`.
 */
export class ApiTokenRepository implements IApiTokenRepository {
  private findByIdStmt: Database.Statement;
  private findByHashStmt: Database.Statement;
  private listByUserStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.findByIdStmt = db.prepare('SELECT * FROM api_tokens WHERE id = ?');

    this.findByHashStmt = db.prepare(
      'SELECT * FROM api_tokens WHERE hash = ?'
    );

    this.listByUserStmt = db.prepare(
      'SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC'
    );
  }

  findById(id: number): ApiToken | null {
    return mapRow<ApiToken>(this.findByIdStmt, id) ?? null;
  }

  findByHash(hash: string): ApiToken | null {
    return mapRow<ApiToken>(this.findByHashStmt, hash) ?? null;
  }

  listByUser(userId: number): ApiToken[] {
    return mapRows<ApiToken>(this.listByUserStmt, userId);
  }
}
