// Personal Access Token (PAT) auth strategy.
//
// Pure async function (almost: a single warn log fires when `expires_at`
// is non-null but unparseable — see WR-03 below) that inspects the
// incoming `Authorization` header and returns a discriminated
// `StrategyOutcome`. The chain plugin (Phase 28 Plan 04) composes it with
// the session and legacy strategies and applies the side effects.
//
// Token format (locked by 27-CONTEXT.md):
//   wfb_pat_<32 chars of RFC 4648 base32 (A-Z, 2-7), no padding>
//
// Five categorical failure reasons match the Phase 27 AuthFailureReason
// enum exactly: wrong_prefix | unknown_token | revoked | expired |
// user_disabled. The chain emits these via logAuthFailure(); strategies
// only RETURN reasonCodes, never log them.
import type { FastifyRequest } from 'fastify';
import type { ApiTokenRepository } from '../../../../repositories/api-token.repository.js';
import type { UserRepository } from '../../../../repositories/user.repository.js';
import type { AuthenticatedUser, User } from '../../../../types/identity.js';
import { hashToken, PAT_PREFIX } from '../../../../services/pat-hash.js';
import type { StrategyOutcome } from './types.js';

/** Standard HTTP Bearer scheme prefix (RFC 6750 §2.1). */
const BEARER_PREFIX = 'Bearer ';

/** RFC 4648 base32 body: exactly 32 uppercase letters or digits 2..7. */
const PAT_BODY_PATTERN = /^[A-Z2-7]{32}$/;

export interface PatDeps {
  apiTokenRepository: ApiTokenRepository;
  userRepository: UserRepository;
}

/**
 * Map a snake_case `users` row to the camelCase boundary projection that
 * the auth chain populates on `request.user`.
 *
 * SQLite returns booleans as INTEGER (0|1); the projection normalises to
 * the boolean type the downstream consumers expect. Exported so the legacy
 * strategy can share the conversion in Task 3.
 */
export function toAuthenticatedUser(user: User): AuthenticatedUser {
  return {
    id: user.id,
    displayName: user.display_name,
    email: user.email,
    isLegacy: user.is_legacy === 1,
    isServiceAccount: user.is_service_account === 1,
  };
}

/**
 * Inspect the request for a PAT credential and return the outcome.
 *
 * Decision tree:
 *   1. No Authorization header                       → skip
 *   2. Authorization doesn't start with `Bearer `    → skip
 *   3. Bearer body doesn't start with `wfb_pat_`     → skip (legacy may try)
 *   4. PAT body shape wrong (length / charset)       → fail/wrong_prefix
 *   5. findByHash returns null                       → fail/unknown_token
 *   6. row.revoked_at is set                         → fail/revoked
 *   7. row.expires_at is past wall-clock now         → fail/expired
 *   8. user row missing OR user.disabled_at set      → fail/user_disabled
 *   9. all checks pass                               → match
 *
 * No side effects: no log writes, no last_used_at update — the chain (Plan
 * 4) does both centrally after a strategy returns. Keeps this function
 * pure and unit-testable without a Fastify instance.
 */
export async function tryAuth(
  request: FastifyRequest,
  deps: PatDeps,
): Promise<StrategyOutcome> {
  const auth = request.headers.authorization;
  if (typeof auth !== 'string') {
    return { kind: 'skip' };
  }
  if (!auth.startsWith(BEARER_PREFIX)) {
    return { kind: 'skip' };
  }
  const token = auth.slice(BEARER_PREFIX.length);
  if (!token.startsWith(PAT_PREFIX)) {
    // Some other Bearer flavour (e.g. JWT). Defer to other strategies.
    return { kind: 'skip' };
  }
  const body = token.slice(PAT_PREFIX.length);
  if (!PAT_BODY_PATTERN.test(body)) {
    // The caller used our prefix but a malformed body. This is past the
    // skip→fail boundary: we own the credential, so we categorise it.
    return { kind: 'fail', reasonCode: 'wrong_prefix' };
  }

  const row = deps.apiTokenRepository.findByHash(hashToken(token));
  if (row === null) {
    return { kind: 'fail', reasonCode: 'unknown_token' };
  }
  if (row.revoked_at !== null) {
    return { kind: 'fail', reasonCode: 'revoked' };
  }
  if (row.expires_at !== null) {
    const expiresMs = new Date(row.expires_at).getTime();
    // WR-03 (Phase 28 review) — fail-closed on unparseable values. The
    // route-level `MintTokenBodySchema` uses `z.string().datetime()` so
    // the API mint path is safe; this guards against a hand-edited DB or
    // a future write path that drifts from the ISO-8601 contract. Without
    // the explicit NaN check, `NaN < Date.now()` is `false`, so a token
    // with `expires_at = 'soon'` would be treated as still valid.
    if (Number.isNaN(expiresMs)) {
      request.log.warn(
        { tokenId: row.id, expiresAt: row.expires_at },
        'pat.expires_at_unparseable',
      );
      return { kind: 'fail', reasonCode: 'expired' };
    }
    if (expiresMs < Date.now()) {
      return { kind: 'fail', reasonCode: 'expired' };
    }
  }

  const user = deps.userRepository.findById(row.user_id);
  // Both "user row missing" (FK cascade should make this impossible but
  // we defend against it) and "user.disabled_at set" collapse to one
  // reasonCode: user_disabled. Distinguishing them would leak existence.
  if (user === null || user.disabled_at !== null) {
    return { kind: 'fail', reasonCode: 'user_disabled' };
  }

  return {
    kind: 'match',
    result: {
      user: toAuthenticatedUser(user),
      authMethod: 'pat',
      tokenId: row.id,
    },
  };
}
