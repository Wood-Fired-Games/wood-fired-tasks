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
    prefix: row.prefix ?? 'wft_pat_',
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
      expect(token!.prefix).toBe('wft_pat_');
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

  describe('insert', () => {
    it('inserts a row and returns the full ApiToken with id > 0, defaults populated', () => {
      const result = repo.insert({
        userId,
        name: 'laptop',
        prefix: 'wft_pat_',
        suffix: 'wxyz',
        hash: 'sha256-insert-happy',
      });

      expect(result.id).toBeGreaterThan(0);
      expect(result.user_id).toBe(userId);
      expect(result.name).toBe('laptop');
      expect(result.prefix).toBe('wft_pat_');
      expect(result.suffix).toBe('wxyz');
      expect(result.hash).toBe('sha256-insert-happy');
      expect(result.scopes).toBe('[]');
      expect(typeof result.created_at).toBe('string');
      expect(result.created_at.length).toBeGreaterThan(0);
      expect(result.last_used_at).toBeNull();
      expect(result.revoked_at).toBeNull();
      expect(result.expires_at).toBeNull();
    });

    it('persists scopes JSON-array string verbatim when provided', () => {
      const result = repo.insert({
        userId,
        name: 'admin-token',
        prefix: 'wft_pat_',
        suffix: 'admn',
        hash: 'sha256-insert-scopes',
        scopes: '["admin"]',
      });

      expect(result.scopes).toBe('["admin"]');

      // Round-trip via findById to confirm DB-level persistence (not just an
      // in-memory echo).
      const reread = repo.findById(result.id);
      expect(reread).not.toBeNull();
      expect(reread!.scopes).toBe('["admin"]');
    });

    it('persists expiresAt = null (omitted) as NULL in the DB', () => {
      const result = repo.insert({
        userId,
        name: 'no-expiry',
        prefix: 'wft_pat_',
        suffix: 'noex',
        hash: 'sha256-insert-no-expiry',
      });

      expect(result.expires_at).toBeNull();

      const reread = repo.findById(result.id);
      expect(reread!.expires_at).toBeNull();
    });

    it('persists explicit expiresAt ISO string', () => {
      const result = repo.insert({
        userId,
        name: 'with-expiry',
        prefix: 'wft_pat_',
        suffix: 'expy',
        hash: 'sha256-insert-with-expiry',
        expiresAt: '2027-01-01T00:00:00.000Z',
      });

      expect(result.expires_at).toBe('2027-01-01T00:00:00.000Z');
    });

    it('throws on FK violation when userId references a non-existent user', () => {
      expect(() =>
        repo.insert({
          userId: 999999,
          name: 'orphan',
          prefix: 'wft_pat_',
          suffix: 'orph',
          hash: 'sha256-insert-orphan',
        })
      ).toThrow(/FOREIGN KEY/i);
    });

    it('returned row matches the snake_case ApiToken shape', () => {
      const result = repo.insert({
        userId,
        name: 'shape-check',
        prefix: 'wft_pat_',
        suffix: 'shap',
        hash: 'sha256-insert-shape',
      });

      // Snake_case ApiToken interface fields must all be present.
      expect(result).toEqual(
        expect.objectContaining({
          id: expect.any(Number),
          user_id: expect.any(Number),
          name: expect.any(String),
          prefix: expect.any(String),
          suffix: expect.any(String),
          hash: expect.any(String),
          scopes: expect.any(String),
          created_at: expect.any(String),
          last_used_at: null,
          revoked_at: null,
          expires_at: null,
        })
      );
    });
  });

  describe('revoke', () => {
    it('returns true and sets revoked_at on a fresh token owned by the user', () => {
      const inserted = repo.insert({
        userId,
        name: 'to-revoke',
        prefix: 'wft_pat_',
        suffix: 'revk',
        hash: 'sha256-revoke-happy',
      });

      const ok = repo.revoke(inserted.id, userId);
      expect(ok).toBe(true);

      const after = repo.findById(inserted.id);
      expect(after).not.toBeNull();
      expect(after!.revoked_at).not.toBeNull();
      expect(typeof after!.revoked_at).toBe('string');
    });

    it('returns false and does NOT revoke when caller is a different user (cross-user isolation)', () => {
      const otherUserId = insertUser(db, 'other-owner-revoke');
      const inserted = repo.insert({
        userId,
        name: 'mine',
        prefix: 'wft_pat_',
        suffix: 'mine',
        hash: 'sha256-revoke-cross-user',
      });

      const ok = repo.revoke(inserted.id, otherUserId);
      expect(ok).toBe(false);

      const after = repo.findById(inserted.id);
      expect(after).not.toBeNull();
      expect(after!.revoked_at).toBeNull();
    });

    it('returns false on the second call (idempotency: revoked_at IS NULL guard)', () => {
      const inserted = repo.insert({
        userId,
        name: 'double-revoke',
        prefix: 'wft_pat_',
        suffix: 'dbrv',
        hash: 'sha256-revoke-idempotent',
      });

      expect(repo.revoke(inserted.id, userId)).toBe(true);
      expect(repo.revoke(inserted.id, userId)).toBe(false);
    });

    it('returns false for an unknown id', () => {
      expect(repo.revoke(999999, userId)).toBe(false);
    });
  });

  describe('touchLastUsed', () => {
    it('sets last_used_at to a non-null string', () => {
      const inserted = repo.insert({
        userId,
        name: 'touch-me',
        prefix: 'wft_pat_',
        suffix: 'tchm',
        hash: 'sha256-touch-happy',
      });

      expect(inserted.last_used_at).toBeNull();

      repo.touchLastUsed(inserted.id);

      const after = repo.findById(inserted.id);
      expect(after).not.toBeNull();
      expect(after!.last_used_at).not.toBeNull();
      expect(typeof after!.last_used_at).toBe('string');
      expect(after!.last_used_at!.length).toBeGreaterThan(0);
    });

    it('is a no-op (no throw) for a missing id', () => {
      expect(() => repo.touchLastUsed(999999)).not.toThrow();
    });

    // Task #710 — shutdown race containment. The auth chain fires
    // `setImmediate(() => touchLastUsed(id))`, so the callback can run AFTER
    // the owning App has been disposed and the better-sqlite3 handle closed
    // (final request before SIGTERM shutdown, or test teardown that closes
    // the server/db before the scheduled task drains). Without the `db.open`
    // guard this throws `TypeError: The database connection is not open`,
    // which surfaces as a spurious "touchLastUsed failed" warn line. Because
    // `last_used_at` is observational, the lost-the-race write is silently
    // dropped — but the call must NOT throw.
    it('is a no-op (no throw) when the db connection is closed', () => {
      const inserted = repo.insert({
        userId,
        name: 'closed-db',
        prefix: 'wft_pat_',
        suffix: 'clsd',
        hash: 'sha256-touch-closed',
      });

      db.close();
      expect(db.open).toBe(false);

      expect(() => repo.touchLastUsed(inserted.id)).not.toThrow();
    });

    it('returns void (no return value contract)', () => {
      const inserted = repo.insert({
        userId,
        name: 'void-return',
        prefix: 'wft_pat_',
        suffix: 'void',
        hash: 'sha256-touch-void',
      });

      const ret = repo.touchLastUsed(inserted.id);
      expect(ret).toBeUndefined();
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
