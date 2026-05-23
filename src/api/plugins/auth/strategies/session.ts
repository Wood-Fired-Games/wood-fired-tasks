// Session auth strategy — Phase 28 stub.
//
// Phase 29 replaces the body of `tryAuth` with the @fastify/secure-session
// decode logic that resolves `request.cookies['wfb_session']` to an
// AuthenticatedUser. The function signature defined here MUST NOT change
// — the chain plugin (Plan 28-04) imports it by that contract and Phase
// 29's swap is intended to be surgical.
//
// In Phase 28 the strategy always returns `{ kind: 'skip' }`. When a
// `wfb_session` cookie happens to be present (an operator manually setting
// one for testing, for instance), it emits a single `debug`-level log line
// tagged `phase: 'session-stub'` so the seam is visible / greppable.
//
// Safety: `@fastify/cookie` is NOT installed in Phase 28, so
// `request.cookies` may be `undefined`. The optional-chain access guard
// below makes the strategy tolerant of that.
import type { FastifyRequest } from 'fastify';
import type { StrategyOutcome } from './types.js';

export interface SessionDeps {
  // Intentionally empty for Phase 28. Phase 29 will add a session-backend
  // dependency (likely `cookieSecret: Buffer` + a decoder).
}

/**
 * Session strategy stub.
 *
 * Always returns `{ kind: 'skip' }` in Phase 28. The chain proceeds to
 * the legacy strategy after this returns.
 */
export async function tryAuth(
  request: FastifyRequest,
  _deps: SessionDeps = {},
): Promise<StrategyOutcome> {
  const cookies = (request as { cookies?: Record<string, string> }).cookies;
  if (cookies && cookies['wfb_session']) {
    request.log.debug(
      { phase: 'session-stub' },
      'session strategy stub returning null',
    );
  }
  return { kind: 'skip' };
}
