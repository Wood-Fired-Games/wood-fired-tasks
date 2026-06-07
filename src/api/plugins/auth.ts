/**
 * Backward-compat shim — Phase 28 (Plan 28-04).
 *
 * The real auth plugin lives at `src/api/plugins/auth/index.ts` (the
 * three-strategy chain: PAT → session-stub → legacy). This file survives
 * only so existing callers — `src/api/server.ts:34`, `src/api/routes/events.ts`,
 * `src/api/__tests__/auth-logging.test.ts`, `src/api/__tests__/sse-caps.test.ts`,
 * `src/api/plugins/auth/strategies/legacy.ts` — keep their existing import
 * paths without churn.
 *
 * Verified import sites at split time:
 *   - `import authPlugin from './plugins/auth.js'`     (default)
 *   - `import { hashKey } from '../plugins/auth.js'`   (named)
 *
 * Re-exports are the entire public surface; this file contains NO
 * implementation. If you need to change auth behaviour, edit
 * `src/api/plugins/auth/index.ts` (chain) or `src/api/plugins/auth/keys.ts`
 * (key hashing).
 *
 * The `apiKeyLabel?: string` Fastify module augmentation that used to live
 * in this file (declaration of `FastifyRequest.apiKeyLabel`) was moved to
 * `src/types/fastify.d.ts` in WR-04 (Phase 28 review) so the chain module
 * at `src/api/plugins/auth/index.ts` no longer relies on this shim being
 * transitively imported to see its own typed fields. Importing this shim
 * still works exactly as before because the central declaration is loaded
 * via `tsconfig.json` includes.
 */

export { hashKey } from './auth/keys.js';
export { default, requireUser } from './auth/index.js';
