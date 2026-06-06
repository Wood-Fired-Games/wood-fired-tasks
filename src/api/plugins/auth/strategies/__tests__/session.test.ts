import { describe, it, expect, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { User } from '../../../../../types/identity.js';
import type { UserRepository } from '../../../../../repositories/user.repository.js';
import { tryAuth } from '../session.js';

/**
 * Phase 29 session strategy unit tests.
 *
 * Plan 29-05 swapped the Phase 28 stub body. Behavior under test:
 *
 *   1. request.session undefined (OIDC-disabled mode)              → skip
 *   2. request.session.get('user') undefined                        → skip
 *   3. session.user.id resolves to active user (disabled_at null)  → match
 *   4. session.user.id resolves to disabled user                    → skip + clear + warn
 *   5. session.user.id resolves to no user (deleted)               → skip + clear + warn
 *
 * The function signature is the Phase 28 contract (preserved): `tryAuth(
 * request, deps): Promise<StrategyOutcome>`. SessionDeps now carries
 * `{ userRepository }` and the chain orchestrator passes
 * `fastify.userRepository` in.
 *
 * Implementation detail under test: in cases (4) and (5), the strategy
 * MUST call `request.session.delete()` AND emit a single
 * `request.log.warn` line tagged `'session.user_disabled_during_active_session'`.
 * Both "disabled" and "missing" collapse to the same outcome — distinguishing
 * them in the warn body or to the chain would leak existence (Threat T-29-05-04).
 */

function makeUser(overrides: Partial<User> & { id: number }): User {
  return {
    id: overrides.id,
    oidc_sub: 'sub-123',
    oidc_provider: 'google',
    email: 'alice@example.com',
    display_name: 'Alice',
    slack_user_id: null,
    is_legacy: 0,
    is_service_account: 0,
    created_at: '2026-01-01T00:00:00Z',
    disabled_at: null,
    ...overrides,
  };
}

interface MakeRequestOpts {
  withSession?: boolean;
  sessionUser?: { id: number } | undefined;
}

function makeRequest(opts: MakeRequestOpts): {
  req: FastifyRequest;
  sessionGet: ReturnType<typeof vi.fn>;
  sessionDelete: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const sessionGet = vi.fn((key: string) => {
    if (key === 'user') return opts.sessionUser;
    return undefined;
  });
  const sessionDelete = vi.fn();
  const warn = vi.fn();
  const req = {
    headers: {},
    log: { warn },
    ...(opts.withSession ? { session: { get: sessionGet, delete: sessionDelete } } : {}),
  } as unknown as FastifyRequest;
  return { req, sessionGet, sessionDelete, warn };
}

function makeRepo(opts: { findById?: User | null }): UserRepository {
  return {
    findById: vi.fn(() => opts.findById ?? null),
  } as unknown as UserRepository;
}

describe('Session strategy tryAuth (Phase 29 real impl)', () => {
  it('returns skip when request.session is undefined (OIDC-disabled mode)', async () => {
    const { req, sessionDelete, warn } = makeRequest({ withSession: false });
    const userRepository = makeRepo({});
    const out = await tryAuth(req, { userRepository });
    expect(out).toEqual({ kind: 'skip' });
    expect(sessionDelete).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(userRepository.findById).not.toHaveBeenCalled();
  });

  it('returns skip when session.get("user") is undefined', async () => {
    const { req, sessionDelete, warn } = makeRequest({
      withSession: true,
      sessionUser: undefined,
    });
    const userRepository = makeRepo({});
    const out = await tryAuth(req, { userRepository });
    expect(out).toEqual({ kind: 'skip' });
    expect(sessionDelete).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(userRepository.findById).not.toHaveBeenCalled();
  });

  it('returns match with authMethod=session when session resolves to an active user', async () => {
    const user = makeUser({ id: 7, display_name: 'Alice', email: 'a@x.com' });
    const { req, sessionDelete, warn } = makeRequest({
      withSession: true,
      sessionUser: { id: 7 },
    });
    const userRepository = makeRepo({ findById: user });
    const out = await tryAuth(req, { userRepository });
    expect(out).toEqual({
      kind: 'match',
      result: {
        user: {
          id: 7,
          displayName: 'Alice',
          email: 'a@x.com',
          isLegacy: false,
          isServiceAccount: false,
        },
        authMethod: 'session',
        tokenId: null,
      },
    });
    expect(userRepository.findById).toHaveBeenCalledWith(7);
    expect(sessionDelete).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('clears session and skips when user is disabled mid-session', async () => {
    const disabled = makeUser({
      id: 11,
      disabled_at: '2026-05-23T00:00:00Z',
    });
    const { req, sessionGet, sessionDelete, warn } = makeRequest({
      withSession: true,
      sessionUser: { id: 11 },
    });
    const userRepository = makeRepo({ findById: disabled });
    const out = await tryAuth(req, { userRepository });
    expect(out).toEqual({ kind: 'skip' });
    expect(sessionGet).toHaveBeenCalledWith('user');
    expect(sessionDelete).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { user_id: 11 },
      'session.user_disabled_during_active_session',
    );
  });

  it('clears session and skips when user has been deleted (findById null)', async () => {
    const { req, sessionDelete, warn } = makeRequest({
      withSession: true,
      sessionUser: { id: 99 },
    });
    const userRepository = makeRepo({ findById: null });
    const out = await tryAuth(req, { userRepository });
    expect(out).toEqual({ kind: 'skip' });
    expect(sessionDelete).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { user_id: 99 },
      'session.user_disabled_during_active_session',
    );
  });

  it('projects is_legacy=1 / is_service_account=1 to boolean true', async () => {
    const legacy = makeUser({
      id: 3,
      is_legacy: 1,
      is_service_account: 1,
    });
    const { req } = makeRequest({
      withSession: true,
      sessionUser: { id: 3 },
    });
    const userRepository = makeRepo({ findById: legacy });
    const out = await tryAuth(req, { userRepository });
    expect(out.kind).toBe('match');
    if (out.kind === 'match') {
      expect(out.result.user.isLegacy).toBe(true);
      expect(out.result.user.isServiceAccount).toBe(true);
    }
  });
});
