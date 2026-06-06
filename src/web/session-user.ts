/**
 * Phase 29 CR-02 fix — shared "session present AND user still active" guard
 * for the web HTML routes (`/me`, `/me/tokens`, `POST /me/tokens/:id/revoke`).
 *
 * Background:
 * The session strategy at `src/api/plugins/auth/strategies/session.ts` re-reads
 * the user row on every request and clears the session if `disabled_at IS NOT
 * NULL`. That defense ONLY applies to routes that pass through the auth
 * chain — which is `/api/v1/*` only. The web HTML routes carry
 * `config: { skipAuth: true }` and previously read `request.session?.get('user')`
 * directly, then trusted that snapshot. A user disabled mid-session could
 * continue accessing the profile page and PAT management UI for up to 8 hours
 * after disable.
 *
 * `resolveActiveSessionUser` closes that gap by performing the same
 * `findById` + `disabled_at` check as the session strategy, with identical
 * side effects:
 *   - Returns the AuthenticatedUser when the session is present AND the user
 *     row exists AND `disabled_at IS NULL`.
 *   - Returns null AND clears the session via `session.delete()` + emits a
 *     warn-level audit line when the user is missing or disabled.
 *   - Returns null without clearing when no session is present at all (the
 *     normal "no cookie yet" case — handlers redirect to /auth/login).
 *
 * "Missing" and "disabled" collapse to the same outcome on purpose:
 * distinguishing them in the response or log would leak user-existence
 * (mirrors the session strategy's behavior at strategies/session.ts:80-87).
 *
 * Why a separate helper (not just calling the strategy directly):
 * the strategy returns a `StrategyOutcome` discriminated union shaped for
 * the auth chain. Web routes only need "is this caller still active?" — a
 * thin boolean-equivalent. Sharing the underlying findById + disabled_at
 * check via this helper keeps both paths in lockstep without dragging the
 * chain's plumbing into the web layer.
 */
import type { FastifyRequest } from 'fastify';
import type { UserRepository } from '../repositories/user.repository.js';
import type { AuthenticatedUser } from '../types/identity.js';
import { toAuthenticatedUser } from '../api/plugins/auth/strategies/pat.js';

/**
 * Shape projection for the optional `request.session` decorator. Mirrors
 * the narrowing pattern in strategies/session.ts so the cast does not
 * over-promise the secure-session surface.
 */
interface MaybeSession {
  session?: {
    get: <K extends string>(key: K) => unknown;
    delete: () => void;
  };
}

interface SessionUserPayload {
  id: number;
}

/**
 * Resolve the currently-authenticated user for a web HTML route.
 *
 * Returns null in three cases:
 *   1. No session backend (OIDC-disabled mode — secure-session not registered).
 *   2. No `session.user` payload (visitor has never signed in, or the session
 *      cookie was cleared).
 *   3. Session present but the user row is missing OR `disabled_at IS NOT NULL`.
 *      Cases 3a (missing) and 3b (disabled) collapse to the same outcome:
 *      the session is cleared via `session.delete()` AND a single warn-level
 *      audit line is emitted, tagged `web.user_disabled_during_active_session`.
 *      Distinguishing them would leak existence (Threat T-29-05-04).
 *
 * Callers should redirect to `/auth/login?next=<current path>` on null.
 *
 * Side effects:
 *   - `request.session.delete()` ONLY in case (3).
 *   - One `request.log.warn` line ONLY in case (3). Cases (1) and (2) are
 *     normal unauthenticated traffic and produce no log noise.
 */
export function resolveActiveSessionUser(
  request: FastifyRequest,
  userRepository: UserRepository,
): AuthenticatedUser | null {
  const session = (request as unknown as MaybeSession).session;
  if (!session) {
    // Case (1): OIDC-disabled mode. The web routes only register when
    // secure-session is active (see server.ts), so reaching here implies a
    // misconfiguration; bail safely without logging.
    return null;
  }

  const payload = session.get('user') as SessionUserPayload | undefined;
  if (!payload) {
    // Case (2): no session.user — visitor is unauthenticated. Normal path.
    return null;
  }

  const row = userRepository.findById(payload.id);
  if (!row || row.disabled_at !== null) {
    // Case (3): missing OR disabled. Clear the session AND log.
    session.delete();
    request.log.warn({ user_id: payload.id }, 'web.user_disabled_during_active_session');
    return null;
  }

  return toAuthenticatedUser(row);
}
