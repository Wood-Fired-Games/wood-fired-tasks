import { describe, it, expect, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { User } from '../../../../../types/identity.js';
import { tryAuth, precomputeHashedEntries } from '../legacy.js';
import { hashKey } from '../../../auth.js';
import type { ApiKeyEntry } from '../../../../../config/env.js';

/**
 * Legacy strategy unit tests.
 *
 * The legacy strategy is byte-equivalent to the existing
 * src/api/plugins/auth.ts:170-216 inline preHandler, with two boundary
 * changes:
 *   1. On match, returns `{ kind: 'match', result, label }` instead of
 *      mutating `request.apiKeyLabel`.
 *   2. On no-credential / no-match, returns a categorical outcome
 *      instead of sending 401 — the chain emits the audit log + 401.
 *
 * The constant-time loop MUST NOT short-circuit on first match —
 * a dedicated test asserts every entry is compared by hooking the
 * underlying iteration via a recorded comparison count.
 */

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    oidc_sub: null,
    oidc_provider: null,
    email: null,
    display_name: 'legacy-key',
    slack_user_id: null,
    is_legacy: 1,
    is_service_account: 0,
    created_at: '2026-01-01T00:00:00Z',
    disabled_at: null,
    ...overrides,
  };
}

function makeRequest(opts: { apiKey?: string } = {}): FastifyRequest {
  return {
    headers: opts.apiKey !== undefined ? { 'x-api-key': opts.apiKey } : {},
  } as unknown as FastifyRequest;
}

function makeDeps(opts: {
  entries: ApiKeyEntry[];
  findLegacyByDisplayName?: (label: string) => User | null;
}) {
  return {
    userRepository: {
      findLegacyByDisplayName: vi.fn(
        opts.findLegacyByDisplayName ?? ((_label: string) => makeUser()),
      ),
    } as unknown as import('../../../../../repositories/user.repository.js').UserRepository,
    hashedEntries: precomputeHashedEntries(opts.entries),
  };
}

describe('Legacy strategy tryAuth', () => {
  it('skips when there is no x-api-key header', async () => {
    const req = makeRequest();
    const deps = makeDeps({ entries: [{ key: 'secret-a', label: 'agent-a' }] });
    const out = await tryAuth(req, deps);
    expect(out).toEqual({ kind: 'skip' });
    expect(deps.userRepository.findLegacyByDisplayName).not.toHaveBeenCalled();
  });

  it('skips when x-api-key header is empty string', async () => {
    const req = makeRequest({ apiKey: '' });
    const deps = makeDeps({ entries: [{ key: 'secret-a', label: 'agent-a' }] });
    const out = await tryAuth(req, deps);
    expect(out).toEqual({ kind: 'skip' });
  });

  it('fails with unknown_token when header is present but no entry matches', async () => {
    const req = makeRequest({ apiKey: 'wrong-secret' });
    const deps = makeDeps({
      entries: [
        { key: 'secret-a', label: 'agent-a' },
        { key: 'secret-b', label: 'agent-b' },
      ],
    });
    const out = await tryAuth(req, deps);
    expect(out).toEqual({ kind: 'fail', reasonCode: 'unknown_token' });
    expect(deps.userRepository.findLegacyByDisplayName).not.toHaveBeenCalled();
  });

  it('matches and returns the legacy user + label when a configured entry hashes equal', async () => {
    const req = makeRequest({ apiKey: 'secret-b' });
    const deps = makeDeps({
      entries: [
        { key: 'secret-a', label: 'agent-a' },
        { key: 'secret-b', label: 'agent-b' },
      ],
      findLegacyByDisplayName: (label) =>
        label === 'agent-b' ? makeUser({ id: 99, display_name: 'agent-b' }) : null,
    });
    const out = await tryAuth(req, deps);
    expect(out).toEqual({
      kind: 'match',
      result: {
        user: {
          id: 99,
          displayName: 'agent-b',
          email: null,
          isLegacy: true,
          isServiceAccount: false,
        },
        authMethod: 'legacy',
        tokenId: null,
      },
      label: 'agent-b',
    });
    expect(deps.userRepository.findLegacyByDisplayName).toHaveBeenCalledWith(
      'agent-b',
    );
  });

  it('fails with user_disabled when the legacy user row is missing (defensive, theoretically impossible post-seeder)', async () => {
    const req = makeRequest({ apiKey: 'secret-a' });
    const deps = makeDeps({
      entries: [{ key: 'secret-a', label: 'agent-a' }],
      findLegacyByDisplayName: () => null,
    });
    const out = await tryAuth(req, deps);
    expect(out).toEqual({ kind: 'fail', reasonCode: 'user_disabled' });
  });

  it('fails with user_disabled when the matched legacy user has disabled_at set', async () => {
    const req = makeRequest({ apiKey: 'secret-a' });
    const deps = makeDeps({
      entries: [{ key: 'secret-a', label: 'agent-a' }],
      findLegacyByDisplayName: () => makeUser({ disabled_at: '2026-04-01T00:00:00Z' }),
    });
    const out = await tryAuth(req, deps);
    expect(out).toEqual({ kind: 'fail', reasonCode: 'user_disabled' });
  });

  it('does NOT short-circuit on first match — runs timingSafeEqual against every entry', async () => {
    // We wrap the hashedEntries array in a Proxy that counts iterator
    // accesses. A short-circuiting loop would only consume entries up to
    // the match position; the contract is that the loop walks the full
    // sequence regardless.
    const entries: ApiKeyEntry[] = [
      { key: 'secret-a', label: 'agent-a' }, // match position 0
      { key: 'secret-b', label: 'agent-b' },
      { key: 'secret-c', label: 'agent-c' },
      { key: 'secret-d', label: 'agent-d' },
    ];
    const hashedEntries = precomputeHashedEntries(entries);
    let iterations = 0;
    const monitored = new Proxy(hashedEntries, {
      get(target, prop, receiver) {
        if (prop === Symbol.iterator) {
          const iter = target[Symbol.iterator]();
          return function* () {
            for (const v of iter) {
              iterations++;
              yield v;
            }
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const req = makeRequest({ apiKey: 'secret-a' });
    const deps = {
      userRepository: {
        findLegacyByDisplayName: vi.fn(() => makeUser({ display_name: 'agent-a' })),
      } as unknown as import('../../../../../repositories/user.repository.js').UserRepository,
      hashedEntries: monitored as unknown as Array<{ hash: Buffer; label: string }>,
    };
    const out = await tryAuth(req, deps);
    expect(out.kind).toBe('match');
    // All 4 entries must have been visited even though the first one matched.
    expect(iterations).toBe(4);
  });
});

describe('precomputeHashedEntries', () => {
  it('produces one { hash, label } record per entry with sha256 hash matching hashKey', () => {
    const entries: ApiKeyEntry[] = [
      { key: 'k1', label: 'lbl1' },
      { key: 'k2', label: 'lbl2' },
    ];
    const out = precomputeHashedEntries(entries);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ hash: hashKey('k1'), label: 'lbl1' });
    expect(out[1]).toEqual({ hash: hashKey('k2'), label: 'lbl2' });
  });
});
