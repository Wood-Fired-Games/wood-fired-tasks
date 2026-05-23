// Legacy API_KEYS auth strategy (MIGR-01 break-glass).
//
// Behaviour ported nearly byte-for-byte from `src/api/plugins/auth.ts:170-216`
// (the existing inline preHandler that this strategy will replace once the
// chain plugin lands in Plan 28-04). The boundary changes are deliberate:
//
//   - Returns a categorical `StrategyOutcome` instead of mutating
//     `request.apiKeyLabel` / `request.log` and sending a 401. The chain
//     plugin (Plan 28-04) applies the outcome.
//   - On a successful hash match, performs the additional
//     `userRepository.findLegacyByDisplayName(label)` lookup so the
//     chain can populate `request.user` from a real `users` row (the
//     legacy identity seeded by Phase 27's identity-seeder service).
//
// The constant-time comparison loop is preserved verbatim — every
// configured hash is compared against the supplied hash regardless of
// where (or whether) a match occurs. This is the timing-attack defence
// originally documented at `src/api/plugins/auth.ts:198` and re-asserted
// by the unit test `does NOT short-circuit on first match`.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { UserRepository } from '../../../../repositories/user.repository.js';
import { hashKey } from '../../auth.js';
import type { ApiKeyEntry } from '../../../../config/env.js';
import { toAuthenticatedUser } from './pat.js';
import type { StrategyOutcome } from './types.js';

export interface LegacyDeps {
  userRepository: UserRepository;
  /**
   * Pre-computed SHA-256 hashes of every configured API_KEYS entry. The
   * chain plugin computes this once at register time via
   * `precomputeHashedEntries` and passes it in so the strategy never
   * re-hashes per request.
   */
  hashedEntries: Array<{ hash: Buffer; label: string }>;
}

/**
 * Pre-compute the SHA-256 hash + label for each parsed API_KEYS entry.
 *
 * Called once by the chain plugin at register time. The result feeds into
 * `LegacyDeps.hashedEntries` for every subsequent request, avoiding
 * per-request rehash of the configured key list.
 */
export function precomputeHashedEntries(
  entries: ApiKeyEntry[],
): Array<{ hash: Buffer; label: string }> {
  return entries.map((e) => ({ hash: hashKey(e.key), label: e.label }));
}

/**
 * Inspect the request for a legacy `x-api-key` header and return the
 * outcome.
 *
 * Decision tree:
 *   1. No / empty `x-api-key` header                   → skip
 *      (chain catch-all wraps this as `missing_credential` in the audit
 *      log if no other strategy matched.)
 *   2. Supplied hash compares equal to a configured one → look up legacy
 *      user via `findLegacyByDisplayName(label)`:
 *      - user row missing OR user.disabled_at set       → fail/user_disabled
 *      - otherwise                                       → match
 *   3. Supplied hash equals NONE of the configured hashes → fail/unknown_token
 *
 * The strategy emits NO log lines — the chain owns audit logging via
 * Phase 27's `logAuthFailure` helper.
 */
export async function tryAuth(
  request: FastifyRequest,
  deps: LegacyDeps,
): Promise<StrategyOutcome> {
  const supplied = request.headers['x-api-key'];
  if (typeof supplied !== 'string' || supplied.length === 0) {
    return { kind: 'skip' };
  }

  const suppliedHash = hashKey(supplied);

  // Constant-time compare against EVERY configured hash. Do NOT break on
  // first match — keeping the comparison count fixed prevents leaking the
  // match position (or the existence of any match at all) via wall-clock
  // timing. Preserved verbatim from src/api/plugins/auth.ts:194-200.
  let matchedLabel: string | undefined;
  for (const entry of deps.hashedEntries) {
    if (timingSafeEqual(entry.hash, suppliedHash)) {
      matchedLabel = entry.label;
      // Do NOT break — keeps total comparison count fixed.
    }
  }

  if (matchedLabel === undefined) {
    return { kind: 'fail', reasonCode: 'unknown_token' };
  }

  // Match — resolve the legacy `users` row Phase 27 seeded so the chain
  // can populate `request.user` with a real principal. `is_legacy=1` is
  // already enforced inside the repository query.
  const user = deps.userRepository.findLegacyByDisplayName(matchedLabel);
  if (user === null || user.disabled_at !== null) {
    return { kind: 'fail', reasonCode: 'user_disabled' };
  }

  return {
    kind: 'match',
    result: {
      user: toAuthenticatedUser(user),
      authMethod: 'legacy',
      tokenId: null,
    },
    label: matchedLabel,
  };
}
