import { describe, it, expect, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { tryAuth } from '../session.js';

/**
 * Session strategy unit tests (Phase 28 stub).
 *
 * The session strategy is a behavioural seam — it always returns
 * `{ kind: 'skip' }` in Phase 28 and only emits a single debug log line
 * when a `wfb_session` cookie is observed. Phase 29 swaps the body to
 * decode the @fastify/secure-session cookie; the function signature must
 * stay identical.
 *
 * Key safety property: the strategy must NOT throw when `request.cookies`
 * is `undefined` (since @fastify/cookie is not installed in Phase 28).
 */

function makeRequest(opts: { cookies?: Record<string, string> }): {
  req: FastifyRequest;
  debug: ReturnType<typeof vi.fn>;
} {
  const debug = vi.fn();
  const req = {
    headers: {},
    log: { debug },
    ...(opts.cookies !== undefined ? { cookies: opts.cookies } : {}),
  } as unknown as FastifyRequest;
  return { req, debug };
}

describe('Session strategy tryAuth (Phase 28 stub)', () => {
  it('returns skip and does NOT log when request has no cookies object', async () => {
    const { req, debug } = makeRequest({});
    const out = await tryAuth(req);
    expect(out).toEqual({ kind: 'skip' });
    expect(debug).not.toHaveBeenCalled();
  });

  it('returns skip and does NOT log when cookies object lacks wfb_session', async () => {
    const { req, debug } = makeRequest({ cookies: { other: 'value' } });
    const out = await tryAuth(req);
    expect(out).toEqual({ kind: 'skip' });
    expect(debug).not.toHaveBeenCalled();
  });

  it('returns skip and DOES log exactly once when wfb_session is present', async () => {
    const { req, debug } = makeRequest({
      cookies: { wfb_session: 'encrypted-cookie-blob' },
    });
    const out = await tryAuth(req);
    expect(out).toEqual({ kind: 'skip' });
    expect(debug).toHaveBeenCalledTimes(1);
    // First arg is the structured payload — must include the documented
    // phase tag so Phase 29 wiring is grep-able.
    expect(debug).toHaveBeenCalledWith(
      { phase: 'session-stub' },
      'session strategy stub returning null',
    );
  });

  it('does NOT throw when cookies is undefined (pre @fastify/cookie install)', async () => {
    const { req } = makeRequest({});
    // Intentional: no `cookies` field at all on the request.
    expect((req as unknown as { cookies?: unknown }).cookies).toBeUndefined();
    await expect(tryAuth(req)).resolves.toEqual({ kind: 'skip' });
  });
});
