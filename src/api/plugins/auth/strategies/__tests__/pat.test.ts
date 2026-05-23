import { describe, it, expect, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { ApiToken, User } from '../../../../../types/identity.js';
import { tryAuth, toAuthenticatedUser } from '../pat.js';
import { hashToken, PAT_PREFIX } from '../../../../../services/pat-hash.js';

/**
 * PAT strategy unit tests.
 *
 * Strategies are pure async functions — no Fastify boot-up. We pass a
 * minimal `request`-shaped object with just the headers field and an
 * empty stub repository pair via `vi.fn()` returns.
 */

const FIXED_NOW = new Date('2026-05-23T12:00:00Z').getTime();

/** Build a 32-char base32 (RFC 4648 alphabet) body for a synthetic token. */
function base32Body(): string {
  // 32 chars matching /^[A-Z2-7]{32}$/.
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
}

function makeToken(body: string = base32Body()): string {
  return `${PAT_PREFIX}${body}`;
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 42,
    oidc_sub: null,
    oidc_provider: null,
    email: 'alice@example.com',
    display_name: 'alice',
    slack_user_id: null,
    is_legacy: 0,
    is_service_account: 0,
    created_at: '2026-01-01T00:00:00Z',
    disabled_at: null,
    ...overrides,
  };
}

function makeTokenRow(overrides: Partial<ApiToken> = {}): ApiToken {
  return {
    id: 7,
    user_id: 42,
    name: 'test-token',
    prefix: PAT_PREFIX,
    suffix: '4567',
    hash: hashToken(makeToken()),
    scopes: '[]',
    created_at: '2026-05-01T00:00:00Z',
    last_used_at: null,
    revoked_at: null,
    expires_at: null,
    ...overrides,
  };
}

function makeRequest(
  authorization?: string,
  log?: { warn: ReturnType<typeof vi.fn> },
): FastifyRequest {
  return {
    headers: authorization !== undefined ? { authorization } : {},
    log: log ?? { warn: vi.fn() },
  } as unknown as FastifyRequest;
}

function makeDeps(opts: {
  findByHash?: ApiToken | null;
  findById?: User | null;
} = {}) {
  return {
    apiTokenRepository: {
      findByHash: vi.fn(() => opts.findByHash ?? null),
    } as unknown as import('../../../../../repositories/api-token.repository.js').ApiTokenRepository,
    userRepository: {
      findById: vi.fn(() => opts.findById ?? null),
    } as unknown as import('../../../../../repositories/user.repository.js').UserRepository,
  };
}

describe('PAT strategy tryAuth', () => {
  describe('skip outcomes (chain falls through)', () => {
    it('skips when there is no Authorization header at all', async () => {
      const req = makeRequest();
      const deps = makeDeps();
      const out = await tryAuth(req, deps);
      expect(out).toEqual({ kind: 'skip' });
      expect(deps.apiTokenRepository.findByHash).not.toHaveBeenCalled();
    });

    it('skips when Authorization is non-Bearer (e.g. Basic)', async () => {
      const req = makeRequest('Basic dXNlcjpwYXNz');
      const deps = makeDeps();
      const out = await tryAuth(req, deps);
      expect(out).toEqual({ kind: 'skip' });
      expect(deps.apiTokenRepository.findByHash).not.toHaveBeenCalled();
    });

    it('skips when the Bearer token is not a wfb_pat_ token (e.g. JWT)', async () => {
      const req = makeRequest('Bearer eyJhbGciOiJIUzI1NiJ9.foo.bar');
      const deps = makeDeps();
      const out = await tryAuth(req, deps);
      expect(out).toEqual({ kind: 'skip' });
      expect(deps.apiTokenRepository.findByHash).not.toHaveBeenCalled();
    });

    it('skips when prefix is wfb_pat_ but missing the Bearer scheme (raw body)', async () => {
      // We only own the Bearer scheme. Naked `wfb_pat_...` (no Bearer)
      // belongs to the legacy strategy's catch-all path.
      const req = makeRequest(makeToken());
      const deps = makeDeps();
      const out = await tryAuth(req, deps);
      expect(out).toEqual({ kind: 'skip' });
    });
  });

  describe('fail outcomes (categorical 401 with reasonCode)', () => {
    it('fails with wrong_prefix when body is too short', async () => {
      const req = makeRequest(`Bearer ${PAT_PREFIX}SHORT`);
      const deps = makeDeps();
      const out = await tryAuth(req, deps);
      expect(out).toEqual({ kind: 'fail', reasonCode: 'wrong_prefix' });
      expect(deps.apiTokenRepository.findByHash).not.toHaveBeenCalled();
    });

    it('fails with wrong_prefix when body contains non-base32 characters', async () => {
      // 32 chars total but includes lowercase and `1` (not in [A-Z2-7]).
      const req = makeRequest(`Bearer ${PAT_PREFIX}abcdefgh1jklmnopqrstuvwxyz123456`);
      const deps = makeDeps();
      const out = await tryAuth(req, deps);
      expect(out).toEqual({ kind: 'fail', reasonCode: 'wrong_prefix' });
      expect(deps.apiTokenRepository.findByHash).not.toHaveBeenCalled();
    });

    it('fails with unknown_token when findByHash returns null', async () => {
      const req = makeRequest(`Bearer ${makeToken()}`);
      const deps = makeDeps({ findByHash: null });
      const out = await tryAuth(req, deps);
      expect(out).toEqual({ kind: 'fail', reasonCode: 'unknown_token' });
      expect(deps.apiTokenRepository.findByHash).toHaveBeenCalledOnce();
    });

    it('fails with revoked when row.revoked_at is set', async () => {
      const req = makeRequest(`Bearer ${makeToken()}`);
      const deps = makeDeps({
        findByHash: makeTokenRow({ revoked_at: '2026-05-22T00:00:00Z' }),
      });
      const out = await tryAuth(req, deps);
      expect(out).toEqual({ kind: 'fail', reasonCode: 'revoked' });
      // We must short-circuit before findById — revoked check is cheaper.
      expect(deps.userRepository.findById).not.toHaveBeenCalled();
    });

    it('fails with expired when row.expires_at is in the past', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);
      const req = makeRequest(`Bearer ${makeToken()}`);
      const deps = makeDeps({
        findByHash: makeTokenRow({
          expires_at: new Date(FIXED_NOW - 1_000).toISOString(),
        }),
      });
      const out = await tryAuth(req, deps);
      expect(out).toEqual({ kind: 'fail', reasonCode: 'expired' });
      expect(deps.userRepository.findById).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('does NOT fail with expired when expires_at is in the future', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(FIXED_NOW);
      const req = makeRequest(`Bearer ${makeToken()}`);
      const deps = makeDeps({
        findByHash: makeTokenRow({
          expires_at: new Date(FIXED_NOW + 60_000).toISOString(),
        }),
        findById: makeUser(),
      });
      const out = await tryAuth(req, deps);
      expect(out.kind).toBe('match');
      vi.useRealTimers();
    });

    it('WR-03: fails with expired (fail-closed) when expires_at is unparseable, and emits a warn log', async () => {
      const warn = vi.fn();
      const req = makeRequest(`Bearer ${makeToken()}`, { warn });
      const deps = makeDeps({
        findByHash: makeTokenRow({ id: 123, expires_at: 'soon' }),
      });
      const out = await tryAuth(req, deps);
      expect(out).toEqual({ kind: 'fail', reasonCode: 'expired' });
      // Must NOT reach the user lookup — expired short-circuits first.
      expect(deps.userRepository.findById).not.toHaveBeenCalled();
      // Exactly one warn log with the diagnostic tag and the offending value.
      expect(warn).toHaveBeenCalledTimes(1);
      const [obj, msg] = warn.mock.calls[0];
      expect(obj).toEqual({ tokenId: 123, expiresAt: 'soon' });
      expect(msg).toBe('pat.expires_at_unparseable');
    });

    it('fails with user_disabled when user.disabled_at is set', async () => {
      const req = makeRequest(`Bearer ${makeToken()}`);
      const deps = makeDeps({
        findByHash: makeTokenRow(),
        findById: makeUser({ disabled_at: '2026-04-01T00:00:00Z' }),
      });
      const out = await tryAuth(req, deps);
      expect(out).toEqual({ kind: 'fail', reasonCode: 'user_disabled' });
    });

    it('fails with user_disabled when findById returns null (orphan token, defensive)', async () => {
      const req = makeRequest(`Bearer ${makeToken()}`);
      const deps = makeDeps({
        findByHash: makeTokenRow(),
        findById: null,
      });
      const out = await tryAuth(req, deps);
      expect(out).toEqual({ kind: 'fail', reasonCode: 'user_disabled' });
    });
  });

  describe('match outcome (happy path)', () => {
    it('returns match with correctly-shaped AuthenticatedUser, authMethod=pat, and tokenId', async () => {
      const req = makeRequest(`Bearer ${makeToken()}`);
      const row = makeTokenRow({ id: 99 });
      const user = makeUser({
        id: 42,
        display_name: 'alice',
        email: 'alice@example.com',
        is_legacy: 0,
        is_service_account: 0,
      });
      const deps = makeDeps({ findByHash: row, findById: user });
      const out = await tryAuth(req, deps);
      expect(out).toEqual({
        kind: 'match',
        result: {
          user: {
            id: 42,
            displayName: 'alice',
            email: 'alice@example.com',
            isLegacy: false,
            isServiceAccount: false,
          },
          authMethod: 'pat',
          tokenId: 99,
        },
      });
    });

    it('hashes the token before lookup (findByHash receives the SHA-256 hex, never the raw token)', async () => {
      const token = makeToken();
      const req = makeRequest(`Bearer ${token}`);
      const deps = makeDeps({
        findByHash: makeTokenRow(),
        findById: makeUser(),
      });
      await tryAuth(req, deps);
      const callArg = (deps.apiTokenRepository.findByHash as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg).toBe(hashToken(token));
      // Critical: the raw token must NEVER be the lookup argument.
      expect(callArg).not.toBe(token);
      // SHA-256 hex is 64 chars.
      expect(callArg).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('toAuthenticatedUser helper', () => {
    it('maps snake_case row to camelCase boundary projection with proper booleans', () => {
      const user = makeUser({
        id: 7,
        display_name: 'bot',
        email: null,
        is_legacy: 1,
        is_service_account: 1,
      });
      expect(toAuthenticatedUser(user)).toEqual({
        id: 7,
        displayName: 'bot',
        email: null,
        isLegacy: true,
        isServiceAccount: true,
      });
    });
  });
});
