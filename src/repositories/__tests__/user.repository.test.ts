import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { UserRepository } from '../user.repository.js';

/**
 * Helper: insert a raw users row. The repository under test exposes ZERO
 * write methods (Phase 27 is read-only scope) so every test fixture is
 * established via direct INSERT.
 */
function insertUser(
  db: Database.Database,
  row: {
    id?: number;
    oidc_sub?: string | null;
    oidc_provider?: string | null;
    email?: string | null;
    display_name: string;
    slack_user_id?: string | null;
    is_legacy?: number;
    is_service_account?: number;
    created_at?: string;
    disabled_at?: string | null;
  }
): number {
  const stmt = db.prepare(`
    INSERT INTO users (
      id, oidc_sub, oidc_provider, email, display_name,
      slack_user_id, is_legacy, is_service_account, created_at, disabled_at
    ) VALUES (
      @id, @oidc_sub, @oidc_provider, @email, @display_name,
      @slack_user_id, @is_legacy, @is_service_account, @created_at, @disabled_at
    )
  `);
  const info = stmt.run({
    id: row.id ?? null,
    oidc_sub: row.oidc_sub ?? null,
    oidc_provider: row.oidc_provider ?? null,
    email: row.email ?? null,
    display_name: row.display_name,
    slack_user_id: row.slack_user_id ?? null,
    is_legacy: row.is_legacy ?? 0,
    is_service_account: row.is_service_account ?? 0,
    created_at: row.created_at ?? new Date().toISOString(),
    disabled_at: row.disabled_at ?? null,
  });
  return info.lastInsertRowid as number;
}

describe('UserRepository', () => {
  let db: Database.Database;
  let repo: UserRepository;

  beforeEach(async () => {
    db = initDatabase(':memory:');
    await runMigrations(db);
    repo = new UserRepository(db);
  });

  describe('findById', () => {
    it('returns inserted user with snake_case fields', () => {
      const id = insertUser(db, {
        id: 1,
        display_name: 'alice',
        is_legacy: 1,
      });

      const user = repo.findById(id);

      expect(user).not.toBeNull();
      expect(user!.id).toBe(1);
      expect(user!.display_name).toBe('alice');
      expect(user!.is_legacy).toBe(1);
      expect(user!.is_service_account).toBe(0);
      expect(user!.oidc_sub).toBeNull();
      expect(user!.oidc_provider).toBeNull();
      expect(user!.email).toBeNull();
      expect(user!.slack_user_id).toBeNull();
      expect(user!.disabled_at).toBeNull();
      expect(typeof user!.created_at).toBe('string');
    });

    it('returns null for missing id (not undefined)', () => {
      const result = repo.findById(999);
      expect(result).toBeNull();
    });
  });

  describe('findByOidcSub', () => {
    it('matches on (provider, sub) composite', () => {
      insertUser(db, {
        display_name: 'bob',
        oidc_provider: 'google',
        oidc_sub: 'abc',
        email: 'bob@example.com',
      });

      const match = repo.findByOidcSub('google', 'abc');
      expect(match).not.toBeNull();
      expect(match!.display_name).toBe('bob');
      expect(match!.email).toBe('bob@example.com');

      const noMatch = repo.findByOidcSub('google', 'xyz');
      expect(noMatch).toBeNull();
    });

    it('throws TypeError when provider is null/undefined/empty (defensive type-bypass guard)', () => {
      // WR-03 defense-in-depth: a caller that bypasses the TS signature
      // (e.g. dynamic JSON input, `as any`) must NOT be able to perform a
      // silent NULL-collision lookup that returns zero rows.
      const repoAsAny = repo as unknown as {
        findByOidcSub: (p: unknown, s: unknown) => unknown;
      };
      expect(() => repoAsAny.findByOidcSub(null, 'abc')).toThrow(TypeError);
      expect(() => repoAsAny.findByOidcSub(undefined, 'abc')).toThrow(TypeError);
      expect(() => repoAsAny.findByOidcSub('', 'abc')).toThrow(TypeError);
    });

    it('throws TypeError when sub is null/undefined/empty (defensive type-bypass guard)', () => {
      const repoAsAny = repo as unknown as {
        findByOidcSub: (p: unknown, s: unknown) => unknown;
      };
      expect(() => repoAsAny.findByOidcSub('google', null)).toThrow(TypeError);
      expect(() => repoAsAny.findByOidcSub('google', undefined)).toThrow(TypeError);
      expect(() => repoAsAny.findByOidcSub('google', '')).toThrow(TypeError);
    });

    it('does NOT match across providers (provider isolation)', () => {
      insertUser(db, {
        display_name: 'google-user',
        oidc_provider: 'google',
        oidc_sub: 'abc',
      });
      insertUser(db, {
        display_name: 'github-user',
        oidc_provider: 'github',
        oidc_sub: 'abc',
      });

      const googleMatch = repo.findByOidcSub('google', 'abc');
      expect(googleMatch).not.toBeNull();
      expect(googleMatch!.display_name).toBe('google-user');

      const githubMatch = repo.findByOidcSub('github', 'abc');
      expect(githubMatch).not.toBeNull();
      expect(githubMatch!.display_name).toBe('github-user');
    });
  });

  describe('findBySlackUserId', () => {
    it('returns the row by slack_user_id', () => {
      insertUser(db, {
        display_name: 'slack-bot',
        slack_user_id: 'U123',
        is_service_account: 1,
      });

      const match = repo.findBySlackUserId('U123');
      expect(match).not.toBeNull();
      expect(match!.display_name).toBe('slack-bot');
      expect(match!.slack_user_id).toBe('U123');
      expect(match!.is_service_account).toBe(1);
    });

    it('returns null when slack_user_id is unknown', () => {
      const result = repo.findBySlackUserId('U_NOT_THERE');
      expect(result).toBeNull();
    });
  });

  describe('findLegacyByDisplayName', () => {
    it('only returns is_legacy=1 rows', () => {
      // Two rows with the same display_name: one legacy, one OIDC
      insertUser(db, {
        display_name: 'admin',
        is_legacy: 1,
      });
      insertUser(db, {
        display_name: 'admin',
        oidc_provider: 'google',
        oidc_sub: 'admin-google-sub',
        is_legacy: 0,
      });

      const result = repo.findLegacyByDisplayName('admin');
      expect(result).not.toBeNull();
      expect(result!.display_name).toBe('admin');
      expect(result!.is_legacy).toBe(1);
      expect(result!.oidc_provider).toBeNull();
    });

    it('returns null when no legacy row exists for that name', () => {
      insertUser(db, {
        display_name: 'oidc-only',
        oidc_provider: 'google',
        oidc_sub: 'sub',
        is_legacy: 0,
      });

      const result = repo.findLegacyByDisplayName('oidc-only');
      expect(result).toBeNull();
    });
  });

  describe('listAll', () => {
    it('returns rows in id ASC order', () => {
      // Insert out-of-order; SQLite assigns ids monotonically by INSERT order
      // unless we override. Override to verify ORDER BY id ASC works.
      insertUser(db, { id: 3, display_name: 'third' });
      insertUser(db, { id: 1, display_name: 'first' });
      insertUser(db, { id: 2, display_name: 'second' });

      const all = repo.listAll();

      expect(all).toHaveLength(3);
      expect(all[0].id).toBe(1);
      expect(all[0].display_name).toBe('first');
      expect(all[1].id).toBe(2);
      expect(all[1].display_name).toBe('second');
      expect(all[2].id).toBe(3);
      expect(all[2].display_name).toBe('third');
    });

    it('returns empty array on empty table', () => {
      const all = repo.listAll();
      expect(all).toEqual([]);
    });
  });
});
