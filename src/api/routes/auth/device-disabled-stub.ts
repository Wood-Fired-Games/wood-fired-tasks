/**
 * Phase 30 Plan 08 — 501 stub for /auth/device/* when OIDC is disabled.
 *
 * Mirrors the Phase 29 `disabled-stub.ts` pattern for the four device-flow
 * routes introduced in Plans 30-01 / 30-02 / 30-04:
 *
 *   POST /auth/device/code   → 501 { error: 'OIDC_DISABLED', ... }
 *   POST /auth/device/token  → 501 { error: 'OIDC_DISABLED', ... }
 *   GET  /auth/device        → 501 { error: 'OIDC_DISABLED', ... }
 *   POST /auth/device/verify → 501 { error: 'OIDC_DISABLED', ... }
 *
 * Why a separate file (not extending Phase 29's disabled-stub.ts): Plan 30-08
 * §interfaces calls out keeping the two stubs as siblings so each one's
 * surface stays focused on its own route family — a future migration that
 * turns OIDC off (or on) for ONE family without the other doesn't have to
 * untangle a single combined plugin.
 *
 * All four routes carry `config: { skipAuth: true }` mirroring the enabled
 * routes (device-code.ts, device-token.ts, device-html.ts) so that even if
 * a future change hoists the Phase 28 auth chain above the /auth prefix it
 * would short-circuit them. (The chain is currently /api/v1-scoped; this is
 * belt-and-braces.)
 *
 * Response body shape — locked at `{ error: 'OIDC_DISABLED', message: ... }`
 * with screaming-snake uppercase to MATCH the Plan-30-08 truths block AND
 * distinguish operationally from Phase 29's lowercase `oidc_disabled` (the
 * CLI's polling logic can use the case to disambiguate without parsing the
 * message). The message explicitly names the env var the operator must set
 * so the response is self-documenting for grep / log triage.
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';

const STUB_BODY = {
  error: 'OIDC_DISABLED',
  message:
    'OIDC is not configured. Set OIDC_REDIRECT_URI and related env vars to enable CLI authentication.',
} as const;

const handler = async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
  reply.header('Content-Type', 'application/json; charset=utf-8').code(501).send(STUB_BODY);

const deviceDisabledStub: FastifyPluginAsync = async (fastify) => {
  fastify.post('/device/code', { config: { skipAuth: true } }, handler);
  fastify.post('/device/token', { config: { skipAuth: true } }, handler);
  fastify.get('/device', { config: { skipAuth: true } }, handler);
  fastify.post('/device/verify', { config: { skipAuth: true } }, handler);
};

export default deviceDisabledStub;
