/**
 * Failed-auth audit-log helper.
 *
 * Locks the AUDIT-03 contract: the helper signature physically cannot accept
 * a raw credential. Callers MUST reduce the failure to a categorical
 * `reasonCode` before invoking, which makes credential-leakage a compile-time
 * error rather than a runtime convention.
 *
 * Used by Phase 28's auth chain (PAT / session / legacy strategies). Defined
 * here in Phase 27 so the contract is fixed before any caller exists.
 */

/** Authentication strategy that produced the failure. */
export type AuthStrategy = 'pat' | 'session' | 'legacy';

/**
 * Categorical reason a credential-bearing request was rejected. The set is
 * intentionally narrow — anything that does not fit one of these buckets
 * should be widened here (and in the test fixture) rather than smuggled in
 * via a free-form string.
 */
export type AuthFailureReason =
  | 'missing_credential'
  | 'malformed'
  | 'unknown_token'
  | 'revoked'
  | 'expired'
  | 'user_disabled'
  | 'wrong_prefix';

/**
 * Required context for every auth-failure log line. There is NO field for
 * the supplied credential — this is the discipline the helper enforces.
 */
export interface AuthFailureContext {
  readonly strategy: AuthStrategy;
  readonly reasonCode: AuthFailureReason;
  readonly requestId: string;
  readonly peerIp: string;
}

/**
 * Structural logger contract — compatible with both Fastify's
 * `FastifyBaseLogger` and a vitest mock. Kept minimal to avoid pulling
 * Fastify types into the helper's surface.
 */
export interface MinimalWarnLogger {
  warn(obj: object, msg?: string): void;
}

/**
 * Emit exactly one `warn`-level structured log line tagged `auth.failure`.
 *
 * The payload is deliberately minimal: `tag`, `strategy`, `reasonCode`,
 * `requestId`, `peerIp` — nothing else. Aggregators filter on `tag` and
 * group by `strategy` + `reasonCode`.
 */
export function logAuthFailure(
  logger: MinimalWarnLogger,
  ctx: AuthFailureContext,
): void {
  logger.warn(
    {
      tag: 'auth.failure',
      strategy: ctx.strategy,
      reasonCode: ctx.reasonCode,
      requestId: ctx.requestId,
      peerIp: ctx.peerIp,
    },
    'Authentication failed',
  );
}
