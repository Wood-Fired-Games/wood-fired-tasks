/**
 * Phase 30 Plan 01 Task 3 — POST /auth/device/token
 *
 * RFC 8628 §3.4 token endpoint. The CLI polls this every `interval` seconds
 * while the user approves in their browser. This plan stands up the FULL
 * error-code matrix but stops short of minting the PAT — Plan 30-04 will
 * replace the `'approved'` branch with the actual mint.
 *
 * Body content-type negotiation (RFC 8628 §3.4):
 *   - application/json  — CLI's preferred shape; our `tasks login` sends this
 *   - application/x-www-form-urlencoded — openid-client v6 sends this by
 *     default; supported for compatibility with off-the-shelf RFC 8628 clients
 *
 * Error order (first match wins — locked by behavior list in 30-01-PLAN.md):
 *   1. grant_type ≠ device_code              → unsupported_grant_type
 *   2. client_id ≠ expected                  → invalid_client
 *   3. session not found OR expired          → expired_token
 *   4. rate gate: polled inside (interval-1)s → slow_down + interval += 5
 *   5. status dispatch:
 *      - pending OR approved                  → authorization_pending
 *        (Plan 30-04 changes the 'approved' branch to mint a PAT)
 *      - denied                               → access_denied
 *      - expired                              → expired_token
 *
 * The rate gate INTENTIONALLY mutates `interval` BEFORE sending the response
 * so the CLI's next poll sees the new pace. Mutation is additive (`+= 5`)
 * per RFC 8628 §3.5, NOT multiplicative — test 7 enforces this.
 *
 * Logging contract (Threat T-30-01-04 / T-30-01-05): we log at debug only,
 * carrying just `{event, status, slow_down}`. device_code and client_id are
 * NEVER logged.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { findByDeviceCode } from '../../../services/device-flow-store.js';

export interface DeviceTokenRouteOptions {
  expectedClientId: string;
}

/** RFC 8628 §3.4 grant_type literal. */
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * Body schema — all three fields required. The `.passthrough()` lets the
 * CLI send additional fields (e.g. `scope`) without rejection; we ignore
 * everything we don't recognize.
 */
const BodySchema = z.object({
  grant_type: z.string().min(1),
  device_code: z.string().min(1),
  client_id: z.string().min(1),
});

const deviceTokenRoute: FastifyPluginAsync<DeviceTokenRouteOptions> = async (
  fastify,
  opts,
) => {
  fastify.post(
    '/auth/device/token',
    { config: { skipAuth: true } },
    async (request, reply) => {
      // request.body is either the parsed JSON object OR the formbody plugin's
      // parsed URLSearchParams shape — both surface as plain objects to Zod.
      const parsed = BodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const { grant_type, device_code, client_id } = parsed.data;

      // 1. unsupported_grant_type
      if (grant_type !== DEVICE_CODE_GRANT) {
        return reply.code(400).send({ error: 'unsupported_grant_type' });
      }

      // 2. invalid_client
      if (client_id !== opts.expectedClientId) {
        return reply.code(400).send({ error: 'invalid_client' });
      }

      // 3. expired_token — unknown OR past expiresAt.
      const session = findByDeviceCode(device_code);
      if (!session) {
        return reply.code(400).send({ error: 'expired_token' });
      }
      const now = Date.now();
      if (now > session.expiresAt) {
        return reply.code(400).send({ error: 'expired_token' });
      }

      // 4. slow_down rate gate. The "(interval - 1)" formula is RFC 8628's
      // gentle-tolerance phrasing: a client whose clock drift gives it a
      // poll arriving ~1s early is NOT considered abusive. We mutate
      // BEFORE sending so the next poll sees the new pace.
      if (
        session.lastPollAt > 0 &&
        now - session.lastPollAt < (session.interval - 1) * 1000
      ) {
        session.interval += 5;
        session.lastPollAt = now;
        request.log.debug(
          { event: 'device_flow_poll', status: session.status, slow_down: true },
          'device flow poll',
        );
        return reply.code(400).send({ error: 'slow_down' });
      }

      // 5. Normal poll path — record the timestamp BEFORE dispatching so
      // the next call sees a fresh lastPollAt regardless of outcome.
      session.lastPollAt = now;

      request.log.debug(
        { event: 'device_flow_poll', status: session.status, slow_down: false },
        'device flow poll',
      );

      switch (session.status) {
        case 'pending':
        case 'approved':
          // Plan 30-04 replaces the 'approved' branch with the PAT mint
          // (look up the user repo by approvedUserId, call generateToken,
          // insert the api_tokens row, then remove(session.deviceCode) to
          // prevent replay, then send 200 with the token). Until then
          // we deliberately keep returning authorization_pending so the
          // CLI safely polls in a loop while Plans 30-02 / 30-04 ship.
          return reply.code(400).send({ error: 'authorization_pending' });
        case 'denied':
          return reply.code(400).send({ error: 'access_denied' });
        case 'expired':
          return reply.code(400).send({ error: 'expired_token' });
      }
    },
  );
};

export default deviceTokenRoute;
