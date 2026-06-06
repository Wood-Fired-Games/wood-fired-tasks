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
  cookieName = 'wft_session',
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
 * Plan 29-09: implementation of signInSessionFor.
 *
 * Inject a logged-in session for a user, returning the cookie header value
 * the caller should pass on subsequent `server.inject({ headers: { cookie } })`
 * calls.
 *
 * Strategy: mount a one-time test-only probe route on the server that takes
 * a user id, looks up the row via `server.userRepository.findById`, stamps
 * `request.session.set('user', ...)` exactly as the production OIDC callback
 * would (per `src/api/routes/auth/callback.ts`), and returns 204. The
 * Set-Cookie header from the probe response IS the production session
 * cookie — the test then attaches it to its real assertions and exercises
 * the production session-strategy + auth-chain path end-to-end.
 *
 * This replaces the Phase 28 `vi.mock('...strategies/session.js', ...)`
 * pattern in `src/api/__tests__/me-tokens.test.ts` (Phase 29 R5 — the only
 * categorically-allowed weakening pattern, now strictly stronger because
 * the production cookie + session strategy are both exercised).
 *
 * Why a probe route instead of a real /auth/callback round-trip?
 *   - The OIDC callback requires the full nock stack (discovery + JWKS +
 *     token endpoint) just to inject a session, which is overkill for
 *     me-tokens.test.ts whose subject is /api/v1/me/tokens, not OIDC.
 *   - Plan 29-06's `auth-routes.test.ts` already exercises the real
 *     callback end-to-end (with nock), so the cookie-issuance path itself
 *     is covered.
 *   - The probe route mounts under `/__test/*` and is wired only by this
 *     helper, never by `src/api/server.ts`. There is no production code
 *     path that hits it.
 *
 * Caller responsibility:
 *   - The server must have @fastify/secure-session registered. In practice
 *     this means the harness must set `process.env.SESSION_COOKIE_SECRET`
 *     to a valid 32-byte base64 string BEFORE `createServer()` runs (the
 *     env-loader gates secure-session on this var; see
 *     `src/api/server.ts:301` and `src/config/env.ts`).
 *   - A row must exist in `users` for the supplied `userId` so the
 *     production session strategy's `findById` returns non-null and the
 *     `disabled_at IS NULL` gate passes.
 */
export async function signInSessionFor(server: FastifyInstance, userId: number): Promise<string> {
  const PROBE_PATH = '/__test/session-sign-in';
  if (!server.hasRoute({ method: 'POST', url: PROBE_PATH })) {
    server.post(PROBE_PATH, { config: { skipAuth: true } }, async (request, reply) => {
      const body = request.body as { userId: number };
      const row = server.userRepository.findById(body.userId);
      if (!row) {
        return reply.code(404).send({ error: 'user_not_found' });
      }
      // Mirror the OIDC-callback session payload (Plan 29-06).
      request.session.set('user', { id: row.id });
      request.session.set('authenticatedAt', Date.now());
      return reply.code(204).send();
    });
    await server.ready();
  }

  const res = await server.inject({
    method: 'POST',
    url: PROBE_PATH,
    payload: { userId },
    headers: { 'content-type': 'application/json' },
  });
  if (res.statusCode !== 204) {
    throw new Error(`signInSessionFor: probe returned ${res.statusCode}: ${res.body}`);
  }
  const cookie = extractSessionCookie(res);
  if (!cookie) {
    throw new Error(
      'signInSessionFor: probe responded 204 but emitted no Set-Cookie header — ' +
        'check that @fastify/secure-session is registered (set SESSION_COOKIE_SECRET before createServer).',
    );
  }
  return cookie;
}
