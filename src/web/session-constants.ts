/**
 * Phase 29 (Plan 29-04) session lifetime constants.
 *
 * Exported from a standalone module so the value can be imported by BOTH
 * `src/api/server.ts` (passed to @fastify/secure-session's `expiry` AND
 * `cookie.maxAge` options) AND by tests (asserting both call sites use the
 * same number).
 *
 * Locked in v1.6 STATE.md: 8 hours, no idle timeout (idle timeout deferred
 * to v1.7). 29-RESEARCH.md R4 calls for BOTH `expiry` and `cookie.maxAge` to
 * be 28800 — server-side expiry enforcement + browser-side cookie lifetime
 * agreement.
 */

/**
 * Session lifetime in seconds. Used as both:
 *  - `expiry` (server-side @fastify/secure-session enforcement)
 *  - `cookie.maxAge` (browser-side Set-Cookie attribute)
 *
 * 28800 seconds = 8 hours.
 */
export const SESSION_LIFETIME_SECONDS = 28800;
