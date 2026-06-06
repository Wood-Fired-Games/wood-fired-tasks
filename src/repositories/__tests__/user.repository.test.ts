import { describe, it, expect, beforeEach } from 'vitest';
import type Database from '../../db/driver.js';
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

  describe('findByEmail', () => {
    it('matches case-insensitively', () => {
      insertUser(db, {
        display_name: 'stuart',
        email: 'Stuart@WoodfiredGames.com',
      });

      const lower = repo.findByEmail('stuart@woodfiredgames.com');
      expect(lower).not.toBeNull();
      expect(lower!.display_name).toBe('stuart');

      const upper = repo.findByEmail('STUART@WOODFIREDGAMES.COM');
      expect(upper).not.toBeNull();
      expect(upper!.display_name).toBe('stuart');

      const mixed = repo.findByEmail('Stuart@WoodfiredGames.com');
      expect(mixed).not.toBeNull();
      expect(mixed!.display_name).toBe('stuart');
    });

    it('returns null on miss', () => {
      insertUser(db, {
        display_name: 'present',
        email: 'present@example.com',
      });

      const result = repo.findByEmail('nobody@example.com');
      expect(result).toBeNull();
    });

    it('does NOT return rows with email=NULL (LOWER(NULL) = NULL semantics)', () => {
      // A legacy user with no email must not match any non-null lookup.
      insertUser(db, {
        display_name: 'legacy-no-email',
        email: null,
        is_legacy: 1,
      });

      // Lookup with empty string should not match (empty string guard
      // tested separately); use a benign non-empty value.
      const result = repo.findByEmail('anything@example.com');
      expect(result).toBeNull();
    });

    it('throws TypeError when email is null/undefined/empty (type-bypass guard)', () => {
      const repoAsAny = repo as unknown as {
        findByEmail: (e: unknown) => unknown;
      };
      expect(() => repoAsAny.findByEmail(null)).toThrow(TypeError);
      expect(() => repoAsAny.findByEmail(undefined)).toThrow(TypeError);
      expect(() => repoAsAny.findByEmail('')).toThrow(TypeError);
    });

    it('returns the lowest-id row deterministically when multiple rows share an email (no UNIQUE in v1.6)', () => {
      // No UNIQUE constraint on `email` in migration 008; the contract
      // requires ORDER BY id ASC LIMIT 1.
      const firstId = insertUser(db, {
        id: 100,
        display_name: 'first-with-dup-email',
        email: 'dup@example.com',
      });
      insertUser(db, {
        id: 200,
        display_name: 'second-with-dup-email',
        email: 'dup@example.com',
      });

      const result = repo.findByEmail('dup@example.com');
      expect(result).not.toBeNull();
      expect(result!.id).toBe(firstId);
      expect(result!.display_name).toBe('first-with-dup-email');
    });
  });

  describe('findServiceAccountByName (Phase 31)', () => {
    it('returns the row for a seeded service account', () => {
      insertUser(db, {
        display_name: 'slack-bot',
        is_service_account: 1,
      });
      insertUser(db, {
        display_name: 'mcp-bot',
        is_service_account: 1,
      });

      const slack = repo.findServiceAccountByName('slack-bot');
      expect(slack).not.toBeNull();
      expect(slack!.display_name).toBe('slack-bot');
      expect(slack!.is_service_account).toBe(1);

      const mcp = repo.findServiceAccountByName('mcp-bot');
      expect(mcp).not.toBeNull();
      expect(mcp!.display_name).toBe('mcp-bot');
      expect(mcp!.is_service_account).toBe(1);
    });

    it('returns null for unknown service-account name', () => {
      const result = repo.findServiceAccountByName('not-a-bot');
      expect(result).toBeNull();
    });

    it('returns null when display_name matches a legacy row (is_service_account=0)', () => {
      // A legacy row with display_name='mcp-bot' must NOT be returned —
      // the predicate requires is_service_account = 1.
      insertUser(db, {
        display_name: 'mcp-bot',
        is_legacy: 1,
        is_service_account: 0,
      });
      const result = repo.findServiceAccountByName('mcp-bot');
      expect(result).toBeNull();
    });

    it('returns null for null/undefined/empty name (defensive guard)', () => {
      const repoAsAny = repo as unknown as {
        findServiceAccountByName: (n: unknown) => unknown;
      };
      expect(repoAsAny.findServiceAccountByName(null)).toBeNull();
      expect(repoAsAny.findServiceAccountByName(undefined)).toBeNull();
      expect(repoAsAny.findServiceAccountByName('')).toBeNull();
    });

    it('is case-sensitive (exact match required)', () => {
      insertUser(db, {
        display_name: 'mcp-bot',
        is_service_account: 1,
      });
      expect(repo.findServiceAccountByName('MCP-BOT')).toBeNull();
      expect(repo.findServiceAccountByName('Mcp-Bot')).toBeNull();
      expect(repo.findServiceAccountByName('mcp-bot')).not.toBeNull();
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

  describe('Phase 29 — write methods', () => {
    describe('insert', () => {
      it('inserts a new user with (provider, sub, email, displayName) and returns the full row', () => {
        const row = repo.insert({
          provider: 'google',
          sub: 'sub-1',
          email: 'alice@example.com',
          displayName: 'Alice',
        });

        expect(row).not.toBeNull();
        expect(typeof row.id).toBe('number');
        expect(row.id).toBeGreaterThan(0);
        expect(row.oidc_provider).toBe('google');
        expect(row.oidc_sub).toBe('sub-1');
        expect(row.email).toBe('alice@example.com');
        expect(row.display_name).toBe('Alice');
        expect(row.is_legacy).toBe(0);
        expect(row.is_service_account).toBe(0);
        expect(row.slack_user_id).toBeNull();
        expect(row.disabled_at).toBeNull();
        expect(typeof row.created_at).toBe('string');
        expect(row.created_at.length).toBeGreaterThan(0);
      });

      it('accepts null email (provider declined to share)', () => {
        const row = repo.insert({
          provider: 'github',
          sub: 'gh-12345',
          email: null,
          displayName: 'Anonymous Octocat',
        });
        expect(row.email).toBeNull();
        expect(row.display_name).toBe('Anonymous Octocat');
        expect(row.oidc_provider).toBe('github');
        expect(row.oidc_sub).toBe('gh-12345');
      });

      it('round-trips through findByOidcSub on the same connection', () => {
        const inserted = repo.insert({
          provider: 'google',
          sub: 'sub-round-trip',
          email: 'roundtrip@example.com',
          displayName: 'Round Trip',
        });
        const looked = repo.findByOidcSub('google', 'sub-round-trip');
        expect(looked).not.toBeNull();
        expect(looked!.id).toBe(inserted.id);
        expect(looked!.email).toBe('roundtrip@example.com');
      });

      it('throws TypeError when provider is null/undefined/empty', () => {
        const repoAsAny = repo as unknown as {
          insert: (i: unknown) => unknown;
        };
        expect(() =>
          repoAsAny.insert({
            provider: null,
            sub: 's',
            email: null,
            displayName: 'd',
          }),
        ).toThrow(TypeError);
        expect(() =>
          repoAsAny.insert({
            provider: undefined,
            sub: 's',
            email: null,
            displayName: 'd',
          }),
        ).toThrow(TypeError);
        expect(() =>
          repoAsAny.insert({
            provider: '',
            sub: 's',
            email: null,
            displayName: 'd',
          }),
        ).toThrow(TypeError);
      });

      it('throws TypeError when sub is null/undefined/empty', () => {
        const repoAsAny = repo as unknown as {
          insert: (i: unknown) => unknown;
        };
        expect(() =>
          repoAsAny.insert({
            provider: 'google',
            sub: null,
            email: null,
            displayName: 'd',
          }),
        ).toThrow(TypeError);
        expect(() =>
          repoAsAny.insert({
            provider: 'google',
            sub: undefined,
            email: null,
            displayName: 'd',
          }),
        ).toThrow(TypeError);
        expect(() =>
          repoAsAny.insert({
            provider: 'google',
            sub: '',
            email: null,
            displayName: 'd',
          }),
        ).toThrow(TypeError);
      });

      it('throws TypeError when displayName is null/undefined/empty', () => {
        const repoAsAny = repo as unknown as {
          insert: (i: unknown) => unknown;
        };
        expect(() =>
          repoAsAny.insert({
            provider: 'google',
            sub: 's',
            email: null,
            displayName: null,
          }),
        ).toThrow(TypeError);
        expect(() =>
          repoAsAny.insert({
            provider: 'google',
            sub: 's',
            email: null,
            displayName: undefined,
          }),
        ).toThrow(TypeError);
        expect(() =>
          repoAsAny.insert({
            provider: 'google',
            sub: 's',
            email: null,
            displayName: '',
          }),
        ).toThrow(TypeError);
      });

      it('raises SqliteError on duplicate (provider, sub) — caller resolves via findByOidcSub', () => {
        repo.insert({
          provider: 'google',
          sub: 'dup-sub',
          email: 'first@example.com',
          displayName: 'First',
        });
        // Second insert with the SAME (provider, sub) must violate the
        // partial UNIQUE index from migration 008. better-sqlite3 throws
        // synchronously.
        expect(() =>
          repo.insert({
            provider: 'google',
            sub: 'dup-sub',
            email: 'second@example.com',
            displayName: 'Second',
          }),
        ).toThrow(/UNIQUE/i);
      });

      it('does NOT trip the legacy partial unique index (idx_users_legacy_display_name)', () => {
        // Migration 010 added: UNIQUE(display_name) WHERE is_legacy = 1.
        // OIDC users insert with is_legacy = 0 (DEFAULT), so two OIDC users
        // sharing a display_name must coexist freely.
        const a = repo.insert({
          provider: 'google',
          sub: 'sub-a',
          email: 'a@example.com',
          displayName: 'admin',
        });
        const b = repo.insert({
          provider: 'github',
          sub: 'sub-b',
          email: 'b@example.com',
          displayName: 'admin',
        });
        expect(a.id).not.toBe(b.id);
        expect(a.is_legacy).toBe(0);
        expect(b.is_legacy).toBe(0);
        // And a legacy 'admin' row (e.g. from the boot-time seeder) must
        // still be insertable separately via the raw fixture path.
        insertUser(db, { display_name: 'admin', is_legacy: 1 });
        const legacy = repo.findLegacyByDisplayName('admin');
        expect(legacy).not.toBeNull();
        expect(legacy!.is_legacy).toBe(1);
      });

      it('does NOT trip the slack-bot partial unique index (idx_users_slack_bot)', () => {
        // Migration 010 added: UNIQUE(display_name) WHERE is_service_account = 1.
        // OIDC users insert with is_service_account = 0 (DEFAULT), so they
        // must coexist with the seeded 'slack-bot' service-account row.
        insertUser(db, {
          display_name: 'slack-bot',
          slack_user_id: 'U_BOT',
          is_service_account: 1,
        });
        // OIDC user with display_name = 'slack-bot' must be allowed because
        // is_service_account = 0 puts it outside the partial index.
        const collide = repo.insert({
          provider: 'google',
          sub: 'human-named-slack-bot',
          email: 'human@example.com',
          displayName: 'slack-bot',
        });
        expect(collide.id).toBeGreaterThan(0);
        expect(collide.is_service_account).toBe(0);
        // Service-account row still present and intact.
        const bot = repo.findBySlackUserId('U_BOT');
        expect(bot).not.toBeNull();
        expect(bot!.is_service_account).toBe(1);
      });
    });

    describe('updateProfile', () => {
      it('updates email + displayName and returns the fresh row', () => {
        const inserted = repo.insert({
          provider: 'google',
          sub: 'sub-update-1',
          email: 'old@example.com',
          displayName: 'Old Name',
        });
        const updated = repo.updateProfile(inserted.id, {
          email: 'new@example.com',
          displayName: 'New Name',
        });
        expect(updated).not.toBeNull();
        expect(updated!.id).toBe(inserted.id);
        expect(updated!.email).toBe('new@example.com');
        expect(updated!.display_name).toBe('New Name');
        // Identity columns must be preserved.
        expect(updated!.oidc_provider).toBe('google');
        expect(updated!.oidc_sub).toBe('sub-update-1');
        expect(updated!.is_legacy).toBe(0);
        expect(updated!.is_service_account).toBe(0);
      });

      it('updates only displayName when email is omitted (partial patch)', () => {
        const inserted = repo.insert({
          provider: 'google',
          sub: 'sub-update-2',
          email: 'keep@example.com',
          displayName: 'Old',
        });
        const updated = repo.updateProfile(inserted.id, {
          displayName: 'New Only',
        });
        expect(updated).not.toBeNull();
        expect(updated!.email).toBe('keep@example.com');
        expect(updated!.display_name).toBe('New Only');
      });

      it('updates only email when displayName is omitted (partial patch)', () => {
        const inserted = repo.insert({
          provider: 'google',
          sub: 'sub-update-3',
          email: 'old@example.com',
          displayName: 'Stable',
        });
        const updated = repo.updateProfile(inserted.id, {
          email: 'new@example.com',
        });
        expect(updated).not.toBeNull();
        expect(updated!.email).toBe('new@example.com');
        expect(updated!.display_name).toBe('Stable');
      });

      it('clears email when explicit null is provided', () => {
        const inserted = repo.insert({
          provider: 'google',
          sub: 'sub-update-4',
          email: 'present@example.com',
          displayName: 'WithEmail',
        });
        const updated = repo.updateProfile(inserted.id, { email: null });
        expect(updated).not.toBeNull();
        expect(updated!.email).toBeNull();
        expect(updated!.display_name).toBe('WithEmail');
      });

      it('returns the unchanged row on empty patch (no-op)', () => {
        const inserted = repo.insert({
          provider: 'google',
          sub: 'sub-update-5',
          email: 'noop@example.com',
          displayName: 'NoOp',
        });
        const updated = repo.updateProfile(inserted.id, {});
        expect(updated).not.toBeNull();
        expect(updated!.id).toBe(inserted.id);
        expect(updated!.email).toBe('noop@example.com');
        expect(updated!.display_name).toBe('NoOp');
      });

      it('returns null when id does not exist', () => {
        const result = repo.updateProfile(99999, {
          email: 'nobody@example.com',
        });
        expect(result).toBeNull();
      });

      it('throws TypeError when id is non-positive (0, negative, NaN, non-integer)', () => {
        expect(() => repo.updateProfile(0, { email: 'x@example.com' })).toThrow(
          TypeError,
        );
        expect(() =>
          repo.updateProfile(-1, { email: 'x@example.com' }),
        ).toThrow(TypeError);
        expect(() =>
          repo.updateProfile(NaN, { email: 'x@example.com' }),
        ).toThrow(TypeError);
        expect(() =>
          repo.updateProfile(1.5, { email: 'x@example.com' }),
        ).toThrow(TypeError);
      });

      it('throws TypeError when displayName is supplied as empty/null', () => {
        const inserted = repo.insert({
          provider: 'google',
          sub: 'sub-update-6',
          email: 'g@example.com',
          displayName: 'Stable',
        });
        const repoAsAny = repo as unknown as {
          updateProfile: (id: number, patch: unknown) => unknown;
        };
        expect(() =>
          repoAsAny.updateProfile(inserted.id, { displayName: '' }),
        ).toThrow(TypeError);
        expect(() =>
          repoAsAny.updateProfile(inserted.id, { displayName: null }),
        ).toThrow(TypeError);
      });

      it('does NOT mutate identity columns even when patch attempts smuggled keys', () => {
        // The SET clause is built from a static allowlist (email,
        // display_name). Smuggled keys on the patch object MUST be ignored.
        const inserted = repo.insert({
          provider: 'google',
          sub: 'sub-immutable',
          email: 'safe@example.com',
          displayName: 'Safe',
        });
        const repoAsAny = repo as unknown as {
          updateProfile: (id: number, patch: unknown) => unknown;
        };
        const updated = repoAsAny.updateProfile(inserted.id, {
          email: 'new@example.com',
          oidc_provider: 'evil',
          oidc_sub: 'evil-sub',
          is_legacy: 1,
          is_service_account: 1,
          disabled_at: '2030-01-01T00:00:00.000Z',
          id: 99999,
        }) as ReturnType<typeof repo.updateProfile>;
        expect(updated).not.toBeNull();
        expect(updated!.id).toBe(inserted.id);
        expect(updated!.email).toBe('new@example.com');
        expect(updated!.oidc_provider).toBe('google');
        expect(updated!.oidc_sub).toBe('sub-immutable');
        expect(updated!.is_legacy).toBe(0);
        expect(updated!.is_service_account).toBe(0);
        expect(updated!.disabled_at).toBeNull();
      });
    });
  });
});
