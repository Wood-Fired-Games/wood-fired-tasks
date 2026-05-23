import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { getFlashAndClear } from '../session-flash.js';

/**
 * Construct a minimal FastifyRequest stand-in whose `session` exposes a
 * `Map`-backed `get`/`set` matching @fastify/secure-session v8 semantics:
 *   - `get(key)` returns the stored value or `undefined`.
 *   - `set(key, undefined)` removes the entry (Pitfall 1: secure-session has
 *     no `delete(key)` method — the convention is `set(key, undefined)`).
 *
 * Unit-test isolation: we deliberately do NOT spin up a real Fastify
 * instance here. The flash helper only depends on the `get`/`set` shape, so
 * we can verify behavior synchronously and the integration roundtrip via a
 * real cookie is covered separately by `session-plugins.test.ts`.
 */
function fakeRequest(initial: Record<string, unknown>): FastifyRequest {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    session: {
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => {
        if (v === undefined) store.delete(k);
        else store.set(k, v);
      },
    },
  } as unknown as FastifyRequest;
}

describe('getFlashAndClear', () => {
  it('returns the value and clears it when the key is present', () => {
    const req = fakeRequest({ mintedToken: { id: 42, token: 'wfb_pat_xyz' } });

    const value = getFlashAndClear(req, 'mintedToken');

    expect(value).toEqual({ id: 42, token: 'wfb_pat_xyz' });
    // After read, the key must be cleared (one-shot semantics).
    expect(req.session.get('mintedToken')).toBeUndefined();
  });

  it('returns undefined and is a no-op when the key was never set', () => {
    const req = fakeRequest({});

    const value = getFlashAndClear(req, 'mintedToken');

    expect(value).toBeUndefined();
    // Still undefined — no spurious set call.
    expect(req.session.get('mintedToken')).toBeUndefined();
  });

  it('is idempotent: a second read returns undefined (already cleared)', () => {
    const req = fakeRequest({ csrf: 'abc123' });

    const first = getFlashAndClear(req, 'csrf');
    const second = getFlashAndClear(req, 'csrf');

    expect(first).toBe('abc123');
    expect(second).toBeUndefined();
  });

  it('preserves the generic value type at call sites', () => {
    // Type-level check: the return type narrows to the SessionData[K] shape.
    // If the augmentation drifts, this assertion fails to compile.
    const req = fakeRequest({
      mintedToken: { id: 7, token: 'wfb_pat_demo' },
    });

    const value = getFlashAndClear(req, 'mintedToken');

    // At runtime: the value preserves its structural shape.
    expect(value?.id).toBe(7);
    expect(value?.token).toBe('wfb_pat_demo');
  });

  it('clears the key when the stored value is falsy-but-defined', () => {
    // Edge: empty string is a defined value — should be returned AND cleared.
    const req = fakeRequest({ csrf: '' });

    const value = getFlashAndClear(req, 'csrf');

    // Empty string is treated as "no value" by the helper because the
    // guard is `value !== undefined && value !== null`; '' passes the guard
    // and is returned, then cleared.
    expect(value).toBe('');
    expect(req.session.get('csrf')).toBeUndefined();
  });
});
