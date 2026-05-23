/**
 * Phase 30 Plan 01 Task 2 — POST /auth/device/code
 *
 * RFC 8628 §3.1 device-authorization request. Anonymous (no auth) POST that
 * starts a new device-flow session. The CLI calls this, then polls
 * `/auth/device/token` while the user approves in their browser.
 *
 * Plugin factory signature: `deviceCodeRoute({ origin, expectedClientId })`.
 * The `origin` becomes the base of `verification_uri` (`${origin}/auth/device`)
 * and `verification_uri_complete` (`${origin}/auth/device?user_code=…`). Plan
 * 30-08 wires these from `env.OIDC_REDIRECT_URI`'s origin and `env.OIDC_CLIENT_ID`
 * at server.ts registration time.
 *
 * Response envelope (locked by RFC 8628 §3.2):
 *   { device_code, user_code, verification_uri, verification_uri_complete,
 *     expires_in: 600, interval: 5 }
 *
 * Error envelope (RFC 8628 §3.2):
 *   400 { error: 'invalid_request' }  — missing/malformed client_id
 *   400 { error: 'invalid_client' }   — client_id ≠ expectedClientId
 *
 * Logging contract (Threat T-30-01-04): we emit one structured info line per
 * successful start: `{ event: 'device_flow_started', clientId, hostname }`.
 * device_code AND user_code are NEVER logged.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createSession } from '../../../services/device-flow-store.js';

export interface DeviceCodeRouteOptions {
  /**
   * Server origin used to build the verification URIs the CLI prints. Plan
   * 30-08 sources this from `new URL(env.OIDC_REDIRECT_URI).origin`.
   * Example: `https://woodfiredbugs.local`.
   */
  origin: string;
  /**
   * Expected OAuth client_id. Locked single-client in v1.6 (Phase 29 ships
   * one OIDC_CLIENT_ID; we reject anything else).
   */
  expectedClientId: string;
}

/**
 * Body schema for POST /auth/device/code (JSON only — RFC 8628 lets servers
 * pick; the CLI always sends JSON). `scope` is accepted-and-ignored in v1.6
 * (no scope split yet; the minted PAT is always full-scope).
 */
const BodySchema = z.object({
  client_id: z.string().min(1),
  hostname: z.string().optional(),
  scope: z.string().optional(),
});

const deviceCodeRoute: FastifyPluginAsync<DeviceCodeRouteOptions> = async (
  fastify,
  opts,
) => {
  fastify.post(
    '/auth/device/code',
    { config: { skipAuth: true } },
    async (request, reply) => {
      // Manual Zod parse so the error envelope matches RFC 8628 verbatim
      // (`{error: 'invalid_request'}`) — Fastify's default 400 carries the
      // `statusCode/error/message` triplet which is not what RFC 8628 wants.
      const parsed = BodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_request',
          error_description: 'client_id is required',
        });
      }
      const { client_id, hostname } = parsed.data;

      if (client_id !== opts.expectedClientId) {
        return reply.code(400).send({ error: 'invalid_client' });
      }

      const session = createSession({
        clientId: client_id,
        hostname: hostname ?? null,
      });

      // Audit log — no secrets. `event` is the canonical correlation key
      // pluggable into the analytics DB downstream.
      request.log.info(
        {
          event: 'device_flow_started',
          clientId: client_id,
          hostname: hostname ?? null,
        },
        'device flow started',
      );

      return reply.code(200).send({
        device_code: session.deviceCode,
        user_code: session.userCode,
        verification_uri: `${opts.origin}/auth/device`,
        verification_uri_complete: `${opts.origin}/auth/device?user_code=${session.userCode}`,
        expires_in: 600 as const,
        interval: 5 as const,
      });
    },
  );
};

export default deviceCodeRoute;
