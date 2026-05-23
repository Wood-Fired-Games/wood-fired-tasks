/**
 * Phase 29 session auth strategy.
 *
 * Replaces the Phase 28 stub. The function signature is intentionally
 * unchanged — the chain orchestrator at src/api/plugins/auth/index.ts:310
 * calls `tryAuth(request, deps)` and the Phase 28 contract locked that
 * shape. Only the body and the `SessionDeps` interface are new.
 *
 * Behavior:
 *   1. No session backend (request.session undefined) → skip.
 *      This preserves the Phase 28 "OIDC disabled mode" guarantee: when
 *      @fastify/secure-session has NOT been registered, the chain proceeds
 *      to the legacy strategy unchanged.
 *   2. No session.user payload → skip.
 *   3. session.user.id looked up via userRepository.findById. If the user
 *      row is absent OR `disabled_at IS NOT NULL`, the strategy clears the
 *      session via `session.delete()`, emits a warn-level audit line, and
 *      returns skip (chain proceeds to legacy). Distinguishing "disabled"
 *      from "missing" in the response or log would leak existence; both
 *      collapse to one outcome.
 *   4. Otherwise return match with authMethod='session', tokenId=null.
 *
 * Side effects:
 *   - `session.delete()` on disabled/missing user (mid-session disable).
 *   - One `request.log.warn` line tagged
 *     `session.user_disabled_during_active_session`. The chain's
 *     `logAuthFailure` is NOT invoked from here — the strategy returns skip,
 *     so the chain moves on. The warn line is the only audit trace of the
 *     forced logout.
 */
import type { FastifyRequest } from 'fastify';
import type { UserRepository } from '../../../../repositories/user.repository.js';
import type { StrategyOutcome } from './types.js';
import { toAuthenticatedUser } from './pat.js';

export interface SessionDeps {
  userRepository: UserRepository;
}

/**
 * Shape of the payload the OIDC callback writes into the session via
 * `request.session.set('user', { id })`. Plan 6 owns the write site; this
 * file is its only documented reader.
 */
interface SessionUserPayload {
  id: number;
}

/**
 * Shape projection for the optional `request.session` decorator. The
 * @fastify/secure-session module decorates with `get`/`delete`/`set`/etc.;
 * we narrow to just what this strategy uses so the `request as { ... }`
 * cast does not over-promise.
 */
interface MaybeSession {
  session?: {
    get: <K extends string>(key: K) => unknown;
    delete: () => void;
  };
}

export async function tryAuth(
  request: FastifyRequest,
  deps: SessionDeps,
): Promise<StrategyOutcome> {
  // Defensive: in OIDC-disabled mode the secure-session plugin is NOT
  // registered, so request.session is undefined. The optional-property
  // pattern mirrors the Phase 28 stub for safety against a later refactor
  // that removes the plugin again.
  const session = (request as unknown as MaybeSession).session;
  if (!session) {
    return { kind: 'skip' };
  }

  const payload = session.get('user') as SessionUserPayload | undefined;
  if (!payload) {
    return { kind: 'skip' };
  }

  const row = deps.userRepository.findById(payload.id);
  if (!row || row.disabled_at !== null) {
    session.delete();
    request.log.warn(
      { user_id: payload.id },
      'session.user_disabled_during_active_session',
    );
    return { kind: 'skip' };
  }

  return {
    kind: 'match',
    result: {
      user: toAuthenticatedUser(row),
      authMethod: 'session',
      tokenId: null,
    },
  };
}
