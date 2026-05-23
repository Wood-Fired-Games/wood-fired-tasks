import type Database from 'better-sqlite3';
import type { ApiToken } from '../types/identity.js';
import type { IApiTokenRepository } from './interfaces.js';
import { mapRow, mapRows } from './row-mapper.js';

/**
 * Repository for the `api_tokens` table.
 *
 * Phase 27 shipped the read methods (`findById`, `findByHash`, `listByUser`).
 * Phase 28 (Plan 28-02) added the writes (`insert`, `revoke`,
 * `touchLastUsed`) that the auth chain, the `/me/tokens` API, and the
 * `tasks db mint-token` CLI all depend on.
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
  private insertStmt: Database.Statement;
  private revokeStmt: Database.Statement;
  private touchLastUsedStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.findByIdStmt = db.prepare('SELECT * FROM api_tokens WHERE id = ?');

    this.findByHashStmt = db.prepare(
      'SELECT * FROM api_tokens WHERE hash = ?'
    );

    this.listByUserStmt = db.prepare(
      'SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC'
    );

    this.insertStmt = db.prepare(
      'INSERT INTO api_tokens (user_id, name, prefix, suffix, hash, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    // Cross-user revoke isolation enforced at SQL: id AND user_id must
    // both match, and the row must not already be revoked. .changes === 1
    // ⇒ true; .changes === 0 ⇒ false (caller maps to 404 without leaking
    // whether the id exists for another user).
    this.revokeStmt = db.prepare(
      "UPDATE api_tokens SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL"
    );

    // Best-effort observational write. Auth chain has already verified the
    // token before reaching this method, so the id is trusted; no user_id
    // guard needed. A row that has been deleted between auth and this call
    // simply produces info.changes === 0 (no throw).
    this.touchLastUsedStmt = db.prepare(
      "UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?"
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

  insert(input: {
    userId: number;
    name: string;
    prefix: string;
    suffix: string;
    hash: string;
    scopes?: string;
    expiresAt?: string | null;
  }): ApiToken {
    const info = this.insertStmt.run(
      input.userId,
      input.name,
      input.prefix,
      input.suffix,
      input.hash,
      input.scopes ?? '[]',
      input.expiresAt ?? null
    );
    // The row is guaranteed to exist (we just inserted it). The non-null
    // assertion is the canonical pattern for "just-inserted row lookup" in
    // this codebase.
    return this.findById(Number(info.lastInsertRowid))!;
  }

  revoke(_id: number, _userId: number): boolean {
    throw new Error('not yet implemented (28-02 Task 2)');
  }

  touchLastUsed(_id: number): void {
    throw new Error('not yet implemented (28-02 Task 2)');
  }
}
