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
import {
  findByDeviceCode,
  remove,
} from '../../../services/device-flow-store.js';
import { toAuthenticatedUser } from '../../plugins/auth/strategies/pat.js';

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
  // Plan 30-04 — token endpoint reads userRepository to build the success
  // envelope's `user` field. Fail fast at register time if the host app
  // didn't wire it.
  if (!fastify.hasDecorator('userRepository')) {
    throw new Error(
      'deviceTokenRoute requires userRepository to be decorated before registration',
    );
  }

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
          return reply.code(400).send({ error: 'authorization_pending' });
        case 'approved': {
          // Plan 30-04: the verify handler mints the PAT and stashes
          // {tokenId, token} on the session via recordMintedToken. The
          // CLI may poll between approve() and the mint completing (a
          // narrow window, but real — DB outage path keeps the session
          // in approved/unminted state). In that case the CLI must keep
          // polling, NOT receive a half-built envelope.
          if (
            session.mintedToken === null ||
            session.mintedTokenId === null ||
            session.approvedUserId === null
          ) {
            return reply
              .code(400)
              .send({ error: 'authorization_pending' });
          }
          // Look up the approver to project an AuthenticatedUser into
          // the success envelope. Anything missing here is a bug — the
          // user existed when verify ran, and the FK ON DELETE CASCADE
          // would have killed the api_tokens row too. Treat as 500-class.
          const userRow = fastify.userRepository.findById(
            session.approvedUserId,
          );
          if (!userRow) {
            request.log.error(
              {
                event: 'device_flow_user_vanished',
                userId: session.approvedUserId,
                tokenId: session.mintedTokenId,
              },
              'approved user not found at token delivery',
            );
            // WR-02 (Phase 30 review) — purge the orphan PAT row + drop
            // the session so a) the user_id-less row doesn't linger in
            // the DB until the FK cascade catches up, and b) the
            // plaintext PAT held by `session.mintedToken` clears from
            // process memory immediately (instead of waiting the
            // remaining TTL × poll-frequency cycles). Both operations
            // are best-effort: a failed revoke is logged but does not
            // change the response (the CLI still gets expired_token).
            try {
              fastify.apiTokenRepository.revoke(
                session.mintedTokenId,
                session.approvedUserId,
              );
            } catch (revokeErr) {
              request.log.error(
                {
                  err: revokeErr,
                  event: 'pat_orphan_revoke_failed',
                  userId: session.approvedUserId,
                  tokenId: session.mintedTokenId,
                },
                'failed to revoke orphan PAT for vanished user',
              );
            }
            remove(session.deviceCode);
            return reply.code(400).send({ error: 'expired_token' });
          }
          const successEnvelope = {
            token: session.mintedToken,
            token_type: 'PAT' as const,
            token_id: session.mintedTokenId,
            user: toAuthenticatedUser(userRow),
          };
          // One-shot consumption — Threat T-30-04-01 mitigation. We
          // remove BEFORE sending so a hypothetical synchronous replay
          // would already see expired_token. (fastify.inject is async
          // so this ordering matters; production CLI polls are also
          // network-async.) The captured envelope above is the only
          // copy of session.mintedToken that survives `remove`.
          remove(session.deviceCode);
          request.log.info(
            {
              event: 'device_flow_token_issued',
              userId: session.approvedUserId,
              tokenId: session.mintedTokenId,
            },
            'device-flow PAT delivered',
          );
          return reply.code(200).send(successEnvelope);
        }
        case 'denied':
          return reply.code(400).send({ error: 'access_denied' });
        case 'expired':
          return reply.code(400).send({ error: 'expired_token' });
      }
    },
  );
};

export default deviceTokenRoute;
