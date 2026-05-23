/**
 * Phase 29 (Plan 29-05) — OIDC user lifecycle service.
 *
 * Owns the "lookup → insert OR update" path the /auth/callback handler
 * (Plan 6) calls after successful ID-token validation. Returns the
 * canonical `users` row matching the supplied (provider, sub) identity.
 *
 * Repository owns SQL; this module owns the business rules:
 *   - Idempotent re-login: same (provider, sub) returns same row.
 *   - Drift handling: email or displayName changes apply via updateProfile.
 *   - Race recovery: a concurrent INSERT racing this one surfaces as a
 *     UNIQUE violation; we catch and re-resolve via findByOidcSub.
 *
 * Pure dep-injection — no module-level state, no Fastify coupling. Unit
 * tests use a hand-rolled IUserRepository mock without instantiating a
 * Fastify app or SQLite database.
 *
 * Empty displayName handling: the caller (Plan 6 callback) is responsible
 * for falling back to `email` BEFORE invoking upsertFromOidc. The service
 * rejects empty displayName by surfacing UserRepository.insert's TypeError
 * unchanged.
 */
import type { IUserRepository } from '../repositories/interfaces.js';
import type { User, UserUpsertInput } from '../types/identity.js';

export interface UpsertFromOidcDeps {
  userRepository: IUserRepository;
}

/**
 * Look up by (provider, sub); if found, apply any email/displayName drift
 * and return the row. If not found, insert a new row and return it. On
 * UNIQUE violation racing a concurrent insert, recover by re-resolving
 * via findByOidcSub.
 *
 * @throws TypeError when displayName is empty (surfaced from
 *         UserRepository.insert).
 * @throws Error when updateProfile returns null mid-flight (row deleted
 *         between findByOidcSub and updateProfile) — extremely unlikely
 *         in v1.6 (no delete path), but fail loud rather than silently
 *         re-insert.
 * @throws Error (rethrown) when insert fails for a reason OTHER than a
 *         UNIQUE race (e.g. SQLITE_FULL).
 */
export function upsertFromOidc(
  deps: UpsertFromOidcDeps,
  input: UserUpsertInput,
): User {
  const { userRepository } = deps;

  const existing = userRepository.findByOidcSub(input.provider, input.sub);
  if (existing) {
    const emailDrifted = (existing.email ?? null) !== (input.email ?? null);
    const displayNameDrifted = existing.display_name !== input.displayName;
    if (!emailDrifted && !displayNameDrifted) {
      return existing;
    }
    const patch: { email?: string | null; displayName?: string } = {};
    if (emailDrifted) patch.email = input.email;
    if (displayNameDrifted) patch.displayName = input.displayName;
    const updated = userRepository.updateProfile(existing.id, patch);
    if (updated) return updated;
    // updateProfile returning null mid-flight means the row was deleted
    // between findByOidcSub and updateProfile — extremely unlikely (no
    // delete path in v1.6), but fail loud rather than silently re-insert.
    throw new Error(
      `upsertFromOidc: user ${existing.id} disappeared mid-update`,
    );
  }

  try {
    return userRepository.insert(input);
  } catch (err) {
    // Race window: a concurrent callback for the same (provider, sub)
    // already INSERTed between our findByOidcSub and our insert. Surface
    // as a UNIQUE violation; re-resolve and return.
    const racer = userRepository.findByOidcSub(input.provider, input.sub);
    if (racer) return racer;
    // Genuinely a different failure (e.g. CHECK constraint, disk full).
    // Surface the original error.
    throw err;
  }
}
