/**
 * Phase 30 Plan 02 — browser leg of RFC 8628 device flow.
 *
 * Registers TWO routes inside one Fastify plugin factory:
 *
 *   GET  /auth/device         — renders the approval form (Task 2 of 30-02)
 *   POST /auth/device/verify  — validates CSRF, marks the device-flow session
 *                                approved (Task 3 of 30-02)
 *
 * Both routes share the `?user_code` alphabet (USER_CODE_ALPHABET from
 * device-flow-store) so reflected XSS via the query string is structurally
 * impossible — the route validates BEFORE handing the value to the
 * `renderDevicePage` helper, and the helper escapes via `html` as defense
 * in depth (Threat T-30-02-02).
 *
 * Auth posture:
 *   - GET runs with `config: { skipAuth: true }` because an unauthenticated
 *     visitor MUST be redirected to /auth/login (we cannot rely on the
 *     chain's 401, which doesn't redirect). We read `session.get('user')`
 *     ourselves to decide.
 *   - POST runs with `config: { sessionOnly: true }` so the Phase 28 chain
 *     enforces "PAT cannot approve a device flow" before our handler runs
 *     (Threat T-30-02-04).
 *
 * Plan 30-04 will REPLACE the success branch of the POST handler with one
 * that ALSO mints a PAT and stashes it for the CLI to consume. This plan
 * stops at `approve(userCode, userId)` + the success page so the diff for
 * Plan 30-04 stays small.
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import {
  approve,
  findByUserCode,
  recordMintedToken,
  tokenName,
} from '../../../services/device-flow-store.js';
import { renderDevicePage, renderDeviceApprovedPage } from '../../../web/pages/device.js';
import { getOrCreateCsrfToken, verifyCsrfToken } from './csrf.js';
import { requireUser } from '../../plugins/auth.js';
import { generateToken } from '../../../services/pat-hash.js';
import { config } from '../../../config/env.js';

export interface DeviceHtmlRouteOptions {
  /**
   * Server origin used to build the absolute redirect target on the
   * 302 to /auth/login. Plan 30-08 sources this from
   * `new URL(env.OIDC_REDIRECT_URI).origin` — same value passed to
   * deviceCodeRoute so the verification_uri the CLI prints matches.
   */
  origin: string;
}

/**
 * Strict alphabet check for `?user_code=`. MUST match the alphabet used by
 * device-flow-store's generator: 31 confusable-free uppercase chars,
 * length exactly 8. Anything else is dropped so an attacker-controlled
 * value never reaches the rendered HTML or the `findByUserCode` lookup.
 */
const USER_CODE_RE = /^[A-HJ-KM-NP-Z2-9]{8}$/;

function getSessionUserId(request: FastifyRequest): number | null {
  const u = request.session.get('user') as { id?: number } | null | undefined;
  if (!u || typeof u.id !== 'number') return null;
  return u.id;
}

interface DeviceQuery {
  user_code?: unknown;
}

interface VerifyBody {
  user_code?: unknown;
  _csrf?: unknown;
}

const deviceHtmlRoute: FastifyPluginAsync<DeviceHtmlRouteOptions> = async (fastify, opts) => {
  // Plan 30-04 Task 2 — fail fast at registration if the host app didn't
  // wire the api-token repository. The verify handler depends on it to
  // mint the auto-PAT after approval; a missing decorator surfaces a clear
  // boot error instead of a runtime 500 on the first device-flow attempt.
  if (!fastify.hasDecorator('apiTokenRepository')) {
    throw new Error(
      'deviceHtmlRoute requires apiTokenRepository to be decorated before registration',
    );
  }
  // ---------------------------------------------------------------------------
  // GET /auth/device — render the form (or 302 to /auth/login)
  // ---------------------------------------------------------------------------
  fastify.get('/auth/device', { config: { skipAuth: true } }, async (request, reply) => {
    const rawUserCode = (request.query as DeviceQuery).user_code;
    const safeUserCode =
      typeof rawUserCode === 'string' && USER_CODE_RE.test(rawUserCode) ? rawUserCode : null;

    // Redirect unauthenticated visitors to /auth/login with a sanitized
    // ?next that preserves the user_code ONLY when it is well-formed.
    if (getSessionUserId(request) === null) {
      const nextValue =
        safeUserCode !== null ? `/auth/device?user_code=${safeUserCode}` : '/auth/device';
      return reply
        .header('Cache-Control', 'no-store')
        .redirect(`${opts.origin}/auth/login?next=${encodeURIComponent(nextValue)}`, 302);
    }

    // Authenticated — render the form. getOrCreateCsrfToken seeds the
    // session.csrf entry on first visit so the subsequent POST has
    // something to validate against.
    const csrfToken = getOrCreateCsrfToken(request);
    const html = renderDevicePage({
      csrfToken,
      prefilledUserCode: safeUserCode,
      errorMessage: null,
    });
    return reply
      .header('Cache-Control', 'no-store')
      .type('text/html; charset=utf-8')
      .code(200)
      .send(html);
  });

  // ---------------------------------------------------------------------------
  // POST /auth/device/verify — CSRF + approve (Task 3)
  // ---------------------------------------------------------------------------
  //
  // Auth: config.sessionOnly=true → Phase 28 chain returns 403 session_required
  // for PAT/legacy callers BEFORE this handler runs (Threat T-30-02-04).
  //
  // Branch order (first failure wins):
  //   1. CSRF mismatch → 403 with the device page re-rendered (CSRF error
  //      is rendered as an in-page banner — the response status is still
  //      403 so JS callers can detect; HTML clients see the rendered page).
  //   2. user_code fails the alphabet → 400, re-render with format error.
  //   3. findByUserCode undefined OR status != 'pending' OR expired →
  //      400, re-render with "expired" error.
  //   4. Success → approve() then renderDeviceApprovedPage(). Logger emits
  //      `event: device_flow_approved` with the userId — user_code is
  //      DELIBERATELY OMITTED from the log payload (Threat T-30-02-06).
  // Issue #75 — tighter per-route rate limit (auth surface hardening).
  fastify.post(
    '/auth/device/verify',
    {
      config: {
        sessionOnly: true,
        rateLimit: {
          max: config.RATE_LIMIT_AUTH_MAX,
          timeWindow: config.RATE_LIMIT_AUTH_TIME_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as VerifyBody;

      // 1. CSRF gate.
      if (!verifyCsrfToken(request, body._csrf)) {
        // Re-render with a CSRF error message; status 403 so clients (and
        // tests) can detect the mismatch without parsing HTML.
        const csrfToken = getOrCreateCsrfToken(request);
        const html = renderDevicePage({
          csrfToken,
          prefilledUserCode: null,
          errorMessage: 'Session expired. Refresh the page and try again.',
        });
        return replyHtml(reply, 403, html);
      }

      // 2. Format gate — defense in depth on top of the HTML `pattern`
      //    attribute (which is purely client-side and easily bypassed).
      const rawUserCode = body.user_code;
      const userCode =
        typeof rawUserCode === 'string' && USER_CODE_RE.test(rawUserCode) ? rawUserCode : null;
      if (userCode === null) {
        const csrfToken = getOrCreateCsrfToken(request);
        const html = renderDevicePage({
          csrfToken,
          prefilledUserCode: null,
          errorMessage: 'That code is not in the expected format.',
        });
        return replyHtml(reply, 400, html);
      }

      // 3. Lookup + expiry gate.
      const session = findByUserCode(userCode);
      const now = Date.now();
      const expired =
        session === undefined || session.status === 'expired' || now > session.expiresAt;
      // Plan 30-04 will treat status==='approved' (with a different userId)
      // as a no-op too; for this plan the approve() helper's own idempotency
      // is the source of truth.
      if (expired || session.status === 'denied') {
        const csrfToken = getOrCreateCsrfToken(request);
        const html = renderDevicePage({
          csrfToken,
          prefilledUserCode: null,
          errorMessage: 'That code has expired. Please run `tasks login` again.',
        });
        return replyHtml(reply, 400, html);
      }

      // 4. Approve. requireUser() narrows request.user — the chain's
      //    sessionOnly gate has already proved session auth at this point.
      const user = requireUser(request);
      approve(userCode, user.id);

      // Audit log — userId only. user_code MUST NOT appear (Threat T-30-02-06).
      request.log.info(
        {
          event: 'device_flow_approved',
          userId: user.id,
        },
        'device flow approved',
      );

      // 5. (Plan 30-04 Task 2) Mint a PAT for the CLI to consume on its
      //    next /auth/device/token poll. The session is now in 'approved'
      //    state, so the lookup here is guaranteed; we re-fetch only to
      //    read the (already sanitized) hostname captured at create time.
      //
      //    The mint is wrapped in a try/catch so a transient DB outage
      //    surfaces a user-actionable error page rather than a generic
      //    500. The session stays in 'approved' (mintedToken === null)
      //    so a retry via the polling endpoint would still see
      //    `authorization_pending` until the device-code TTL expires —
      //    no replay window opens.
      const approvedSession = findByUserCode(userCode);
      // The store guarantees this lookup is non-null at this point
      // (approve() returned successfully, no concurrent remove()). The
      // narrow is a type-system requirement, not a runtime expectation.
      if (!approvedSession) {
        throw new Error('device-flow: session vanished between approve() and mint');
      }
      const name = tokenName(approvedSession.hostname ?? 'unknown');
      try {
        const { token, prefix, suffix, hash } = generateToken();
        const row = fastify.apiTokenRepository.insert({
          userId: user.id,
          name,
          prefix,
          suffix,
          hash,
          scopes: JSON.stringify([]),
          expiresAt: null,
        });
        // WR-01 (Phase 30 review) — `recordMintedToken` returns `false`
        // when the session is no longer in 'approved' state (e.g. a
        // concurrent `remove()` raced, or the cleanup tick fired between
        // approve() and here). better-sqlite3 is synchronous so this
        // race is structurally unreachable today, but the contract is
        // fragile and silent failure would leave an orphan PAT row in
        // the DB that the CLI never receives. If the stash fails, REVOKE
        // the just-minted PAT and render the recoverable-error page so
        // the user can retry without leaking an unreachable token.
        const stashed = recordMintedToken(userCode, {
          tokenId: row.id,
          token,
        });
        if (!stashed) {
          // Best-effort revoke — if THIS fails too, log + carry on; the
          // outer catch will render the same error page.
          try {
            fastify.apiTokenRepository.revoke(row.id, user.id);
          } catch (revokeErr) {
            request.log.error(
              {
                err: revokeErr,
                event: 'pat_orphan_revoke_failed',
                userId: user.id,
                tokenId: row.id,
              },
              'failed to revoke orphan PAT after recordMintedToken returned false',
            );
          }
          request.log.warn(
            {
              event: 'device_flow_mint_stash_failed',
              userId: user.id,
              tokenId: row.id,
            },
            'recordMintedToken returned false — session not in approved state; orphan PAT revoked',
          );
          const csrfToken = getOrCreateCsrfToken(request);
          const html = renderDevicePage({
            csrfToken,
            prefilledUserCode: null,
            errorMessage: 'Could not complete sign-in. Please try again.',
          });
          return replyHtml(reply, 500, html);
        }
        // Audit log — userId + tokenId only. token, hash, user_code, and
        // name are intentionally OMITTED (Threats T-30-04-02 / T-30-02-06).
        request.log.info(
          {
            event: 'pat_minted',
            via: 'device_flow',
            userId: user.id,
            tokenId: row.id,
          },
          'pat minted via device flow',
        );
      } catch (err) {
        // The PAT didn't land — log + render a recoverable error page.
        // The session remains 'approved' (no mintedToken), so the CLI
        // polling endpoint continues returning `authorization_pending`
        // until the device-code TTL elapses (graceful degradation per
        // Threat T-30-04-05 disposition).
        request.log.error(
          { err, event: 'pat_mint_failed', userId: user.id },
          'pat mint failed during device flow',
        );
        const csrfToken = getOrCreateCsrfToken(request);
        const html = renderDevicePage({
          csrfToken,
          prefilledUserCode: null,
          errorMessage: 'Could not complete sign-in. Please try again.',
        });
        return replyHtml(reply, 500, html);
      }

      const successHtml = renderDeviceApprovedPage();
      return replyHtml(reply, 200, successHtml);
    },
  );
};

/**
 * Shared HTML reply builder — same headers on every branch so the cache
 * + content-type contract is enforced in one place.
 */
function replyHtml(reply: FastifyReply, code: number, html: string): FastifyReply {
  return reply
    .header('Cache-Control', 'no-store')
    .type('text/html; charset=utf-8')
    .code(code)
    .send(html);
}

export default deviceHtmlRoute;
