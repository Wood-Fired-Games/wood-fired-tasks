/**
 * Phase 29 test helpers — extract + replay encrypted session cookies
 * across server.inject() calls.
 *
 * @fastify/secure-session emits its sealed-box cookie via the `Set-Cookie`
 * response header. `extractSessionCookie` peels off that header (handling
 * multi-cookie responses) and returns the `name=value` portion the caller
 * can supply as `headers.cookie` on the follow-up request.
 *
 * Used by 29-04 session-plugin tests AND downstream plans (29-05 session
 * strategy, 29-06 OIDC routes, 29-09 me-tokens HTML path).
 */
import type { FastifyInstance } from 'fastify';
import type { Response } from 'light-my-request';

/**
 * Extract the encrypted session cookie's `name=value` segment from a
 * response's Set-Cookie header. Returns null if no matching cookie was
 * emitted (e.g. session was untouched on this response).
 *
 * Handles both single-string and string-array `set-cookie` shapes that
 * light-my-request can return.
 */
export function extractSessionCookie(
  response: Pick<Response, 'headers'>,
  cookieName = 'wfb_session',
): string | null {
  const raw = response.headers['set-cookie'];
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const entry of list) {
    const first = entry.split(';', 1)[0];
    if (first.startsWith(`${cookieName}=`)) return first;
  }
  return null;
}

/**
 * For Plan 29-05's session-strategy tests AND Plan 29-09's me-tokens.test.ts
 * refactor: drive a real OIDC callback (nock-mocked) and return the
 * resulting Set-Cookie value so subsequent inject() calls carry the session.
 *
 * Implemented fully in Plan 29-05; here we ship the placeholder so Plan
 * 29-05's diff is just the body.
 */
export async function signInSessionFor(
  _server: FastifyInstance,
  _userId: number,
): Promise<string> {
  throw new Error('signInSessionFor: implemented in Plan 29-05');
}
