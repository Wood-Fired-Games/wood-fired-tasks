/**
 * Phase 29 Plan 06 — GET /auth/error generic error page.
 *
 * Rendered when an OIDC flow aborts for any reason: state mismatch,
 * exchange failure, email_unverified, missing handshake, OIDC disabled,
 * etc. The page MUST NOT echo provider error text or session-derived
 * data; the only piece of caller-supplied query content reflected back
 * is the `?reason=<code>` value AND only when it matches a small
 * allowlist of categorical codes.
 *
 * Status 200 intentionally (29-CONTEXT.md): this is a normal HTML page,
 * not a server error. Returning 500 would log spam on Sentry-class
 * pipelines and would surface as a noisy error in browser dev tools.
 *
 * Cache-Control: no-store — security-relevant pages must never be cached.
 *
 * The route registers at `GET /error`; the parent plugin in `index.ts`
 * (registered by Plan 8 at server.ts with prefix `/auth`) means the
 * final externally-visible path is `/auth/error`.
 */
import type { FastifyPluginAsync } from 'fastify';
import { HTML_SECURITY_HEADERS } from '../../../web/html.js';

/**
 * Categorical reason codes the OIDC flow may emit. Anything outside this
 * allowlist is silently dropped (no footer rendered) so a malformed query
 * string can never inject content into the page.
 *
 * Keep in sync with the redirect targets in:
 *   - login.ts        (`oidc_not_configured`)
 *   - callback.ts     (`handshake_missing`, `state_mismatch`,
 *                       `email_unverified`, `exchange_failed`)
 *   - any future emitter (`unknown` is the catch-all)
 */
const ALLOWED_REASONS = new Set([
  'oidc_not_configured',
  'handshake_missing',
  'state_mismatch',
  'email_unverified',
  'exchange_failed',
  // WR-05 fix: distinct reason for upsert/provisioning failures (DB
  // error, FK violation, etc.). Surfaces operationally so operators can
  // tell "Google bounced the user" (exchange_failed) from "our DB hiccupped
  // during provisioning" (provisioning_failed) in logs and SLOs.
  'provisioning_failed',
  'unknown',
]);

const authErrorRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/error',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const rawReason = (request.query as { reason?: unknown }).reason;
      const reason =
        typeof rawReason === 'string' && ALLOWED_REASONS.has(rawReason)
          ? rawReason
          : null;

      // `reason` is guaranteed to be one of the allowlisted strings when
      // present, so direct interpolation is safe (no escaping needed —
      // the allowlist's character class is [a-z_] only).
      const footer = reason
        ? `<p class="error-code">Error code: ${reason}</p>`
        : '';

      const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Sign-in failed</title>
</head>
<body>
<main>
<h1>Sign-in failed</h1>
<p>Sign-in failed. Please try again. If the problem persists, contact your administrator.</p>
<p><a href="/auth/login">Return to sign-in</a></p>
${footer}
</main>
</body>
</html>`;

      // WR-04 fix: stamp X-Frame-Options / CSP / Referrer-Policy on the
      // error page. The web-routes onSend hook does not run here (the
      // error page lives under /auth, not /, and the hook is scoped to
      // the web plugin), so we apply the constants explicitly.
      const replyWithHeaders = reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Cache-Control', 'no-store');
      for (const [name, value] of Object.entries(HTML_SECURITY_HEADERS)) {
        replyWithHeaders.header(name, value);
      }
      return replyWithHeaders.code(200).send(body);
    },
  );
};

export default authErrorRoute;
