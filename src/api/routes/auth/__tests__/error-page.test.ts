/**
 * Phase 29 Plan 06 — /auth/error route tests.
 *
 * The error page is a "safety-net" rendered when the OIDC handshake aborts
 * for any reason (state mismatch, exchange failure, email_unverified, etc.).
 *
 * Hard contract:
 *   - status 200 (it's a normal page, not a server error)
 *   - Content-Type: text/html; charset=utf-8
 *   - Cache-Control: no-store
 *   - body contains the literal user-facing message
 *   - when ?reason matches an allowlist of categorical codes, a small
 *     "Error code: <reason>" footer appears
 *   - unknown / malformed / missing reason → no footer (never reflects
 *     untrusted query content beyond the validated allowlist)
 *
 * Allowlist: oidc_not_configured | handshake_missing | state_mismatch
 *          | email_unverified | exchange_failed | unknown
 *   (Matches the PLAN.md allowlist; see PLAN-CHECK fixes section).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import authErrorRoute from '../auth-error.js';

const GENERIC_MESSAGE =
  'Sign-in failed. Please try again. If the problem persists, contact your administrator.';

describe('GET /auth/error', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = Fastify();
    // Mirror Plan 8's wiring: authRoutes plugin is registered with the
    // /auth prefix in server.ts, so the externally-visible path becomes
    // /auth/error.
    await server.register(authErrorRoute, { prefix: '/auth' });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it('responds 200 with text/html and Cache-Control: no-store', async () => {
    const r = await server.inject({ method: 'GET', url: '/auth/error' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/html; charset=utf-8/);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('WR-04: stamps X-Frame-Options, CSP, and Referrer-Policy on every response', async () => {
    const r = await server.inject({ method: 'GET', url: '/auth/error' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('same-origin');
    const csp = r.headers['content-security-policy'];
    expect(typeof csp).toBe('string');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // Inline style/script are intentionally allowlisted in v1.6 (the
    // project's pages use inline <style> + onclick clipboard handlers).
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('body contains the generic operator-friendly message', async () => {
    const r = await server.inject({ method: 'GET', url: '/auth/error' });
    expect(r.body).toContain(GENERIC_MESSAGE);
  });

  it('renders "Error code: <reason>" footer when ?reason is in the allowlist', async () => {
    const r = await server.inject({
      method: 'GET',
      url: '/auth/error?reason=state_mismatch',
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Error code: state_mismatch');
  });

  it.each([
    'oidc_not_configured',
    'handshake_missing',
    'state_mismatch',
    'email_unverified',
    'exchange_failed',
    'unknown',
  ])('renders footer for allowlisted reason %s', async (reason) => {
    const r = await server.inject({
      method: 'GET',
      url: `/auth/error?reason=${reason}`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`Error code: ${reason}`);
  });

  it('omits the footer when ?reason is not in the allowlist (e.g. malformed)', async () => {
    const cases = [
      'foo_bar', // not in allowlist
      'STATE_MISMATCH', // uppercase
      'state.mismatch', // dot
      '<script>alert(1)</script>', // XSS payload
      'state_mismatch_extra', // suffix
      '', // empty
    ];
    for (const reason of cases) {
      const r = await server.inject({
        method: 'GET',
        url: `/auth/error?reason=${encodeURIComponent(reason)}`,
      });
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain('Error code:');
    }
  });

  it('never reflects untrusted query content into the body', async () => {
    // Even with a malformed reason, the literal query string must not appear
    // anywhere in the HTML output (defense against XSS via the error page).
    const r = await server.inject({
      method: 'GET',
      url: '/auth/error?reason=' + encodeURIComponent('<script>alert(1)</script>'),
    });
    expect(r.body).not.toContain('<script>alert(1)</script>');
    expect(r.body).not.toContain('alert(1)');
  });

  it('omits the footer when ?reason is missing entirely', async () => {
    const r = await server.inject({ method: 'GET', url: '/auth/error' });
    expect(r.body).not.toContain('Error code:');
  });
});
