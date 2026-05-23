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
 * (key hashing + production validation).
 *
 * The `apiKeyLabel?: string` declaration is kept here to preserve MIGR-01
 * legacy compat — every existing route handler that reads
 * `request.apiKeyLabel` (notably `routes/events.ts` SSE fingerprinting) sees
 * the same typed surface as before the split. The chain plugin's
 * `decorateRequest('apiKeyLabel', undefined)` populates the slot at register
 * time exactly as the pre-split plugin did.
 */

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyLabel?: string;
  }
}

export { hashKey, validateApiKeysForProduction } from './auth/keys.js';
export { default, requireUser } from './auth/index.js';
