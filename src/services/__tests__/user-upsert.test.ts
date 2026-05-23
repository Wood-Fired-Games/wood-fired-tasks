/**
 * Phase 29 Plan 05: tests for the OIDC user-upsert service.
 *
 * `upsertFromOidc` owns the "lookup → insert OR update" path the
 * /auth/callback handler invokes after successful ID-token validation.
 * Repository owns SQL; this module owns the business rules:
 *
 *   1. Idempotent re-login: same (provider, sub) returns same row.
 *   2. Drift handling: email or displayName changes apply via updateProfile.
 *   3. Race recovery: concurrent INSERT racing this one surfaces as a
 *      UNIQUE violation; catch + re-resolve via findByOidcSub.
 *   4. Empty displayName: rejected upstream by UserRepository.insert
 *      (TypeError); caller is responsible for falling back to email.
 *
 * Pure dep-injection — these tests use a hand-rolled in-memory
 * `IUserRepository` mock, no real SQLite required.
 */
import { describe, it, expect, vi } from 'vitest';
import { upsertFromOidc } from '../user-upsert.js';
import type { IUserRepository } from '../../repositories/interfaces.js';
import type { User, UserUpsertInput } from '../../types/identity.js';

interface MockRepo extends IUserRepository {
  _rows: User[];
  _insertCalls: number;
  _updateCalls: Array<{
    id: number;
    patch: { email?: string | null; displayName?: string };
  }>;
}

function makeMockRepo(seed: User[] = []): MockRepo {
  const rows: User[] = [...seed];
  let nextId =
    rows.reduce((max, r) => (r.id > max ? r.id : max), 0) + 1;
  const updateCalls: Array<{
    id: number;
    patch: { email?: string | null; displayName?: string };
  }> = [];
  const repo: MockRepo = {
    _rows: rows,
    _insertCalls: 0,
    _updateCalls: updateCalls,
    findById: (id: number) => rows.find((r) => r.id === id) ?? null,
    findByOidcSub: (provider: string, sub: string) =>
      rows.find(
        (r) => r.oidc_provider === provider && r.oidc_sub === sub,
      ) ?? null,
    findBySlackUserId: () => null,
    findLegacyByDisplayName: () => null,
    findByEmail: () => null,
    listAll: () => [...rows],
    insert: (input: UserUpsertInput): User => {
      repo._insertCalls += 1;
      if (
        rows.some(
          (r) =>
            r.oidc_provider === input.provider && r.oidc_sub === input.sub,
        )
      ) {
        const err = new Error(
          'UNIQUE constraint failed: users.oidc_provider, users.oidc_sub',
        ) as Error & { code: string };
        err.code = 'SQLITE_CONSTRAINT_UNIQUE';
        throw err;
      }
      if (input.displayName == null || input.displayName === '') {
        throw new TypeError(
          'UserRepository.insert: displayName must be a non-empty string',
        );
      }
      const row: User = {
        id: nextId++,
        oidc_provider: input.provider,
        oidc_sub: input.sub,
        email: input.email,
        display_name: input.displayName,
        slack_user_id: null,
        is_legacy: 0,
        is_service_account: 0,
        created_at: new Date().toISOString(),
        disabled_at: null,
      };
      rows.push(row);
      return { ...row };
    },
    updateProfile: (
      id: number,
      patch: { email?: string | null; displayName?: string },
    ): User | null => {
      updateCalls.push({ id, patch: { ...patch } });
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      if (Object.prototype.hasOwnProperty.call(patch, 'email')) {
        row.email = patch.email ?? null;
      }
      if (
        Object.prototype.hasOwnProperty.call(patch, 'displayName') &&
        patch.displayName
      ) {
        row.display_name = patch.displayName;
      }
      return { ...row };
    },
  };
  return repo;
}

function makeUser(overrides: Partial<User> & { id: number }): User {
  // Use property-presence checks (not `??`) so `null` overrides survive —
  // `email: null` from a caller must produce `email: null`, not the default.
  return {
    id: overrides.id,
    oidc_provider:
      'oidc_provider' in overrides ? overrides.oidc_provider : 'google',
    oidc_sub: 'oidc_sub' in overrides ? overrides.oidc_sub : 'sub-default',
    email: 'email' in overrides ? overrides.email : 'user@example.com',
    display_name:
      'display_name' in overrides ? overrides.display_name : 'Display Name',
    slack_user_id:
      'slack_user_id' in overrides ? overrides.slack_user_id : null,
    is_legacy: 'is_legacy' in overrides ? overrides.is_legacy : 0,
    is_service_account:
      'is_service_account' in overrides ? overrides.is_service_account : 0,
    created_at:
      'created_at' in overrides ? overrides.created_at : '2026-05-23T00:00:00Z',
    disabled_at: 'disabled_at' in overrides ? overrides.disabled_at : null,
  } as User;
}

describe('upsertFromOidc', () => {
  it('inserts a new user when (provider, sub) is unknown', () => {
    const repo = makeMockRepo();
    const result = upsertFromOidc(
      { userRepository: repo },
      {
        provider: 'google',
        sub: 'new-sub-001',
        email: 'new@example.com',
        displayName: 'New User',
      },
    );

    expect(result.id).toBe(1);
    expect(result.oidc_provider).toBe('google');
    expect(result.oidc_sub).toBe('new-sub-001');
    expect(result.email).toBe('new@example.com');
    expect(result.display_name).toBe('New User');
    expect(repo._insertCalls).toBe(1);
    expect(repo._updateCalls).toHaveLength(0);
  });

  it('returns existing row when (provider, sub) matches and no drift', () => {
    const existing = makeUser({
      id: 42,
      oidc_provider: 'google',
      oidc_sub: 'sub-stable',
      email: 'stable@example.com',
      display_name: 'Stable User',
    });
    const repo = makeMockRepo([existing]);

    const result = upsertFromOidc(
      { userRepository: repo },
      {
        provider: 'google',
        sub: 'sub-stable',
        email: 'stable@example.com',
        displayName: 'Stable User',
      },
    );

    expect(result.id).toBe(42);
    expect(repo._insertCalls).toBe(0);
    expect(repo._updateCalls).toHaveLength(0);
  });

  it('applies email drift via updateProfile when email differs', () => {
    const existing = makeUser({
      id: 7,
      oidc_provider: 'google',
      oidc_sub: 'sub-email',
      email: 'old@example.com',
      display_name: 'Email Drift',
    });
    const repo = makeMockRepo([existing]);

    const result = upsertFromOidc(
      { userRepository: repo },
      {
        provider: 'google',
        sub: 'sub-email',
        email: 'new@example.com',
        displayName: 'Email Drift',
      },
    );

    expect(result.id).toBe(7);
    expect(result.email).toBe('new@example.com');
    expect(repo._insertCalls).toBe(0);
    expect(repo._updateCalls).toEqual([
      { id: 7, patch: { email: 'new@example.com' } },
    ]);
  });

  it('applies displayName drift via updateProfile when displayName differs', () => {
    const existing = makeUser({
      id: 9,
      oidc_provider: 'google',
      oidc_sub: 'sub-name',
      email: 'name@example.com',
      display_name: 'Old Name',
    });
    const repo = makeMockRepo([existing]);

    const result = upsertFromOidc(
      { userRepository: repo },
      {
        provider: 'google',
        sub: 'sub-name',
        email: 'name@example.com',
        displayName: 'New Name',
      },
    );

    expect(result.id).toBe(9);
    expect(result.display_name).toBe('New Name');
    expect(repo._insertCalls).toBe(0);
    expect(repo._updateCalls).toEqual([
      { id: 9, patch: { displayName: 'New Name' } },
    ]);
  });

  it('applies both drifts in a single updateProfile call', () => {
    const existing = makeUser({
      id: 13,
      oidc_provider: 'google',
      oidc_sub: 'sub-both',
      email: 'old@example.com',
      display_name: 'Old Both',
    });
    const repo = makeMockRepo([existing]);

    const result = upsertFromOidc(
      { userRepository: repo },
      {
        provider: 'google',
        sub: 'sub-both',
        email: 'new@example.com',
        displayName: 'New Both',
      },
    );

    expect(result.id).toBe(13);
    expect(result.email).toBe('new@example.com');
    expect(result.display_name).toBe('New Both');
    expect(repo._insertCalls).toBe(0);
    expect(repo._updateCalls).toEqual([
      {
        id: 13,
        patch: { email: 'new@example.com', displayName: 'New Both' },
      },
    ]);
  });

  it('treats null vs null email as no drift', () => {
    const existing = makeUser({
      id: 21,
      oidc_provider: 'google',
      oidc_sub: 'sub-null',
      email: null,
      display_name: 'Null Email',
    });
    const repo = makeMockRepo([existing]);

    const result = upsertFromOidc(
      { userRepository: repo },
      {
        provider: 'google',
        sub: 'sub-null',
        email: null,
        displayName: 'Null Email',
      },
    );

    expect(result.id).toBe(21);
    expect(repo._updateCalls).toHaveLength(0);
  });

  it('is idempotent — second identical call returns same row id without update', () => {
    const repo = makeMockRepo();
    const input = {
      provider: 'google',
      sub: 'sub-idem',
      email: 'idem@example.com',
      displayName: 'Idem User',
    };

    const first = upsertFromOidc({ userRepository: repo }, input);
    const second = upsertFromOidc({ userRepository: repo }, input);

    expect(second.id).toBe(first.id);
    expect(repo._insertCalls).toBe(1);
    expect(repo._updateCalls).toHaveLength(0);
  });

  it('rejects empty displayName via the repository TypeError', () => {
    const repo = makeMockRepo();

    expect(() =>
      upsertFromOidc(
        { userRepository: repo },
        {
          provider: 'google',
          sub: 'sub-empty',
          email: 'x@example.com',
          displayName: '',
        },
      ),
    ).toThrow(TypeError);
  });

  it('recovers from concurrent insert race — UNIQUE violation re-resolves via findByOidcSub', () => {
    // Setup: pre-populate the "real" backing store with a row, but lie
    // through findByOidcSub on the first call so upsert proceeds to insert.
    // The insert then throws UNIQUE, and the recovery findByOidcSub succeeds.
    const racer = makeUser({
      id: 99,
      oidc_provider: 'google',
      oidc_sub: 'sub-race',
      email: 'race@example.com',
      display_name: 'Race User',
    });
    const repo = makeMockRepo([racer]);

    // Make first findByOidcSub call return null (simulate "we lost the race
    // — the row didn't exist when we checked"), then return the racer on
    // the recovery call.
    const findSpy = vi.spyOn(repo, 'findByOidcSub');
    findSpy.mockImplementationOnce(() => null);

    const result = upsertFromOidc(
      { userRepository: repo },
      {
        provider: 'google',
        sub: 'sub-race',
        email: 'race@example.com',
        displayName: 'Race User',
      },
    );

    expect(result.id).toBe(99);
    expect(repo._insertCalls).toBe(1); // we tried to insert (and failed UNIQUE)
    expect(findSpy).toHaveBeenCalledTimes(2); // initial + recovery
  });

  it('throws when updateProfile returns null mid-flight (row disappeared)', () => {
    const existing = makeUser({
      id: 55,
      oidc_provider: 'google',
      oidc_sub: 'sub-gone',
      email: 'gone@example.com',
      display_name: 'Gone',
    });
    const repo = makeMockRepo([existing]);

    // Override updateProfile to return null (simulates row deleted between
    // findByOidcSub and updateProfile). The service should fail loud rather
    // than silently re-insert.
    repo.updateProfile = () => null;

    expect(() =>
      upsertFromOidc(
        { userRepository: repo },
        {
          provider: 'google',
          sub: 'sub-gone',
          email: 'changed@example.com',
          displayName: 'Gone',
        },
      ),
    ).toThrow(/disappeared mid-update/);
  });

  it('re-throws non-UNIQUE insert errors when the race recovery also returns null', () => {
    const repo = makeMockRepo();

    // Force insert to throw a non-UNIQUE-related error; race recovery returns
    // null because there's no pre-existing row.
    repo.insert = () => {
      const err = new Error('SQLITE_FULL: database or disk is full') as Error & {
        code: string;
      };
      err.code = 'SQLITE_FULL';
      throw err;
    };

    expect(() =>
      upsertFromOidc(
        { userRepository: repo },
        {
          provider: 'google',
          sub: 'sub-disk',
          email: 'disk@example.com',
          displayName: 'Disk Full',
        },
      ),
    ).toThrow(/SQLITE_FULL/);
  });
});
