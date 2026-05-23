import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ApiTokenRepository } from '../api-token.repository.js';

/**
 * Helper: insert a parent users row (FK satisfaction for api_tokens.user_id).
 */
function insertUser(
  db: Database.Database,
  display_name: string,
  id?: number
): number {
  const stmt = db.prepare(`
    INSERT INTO users (id, display_name, is_legacy)
    VALUES (?, ?, 1)
  `);
  const info = stmt.run(id ?? null, display_name);
  return info.lastInsertRowid as number;
}

/**
 * Helper: insert a raw api_tokens row. Repository under test is read-only.
 */
function insertToken(
  db: Database.Database,
  row: {
    id?: number;
    user_id: number;
    name: string;
    prefix?: string;
    suffix?: string;
    hash: string;
    scopes?: string;
    created_at?: string;
    last_used_at?: string | null;
    revoked_at?: string | null;
    expires_at?: string | null;
  }
): number {
  const stmt = db.prepare(`
    INSERT INTO api_tokens (
      id, user_id, name, prefix, suffix, hash, scopes,
      created_at, last_used_at, revoked_at, expires_at
    ) VALUES (
      @id, @user_id, @name, @prefix, @suffix, @hash, @scopes,
      @created_at, @last_used_at, @revoked_at, @expires_at
    )
  `);
  const info = stmt.run({
    id: row.id ?? null,
    user_id: row.user_id,
    name: row.name,
    prefix: row.prefix ?? 'wfb_pat_',
    suffix: row.suffix ?? 'abcd',
    hash: row.hash,
    scopes: row.scopes ?? '[]',
    created_at: row.created_at ?? new Date().toISOString(),
    last_used_at: row.last_used_at ?? null,
    revoked_at: row.revoked_at ?? null,
    expires_at: row.expires_at ?? null,
  });
  return info.lastInsertRowid as number;
}

describe('ApiTokenRepository', () => {
  let db: Database.Database;
  let repo: ApiTokenRepository;
  let userId: number;

  beforeEach(async () => {
    db = initDatabase(':memory:');
    await runMigrations(db);
    repo = new ApiTokenRepository(db);
    userId = insertUser(db, 'token-owner');
  });

  describe('findById', () => {
    it('returns inserted token', () => {
      const tokenId = insertToken(db, {
        user_id: userId,
        name: 'laptop',
        hash: 'hash-abc-123',
      });

      const token = repo.findById(tokenId);

      expect(token).not.toBeNull();
      expect(token!.id).toBe(tokenId);
      expect(token!.user_id).toBe(userId);
      expect(token!.name).toBe('laptop');
      expect(token!.hash).toBe('hash-abc-123');
      expect(token!.prefix).toBe('wfb_pat_');
      expect(token!.scopes).toBe('[]');
      expect(token!.revoked_at).toBeNull();
      expect(token!.last_used_at).toBeNull();
      expect(token!.expires_at).toBeNull();
    });

    it('returns null for missing id', () => {
      const result = repo.findById(999);
      expect(result).toBeNull();
    });
  });

  describe('findByHash', () => {
    it('returns the token for a known hash', () => {
      insertToken(db, {
        user_id: userId,
        name: 'ci',
        hash: 'sha256-known-hash',
      });

      const match = repo.findByHash('sha256-known-hash');
      expect(match).not.toBeNull();
      expect(match!.name).toBe('ci');
      expect(match!.hash).toBe('sha256-known-hash');
    });

    it('returns null for unknown hash', () => {
      const result = repo.findByHash('nonexistent-hash');
      expect(result).toBeNull();
    });

    it('does NOT pre-filter revoked tokens (Phase 28 layer responsibility)', () => {
      insertToken(db, {
        user_id: userId,
        name: 'revoked-token',
        hash: 'revoked-hash',
        revoked_at: '2026-01-01T00:00:00.000Z',
      });

      const match = repo.findByHash('revoked-hash');
      expect(match).not.toBeNull();
      expect(match!.revoked_at).toBe('2026-01-01T00:00:00.000Z');
    });
  });

  describe('listByUser', () => {
    it('returns tokens for user ordered by created_at DESC (newest first)', () => {
      insertToken(db, {
        user_id: userId,
        name: 'oldest',
        hash: 'hash-old',
        created_at: '2026-01-01T00:00:00.000Z',
      });
      insertToken(db, {
        user_id: userId,
        name: 'newest',
        hash: 'hash-new',
        created_at: '2026-03-01T00:00:00.000Z',
      });
      insertToken(db, {
        user_id: userId,
        name: 'middle',
        hash: 'hash-mid',
        created_at: '2026-02-01T00:00:00.000Z',
      });

      const tokens = repo.listByUser(userId);

      expect(tokens).toHaveLength(3);
      expect(tokens[0].name).toBe('newest');
      expect(tokens[1].name).toBe('middle');
      expect(tokens[2].name).toBe('oldest');
    });

    it('returns empty array for user with no tokens', () => {
      const tokens = repo.listByUser(userId);
      expect(tokens).toEqual([]);
    });

    it('does NOT return tokens for other users', () => {
      const otherUserId = insertUser(db, 'other-owner');

      insertToken(db, {
        user_id: userId,
        name: 'mine-1',
        hash: 'mine-hash-1',
      });
      insertToken(db, {
        user_id: userId,
        name: 'mine-2',
        hash: 'mine-hash-2',
      });
      insertToken(db, {
        user_id: otherUserId,
        name: 'theirs',
        hash: 'theirs-hash',
      });

      const mine = repo.listByUser(userId);
      expect(mine).toHaveLength(2);
      expect(mine.every((t) => t.user_id === userId)).toBe(true);
      expect(mine.map((t) => t.name).sort()).toEqual(['mine-1', 'mine-2']);

      const theirs = repo.listByUser(otherUserId);
      expect(theirs).toHaveLength(1);
      expect(theirs[0].name).toBe('theirs');
    });
  });
});
