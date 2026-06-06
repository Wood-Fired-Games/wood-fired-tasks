/**
 * Phase 29 Plan 06 — CSRF helper unit tests.
 *
 * `getOrCreateCsrfToken(request)` and `verifyCsrfToken(request, supplied)`
 * are pure functions over `request.session.get`/`request.session.set`. No
 * Fastify instance required — we fake the session with a Map-backed shape
 * matching @fastify/secure-session's `get`/`set` semantics.
 *
 * Coverage:
 *   1. generate on first call (writes session.csrf, returns 64-hex string)
 *   2. reuse on subsequent calls (no rewrite, same token returned)
 *   3. verify true on exact match
 *   4. verify false on mismatch
 *   5. verify false when session has no csrf
 *   6. verify false on wrong-length supplied value
 *   7. verify false on non-string supplied value
 *   8. timing-safe equality: identical tokens compare true (sanity check)
 */
import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { getOrCreateCsrfToken, verifyCsrfToken } from '../csrf.js';

function fakeRequest(initial: Record<string, unknown> = {}): FastifyRequest {
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

describe('getOrCreateCsrfToken', () => {
  it('generates a new 64-hex token on first call and stores it in the session', () => {
    const req = fakeRequest();
    const token = getOrCreateCsrfToken(req);

    expect(typeof token).toBe('string');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(req.session.get('csrf')).toBe(token);
  });

  it('reuses an existing valid token on subsequent calls (no rewrite)', () => {
    const req = fakeRequest();
    const first = getOrCreateCsrfToken(req);
    const second = getOrCreateCsrfToken(req);
    const third = getOrCreateCsrfToken(req);

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('regenerates when the stored value is the wrong length (defense)', () => {
    // If somehow a malformed value lands in the session (manual tampering or
    // a migration), the helper should self-heal by writing a fresh token.
    const req = fakeRequest({ csrf: 'too-short' });
    const token = getOrCreateCsrfToken(req);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(req.session.get('csrf')).toBe(token);
  });
});

describe('verifyCsrfToken', () => {
  it('returns true when supplied token matches session.csrf exactly', () => {
    const req = fakeRequest();
    const token = getOrCreateCsrfToken(req);

    expect(verifyCsrfToken(req, token)).toBe(true);
  });

  it('returns false on mismatch (same length, different bytes)', () => {
    const req = fakeRequest();
    getOrCreateCsrfToken(req); // populate session.csrf
    // 64 hex chars but completely different
    const bogus = 'a'.repeat(64);

    expect(verifyCsrfToken(req, bogus)).toBe(false);
  });

  it('returns false when the session has no csrf value', () => {
    const req = fakeRequest(); // no csrf set
    // even with a perfectly-shaped token, verify must fail
    const supplied = 'b'.repeat(64);

    expect(verifyCsrfToken(req, supplied)).toBe(false);
  });

  it('returns false when supplied is the wrong length', () => {
    const req = fakeRequest();
    getOrCreateCsrfToken(req);

    expect(verifyCsrfToken(req, 'short')).toBe(false);
    expect(verifyCsrfToken(req, 'a'.repeat(63))).toBe(false);
    expect(verifyCsrfToken(req, 'a'.repeat(65))).toBe(false);
  });

  it('returns false on non-string supplied values', () => {
    const req = fakeRequest();
    getOrCreateCsrfToken(req);

    expect(verifyCsrfToken(req, undefined)).toBe(false);
    expect(verifyCsrfToken(req, null)).toBe(false);
    expect(verifyCsrfToken(req, 12345)).toBe(false);
    expect(verifyCsrfToken(req, { token: 'x' })).toBe(false);
    expect(verifyCsrfToken(req, ['a'])).toBe(false);
  });

  it('returns false on non-hex characters even at the right length', () => {
    const req = fakeRequest();
    getOrCreateCsrfToken(req);
    // 64 chars but with invalid hex characters — Buffer.from(s, 'hex') will
    // silently truncate or produce a shorter buffer, which timingSafeEqual
    // catches by length mismatch.
    const notHex = 'z'.repeat(64);

    expect(verifyCsrfToken(req, notHex)).toBe(false);
  });
});
