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
import { config } from '../../../config/env.js';

export interface DeviceCodeRouteOptions {
  /**
   * FALLBACK origin for the verification URIs the CLI prints, used only when
   * the request carries no usable Host header. Plan 30-08 sources this from
   * `new URL(env.OIDC_REDIRECT_URI).origin`. Example: `https://woodfiredbugs.local`.
   *
   * #834: the verification origin is now derived PER-REQUEST from the address
   * the client actually connected to (see {@link resolveVerificationOrigin}),
   * because this configured value is typically `http://localhost:3000` and is
   * unroutable for any client that reached the server over the LAN / a real
   * hostname. `origin` remains as the no-Host-header fallback.
   */
  origin: string;
  /**
   * Expected OAuth client_id. Locked single-client in v1.6 (Phase 29 ships
   * one OIDC_CLIENT_ID; we reject anything else).
   */
  expectedClientId: string;
  /**
   * Issue #68 (finding 2) — optional allowlist of hostnames the per-request
   * verification origin may be built from (sourced from
   * `env.DEVICE_FLOW_TRUSTED_HOSTS`). When non-empty, a request whose
   * `Host` / `X-Forwarded-Host` is not in the list is ignored and the
   * verification URI falls back to the configured {@link origin}. When
   * empty/undefined (default) every Host is honored — backward compatible.
   * Hostnames only (no port); the resolver strips any `:port` before matching.
   */
  trustedHosts?: readonly string[];
}

/** First value of a possibly comma-joined / array-valued HTTP header. */
function firstHeaderValue(v: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  if (typeof raw !== 'string') return undefined;
  const first = raw.split(',')[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

/**
 * Resolve the origin (`scheme://host[:port]`) the CLIENT used to reach this
 * server, for building the device-flow `verification_uri` the user opens in a
 * browser (#834).
 *
 * Previously this was a STATIC configured origin (`OIDC_REDIRECT_URI`'s origin),
 * which is `http://localhost:3000` on a typical server — so a CLI that connected
 * over the LAN (e.g. `http://192.168.x.x:3000`) was told to open a localhost URL
 * pointing at its OWN machine. We instead use the host the request arrived on,
 * honoring `X-Forwarded-{Host,Proto}` from a trusted reverse proxy.
 *
 * Security: this is NOT a host-header-injection vector. The `verification_uri`
 * is returned ONLY to the same client that sent the request, so a spoofed Host
 * merely misdirects the spoofer. Falls back to `fallback` (the configured
 * origin) when no Host header is present at all.
 *
 * Issue #68 (finding 2) — an operator who wants to pin the trust boundary may
 * pass `trustedHosts` (from `env.DEVICE_FLOW_TRUSTED_HOSTS`). When that list is
 * non-empty, a Host whose hostname is NOT on it is refused and we fall back to
 * the configured `fallback` origin rather than echoing an arbitrary header.
 * When the list is empty/omitted the behavior is unchanged (every Host honored).
 */
export function resolveVerificationOrigin(
  request: { headers: Record<string, string | string[] | undefined>; protocol?: string },
  fallback: string,
  trustedHosts: readonly string[] = [],
): string {
  const host =
    firstHeaderValue(request.headers['x-forwarded-host']) ??
    firstHeaderValue(request.headers['host']);
  if (!host) return fallback;
  // When an allowlist is configured, the Host's hostname (sans :port) must be
  // on it; otherwise refuse the header and use the configured origin.
  if (trustedHosts.length > 0) {
    const hostname = (host.split(':')[0] ?? host).toLowerCase();
    if (!trustedHosts.includes(hostname)) return fallback;
  }
  const scheme =
    firstHeaderValue(request.headers['x-forwarded-proto']) ??
    (request.protocol && request.protocol.length > 0 ? request.protocol : 'http');
  return `${scheme}://${host}`;
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

const deviceCodeRoute: FastifyPluginAsync<DeviceCodeRouteOptions> = async (fastify, opts) => {
  // Issue #75 — tighter per-route rate limit (auth surface hardening).
  fastify.post(
    '/auth/device/code',
    {
      config: {
        skipAuth: true,
        rateLimit: {
          max: config.RATE_LIMIT_AUTH_MAX,
          timeWindow: config.RATE_LIMIT_AUTH_TIME_WINDOW,
        },
      },
    },
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

      // #834: build the verification URL from the address the CLIENT connected to
      // (request Host / X-Forwarded-*), not the static configured origin, so a
      // remote/LAN client gets a URL it can actually open instead of localhost.
      const origin = resolveVerificationOrigin(request, opts.origin, opts.trustedHosts ?? []);

      return reply.code(200).send({
        device_code: session.deviceCode,
        user_code: session.userCode,
        verification_uri: `${origin}/auth/device`,
        verification_uri_complete: `${origin}/auth/device?user_code=${session.userCode}`,
        expires_in: 600 as const,
        interval: 5 as const,
      });
    },
  );
};

export default deviceCodeRoute;
